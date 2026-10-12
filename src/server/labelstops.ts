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
// - その場所の本当の滞在（STOP_M 以内の滞在先）と、前後 COVERED_MARGIN_MS の範囲で重なる立ち寄りは足さない
// - 自宅・職場（訪問が HOME_MIN_VISITS 回以上）の近くのラベルは使わない（家の前を通るたびに立ち寄りになるため）
// - 滞在先：ラベルから takeoutLabelM 以内に本当の滞在先があればその場所、なければラベルごとの場所
//   （placeId は `label:緯度,経度`）。種類は ALIASED_LOCATION（Google でもラベルを付けた場所の種類）
//
// 取り込みのたびと「今すぐ調べる」で全部を作り直す（areas.ts の runAssign の最初）。

const LEAVE_M = 200;
const MAX_GAP_MS = 12 * 3600_000;
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
    const pts: { t: number; lat: number; lng: number }[] = [];
    for (const r of db.prepare('SELECT t_ms, lat, lng FROM path_points').iterate() as Iterable<any>) pts.push({ t: r.t_ms, lat: r.lat, lng: r.lng });
    for (const r of db.prepare('SELECT start_ms, end_ms, start_lat, start_lng, end_lat, end_lng FROM activities').iterate() as Iterable<any>) {
      pts.push({ t: r.start_ms, lat: r.start_lat, lng: r.start_lng }, { t: r.end_ms, lat: r.end_lat, lng: r.end_lng });
    }
    pts.sort((a, b) => a.t - b.t);

    // 時差：その時刻の前の滞在か移動のもの
    const offsetAt = db.prepare(
      'SELECT COALESCE((SELECT utc_offset_min FROM activities WHERE start_ms <= ? AND utc_offset_min IS NOT NULL ORDER BY start_ms DESC LIMIT 1), ?) AS o',
    );
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
        if (prev && s[0] - prev[1] <= MERGE_MS) prev[1] = s[1];
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
