import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { transaction } from './tx';
import { readZipEntriesFromFile } from './zip';
import { distM, getKv, loadedKey, markChecked, setKv, type Target } from './labelstore';

// Google Takeout で書き出した、自分の Google マップのデータから地点名と住所を付ける。
// 自分のデータを書き出したものなので、Places API と違って保存してよい。
//
// 使うデータ（Takeout の zip から、必要なファイルだけを読む。日本語版・英語版のファイル名に対応）：
// - 保存した場所（マップ（マイプレイス）/保存した場所.json）：店名・住所・座標・保存日・cid・コメント
// - ラベルを付けた場所（マップ/ラベルを付けた場所/ラベル付きの場所.json）：自分で付けた名前・住所・座標
// - 保存リスト（保存済み/*.csv）：リスト名・タイトル・メモ・URL（座標はない。URL の cid で保存した場所と照らし合わせる）
//
// 作業は位置参照情報と同じく2つに分かれる：
// 1. データを入れる（import-takeout。Takeout を書き出し直したときだけ。全部置き換える）
// 2. 地点に割り当てる（タイムラインの取り込みのたびと「今すぐ調べる」。areas.ts の assignForImport から呼ぶ）
//
// 取得方法：
// - takeout-label（地点名）：ラベルを付けた場所。labelM（既定 30m）以内でいちばん近いもの
// - takeout-saved（地点名）：保存した場所。sameM（既定 2m）以内でいちばん近いもの。滞在先も保存した場所も Google の
//   「場所」の座標なので、同じ場所ならほぼ一致する（1〜15m 離れると、同じ建物の別の店も混ざる）
//   sameM 以内に滞在先がなかった保存した場所は、nearM（既定 30m）以内でいちばん近い滞在先 1 か所にだけ付ける（ほかの保存した場所が
//   付いている滞在先は使わない）。記録の位置が数 m〜数十 m ずれていることがあるため。距離を単純に広げると、1 つの店が隣の駐車場や
//   隣の店にも付いてしまうので、店の側から 1 か所だけを選ぶ
// - takeout-addr（住所）：takeout-saved と同じ保存した場所の住所（番地まである）

export const TAKEOUT_SOURCES = ['takeout-label', 'takeout-saved', 'takeout-addr'] as const;

export interface TakeoutOptions {
  /** 保存した場所を「同じ場所」とみなす距離（m） */
  sameM: number;
  /** 同じ場所の滞在先がなかった保存した場所を、いちばん近い滞在先 1 か所に付ける距離（m） */
  nearM: number;
  /** ラベルを付けた場所を割り当てる距離（m）。住所の位置にラベルを付けていることがあるので広めにとる */
  labelM: number;
}

// ---- 読み込み ----

const SAVED_RE = /(保存した場所|Saved Places)\.json$/i;
// フォルダー名は「ラベルを付けた場所」だが、ファイル名は「ラベル付きの場所.json」になっている
const LABELED_RE = /(ラベルを付けた場所|ラベル付きの場所|Labeled places)\.json$/i;
const LIST_RE = /\/(保存済み|Saved)\/[^/]+\.csv$/i;

/** RFC 4180 の CSV（引用符の中の改行も扱う） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** Google マップの URL から cid（10 進の文字列）を取り出す。「cid=123」と「!1s0x…:0x…」（後半が cid の 16 進）の両方 */
export function cidOf(url: string | undefined): string | null {
  if (!url) return null;
  const dec = /[?&]cid=(\d+)/.exec(url);
  if (dec) return dec[1];
  const hex = /(?:!1s|cid=)0x[0-9a-f]+:(0x[0-9a-f]+)/i.exec(url);
  return hex ? BigInt(hex[1]).toString() : null;
}

