import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './tx';
import { distM } from './labelstore';
import { rebuildPlaces } from './db';

// Google Takeout の「ラベルを付けた場所」への立ち寄りを、経路の点から推定して滞在に加える（visits の estimated = 1）。
//
// ラベルを付けた場所は、友人の家などの個人的な場所が多い。タイムラインは、そこでの滞在を記録しないことがある
// （住所だけの地点への滞在は 2024 年から記録されなくなり、その時間は動かない「移動」になっている）。また、
// 友人を拾っただけのような短い立ち寄りは、もともと滞在にならない。そこで、経路の点（と移動の始まり・終わり）が
// ラベルの場所の近くに来た時間を、短くても「立ち寄り」として扱う。
//
// - ラベルから STOP_M（設定 labelStopM、既定 50m）以内の点が来たら立ち寄りを始め、LEAVE_M より遠い点が来るか、
//   点の間が MAX_GAP_MS あいたら終える。間が MERGE_MS 以内の立ち寄りは 1 つにまとめる。点が 1 つだけでもよい
//   - 端末は動かないと点を記録しないので、点が GAP_EXTEND_MS 以上途切れたあとに遠い点が来たときは、その遠い点の時刻まで
//     そこにいたものとする（途切れた間を立ち寄りに含める）。ただし、その間に別の場所（LEAVE_M より遠く）の本当の滞在が
//     始まっていたら、そこまで
//   - 間に別の場所の本当の滞在がある 2 つの立ち寄りは、MERGE_MS 以内でもまとめない（出かけて戻ってきたため）
//   - 移動の始まり・終わりの位置は、前後 ENDPOINT_CHECK_MS の経路の点が LEAVE_M より遠くにあれば使わない（長時間動かない
//     移動の終わりの位置が、実際にはもう離れた時刻のものになっていることがあるため）
// - その場所の本当の滞在（STOP_M 以内の滞在先）と、前後 COVERED_MARGIN_MS の範囲で重なる立ち寄りは足さない
// - 自宅・職場（訪問が HOME_MIN_VISITS 回以上）の近くのラベルは使わない（家の前を通るたびに立ち寄りになるため）
// - 滞在先：ラベルから takeoutLabelM 以内に本当の滞在先があればその場所、なければラベルごとの場所
//   （placeId は `label:緯度,経度`）。種類は ALIASED_LOCATION（Google でもラベルを付けた場所の種類）
//
// 取り込みのたびと「今すぐ調べる」で全部を作り直す（areas.ts の runAssign の最初）。

const LEAVE_M = 200;
const MAX_GAP_MS = 12 * 3600_000;
const GAP_EXTEND_MS = 10 * 60_000;
const ENDPOINT_CHECK_MS = 10 * 60_000;
const MERGE_MS = 60 * 60_000;
const COVERED_MARGIN_MS = 15 * 60_000;
const HOME_MIN_VISITS = 10;

export const LABEL_PLACE_PREFIX = 'label:';

export interface LabelStopOptions {
  /** ラベルから、立ち寄ったとみなす距離（m） */
  stopM: number;
  /** ラベルを本当の滞在先に結び付ける距離（m）。takeoutLabelM と同じ */
  labelM: number;
  /** 時差が分からないときの時差（分） */
  tzOffsetMinutes: number;
}

/** 時刻（UTC ミリ秒）と時差から、元データと同じ形の時刻文字列（2024-05-03T09:46:39.000+09:00） */
function localIso(ms: number, offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return new Date(ms + offsetMin * 60_000).toISOString().replace('Z', off);
}

