import type { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { transaction } from './tx';
import { readZip, readZipEntriesFromFile, USER_ZIP_ENTRY_MAX, type InflateBudget } from './zip';
import { distM, getKv, loadedKey, markChecked, setKv, type Target } from './labelstore';

// Google Takeout で書き出した、自分の Google マップのデータから地点名と住所を付ける。
// 自分のデータを書き出したものなので、Places API と違って保存してよい。
//
// 使うデータ（Takeout の zip から、必要なファイルだけを読む。日本語版・英語版のファイル名に対応）：
// - 保存した場所（マップ（マイプレイス）/保存した場所.json）：店名・住所・座標・保存日・cid・コメント
// - ラベルを付けた場所（マップ/ラベルを付けた場所/ラベル付きの場所.json）：自分で付けた名前・住所・座標
// - 保存リスト（保存済み/*.csv）：リスト名・タイトル・メモ・URL（座標はない。URL の cid で保存した場所と照らし合わせる）
// - クチコミ（マップ（マイプレイス）/クチコミ.json）：自分がクチコミを書いた店。保存した場所と同じ形
// - マイマップ（マイマップ/*.kmz）：自分で作った地図の地点（名前・メモ・座標）。経路の線と、名前が時刻だけの記録の点（位置のログ）は除く
//
// 作業は位置参照情報と同じく2つに分かれる：
// 1. データを入れる（Takeout を書き出し直したときだけ。画面から zip を送るか、管理者が import-takeout で）。zip は残さず、
//    使うファイルだけを取り出して利用者のフォルダーの takeout/ に置き（種類ごとに置き換え）、そこから DB に入れ直す
// 2. 地点に割り当てる（タイムラインの取り込みのたびと「今すぐ照合する」。areas.ts の assignForImport から呼ぶ）
//
// 取得方法：
// - takeout-label（地点名）：ラベルを付けた場所。labelM（既定 30m）以内でいちばん近いもの
// - takeout-saved（地点名）：保存した場所。sameM（既定 2m）以内でいちばん近いもの。滞在先も保存した場所も Google の
//   「場所」の座標なので、同じ場所ならほぼ一致する（1〜15m 離れると、同じ建物の別の店も混ざる）
//   sameM 以内に滞在先がなかった保存した場所は、nearM（既定 30m）以内でいちばん近い滞在先 1 か所にだけ付ける（ほかの保存した場所が
//   付いている滞在先は使わない）。記録の位置が数 m〜数十 m ずれていることがあるため。距離を単純に広げると、1 つの店が隣の駐車場や
//   隣の店にも付いてしまうので、店の側から 1 か所だけを選ぶ
// - takeout-addr（住所）：takeout-saved と同じ保存した場所の住所（番地まである）
// - takeout-review（地点名）：クチコミを書いた店。店の側から nearM 以内でいちばん近い滞在先 1 か所に付ける
// - takeout-mymap（地点名）：マイマップの地点。地点の側から labelM 以内でいちばん近い滞在先 1 か所に付ける

export const TAKEOUT_SOURCES = ['takeout-label', 'takeout-saved', 'takeout-addr', 'takeout-review', 'takeout-mymap'] as const;

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
const REVIEW_RE = /(クチコミ|Reviews)\.json$/i;
const MYMAP_RE = /\/(マイマップ|My Maps)\/[^/]+\.kmz$/i;

/** KML の文字（CDATA と文字参照）を素の文字列にする */
function kmlText(s: string | undefined): string {
  if (!s) return '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1].trim();
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

export interface MyMapPoint {
  map: string;
  folder: string;
  name: string;
  memo: string;
  url: string;
  lat: number | null;
  lng: number | null;
}

/**
 * マイマップの KML から地点を取り出す。座標は Point か、URL（/maps/search/緯度,経度）から。どちらもない地点は座標なしで残す
 * （URL の cid で保存した場所と照らし合わせられることがある）。経路の線・面と、名前が時刻だけの点（位置のログ）は除く
 */
export function parseMyMap(kml: string, map: string): MyMapPoint[] {
  const out: MyMapPoint[] = [];
  const folders: string[] = [];
  const re = /<Folder\b[^>]*>|<\/Folder>|<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g;
  for (let m; (m = re.exec(kml)); ) {
    if (m[0].startsWith('<Folder')) {
      folders.push(kmlText(/^\s*<name>([\s\S]*?)<\/name>/.exec(kml.slice(re.lastIndex))?.[1]));
      continue;
    }
    if (m[0] === '</Folder>') {
      folders.pop();
      continue;
    }
    const body = m[1];
    const name = kmlText(/<name>([\s\S]*?)<\/name>/.exec(body)?.[1]);
    const data = new Map<string, string>();
    for (const d of body.matchAll(/<Data name="([^"]*)">\s*<value>([\s\S]*?)<\/value>/g)) data.set(d[1], kmlText(d[2]));
    const description = kmlText(/<description>([\s\S]*?)<\/description>/.exec(body)?.[1]);
    const point = /<Point>[\s\S]*?<coordinates>\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(body);
    const url = data.get('URL') ?? data.get('Google Maps URL') ?? '';
    const pin = /\/maps\/search\/(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(url);
    // 経路の線・面（点の座標がなく、URL もない）は使わない
    if (!point && !url) continue;
    // 位置のログ（名前が「10:17:23」「#1 10:25:10」のような時刻だけか、説明に経度・緯度が書いてある）は地点ではない
    if (/^(#\d+\s+)?\d{1,2}:\d{2}(:\d{2})?$/.test(name) || /Longitude:[\s\S]*Latitude:/.test(description)) continue;
    const [lat, lng] = point ? [Number(point[2]), Number(point[1])] : pin ? [Number(pin[1]), Number(pin[2])] : [null, null];
    // メモは決まった項目だけ（ほかの項目には書き出した人のメールアドレスなどが入っていることがある）
    const memo = data.get('メモ') ?? data.get('説明') ?? data.get('Description') ?? (data.size ? '' : description.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''));
    // フォルダー（レイヤー）の名前。既定の名前と、地図と同じ名前は意味がないので出さない
    const folder = folders.filter((x) => x && x !== map && !/^(無題のレイヤ|Untitled layer)/i.test(x)).join(' / ');
    out.push({ map, folder, name, memo: memo.slice(0, 1000), url, lat, lng });
  }
  return out;
}

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

/** 種類ごとの、取り出したファイルの置き場所（利用者のフォルダーの takeout/ の下） */
export const TAKEOUT_KINDS = ['saved', 'labeled', 'lists', 'reviews', 'mymaps'] as const;
export type TakeoutKind = (typeof TAKEOUT_KINDS)[number];
const KIND_EXT: Record<TakeoutKind, string> = { saved: '.json', labeled: '.json', lists: '.csv', reviews: '.json', mymaps: '.kml' };
/** ファイル名に意味がある（保存リストの名前・地図の名前）ので、名前を残して置く種類 */
const NAMED_KINDS: TakeoutKind[] = ['lists', 'mymaps'];

/** zip から取り出したファイル。zip に入っていた種類だけを持つ */
type TakeoutExtract = Partial<Record<TakeoutKind, { name: string; data: Buffer }[]>>;

/** Takeout の zip（複数可。フォルダーを渡すと中の zip 全部）から、使うファイルだけを取り出す（写真などは読まない） */
/** budget：取り込み全体で展開してよい量の残り（画面から送られた zip のとき。サーバーのコマンドでは省く） */
export function extractTakeout(paths: string[], budget?: InflateBudget): TakeoutExtract {
  for (const p of paths) if (!existsSync(p)) throw new Error(`${p} がありません`);
  const zips = paths.flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.zip$/i.test(f)).map((f) => join(p, f)) : [p],
  );
  const out: TakeoutExtract = {};
  for (const zip of zips) {
    for (const e of readZipEntriesFromFile(zip, (n) => [SAVED_RE, LABELED_RE, LIST_RE, REVIEW_RE, MYMAP_RE].some((re) => re.test(n)), USER_ZIP_ENTRY_MAX, budget)) {
      const kind: TakeoutKind = SAVED_RE.test(e.name)
        ? 'saved'
        : LABELED_RE.test(e.name)
          ? 'labeled'
          : REVIEW_RE.test(e.name)
            ? 'reviews'
            : MYMAP_RE.test(e.name)
              ? 'mymaps'
              : 'lists';
      if (kind === 'mymaps') {
        // kmz は zip の中の zip。中の KML だけを取り出して置く（アイコンの画像などは使わない）
        const kml = readZip(e.data, USER_ZIP_ENTRY_MAX, budget).find((x) => /\.kml$/i.test(x.name));
        if (kml) (out.mymaps ??= []).push({ name: basename(e.name).replace(/\.kmz$/i, '.kml'), data: kml.data });
        continue;
      }
      (out[kind] ??= []).push({ name: basename(e.name), data: e.data });
    }
  }
  if (!Object.keys(out).length) {
    throw new Error('Takeout の zip ファイル内に Google マップのデータが見つかりませんでした（「マップ」「マップ（マイプレイス）」「保存済み」「マイマップ」を含めてエクスポートしたか確認してください）。');
  }
  return out;
}

/**
 * 取り出したファイルを dir（利用者のフォルダーの takeout/）に置く。zip に入っていた種類だけを置き換え、
 * 入っていなかった種類は前のまま残す（書き出しが複数の zip に分かれていて、一部だけ送られたときに消さないため）。
 * 置き換えた種類を返す
 */
export function storeTakeout(dir: string, ex: TakeoutExtract): TakeoutKind[] {
  const replaced = TAKEOUT_KINDS.filter((k) => ex[k]);
  for (const kind of replaced) {
    const sub = join(dir, kind);
    rmSync(sub, { recursive: true, force: true });
    mkdirSync(sub, { recursive: true });
    const used = new Set<string>();
    ex[kind]!.forEach((f, i) => {
      // 保存リスト・マイマップのファイル名はリスト・地図の名前なので残す（同じ名前が重なったら「(2)」を付ける。保存リストは読むときに同じリストになる）
      const base = NAMED_KINDS.includes(kind) ? f.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') : `${String(i + 1).padStart(2, '0')}${KIND_EXT[kind]}`;
      let name = base;
      for (let n = 2; used.has(name); n++) name = base.replace(/(\.[a-z]+)?$/i, `(${n})$1`);
      used.add(name);
      writeFileSync(join(sub, name), f.data);
    });
  }
  return replaced;
}

interface TakeoutFiles {
  saved: any[];
  labeled: any[];
  lists: { list: string; title: string; memo: string; url: string; comment: string }[];
  reviews: any[];
  mymaps: MyMapPoint[];
}

/** dir（storeTakeout で置いたフォルダー）のファイルを読む */
function readTakeoutDir(dir: string): TakeoutFiles {
  const files = (kind: TakeoutKind) => {
    const sub = join(dir, kind);
    return existsSync(sub) ? readdirSync(sub).sort().map((f) => ({ name: f, text: readFileSync(join(sub, f), 'utf8') })) : [];
  };
  const out: TakeoutFiles = { saved: [], labeled: [], lists: [], reviews: [], mymaps: [] };
  for (const f of files('saved')) out.saved.push(...(JSON.parse(f.text).features ?? []));
  for (const f of files('labeled')) out.labeled.push(...(JSON.parse(f.text).features ?? []));
  for (const f of files('reviews')) out.reviews.push(...(JSON.parse(f.text).features ?? []));
  for (const f of files('mymaps')) out.mymaps.push(...parseMyMap(f.text, f.name.replace(/\.kml$/i, '')));
  for (const f of files('lists')) {
    // 「デフォルト リスト(1).csv」のような重複は同じリストとして扱う
    const list = f.name.replace(/\.csv$/i, '').replace(/\(\d+\)$/, '').trim();
    const rows = parseCsv(f.text);
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
  return out;
}

/**
 * Takeout の zip から使うファイルを取り出して dir に置き（入っていた種類だけ置き換え）、dir のファイル全体から DB に入れ直す。
 * 地点への割り当てはしない。途中で失敗したら dir も DB も元のまま
 */
export function importTakeoutZips(db: DatabaseSync, dir: string, zipPaths: string[], budget?: InflateBudget) {
  const ex = extractTakeout(zipPaths, budget);
  const tmp = `${dir}.new`;
  rmSync(tmp, { recursive: true, force: true });
  if (existsSync(dir)) cpSync(dir, tmp, { recursive: true });
  else mkdirSync(tmp, { recursive: true });
  try {
    const replaced = storeTakeout(tmp, ex);
    const stats = importTakeout(db, tmp);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { ...stats, replaced };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** dir（storeTakeout で置いたフォルダー）のデータを DB に入れる（全部置き換える）。地点への割り当てはしない */
export function importTakeout(
  db: DatabaseSync,
  dir: string,
): { saved: number; labeled: number; listEntries: number; lists: string[]; reviews: number; mymaps: number; mymapPoints: number } {
  const t = readTakeoutDir(dir);
  const insPlace = db.prepare(
    'INSERT INTO takeout_places (kind, cid, name, address, lat, lng, saved_at, comment, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insList = db.prepare('INSERT INTO takeout_lists (cid, list, title, memo, comment, url) VALUES (?, ?, ?, ?, ?, ?)');
  const insMyMap = db.prepare('INSERT INTO takeout_mymaps (map, folder, name, memo, url, cid, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let saved = 0;
  let labeled = 0;
  let reviews = 0;
  transaction(db, () => {
    db.exec('DELETE FROM takeout_places; DELETE FROM takeout_lists; DELETE FROM takeout_mymaps;');
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
    for (const f of t.reviews) {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      const loc = f.properties?.location;
      if (!loc?.name || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
      const url = f.properties.google_maps_url ?? '';
      // コメントの列に、評価（5 段階）とクチコミの本文を入れる
      const rating = f.properties.five_star_rating_published;
      const text = String(f.properties.review_text_published ?? f.properties.Comment ?? '');
      const comment = [rating ? `★${rating}` : '', text].filter(Boolean).join(' ');
      insPlace.run('review', cidOf(url), loc.name, loc.address ?? '', lat, lng, f.properties.date ?? null, comment, url);
      reviews++;
    }
    for (const p of t.mymaps) insMyMap.run(p.map, p.folder, p.name, p.memo, p.url, cidOf(p.url), p.lat, p.lng);
  });
  const now = new Date().toISOString();
  for (const s of TAKEOUT_SOURCES) setKv(db, loadedKey(s), now);
  return {
    saved,
    labeled,
    listEntries: t.lists.length,
    lists: [...new Set(t.lists.map((l) => l.list))],
    reviews,
    mymaps: new Set(t.mymaps.map((p) => p.map)).size,
    mymapPoints: t.mymaps.length,
  };
}

// ---- 割り当て ----

/** 地点に Takeout のラベル・保存した場所・クチコミ・マイマップを割り当てる。取得方法ごとの付いた数を返す */
export function assignTakeout(
  db: DatabaseSync,
  targets: Record<(typeof TAKEOUT_SOURCES)[number], Target[]>,
  opts: TakeoutOptions,
): Record<(typeof TAKEOUT_SOURCES)[number], number> {
  const result = { 'takeout-label': 0, 'takeout-saved': 0, 'takeout-addr': 0, 'takeout-review': 0, 'takeout-mymap': 0 };
  const count = (db.prepare('SELECT (SELECT COUNT(*) FROM takeout_places) + (SELECT COUNT(*) FROM takeout_mymaps) AS n').get() as any).n as number;
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

    // クチコミとマイマップは、店・地点の側から 1 か所を選ぶ。調べる地点があったときは全体を付け直す
    const countIn = (source: (typeof TAKEOUT_SOURCES)[number], done: Set<string>) => targets[source].filter((t) => done.has(t.place_id)).length;
    if (targets['takeout-review'].length) {
      const rows = db.prepare("SELECT * FROM takeout_places WHERE kind = 'review'").all() as any[];
      const done = assignFromPoints(db, 'takeout-review', rows, opts.nearM, (placeId, r, d) => {
        const detail = { cid: r.cid ?? '', url: r.url, date: r.saved_at ?? '', review: r.comment, address: r.address };
        upsert.run(placeId, 'takeout-review', 'name', r.name, r.name, JSON.stringify(detail), d, now);
      });
      result['takeout-review'] = countIn('takeout-review', done);
    }
    markChecked(db, 'takeout-review', targets['takeout-review'], now);
    if (targets['takeout-mymap'].length) {
      // 名前が座標だけの地点（「36°48'51.1"N 139°14'42.1"E」など）は、地点名にならないので使わない
      const rows = (db.prepare("SELECT * FROM takeout_mymaps WHERE lat IS NOT NULL AND name != ''").all() as any[]).filter(
        (r) => !/^-?\d+(\.\d+)?°|^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(r.name),
      );
      const done = assignFromPoints(db, 'takeout-mymap', rows, opts.labelM, (placeId, r, d) => {
        const detail = { map: r.map, folder: r.folder, memo: r.memo, url: r.url };
        upsert.run(placeId, 'takeout-mymap', 'name', r.name, r.name, JSON.stringify(detail), d, now);
      });
      result['takeout-mymap'] = countIn('takeout-mymap', done);
    }
    markChecked(db, 'takeout-mymap', targets['takeout-mymap'], now);
  });
  return result;
}

/**
 * 店や地点（rows。lat・lng を持つ）の側から、maxM 以内でいちばん近い滞在先 1 か所を選んで付ける（source の分を全部付け直す）。
 * 1 つの店が隣の滞在先にも付いてしまわないようにするため。2 つが同じ滞在先を選んだときは近いほう。付けた滞在先を返す
 */
function assignFromPoints(
  db: DatabaseSync,
  source: string,
  rows: any[],
  maxM: number,
  put: (placeId: string, r: any, d: number) => void,
): Set<string> {
  db.prepare('DELETE FROM place_labels WHERE source = ?').run(source);
  const placesIn = db.prepare('SELECT place_id, lat, lng FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
  const cands: { r: any; placeId: string; d: number }[] = [];
  for (const r of rows) {
    const dLat = maxM / 111_320;
    const dLng = dLat / Math.cos((r.lat * Math.PI) / 180);
    let best: string | null = null;
    let bestD = Infinity;
    for (const p of placesIn.all(r.lat - dLat, r.lat + dLat, r.lng - dLng, r.lng + dLng) as any[]) {
      const d = distM(r.lat, r.lng, p.lat, p.lng);
      if (d <= maxM && d < bestD) [best, bestD] = [p.place_id, d];
    }
    if (best) cands.push({ r, placeId: best, d: Math.round(bestD * 10) / 10 });
  }
  cands.sort((a, b) => a.d - b.d);
  const done = new Set<string>();
  for (const c of cands) {
    if (done.has(c.placeId)) continue;
    done.add(c.placeId);
    put(c.placeId, c.r, c.d);
  }
  return done;
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

export function takeoutStatus(db: DatabaseSync) {
  const n = (sql: string) => (db.prepare(sql).get() as any).n as number;
  const loadedAt = getKv(db, loadedKey('takeout-saved'));
  return {
    saved: n("SELECT COUNT(*) AS n FROM takeout_places WHERE kind = 'saved'"),
    labeled: n("SELECT COUNT(*) AS n FROM takeout_places WHERE kind = 'labeled'"),
    listEntries: n('SELECT COUNT(*) AS n FROM takeout_lists'),
    reviews: n("SELECT COUNT(*) AS n FROM takeout_places WHERE kind = 'review'"),
    mymaps: n('SELECT COUNT(DISTINCT map) AS n FROM takeout_mymaps'),
    mymapPoints: n('SELECT COUNT(*) AS n FROM takeout_mymaps'),
    loadedAt,
  };
}
