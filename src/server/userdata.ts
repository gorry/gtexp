import type { DatabaseSync } from 'node:sqlite';
import { normalizeTag } from './db';
import { transaction } from './tx';

// 自分で付けた名前・メモ・タグ（place_notes）とブックマーク（bookmarks）の書き出し・読み込み・削除（取り込みの画面）。
// 書き出しは JSON。読み込みは足し合わせる（同じ場所の名前・メモ・タグは置き換え、同じ画面のブックマークは名前だけ置き換え、
// 新しいブックマークは今の一覧の後ろに、ファイルの並びのまま足す）

/** 書き出したファイルの印（ほかのファイルを読み込まないため） */
export const USERDATA_FORMAT = 'gtexp-userdata';
const USERDATA_VERSION = 1;

export interface UserDataFile {
  format: typeof USERDATA_FORMAT;
  version: number;
  exportedAt: string;
  notes: { placeId: string; name: string; memo: string; tags: string[]; updatedAt: string }[];
  /** 並べた順 */
  bookmarks: { hash: string; title: string; createdAt: string }[];
}

export function userDataStatus(db: DatabaseSync): { notes: number; bookmarks: number } {
  const n = (sql: string) => (db.prepare(sql).get() as any).n as number;
  return { notes: n('SELECT COUNT(*) AS n FROM place_notes'), bookmarks: n('SELECT COUNT(*) AS n FROM bookmarks') };
}

export function exportUserData(db: DatabaseSync): UserDataFile {
  return {
    format: USERDATA_FORMAT,
    version: USERDATA_VERSION,
    exportedAt: new Date().toISOString(),
    notes: (db.prepare('SELECT * FROM place_notes ORDER BY place_id').all() as any[]).map((r) => ({
      placeId: r.place_id,
      name: r.name,
      memo: r.memo,
      tags: JSON.parse(r.tags || '[]'),
      updatedAt: r.updated_at,
    })),
    bookmarks: (db.prepare('SELECT * FROM bookmarks ORDER BY position, id DESC').all() as any[]).map((r) => ({
      hash: r.hash,
      title: r.title,
      createdAt: r.created_at,
    })),
  };
}

const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const isoOr = (v: unknown, fallback: string) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);

/** 読み込む。形が違うときは Error（文言はそのまま画面に出す）。読み込んだ数を返す */
export function importUserData(db: DatabaseSync, data: any): { notes: number; bookmarks: number } {
  if (data?.format !== USERDATA_FORMAT || !Array.isArray(data.notes) || !Array.isArray(data.bookmarks)) {
    throw new Error('gtexp で書き出した名前・メモ・タグとブックマークのファイルではありません。「書き出す」で保存したファイルを選んでください。');
  }
  const now = new Date().toISOString();
  const upsertNote = db.prepare(
    `INSERT INTO place_notes (place_id, name, memo, tags, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(place_id) DO UPDATE SET name = excluded.name, memo = excluded.memo, tags = excluded.tags, updated_at = excluded.updated_at`,
  );
  const findBookmark = db.prepare('SELECT id FROM bookmarks WHERE hash = ?');
  const renameBookmark = db.prepare('UPDATE bookmarks SET title = ? WHERE hash = ?');
  const insBookmark = db.prepare('INSERT INTO bookmarks (hash, title, created_at, position) VALUES (?, ?, ?, ?)');
  let notes = 0;
  let bookmarks = 0;
  transaction(db, () => {
    for (const n of data.notes) {
      const placeId = str(n?.placeId, 300);
      if (!placeId) continue;
      // 画面から保存するときと同じ決まり（名前 200 文字・メモ 5,000 文字・タグ 50 個まで）
      const tags = Array.isArray(n.tags) ? [...new Set(n.tags.map((t: unknown) => normalizeTag(String(t))).filter(Boolean))].slice(0, 50) : [];
      upsertNote.run(placeId, str(n.name, 200), str(n.memo, 5000), JSON.stringify(tags), isoOr(n.updatedAt, now));
      notes++;
    }
    let position = ((db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM bookmarks').get() as any).p as number) + 1;
    for (const b of data.bookmarks) {
      const hash = str(b?.hash, 2000);
      if (!/^#\/[^\s]*$/.test(hash)) continue;
      const title = str(b.title, 200).replace(/\s+/g, ' ').trim() || hash;
      if (findBookmark.get(hash)) renameBookmark.run(title, hash);
      else insBookmark.run(hash, title, isoOr(b.createdAt, now), position++);
      bookmarks++;
    }
  });
  return { notes, bookmarks };
}

export function deleteUserData(db: DatabaseSync): void {
  transaction(db, () => db.exec('DELETE FROM place_notes; DELETE FROM bookmarks;'));
}
