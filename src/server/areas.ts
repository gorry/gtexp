import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { transaction } from './tx';
import { readZip } from './zip';
import { assignOsmPoi } from './osmpoi';
import { assignTakeout, TAKEOUT_SOURCES, type TakeoutOptions } from './takeout';
import { sourceName } from './labels';
import type { AssignStats } from '../shared/types';
import { distM, getKv, loadedKey, markChecked, pendingTargets, setKv, upsertLabel, type Target } from './labelstore';
import { LABEL_SOURCES } from './labels';
import type { LabelSourceStatus } from '../shared/types';

// 国土交通省「位置参照情報」から、各場所に住所を付ける。2種類を、取得方法を分けて使う。
//
// - 大字・町丁目レベル（isj-oaza）：町丁目ごとの代表点。全国で約19万点なので areas テーブルに入れておき、
//   いちばん近い代表点（10km 以内）の町丁目をその場所の住所とする。境界の近くでは隣の町丁目になることがある
// - 街区レベル（isj-gaiku）：街区（「〇番」）ごとの代表点。全国で千万点を超えるので DB には入れず、
//   配布の zip を isj フォルダーに置いたまま、住所を付けるときに対象の都道府県の分だけ読む。
//   いちばん近い代表点が 150m 以内なら「〇〇町一丁目6番」のような住所にする
//
// 作業は2つに分かれる。
// 1. 位置参照情報を入れる（import-isj コマンド。zip を持ち込んだときだけ）：大字・町丁目は areas に入れ、
//    街区は zip の置き場所を確かめる。入れた日時を kv に記録する。地点への割り当てはしない
// 2. 地点に住所を割り当てる（タイムラインの取り込みのたび、アプリの中で）：まだ調べていない地点と、
//    位置参照情報を入れ直したあとにまだ調べ直していない地点だけを調べる（assignForImport）
//
// 割り当てた住所は place_labels に取得方法ごとの行として、調べたこと（見つからなかった場合も）は
// label_checks に取得方法ごとに記録する（テーブルの定義は db.ts）。
// 出典：位置参照情報ダウンロードサービス（国土交通省） https://nlftp.mlit.go.jp/isj/

const OAZA = 'isj-oaza';
const GAIKU = 'isj-gaiku';

/** 大字・町丁目：これより遠い代表点しかない場所（海外・海上など）には住所を付けない */
const OAZA_MAX_M = 10_000;
/** 街区：代表点がこれより遠ければ、その場所の街区は分からないものとする */
const GAIKU_MAX_M = 150;

// ---- CSV ----

function decode(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

type CsvKind = 'oaza' | 'gaiku';

/** 見出しから、どちらの位置参照情報かを判定する */
function csvKind(header: string[]): CsvKind | null {
  if (header.some((h) => h.includes('大字町丁目コード'))) return 'oaza';
  if (header.some((h) => h.includes('街区符号'))) return 'gaiku';
  return null;
}

/** zip（中の .csv）か .csv のファイルから、CSV の本文を取り出す */
function readCsvTexts(path: string): { name: string; text: string }[] {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) === 0x04034b50) {
    return readZip(buf)
      .filter((e) => /\.csv$/i.test(e.name))
      .map((e) => ({ name: `${basename(path)}/${e.name}`, text: decode(e.data) }));
  }
  return [{ name: basename(path), text: decode(buf) }];
}

/** 本文を1行ずつ（見出しを除いて）たどる。大きいファイルでも行の配列を作らない */
function* dataLines(text: string): Generator<string[]> {
  let start = text.indexOf('\n') + 1;
  while (start > 0 && start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    if (line) yield parseCsvLine(line);
    start = end + 1;
  }
}

function headerOf(text: string): string[] {
  const end = text.indexOf('\n');
  return parseCsvLine(text.slice(0, end < 0 ? text.length : end).replace(/\r$/, ''));
}

