import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { transaction } from './tx';
import { readZipEntriesFromFile } from './zip';
import { distM, getKv, loadedKey, markChecked, setKv, type Target } from './labelstore';

// Foursquare の Swarm アプリで書き出したデータ（データのエクスポートの zip）から、チェックインした店の名前を地点名にする。
// 自分のデータを書き出したものなので、保存してよい。
//
// 使うのはチェックイン（checkins1.json, checkins2.json …）だけ。店の名前・端末の位置（lat・lng、精度 hacc）・時刻（UTC）・時差が入っている。
// 自動で検出された訪問（unconfirmed_visits.json）は店が違っていることが多いので使わない。visits.json には店の名前がない。
//
// 作業は Takeout と同じく2つに分かれる：
// 1. データを入れる（書き出し直したときだけ。画面から zip を送るか、管理者が import-swarm で）。zip は残さず、チェックインの
//    ファイルだけを利用者のフォルダーの swarm/ に取り出して（全部置き換え）、そこから DB に入れ直す
// 2. 地点に割り当てる（タイムラインの取り込みのたびと「今すぐ照合する」。areas.ts の runAssign から呼ぶ）
//
// 割り当て（swarm-checkin）：Google のタイムラインと同じ端末で記録しているので、チェックインの時刻を含む滞在を探す。
// その滞在の場所がチェックインした店。時刻を含む滞在が複数（入れ子の滞在など）あれば、端末の位置にいちばん近いもの。
// 時刻を含む滞在がなければ、前後 MARGIN_MS の滞在のうち近いもの。場所ごとに、いちばん多くチェックインした店の名前を付ける

export const SWARM_SOURCE = 'swarm-checkin';

/** チェックインの時刻を含む滞在の、端末の位置からの距離の上限（m） */
const INSIDE_MAX_M = 300;
/** 時刻を含む滞在がないときに、前後を探す幅（ミリ秒）と距離の上限（m） */
const MARGIN_MS = 10 * 60_000;
const MARGIN_MAX_M = 150;

const CHECKINS_RE = /(^|\/)checkins\d*\.json$/i;

/** zip が Swarm の書き出しか（チェックインのファイルがあるか）。中身は読まずに目次だけを見る */
export function isSwarmZip(path: string): boolean {
  let found = false;
  readZipEntriesFromFile(path, (name) => {
    if (CHECKINS_RE.test(name)) found = true;
    return false;
  });
  return found;
}