/** 「日本、〒100-0005 東京都千代田区…」→ 全体「東京都千代田区…」と、都道府県を除いた短い表記 */
function splitAddress(address: string): { text: string; shortText: string } {
  let text = address.replace(/^日本、\s*/, '').replace(/^〒?\d{3}-\d{4}\s*/, '').trim();
  // 一部は小さい順の書式（「〇〇ビル 2F, １丁目−１−１ 丸の内 千代田区 東京都 100-0005 日本」）なので、
  // 最後の部分を大きい順に並べ替え、その前の部分（建物名など。ローマ字だけのものは省く）を後ろに添える
  if (/\s日本$/.test(text)) {
    const body = text.replace(/\s*日本$/, '').replace(/\s*\d{3}-\d{4}$/, '');
    const parts = body.split(/,\s*/);
    const main = parts.pop()!.split(/\s+/).reverse().join('');
    const extra = parts.filter((p) => !/^[\x20-\x7e]+$/.test(p)).join(' ');
    text = extra ? `${main} ${extra}` : main;
  }
  const shortText = text.replace(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/, '');
  return { text, shortText: shortText || text };
}

interface TakeoutFiles {
  saved: any[];
  labeled: any[];
  lists: { list: string; title: string; memo: string; url: string; comment: string }[];
}

/** Takeout の zip（複数可。フォルダーを渡すと中の zip 全部）から、必要なファイルだけを読む */
function readTakeout(paths: string[]): TakeoutFiles {
  const zips = paths.flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.zip$/i.test(f)).map((f) => join(p, f)) : [p],
  );
  const out: TakeoutFiles = { saved: [], labeled: [], lists: [] };
  for (const zip of zips) {
    for (const e of readZipEntriesFromFile(zip, (n) => SAVED_RE.test(n) || LABELED_RE.test(n) || LIST_RE.test(n))) {
      const text = e.data.toString('utf8');
      if (SAVED_RE.test(e.name)) out.saved.push(...(JSON.parse(text).features ?? []));
      else if (LABELED_RE.test(e.name)) out.labeled.push(...(JSON.parse(text).features ?? []));
      else {
        // 「デフォルト リスト(1).csv」のような重複は同じリストとして扱う
        const list = basename(e.name).replace(/\.csv$/i, '').replace(/\(\d+\)$/, '').trim();
        const rows = parseCsv(text);
        // リストに説明文があると、見出しの前に説明の行と空行が入る。「URL」の列がある行を見出しとする
        const headerIndex = rows.findIndex((r) => r.some((c) => c.trim() === 'URL'));
        if (headerIndex < 0) continue;
        const header = rows[headerIndex];
        const col = (...names: string[]) => header.findIndex((h) => names.includes(h.trim()));
        const ci = { title: col('タイトル', 'Title'), memo: col('メモ', 'Note'), url: col('URL'), comment: col('コメント', 'Comment') };
        for (const r of rows.slice(headerIndex + 1)) {
          const url = r[ci.url] ?? '';
          if (!url) continue;
          out.lists.push({ list, title: r[ci.title] ?? '', memo: r[ci.memo] ?? '', url, comment: r[ci.comment] ?? '' });
        }
      }
    }
  }
  return out;
}