/** 推定の立ち寄りを作り直す（前に作った分は消す）。作った数を返す */
export function rebuildLabelStops(db: DatabaseSync, opts: LabelStopOptions): number {
  let count = 0;
  transaction(db, () => {
    db.exec('DELETE FROM visits WHERE estimated = 1');
    rebuildPlaces(db);
    const labels = db.prepare("SELECT name, lat, lng FROM takeout_places WHERE kind = 'labeled'").all() as any[];
    if (!labels.length) return;

    const homes = db
      .prepare("SELECT lat, lng FROM places WHERE semantic_type IN ('HOME', 'INFERRED_HOME', 'WORK', 'INFERRED_WORK') AND visit_count >= ?")
      .all(HOME_MIN_VISITS) as any[];
    const places = db.prepare('SELECT place_id, lat, lng FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
    const realVisits = db.prepare('SELECT start_ms, end_ms, lat, lng FROM visits WHERE estimated = 0 AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
    const box = (lat: number, lng: number, m: number) => {
      const dLat = m / 111_320;
      const dLng = dLat / Math.cos((lat * Math.PI) / 180);
      return [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
    };

    // 経路の点と、移動の始まり・終わりの位置（時刻順）
    type Pt = { t: number; lat: number; lng: number };
    const path: Pt[] = [];
    for (const r of db.prepare('SELECT t_ms, lat, lng FROM path_points ORDER BY t_ms').iterate() as Iterable<any>) path.push({ t: r.t_ms, lat: r.lat, lng: r.lng });
    /** 前後 ENDPOINT_CHECK_MS の経路の点と食い違わないか */
    const agreesWithPath = (e: Pt) => {
      let lo = 0;
      let hi = path.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (path[mid].t < e.t - ENDPOINT_CHECK_MS) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < path.length && path[i].t <= e.t + ENDPOINT_CHECK_MS; i++) {
        if (distM(e.lat, e.lng, path[i].lat, path[i].lng) > LEAVE_M) return false;
      }
      return true;
    };
    const pts: Pt[] = [...path];
    for (const r of db.prepare('SELECT start_ms, end_ms, start_lat, start_lng, end_lat, end_lng FROM activities').iterate() as Iterable<any>) {
      for (const e of [{ t: r.start_ms, lat: r.start_lat, lng: r.start_lng }, { t: r.end_ms, lat: r.end_lat, lng: r.end_lng }]) {
        if (agreesWithPath(e)) pts.push(e);
      }
    }
    pts.sort((a, b) => a.t - b.t);

    // 時差：その時刻の前の滞在か移動のもの
    const offsetAt = db.prepare(
      'SELECT COALESCE((SELECT utc_offset_min FROM activities WHERE start_ms <= ? AND utc_offset_min IS NOT NULL ORDER BY start_ms DESC LIMIT 1), ?) AS o',
    );
    // 別の場所の本当の滞在（時間の範囲で探す）
    const realBetween = db.prepare('SELECT start_ms, lat, lng FROM visits WHERE estimated = 0 AND start_ms < ? AND end_ms > ? ORDER BY start_ms');
    /** from〜to の間に、(lat, lng) から LEAVE_M より遠い本当の滞在があれば、その始まり（なければ null） */
    const awayVisitStart = (lat: number, lng: number, from: number, to: number): number | null => {
      for (const v of realBetween.all(to, from) as any[]) {
        if (distM(lat, lng, v.lat, v.lng) > LEAVE_M) return Math.max(v.start_ms, from);
      }
      return null;
    };
    const ins = db.prepare(
      `INSERT INTO visits (start_ms, end_ms, start_local, end_local, local_date, utc_offset_min,
         place_id, semantic_type, lat, lng, probability, place_probability, hierarchy_level, estimated)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ALIASED_LOCATION', ?, ?, NULL, NULL, 0, 1)`,
    );

    for (const l of labels) {
      if (homes.some((h) => distM(l.lat, l.lng, h.lat, h.lng) <= opts.stopM)) continue;
      // 立ち寄りを探す（近くにない点はすぐ飛ばす）
      const [s1, n1, w1, e1] = box(l.lat, l.lng, LEAVE_M);
      const stops: [number, number][] = [];
      let cur: [number, number] | null = null;
      let last = 0;
      for (const p of pts) {
        const d = p.lat < s1 || p.lat > n1 || p.lng < w1 || p.lng > e1 ? Infinity : distM(l.lat, l.lng, p.lat, p.lng);
        if (cur && (d > LEAVE_M || p.t - last > MAX_GAP_MS)) {
          // 点が途切れたあとに離れた点が来たら、途切れた間もそこにいたものとする
          if (d > LEAVE_M && p.t - last >= GAP_EXTEND_MS && p.t - last <= MAX_GAP_MS) cur[1] = awayVisitStart(l.lat, l.lng, last, p.t) ?? p.t;
          stops.push(cur);
          cur = null;
        }
        if (d <= opts.stopM) {
          if (cur) cur[1] = p.t;
          else cur = [p.t, p.t];
          last = p.t;
        } else if (cur && d <= LEAVE_M) last = p.t;
      }
      if (cur) stops.push(cur);
      if (!stops.length) continue;
      const merged: [number, number][] = [];
      for (const s of stops) {
        const prev = merged[merged.length - 1];
        if (prev && s[0] - prev[1] <= MERGE_MS && awayVisitStart(l.lat, l.lng, prev[1], s[0]) == null) prev[1] = s[1];
        else merged.push([...s]);
      }

      // その場所の本当の滞在と重なるものは足さない
      const [s2, n2, w2, e2] = box(l.lat, l.lng, opts.stopM);
      const covered = (realVisits.all(s2, n2, w2, e2) as any[]).filter((v) => distM(l.lat, l.lng, v.lat, v.lng) <= opts.stopM);
      const fresh = merged.filter(([s, e]) => !covered.some((v) => v.start_ms - COVERED_MARGIN_MS <= e && s <= v.end_ms + COVERED_MARGIN_MS));
      if (!fresh.length) continue;

      // 滞在先：近くの本当の滞在先か、ラベルごとの場所
      const [s3, n3, w3, e3] = box(l.lat, l.lng, opts.labelM);
      let placeId = `${LABEL_PLACE_PREFIX}${l.lat.toFixed(6)},${l.lng.toFixed(6)}`;
      let bestD = Infinity;
      for (const p of places.all(s3, n3, w3, e3) as any[]) {
        const d = distM(l.lat, l.lng, p.lat, p.lng);
        if (d <= opts.labelM && d < bestD) [placeId, bestD] = [p.place_id, d];
      }
      for (const [s, e] of fresh) {
        const off = (offsetAt.get(s, opts.tzOffsetMinutes) as any).o as number;
        const startLocal = localIso(s, off);
        ins.run(s, e, startLocal, localIso(e, off), startLocal.slice(0, 10), off, placeId, l.lat, l.lng);
        count++;
      }
    }
    rebuildPlaces(db);
  });
  return count;
}