function columns(header: string[], fileName: string, want: Record<string, string>): Record<string, number> {
  const idx: Record<string, number> = {};
  const missing: string[] = [];
  for (const [key, label] of Object.entries(want)) {
    idx[key] = header.findIndex((h) => h.includes(label));
    if (idx[key] < 0) missing.push(label);
  }
  if (missing.length) throw new Error(`${fileName}: 必要な列が見つかりません（${missing.join('、')}）`);
  return idx;
}

// ---- 近いものを探すための格子 ----

/** 格子の1マス（度） */
const CELL = 0.05;


const cellKey = (lat: number, lng: number, size = CELL) => `${Math.floor(lat / size)},${Math.floor(lng / size)}`;









function targetsFor(db: DatabaseSync, placeIds: string[] | null): Target[] {
  const all = db.prepare('SELECT place_id, lat, lng FROM places').all() as unknown as Target[];
  if (!placeIds) return all;
  const want = new Set(placeIds);
  return all.filter((t) => want.has(t.place_id));
}

// ---- 大字・町丁目（areas テーブル） ----

function importOazaTexts(db: DatabaseSync, texts: { name: string; text: string }[]): { prefectures: string[]; areas: number } {
  const ins = db.prepare('INSERT INTO areas (pref_code, pref, city_code, city, town_code, town, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const del = db.prepare('DELETE FROM areas WHERE pref_code = ?');
  const prefectures = new Set<string>();
  let areas = 0;
  transaction(db, () => {
    for (const { name, text } of texts) {
      const c = columns(headerOf(text), name, {
        prefCode: '都道府県コード', pref: '都道府県名', cityCode: '市区町村コード', city: '市区町村名',
        townCode: '大字町丁目コード', town: '大字町丁目名', lat: '緯度', lng: '経度',
      });
      const cleared = new Set<string>();
      for (const f of dataLines(text)) {
        const lat = Number(f[c.lat]);
        const lng = Number(f[c.lng]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const prefCode = f[c.prefCode];
        // ファイルに含まれる都道府県の分は置き換える
        if (!cleared.has(prefCode)) {
          del.run(prefCode);
          cleared.add(prefCode);
        }
        ins.run(prefCode, f[c.pref], f[c.cityCode], f[c.city], f[c.townCode], f[c.town], lat, lng);
        prefectures.add(f[c.pref]);
        areas++;
      }
    }
  });
  return { prefectures: [...prefectures], areas };
}

/** 大字・町丁目の住所を付ける。付けた数を返す */
function assignOaza(db: DatabaseSync, targets: Target[]): number {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM areas').get() as any).n as number;
  if (!count || !targets.length) return 0;

  const grid = new Map<string, any[]>();
  for (const r of db.prepare('SELECT pref_code, pref, city, town, city_code, town_code, lat, lng FROM areas').iterate() as Iterable<any>) {
    const key = cellKey(r.lat, r.lng);
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(r);
  }
  const reach = Math.ceil(OAZA_MAX_M / 111_320 / CELL) + 1;
  const upsert = upsertLabel(db);
  const remove = db.prepare(`DELETE FROM place_labels WHERE place_id = ? AND source = '${OAZA}'`);
  const now = new Date().toISOString();
  let assigned = 0;
  transaction(db, () => {
    for (const t of targets) {
      const ci = Math.floor(t.lat / CELL);
      const cj = Math.floor(t.lng / CELL);
      let best: any = null;
      let bestD = Infinity;
      for (let di = -reach; di <= reach; di++) {
        for (let dj = -reach; dj <= reach; dj++) {
          for (const r of grid.get(`${ci + di},${cj + dj}`) ?? []) {
            const d = distM(t.lat, t.lng, r.lat, r.lng);
            if (d < bestD) [best, bestD] = [r, d];
          }
        }
      }
      if (best && bestD <= OAZA_MAX_M) {
        const detail = JSON.stringify({ prefCode: best.pref_code, pref: best.pref, city: best.city, town: best.town, cityCode: best.city_code, townCode: best.town_code });
        upsert.run(t.place_id, OAZA, `${best.pref}${best.city}${best.town}`, `${best.city}${best.town}`, detail, Math.round(bestD), now);
        assigned++;
      } else {
        remove.run(t.place_id);
      }
    }
    markChecked(db, OAZA, targets, now);
  });
  return assigned;
}

// ---- 街区（zip を置いたまま読む） ----

/** isj フォルダーにある街区レベルの zip（ファイル名の版が「a」で終わる。例: 14000-24.0a.zip） */
export function gaikuFiles(isjDir: string): string[] {
  if (!existsSync(isjDir)) return [];
  return readdirSync(isjDir)
    .filter((f) => /^\d{2}000-[\d.]+a\.zip$/i.test(f))
    .sort()
    .map((f) => join(isjDir, f));
}

/** 街区の zip のファイル名から都道府県コードを取る（14000-24.0a.zip → "14"） */
function prefCodeOfFile(path: string): string | null {
  return /^(\d{2})000-/.exec(basename(path))?.[1] ?? null;
}

/**
 * 街区の住所を付ける。大字・町丁目の住所から都道府県が分かる場所は、その都道府県のファイルだけを読む。付けた数を返す
 */
function assignGaiku(db: DatabaseSync, files: string[], targets: Target[]): number {
  if (!files.length || !targets.length) return 0;

  // 場所の都道府県（大字・町丁目の住所から）。大字・町丁目のデータが入っていて住所の付かなかった場所（海外など）は探さない。
  // 大字・町丁目のデータがなければ、すべてのファイルで探す
  const oazaLoaded = ((db.prepare('SELECT COUNT(*) AS n FROM areas').get() as any).n as number) > 0;
  const prefOf = new Map<string, string>();
  for (const r of db.prepare(`SELECT place_id, detail FROM place_labels WHERE source = '${OAZA}'`).all() as any[]) {
    const d = r.detail ? JSON.parse(r.detail) : null;
    const code = d?.prefCode ?? d?.cityCode?.slice(0, 2);
    if (code) prefOf.set(r.place_id, code);
  }

  const best = new Map<string, { d: number; f: string[]; residential: boolean }>();
  const now = new Date().toISOString();
  // 街区は 150m 以内しか見ないので、細かい格子（約 1km）に場所を入れておき、代表点のほうから近くの場所を探す
  const SMALL = 0.01;
  for (const file of files) {
    const code = prefCodeOfFile(file);
    const mine = targets.filter((t) => (prefOf.has(t.place_id) ? prefOf.get(t.place_id) === code : !oazaLoaded));
    if (!mine.length) continue;
    const grid = new Map<string, Target[]>();
    for (const t of mine) {
      const key = cellKey(t.lat, t.lng, SMALL);
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(t);
    }
    for (const { name, text } of readCsvTexts(file)) {
      const header = headerOf(text);
      if (csvKind(header) !== 'gaiku') throw new Error(`${name}: 街区レベルの位置参照情報ではないようです`);
      const c = columns(header, name, {
        pref: '都道府県名', city: '市区町村名', oaza: '大字・丁目名', koaza: '小字・通称名', block: '街区符号',
        lat: '緯度', lng: '経度', residential: '住居表示フラグ', old: '更新前履歴フラグ',
      });
      for (const f of dataLines(text)) {
        if (f[c.old] === '1') continue; // 更新される前の古い記録
        const lat = Number(f[c.lat]);
        const lng = Number(f[c.lng]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const ci = Math.floor(lat / SMALL);
        const cj = Math.floor(lng / SMALL);
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            for (const t of grid.get(`${ci + di},${cj + dj}`) ?? []) {
              const d = distM(t.lat, t.lng, lat, lng);
              if (d > GAIKU_MAX_M) continue;
              const cur = best.get(t.place_id);
              if (!cur || d < cur.d) best.set(t.place_id, { d, f: [f[c.pref], f[c.city], f[c.oaza], f[c.koaza], f[c.block]], residential: f[c.residential] === '1' });
            }
          }
        }
      }
    }
  }

  const upsert = upsertLabel(db);
  const remove = db.prepare(`DELETE FROM place_labels WHERE place_id = ? AND source = '${GAIKU}'`);
  transaction(db, () => {
    for (const t of targets) {
      const b = best.get(t.place_id);
      if (!b) {
        remove.run(t.place_id);
        continue;
      }
      const [pref, city, oaza, koaza, block] = b.f;
      // 住居表示の地域は「〇番」、そうでなければ地番なので「〇番地」
      const ban = block ? `${block}${b.residential ? '番' : '番地'}` : '';
      const detail = JSON.stringify({ pref, city, oaza, koaza, block, residential: b.residential ? '1' : '0' });
      upsert.run(t.place_id, GAIKU, `${pref}${city}${oaza}${koaza}${ban}`, `${city}${oaza}${koaza}${ban}`, detail, Math.round(b.d), now);
    }
    markChecked(db, GAIKU, targets, now);
  });
  return best.size;
}

// ---- まとめ ----

export interface AreaImportStats {
  oaza: { prefectures: string[]; areas: number } | null;
  gaiku: { files: number } | null;
}

/**
 * 位置参照情報を入れる（zip を持ち込んだときだけ行う作業）。地点への割り当てはしない。
 * 大字・町丁目は areas に入れる（同じ都道府県は置き換え）。街区は DB に入れず、isjDir に置いたまま使うので、
 * 置き場所を確かめるだけ。どちらも入れた日時を記録し、次のタイムラインの取り込みで全地点を調べ直させる。
 */
export function importAreas(db: DatabaseSync, paths: string[], isjDir: string): AreaImportStats {
  const oazaTexts: { name: string; text: string }[] = [];
  const gaikuPaths: string[] = [];
  for (const path of paths) {
    // 街区のファイルは大きいので、種類の判定はファイル名で行い、ここでは読まない
    if (/-[\d.]+a\.zip$/i.test(basename(path))) {
      if (resolve(dirname(path)) !== resolve(isjDir)) {
        throw new Error(`${basename(path)}: 街区のファイルは住所を割り当てるたびに読むので、${isjDir} に置いてから指定してください`);
      }
      gaikuPaths.push(path);
      continue;
    }
    for (const t of readCsvTexts(path)) {
      const kind = csvKind(headerOf(t.text));
      if (kind === 'oaza') oazaTexts.push(t);
      else if (kind === 'gaiku') throw new Error(`${t.name}: 街区レベルのファイルは、配布のファイル名（例: 14000-24.0a.zip）のまま渡してください`);
      else throw new Error(`${t.name}: 位置参照情報（大字・町丁目レベルか街区レベル）ではないようです`);
    }
  }
  const now = new Date().toISOString();
  let oaza: AreaImportStats['oaza'] = null;
  if (oazaTexts.length) {
    oaza = importOazaTexts(db, oazaTexts);
    setKv(db, loadedKey(OAZA), now);
  }
  let gaiku: AreaImportStats['gaiku'] = null;
  if (gaikuPaths.length) {
    gaiku = { files: gaikuPaths.length };
    setKv(db, loadedKey(GAIKU), now);
  }
  return { oaza, gaiku };
}

export interface AssignOptions {
  isjDir: string;
  takeout: TakeoutOptions;
}

/**
 * 地点に住所・地点名を割り当てる（タイムラインの取り込みのたびと「今すぐ調べる」で行う作業）。
 * 取得方法ごとに、まだ調べていない地点と、データを入れ直したあとにまだ調べ直していない地点だけを調べる
 */
export function assignForImport(db: DatabaseSync, opts: AssignOptions): AssignStats {
  return runAssign(db, opts, (source) => pendingTargets(db, source));
}

/** すべての地点の住所・地点名を付け直す（保守用のコマンド。ふだんは取り込みのたびに assignForImport が行う） */
export function assignAll(db: DatabaseSync, opts: AssignOptions): AssignStats {
  const all = targetsFor(db, null);
  return runAssign(db, opts, () => all);
}

function runAssign(db: DatabaseSync, opts: AssignOptions, targetsOf: (source: string) => Target[]): AssignStats {
  const bySource: AssignStats['bySource'] = [];
  const add = (source: string, targets: Target[], assigned: number) => {
    if (targets.length) bySource.push({ source, name: sourceName(source), assigned, checked: targets.length });
  };
  const seen = new Set<string>();
  const take = (source: string) => {
    const t = targetsOf(source);
    t.forEach((x) => seen.add(x.place_id));
    return t;
  };
  // 位置参照情報：街区は大字・町丁目の結果（都道府県）を使うので後に行う
  const oazaT = take(OAZA);
  add(OAZA, oazaT, assignOaza(db, oazaT));
  const gaikuT = take(GAIKU);
  add(GAIKU, gaikuT, assignGaiku(db, gaikuFiles(opts.isjDir), gaikuT));
  // OpenStreetMap の施設名（手元のデータから）
  const poiT = take('osm-poi');
  add('osm-poi', poiT, assignOsmPoi(db, poiT));
  // Google Takeout（ラベル・保存した場所・その住所）
  const tk = { 'takeout-label': take('takeout-label'), 'takeout-saved': take('takeout-saved'), 'takeout-addr': take('takeout-addr') };
  const tr = assignTakeout(db, tk, opts.takeout);
  for (const name of TAKEOUT_SOURCES) add(name, tk[name], tr[name]);
  return { checked: seen.size, bySource };
}

export function areaStatus(db: DatabaseSync): { areas: number; prefectures: number; places: number; gaikuPlaces: number; pending: number } {
  const r = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT pref_code) AS p FROM areas').get() as any;
  const count = (source: string) => (db.prepare('SELECT COUNT(*) AS n FROM place_labels WHERE source = ?').get(source) as any).n as number;
  // 次のタイムラインの取り込みで調べる地点の数
  const pending = new Set(
    [OAZA, GAIKU, 'osm-poi', ...TAKEOUT_SOURCES].flatMap((s) => pendingTargets(db, s)).map((t) => t.place_id),
  ).size;
  return { areas: r.n, prefectures: r.p, places: count(OAZA), gaikuPlaces: count(GAIKU), pending };
}

/** 地点の、取得方法ごとの状態（場所の詳細に出す） */
export function sourceStatuses(db: DatabaseSync, placeId: string): LabelSourceStatus[] {
  const found = new Set((db.prepare('SELECT source FROM place_labels WHERE place_id = ?').all(placeId) as any[]).map((r) => r.source as string));
  const checks = new Map((db.prepare('SELECT source, checked_at FROM label_checks WHERE place_id = ?').all(placeId) as any[]).map((r) => [r.source as string, r.checked_at as string]));
  return [...LABEL_SOURCES].sort((x, y) => x.priority - y.priority).map((s): LabelSourceStatus => {
    const loadedAt = getKv(db, loadedKey(s.id));
    const checkedAt = checks.get(s.id);
    const base = { source: s.id, sourceName: s.name, kind: s.kind, checkedAt };
    if (found.has(s.id)) return { ...base, status: 'found' };
    if (s.needsData && !loadedAt) return { ...base, status: 'no-data' };
    if (!checkedAt || (loadedAt && checkedAt < loadedAt)) return { ...base, status: 'pending', note: s.pendingNote };
    return { ...base, status: 'missing', note: s.missingNote };
  });
}