/** Takeout のデータを入れる（全部置き換える）。地点への割り当てはしない */
export function importTakeout(db: DatabaseSync, paths: string[]): { saved: number; labeled: number; listEntries: number; lists: string[] } {
  for (const p of paths) if (!existsSync(p)) throw new Error(`${p} がありません`);
  const t = readTakeout(paths);
  if (!t.saved.length && !t.labeled.length && !t.lists.length) {
    throw new Error('Takeout の zip から「保存した場所」「ラベルを付けた場所」「保存済み」のどれも見つかりませんでした（Google マップのデータを含めて書き出したか確かめてください）');
  }
  const insPlace = db.prepare(
    'INSERT INTO takeout_places (kind, cid, name, address, lat, lng, saved_at, comment, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insList = db.prepare('INSERT INTO takeout_lists (cid, list, title, memo, comment, url) VALUES (?, ?, ?, ?, ?, ?)');
  let saved = 0;
  let labeled = 0;
  transaction(db, () => {
    db.exec('DELETE FROM takeout_places; DELETE FROM takeout_lists;');
    for (const f of t.saved) {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      const loc = f.properties?.location;
      // 座標や名前のない保存（地図上の任意の地点など）は使わない
      if (!loc?.name || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
      const url = f.properties.google_maps_url ?? '';
      insPlace.run('saved', cidOf(url), loc.name, loc.address ?? '', lat, lng, f.properties.date ?? null, f.properties.Comment ?? '', url);
      saved++;
    }
    for (const f of t.labeled) {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      const name = f.properties?.name;
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      insPlace.run('labeled', null, name, f.properties.address ?? '', lat, lng, null, '', '');
      labeled++;
    }
    for (const l of t.lists) insList.run(cidOf(l.url), l.list, l.title, l.memo, l.comment, l.url);
  });
  const now = new Date().toISOString();
  for (const s of TAKEOUT_SOURCES) setKv(db, loadedKey(s), now);
  return { saved, labeled, listEntries: t.lists.length, lists: [...new Set(t.lists.map((l) => l.list))] };
}

// ---- 割り当て ----

/** 地点に Takeout のラベル・保存した場所を割り当てる。取得方法ごとの付いた数を返す */
export function assignTakeout(
  db: DatabaseSync,
  targets: Record<(typeof TAKEOUT_SOURCES)[number], Target[]>,
  opts: TakeoutOptions,
): Record<(typeof TAKEOUT_SOURCES)[number], number> {
  const result = { 'takeout-label': 0, 'takeout-saved': 0, 'takeout-addr': 0 };
  const count = (db.prepare('SELECT COUNT(*) AS n FROM takeout_places').get() as any).n as number;
  if (!count) return result;
  const near = db.prepare('SELECT * FROM takeout_places WHERE kind = ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
  const listsOf = db.prepare('SELECT DISTINCT list FROM takeout_lists WHERE cid = ? ORDER BY list');
  const upsert = db.prepare(
    `INSERT INTO place_labels (place_id, source, kind, text, short_text, detail, dist_m, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(place_id, source) DO UPDATE SET kind = excluded.kind, text = excluded.text, short_text = excluded.short_text,
       detail = excluded.detail, dist_m = excluded.dist_m, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare('DELETE FROM place_labels WHERE place_id = ? AND source = ?');
  const now = new Date().toISOString();

  /** 保存した場所を、地点名（takeout-saved）か住所（takeout-addr）として付ける。住所のない場所には住所を付けない */
  const putSaved = (placeId: string, source: 'takeout-saved' | 'takeout-addr', r: any, d: number): boolean => {
    if (source === 'takeout-addr' && !r.address) return false;
    if (source === 'takeout-saved') {
      const lists = r.cid ? (listsOf.all(r.cid) as any[]).map((x) => x.list) : [];
      const detail = { cid: r.cid ?? '', url: r.url, savedAt: r.saved_at ?? '', comment: r.comment, lists: lists.join('、'), address: r.address };
      upsert.run(placeId, source, 'name', r.name, r.name, JSON.stringify(detail), d, now);
    } else {
      const a = splitAddress(r.address);
      upsert.run(placeId, source, 'address', a.text, a.shortText, JSON.stringify({ address: r.address }), d, now);
    }
    return true;
  };

  const nearest = (kind: string, t: Target, maxM: number) => {
    const dLat = maxM / 111_320;
    const dLng = dLat / Math.cos((t.lat * Math.PI) / 180);
    let best: any = null;
    let bestD = Infinity;
    for (const r of near.all(kind, t.lat - dLat, t.lat + dLat, t.lng - dLng, t.lng + dLng) as any[]) {
      const d = distM(t.lat, t.lng, r.lat, r.lng);
      if (d <= maxM && d < bestD) [best, bestD] = [r, d];
    }
    return best ? { r: best, d: Math.round(bestD * 10) / 10 } : null;
  };

  transaction(db, () => {
    for (const t of targets['takeout-label']) {
      const m = nearest('labeled', t, opts.labelM);
      if (m) {
        upsert.run(t.place_id, 'takeout-label', 'name', m.r.name, m.r.name, JSON.stringify({ address: m.r.address }), m.d, now);
        result['takeout-label']++;
      } else remove.run(t.place_id, 'takeout-label');
    }
    markChecked(db, 'takeout-label', targets['takeout-label'], now);

    // 保存した場所は、地点名（takeout-saved）と住所（takeout-addr）の両方に使う
    for (const source of ['takeout-saved', 'takeout-addr'] as const) {
      for (const t of targets[source]) {
        const m = nearest('saved', t, opts.sameM);
        if (m && putSaved(t.place_id, source, m.r, m.d)) result[source]++;
        else remove.run(t.place_id, source);
      }
      markChecked(db, source, targets[source], now);
    }

    // 同じ場所の滞在先がなかった保存した場所を、いちばん近い滞在先 1 か所に付ける。新しい滞在先のほうが近いこともあるので、
    // 調べる地点があったときは全体を付け直す
    if (targets['takeout-saved'].length || targets['takeout-addr'].length) {
      const near = assignSavedNear(db, opts, putSaved);
      for (const source of ['takeout-saved', 'takeout-addr'] as const) {
        const ids = new Set(targets[source].map((t) => t.place_id));
        result[source] += near.filter((n) => ids.has(n.placeId) && n.sources.includes(source)).length;
      }
    }
  });
  return result;
}

/**
 * sameM 以内に滞在先がない保存した場所を、nearM 以内でいちばん近い滞在先 1 か所に付ける（付け直す）。
 * ほかの保存した場所が付いている滞在先は使わない。2 つの店が同じ滞在先を選んだときは近いほうに付ける
 */
function assignSavedNear(
  db: DatabaseSync,
  opts: TakeoutOptions,
  putSaved: (placeId: string, source: 'takeout-saved' | 'takeout-addr', r: any, d: number) => boolean,
): { placeId: string; sources: string[] }[] {
  // 前に付けた分は消して、全体を付け直す
  db.prepare("DELETE FROM place_labels WHERE source IN ('takeout-saved', 'takeout-addr') AND dist_m > ?").run(opts.sameM);
  if (opts.nearM <= opts.sameM) return [];
  const taken = new Set((db.prepare("SELECT place_id FROM place_labels WHERE source = 'takeout-saved'").all() as any[]).map((r) => r.place_id as string));
  const placesIn = db.prepare('SELECT place_id, lat, lng FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
  const cands: { r: any; placeId: string; d: number }[] = [];
  for (const r of db.prepare("SELECT * FROM takeout_places WHERE kind = 'saved'").all() as any[]) {
    const dLat = opts.nearM / 111_320;
    const dLng = dLat / Math.cos((r.lat * Math.PI) / 180);
    let best: string | null = null;
    let bestD = Infinity;
    let same = false;
    for (const p of placesIn.all(r.lat - dLat, r.lat + dLat, r.lng - dLng, r.lng + dLng) as any[]) {
      const d = distM(r.lat, r.lng, p.lat, p.lng);
      if (d <= opts.sameM) {
        // 同じ場所の滞在先がある（そちらで付いている）
        same = true;
        break;
      }
      if (d <= opts.nearM && d < bestD && !taken.has(p.place_id)) [best, bestD] = [p.place_id, d];
    }
    if (!same && best) cands.push({ r, placeId: best, d: Math.round(bestD * 10) / 10 });
  }
  cands.sort((a, b) => a.d - b.d);
  const done: { placeId: string; sources: string[] }[] = [];
  for (const c of cands) {
    if (taken.has(c.placeId)) continue;
    taken.add(c.placeId);
    const sources = (['takeout-saved', 'takeout-addr'] as const).filter((source) => putSaved(c.placeId, source, c.r, c.d));
    done.push({ placeId: c.placeId, sources });
  }
  return done;
}

export function takeoutStatus(db: DatabaseSync): { saved: number; labeled: number; listEntries: number; loadedAt: string | null } {
  const n = (sql: string) => (db.prepare(sql).get() as any).n as number;
  const loadedAt = getKv(db, loadedKey('takeout-saved'));
  return {
    saved: n("SELECT COUNT(*) AS n FROM takeout_places WHERE kind = 'saved'"),
    labeled: n("SELECT COUNT(*) AS n FROM takeout_places WHERE kind = 'labeled'"),
    listEntries: n('SELECT COUNT(*) AS n FROM takeout_lists'),
    loadedAt,
  };
}
