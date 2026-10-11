import type { DatabaseSync } from 'node:sqlite';

// 住所・地点名（place_labels）と、調べた記録（label_checks）、データを入れた日時（kv）を扱う共通の関数。
// 位置参照情報（areas.ts）と OpenStreetMap の施設（osmpoi.ts）で使う。

/** 数 km 以内の距離（m）。この用途では平面近似で十分 */
export function distM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y) * 111_320;
}

export interface Target {
  place_id: string;
  lat: number;
  lng: number;
}

/** place_labels に1件書く文（住所の取得方法用。kind は address） */
export function upsertLabel(db: DatabaseSync) {
  return db.prepare(
    `INSERT INTO place_labels (place_id, source, kind, text, short_text, detail, dist_m, updated_at) VALUES (?, ?, 'address', ?, ?, ?, ?, ?)
     ON CONFLICT(place_id, source) DO UPDATE SET text = excluded.text, short_text = excluded.short_text,
       detail = excluded.detail, dist_m = excluded.dist_m, updated_at = excluded.updated_at`,
  );
}

/** 全員で使う参照データ（data/shared.sqlite）を使う取得方法。入れた日時は shared_kv に、ほかは利用者の DB の kv に記録する */
const SHARED_SOURCES = ['isj-oaza', 'isj-gaiku', 'osm-poi'];

/** データ（位置参照情報・OSM の施設・Takeout）を入れた日時を記録する kv のキー */
export const loadedKey = (source: string) => `${source}:loaded_at`;

/** データの件数を記録する kv のキー（数えるのに大きな表を全部読むことになるので、入れたときに数えておく） */
export const countsKey = (source: string) => `${source}:counts`;

const kvTable = (key: string) => (SHARED_SOURCES.some((s) => key === loadedKey(s) || key === countsKey(s)) ? 'shared_kv' : 'kv');

export function getKv(db: DatabaseSync, key: string): string | null {
  return ((db.prepare(`SELECT value FROM ${kvTable(key)} WHERE key = ?`).get(key) as any)?.value as string) ?? null;
}

export function setKv(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO ${kvTable(key)} (key, value) VALUES (?, ?)`).run(key, value);
}
/** 調べたこと（見つからなかった場合も）を記録する */
export function markChecked(db: DatabaseSync, source: string, targets: Target[], at: string): void {
  const stmt = db.prepare(
    'INSERT INTO label_checks (place_id, source, checked_at) VALUES (?, ?, ?) ON CONFLICT(place_id, source) DO UPDATE SET checked_at = excluded.checked_at',
  );
  for (const t of targets) stmt.run(t.place_id, source, at);
}

/** まだ調べていないか、データを入れ直したあとに調べ直していない地点 */
export function pendingTargets(db: DatabaseSync, source: string): Target[] {
  const loadedAt = getKv(db, loadedKey(source));
  if (!loadedAt) return [];
  return db
    .prepare(
      `SELECT p.place_id, p.lat, p.lng FROM places p
       LEFT JOIN label_checks c ON c.place_id = p.place_id AND c.source = ?
       WHERE c.place_id IS NULL OR c.checked_at < ?`,
    )
    .all(source, loadedAt) as unknown as Target[];
}