/** Swarm の zip からチェックインのファイルを取り出して dir に置き（全部置き換え）、DB に入れ直す。地点への割り当てはしない */
export function importSwarmZip(db: DatabaseSync, dir: string, zipPath: string) {
  if (!existsSync(zipPath) || statSync(zipPath).isDirectory()) throw new Error(`${zipPath} がありません`);
  const files = readZipEntriesFromFile(zipPath, (name) => CHECKINS_RE.test(name));
  if (!files.length) throw new Error('Swarm の zip ファイル内にチェックインデータ（checkins1.json など）が見つかりませんでした。');
  const tmp = `${dir}.new`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (const f of files) writeFileSync(join(tmp, basename(f.name)), f.data);
    const stats = importSwarm(db, tmp);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return stats;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 「2026-10-04 03:37:37.000000」（UTC）→ ミリ秒 */
function utcMs(s: string): number {
  return Date.parse(`${s.slice(0, 19).replace(' ', 'T')}Z`);
}

/** dir（取り出したチェックインのファイル）のデータを DB に入れる（全部置き換える）。地点への割り当てはしない */
export function importSwarm(db: DatabaseSync, dir: string): { checkins: number; venues: number } {
  const items: any[] = [];
  for (const f of readdirSync(dir).filter((x) => CHECKINS_RE.test(x)).sort()) {
    items.push(...(JSON.parse(readFileSync(join(dir, f), 'utf8')).items ?? []));
  }
  const ins = db.prepare(
    'INSERT OR REPLACE INTO swarm_checkins (id, at_ms, tz_min, venue_id, venue_name, venue_url, lat, lng, hacc, shout, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  let checkins = 0;
  const venues = new Set<string>();
  transaction(db, () => {
    db.exec('DELETE FROM swarm_checkins');
    for (const c of items) {
      const at = utcMs(String(c.createdAt ?? ''));
      // 店のない記録や、位置のない記録は使わない
      if (!c.id || !c.venue?.name || !Number.isFinite(at) || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
      ins.run(
        c.id, at, Number.isFinite(c.timeZoneOffset) ? c.timeZoneOffset : null, c.venue.id ?? '', c.venue.name, c.venue.url ?? '',
        c.lat, c.lng, Number.isFinite(c.hacc) ? c.hacc : null, c.shout ?? '', c.event?.name ?? '',
      );
      venues.add(c.venue.id ?? c.venue.name);
      checkins++;
    }
  });
  setKv(db, loadedKey(SWARM_SOURCE), new Date().toISOString());
  return { checkins, venues: venues.size };
}

/** チェックインした時刻の、その土地の日付（YYYY-MM-DD） */
function localDate(atMs: number, tzMin: number | null): string {
  return new Date(atMs + (tzMin ?? 0) * 60_000).toISOString().slice(0, 10);
}

/**
 * 地点に Swarm のチェックインの店を割り当てる。滞在が変わると割り当ても変わるので、調べる地点があったときは全体を付け直す。
 * targets のうち付いた数を返す
 */
export function assignSwarm(db: DatabaseSync, targets: Target[]): number {
  if (!targets.length) return 0;
  const now = new Date().toISOString();
  const checkins = db.prepare('SELECT * FROM swarm_checkins ORDER BY at_ms').all() as any[];
  // 時刻が重なる滞在を探す（visits_time の索引を使う）
  const around = db.prepare('SELECT place_id, start_ms, end_ms, lat, lng FROM visits WHERE start_ms <= ? AND end_ms >= ?');

  // 場所ごとに、店（venue_id）ごとのチェックイン
  const byPlace = new Map<string, Map<string, { c: any; d: number }[]>>();
  for (const c of checkins) {
    let best: { placeId: string; d: number } | null = null;
    let inside = false;
    for (const v of around.all(c.at_ms + MARGIN_MS, c.at_ms - MARGIN_MS) as any[]) {
      const d = distM(c.lat, c.lng, v.lat, v.lng);
      const isInside = v.start_ms <= c.at_ms && c.at_ms <= v.end_ms;
      if (d > (isInside ? INSIDE_MAX_M : MARGIN_MAX_M)) continue;
      // 時刻を含む滞在を優先し、その中では近いもの
      if (!best || (isInside && !inside) || (isInside === inside && d < best.d)) {
        best = { placeId: v.place_id, d };
        inside = isInside;
      }
    }
    if (!best) continue;
    let venues = byPlace.get(best.placeId);
    if (!venues) byPlace.set(best.placeId, (venues = new Map()));
    const key = c.venue_id || c.venue_name;
    let list = venues.get(key);
    if (!list) venues.set(key, (list = []));
    list.push({ c, d: best.d });
  }

  const upsert = db.prepare(
    `INSERT INTO place_labels (place_id, source, kind, text, short_text, detail, dist_m, updated_at) VALUES (?, ?, 'name', ?, ?, ?, ?, ?)`,
  );
  transaction(db, () => {
    db.prepare('DELETE FROM place_labels WHERE source = ?').run(SWARM_SOURCE);
    for (const [placeId, venues] of byPlace) {
      // いちばん多くチェックインした店。同じ回数なら最後にチェックインした店
      const ranked = [...venues.values()].sort((a, b) => b.length - a.length || b[b.length - 1].c.at_ms - a[a.length - 1].c.at_ms);
      const top = ranked[0];
      const first = top[0].c;
      const last = top[top.length - 1].c;
      const total = ranked.reduce((n, l) => n + l.length, 0);
      const detail = {
        venueId: last.venue_id,
        url: last.venue_url,
        count: String(top.length),
        first: localDate(first.at_ms, first.tz_min),
        last: localDate(last.at_ms, last.tz_min),
        // ほかにチェックインした店（同じ建物の別の店など）
        others: ranked
          .slice(1)
          .map((l) => `${l[l.length - 1].c.venue_name}（${l.length}回）`)
          .join('、'),
        total: String(total),
        // チェックインに書いたひとこととイベントの名前（新しい順）
        shouts: [...new Set(top.map((x) => x.c.shout).filter(Boolean).reverse())].join(' / '),
        events: [...new Set(top.map((x) => x.c.event).filter(Boolean).reverse())].join('、'),
      };
      const d = Math.round(Math.min(...top.map((x) => x.d)) * 10) / 10;
      upsert.run(placeId, SWARM_SOURCE, last.venue_name, last.venue_name, JSON.stringify(detail), d, now);
    }
    markChecked(db, SWARM_SOURCE, targets, now);
  });
  return targets.filter((t) => byPlace.has(t.place_id)).length;
}

export function swarmStatus(db: DatabaseSync) {
  const r = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT venue_id) AS v FROM swarm_checkins').get() as any;
  const places = (db.prepare('SELECT COUNT(*) AS n FROM place_labels WHERE source = ?').get(SWARM_SOURCE) as any).n as number;
  return { checkins: r.n as number, venues: r.v as number, places, loadedAt: getKv(db, loadedKey(SWARM_SOURCE)) };
}

/** 取り込み画面から送られた zip（Takeout と Swarm が混ざっていてもよい）を、Swarm とそれ以外に分ける */
export function splitSwarmZips(paths: string[]): { swarm: string[]; others: string[] } {
  const zips = paths.flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.zip$/i.test(f)).map((f) => join(p, f)) : [p],
  );
  const swarm = zips.filter(isSwarmZip);
  return { swarm, others: zips.filter((z) => !swarm.includes(z)) };
}
