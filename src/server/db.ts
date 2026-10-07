import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { areaStatus, sourceStatuses } from './areas';
import { osmAddrStatus } from './osm';
import { osmPoiStatus } from './osmpoi';
import { takeoutStatus } from './takeout';
import { ADDRESS_COLUMNS, NAME_COLUMNS, bestAddressJoin, bestNameJoin, labelLikeSql, labelOrderSql, sourceName } from './labels';
import type {
  Activity,
  CalendarResponse,
  DayResponse,
  ImportRecord,
  PathPoint,
  PlaceLabel,
  PlaceDetailResponse,
  PlaceKind,
  PlaceNote,
  PlaceSort,
  PlaceSummary,
  PlacesResponse,
  PlaceVisit,
  SearchGroup,
  SearchGroupRow,
  SearchResponse,
  SearchTarget,
  SearchTotals,
  SummaryResponse,
  Trip,
  TripDay,
  TripDestination,
  TripDetailResponse,
  TripSummary,
  TripsResponse,
  Visit,
} from '../shared/types';

// 利用者ごとの記録の DB（data/users/<名前>/gtexp.sqlite）。
// 元データ由来のテーブル（visits / activities / path_points / trips / places）は
// 取り込みのたびに作り直される。自分で付けた情報は place_notes に分けて持ち、取り込みでは触らない。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  local_date TEXT NOT NULL,
  utc_offset_min INTEGER,
  place_id TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  probability REAL,
  place_probability REAL,
  hierarchy_level INTEGER
);
CREATE INDEX IF NOT EXISTS visits_time ON visits(start_ms, end_ms);
CREATE INDEX IF NOT EXISTS visits_place ON visits(place_id);
CREATE INDEX IF NOT EXISTS visits_date ON visits(local_date);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  local_date TEXT NOT NULL,
  utc_offset_min INTEGER,
  type TEXT NOT NULL,
  distance_m REAL NOT NULL,
  probability REAL,
  type_probability REAL,
  start_lat REAL NOT NULL,
  start_lng REAL NOT NULL,
  end_lat REAL NOT NULL,
  end_lng REAL NOT NULL,
  parking_lat REAL,
  parking_lng REAL,
  parking_ms INTEGER
);
CREATE INDEX IF NOT EXISTS activities_time ON activities(start_ms, end_ms);
CREATE INDEX IF NOT EXISTS activities_date ON activities(local_date);

CREATE TABLE IF NOT EXISTS path_points (
  t_ms INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  PRIMARY KEY (t_ms, lat, lng)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  distance_km REAL,
  destinations TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trips_time ON trips(start_ms, end_ms);

CREATE TABLE IF NOT EXISTS places (
  place_id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  semantic_type TEXT NOT NULL,
  visit_count INTEGER NOT NULL,
  first_ms INTEGER NOT NULL,
  last_ms INTEGER NOT NULL
);

-- 位置で探す（Takeout の保存した場所に近い滞在先を探すときなど）
CREATE INDEX IF NOT EXISTS places_lat ON places(lat);

CREATE TABLE IF NOT EXISTS place_notes (
  place_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  imported_at TEXT NOT NULL,
  file_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  range_start TEXT,
  range_end TEXT,
  visits INTEGER NOT NULL,
  activities INTEGER NOT NULL,
  points INTEGER NOT NULL,
  trips INTEGER NOT NULL
);

-- 場所の住所・地点名。取得方法（source）ごとに1件。内容と優先順位は labels.ts
CREATE TABLE IF NOT EXISTS place_labels (
  place_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  short_text TEXT NOT NULL,
  detail TEXT,
  dist_m REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (place_id, source)
);
-- Google Takeout の保存した場所（kind = saved）、ラベルを付けた場所（kind = labeled）、クチコミ（kind = review）（takeout.ts）
CREATE TABLE IF NOT EXISTS takeout_places (
  kind TEXT NOT NULL,
  cid TEXT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  saved_at TEXT,
  comment TEXT NOT NULL,
  url TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS takeout_places_lat ON takeout_places(kind, lat);

-- Google Takeout の保存リスト（座標はない。cid で保存した場所と照らし合わせる）
CREATE TABLE IF NOT EXISTS takeout_lists (
  cid TEXT,
  list TEXT NOT NULL,
  title TEXT NOT NULL,
  memo TEXT NOT NULL,
  comment TEXT NOT NULL,
  url TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS takeout_lists_cid ON takeout_lists(cid);

-- Google Takeout のマイマップの地点（takeout.ts）。座標は点か URL から取る。どちらもなければ NULL（cid で保存した場所と照らし合わせる）
CREATE TABLE IF NOT EXISTS takeout_mymaps (
  map TEXT NOT NULL,
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  memo TEXT NOT NULL,
  url TEXT NOT NULL,
  cid TEXT,
  lat REAL,
  lng REAL
);
CREATE INDEX IF NOT EXISTS takeout_mymaps_map ON takeout_mymaps(map);

-- 地点の住所を取得方法ごとに調べた日時（見つからなかった場合も記録し、同じ地点を何度も探さないため）
CREATE TABLE IF NOT EXISTS label_checks (
  place_id TEXT NOT NULL,
  source TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (place_id, source)
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// 全員で使うデータ（data/shared.sqlite）。利用者の記録の DB に ATTACH して、テーブル名だけで引く
// （利用者の DB には同じ名前のテーブルを作らないので、名前だけで shared の方に届く）。
// 利用者の一覧（users.ts）と、参照データを入れた日時（shared_kv）もここに置く
const SHARED_SCHEMA = `
-- 国土交通省「位置参照情報」（大字・町丁目レベル）の代表点（areas.ts）
CREATE TABLE IF NOT EXISTS areas (
  pref_code TEXT NOT NULL,
  pref TEXT NOT NULL,
  city_code TEXT NOT NULL,
  city TEXT NOT NULL,
  town_code TEXT NOT NULL,
  town TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS areas_pref ON areas(pref_code);

-- OpenStreetMap の名前の付いた施設（osmpoi.ts。日本の OSM データから osmium-tool で取り出したもの）
CREATE TABLE IF NOT EXISTS osm_pois (
  osm_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  type TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS osm_pois_lat ON osm_pois(lat);
-- OSM の施設を名前で探す索引（lists.ts の nameKey でそろえた名前 → osm_pois の rowid）。保存リストの店の位置を探すのに使う
CREATE TABLE IF NOT EXISTS osm_poi_keys (
  key TEXT NOT NULL,
  poi INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS osm_poi_keys_key ON osm_poi_keys(key);

-- 利用者（users.ts）。session_key はログイン Cookie の署名に混ぜる値で、パスワードを変えると作り直す（前の Cookie が無効になる）
CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  session_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 参照データ（位置参照情報・OSM の施設）を入れた日時など。利用者の DB の kv と名前を分ける
CREATE TABLE IF NOT EXISTS shared_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 全員で使うテーブルの名前。利用者の DB にあってはいけない（あると名前だけで引いたときにそちらに届いてしまう） */
const SHARED_TABLES = ['areas', 'osm_pois', 'osm_poi_keys', 'users', 'shared_kv'];

const PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;';

export const sharedDbPath = (dataDir: string) => resolve(dataDir, 'shared.sqlite');
/** 利用者の記録の置き場所（DB と取り込んだ元ファイル） */
export const userDir = (dataDir: string, user: string) => resolve(dataDir, 'users', user);

/** 全員で使う DB を開く（参照データを入れるコマンドと、利用者の管理で使う） */
export function openSharedDb(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(sharedDbPath(dataDir));
  // cron で動く fetch-osm などが同時に書き込んでも、少し待ってから続けられるようにする
  db.exec(PRAGMAS);
  db.exec(SHARED_SCHEMA);
  return db;
}

/** 利用者の記録の DB を開き、全員で使う DB をつなぐ。利用者がいるかどうかは呼ぶ側で確かめる */
export function openUserDb(dataDir: string, user: string): DatabaseSync {
  openSharedDb(dataDir).close(); // ないときに作っておく
  const dir = userDir(dataDir, user);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(resolve(dir, 'gtexp.sqlite'));
  db.exec(PRAGMAS);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((r) => r.name as string);
  const wrong = tables.filter((n) => SHARED_TABLES.includes(n));
  if (wrong.length) {
    db.close();
    throw new Error(`${user} の DB に全員で使うテーブル（${wrong.join(', ')}）があります`);
  }
  db.exec(SCHEMA);
  db.prepare('ATTACH DATABASE ? AS shared').run(sharedDbPath(dataDir));
  db.exec('PRAGMA shared.journal_mode = WAL;');
  return db;
}

import { transaction } from './tx';
export { transaction };

type Row = Record<string, any>;

function parseAddress(row: Row): PlaceLabel | null {
  if (row.addr_source == null) return null;
  return {
    source: row.addr_source,
    sourceName: sourceName(row.addr_source),
    kind: 'address',
    text: row.addr_text,
    shortText: row.addr_short,
    distM: row.addr_dist,
  };
}

function parsePlaceName(row: Row): PlaceLabel | null {
  if (row.pname_source == null) return null;
  return {
    source: row.pname_source,
    sourceName: sourceName(row.pname_source),
    kind: 'name',
    text: row.pname_text,
    shortText: row.pname_short,
    distM: row.pname_dist,
  };
}

function parseNote(row: Row): PlaceNote | null {
  if (row.note_name == null) return null;
  return { name: row.note_name, memo: row.note_memo, tags: JSON.parse(row.note_tags) };
}

function toVisit(r: Row): Visit {
  return {
    id: r.id,
    start: r.start_local,
    end: r.end_local,
    startMs: r.start_ms,
    endMs: r.end_ms,
    placeId: r.place_id,
    semanticType: r.semantic_type,
    lat: r.lat,
    lng: r.lng,
    probability: r.probability,
    hierarchyLevel: r.hierarchy_level ?? 0,
    note: parseNote(r),
    address: parseAddress(r),
    placeName: parsePlaceName(r),
    visitCount: r.visit_count ?? 0,
  };
}

function toActivity(r: Row): Activity {
  return {
    id: r.id,
    start: r.start_local,
    end: r.end_local,
    startMs: r.start_ms,
    endMs: r.end_ms,
    type: r.type,
    distanceM: r.distance_m,
    startLat: r.start_lat,
    startLng: r.start_lng,
    endLat: r.end_lat,
    endLng: r.end_lng,
  };
}

function toTrip(r: Row): Trip {
  return {
    id: r.id,
    start: r.start_local,
    end: r.end_local,
    startMs: r.start_ms,
    endMs: r.end_ms,
    distanceKm: r.distance_km,
    destinations: JSON.parse(r.destinations),
  };
}

/** YYYY-MM-DD の1日（tzOffsetMinutes の時間帯での 0:00〜24:00）を UTC ミリ秒で返す */
export function dayRange(date: string, tzOffsetMinutes: number): [number, number] {
  const start = Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutes * 60_000;
  return [start, start + 86400_000];
}

export function getDay(db: DatabaseSync, date: string, tzOffsetMinutes: number): DayResponse {
  const [from, to] = dayRange(date, tzOffsetMinutes);
  // その日に少しでもかかる記録を返す（日をまたぐ滞在も含める）
  const visits = db
    .prepare(
      `SELECT v.*, p.visit_count, n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
         ${ADDRESS_COLUMNS},
         ${NAME_COLUMNS}
       FROM visits v
       LEFT JOIN places p ON p.place_id = v.place_id
       LEFT JOIN place_notes n ON n.place_id = v.place_id
       ${bestAddressJoin('v.place_id')}
       ${bestNameJoin('v.place_id')}
       WHERE v.start_ms < ? AND v.end_ms > ?
       ORDER BY v.start_ms, v.hierarchy_level`,
    )
    .all(to, from)
    .map(toVisit);
  const activities = db
    .prepare('SELECT * FROM activities WHERE start_ms < ? AND end_ms > ? ORDER BY start_ms')
    .all(to, from)
    .map(toActivity);
  const path = db
    .prepare('SELECT t_ms, lat, lng FROM path_points WHERE t_ms >= ? AND t_ms < ? ORDER BY t_ms')
    .all(from, to)
    .map((r: Row): PathPoint => [r.t_ms, r.lat, r.lng]);
  const trips = db
    .prepare('SELECT * FROM trips WHERE start_ms < ? AND end_ms > ? ORDER BY start_ms')
    .all(to, from)
    .map(toTrip);
  return { date, visits, activities, path, trips };
}

export function getCalendar(db: DatabaseSync, year: number): CalendarResponse {
  const like = `${year}-%`;
  const days: CalendarResponse['days'] = {};
  for (const r of db
    .prepare('SELECT local_date, COUNT(*) AS n FROM visits WHERE local_date LIKE ? GROUP BY local_date')
    .all(like) as Row[]) {
    days[r.local_date] = { visits: r.n, distanceKm: 0 };
  }
  for (const r of db
    .prepare('SELECT local_date, SUM(distance_m) AS m FROM activities WHERE local_date LIKE ? GROUP BY local_date')
    .all(like) as Row[]) {
    (days[r.local_date] ??= { visits: 0, distanceKm: 0 }).distanceKm = Math.round(r.m / 100) / 10;
  }
  return { year, days };
}

function toImport(r: Row): ImportRecord {
  return {
    id: r.id,
    importedAt: r.imported_at,
    fileName: r.file_name,
    rangeStart: r.range_start,
    rangeEnd: r.range_end,
    visits: r.visits,
    activities: r.activities,
    points: r.points,
    trips: r.trips,
  };
}

export function listImports(db: DatabaseSync): ImportRecord[] {
  return db.prepare('SELECT * FROM imports ORDER BY id DESC').all().map(toImport);
}

export function getSummary(db: DatabaseSync): SummaryResponse {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n as number;
  const range = db.prepare('SELECT MIN(local_date) AS first, MAX(local_date) AS last FROM visits').get() as Row;
  const last = db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 1').get() as Row | undefined;
  return {
    visits: count('visits'),
    activities: count('activities'),
    points: count('path_points'),
    trips: count('trips'),
    places: count('places'),
    firstDate: range.first,
    lastDate: range.last,
    lastImport: last ? toImport(last) : null,
    areas: areaStatus(db),
    takeout: {
      ...takeoutStatus(db),
      savedPlaces: (db.prepare("SELECT COUNT(*) AS n FROM place_labels WHERE source = 'takeout-saved'").get() as Row).n,
      labelPlaces: (db.prepare("SELECT COUNT(*) AS n FROM place_labels WHERE source = 'takeout-label'").get() as Row).n,
      reviewPlaces: (db.prepare("SELECT COUNT(*) AS n FROM place_labels WHERE source = 'takeout-review'").get() as Row).n,
      mymapPlaces: (db.prepare("SELECT COUNT(*) AS n FROM place_labels WHERE source = 'takeout-mymap'").get() as Row).n,
    },
    osm: { ...osmAddrStatus(db), ...osmPoiStatus(db), poiPlaces: (db.prepare("SELECT COUNT(*) AS n FROM place_labels WHERE source = 'osm-poi'").get() as Row).n },
  };
}

export interface PlaceQuery {
  q: string;
  kind: PlaceKind;
  from: string; // YYYY-MM-DD（空なら制限なし）
  to: string;
  /** [南, 西, 北, 東] */
  bbox: [number, number, number, number] | null;
  sort: PlaceSort;
  limit: number;
  offset: number;
  /** このタグ（# なし・そろえたもの）の状態も返す（まとめてタグ付け用）。空なら返さない */
  checkTag?: string;
}

const SORT_SQL: Record<PlaceSort, string> = {
  count: 'cnt DESC, last_ms DESC',
  last: 'last_ms DESC',
  first: 'first_ms ASC',
  duration: 'total_ms DESC',
};

function toPlaceSummary(r: Row): PlaceSummary {
  return {
    placeId: r.place_id,
    lat: r.lat,
    lng: r.lng,
    semanticType: r.semantic_type,
    note: parseNote(r),
    address: parseAddress(r),
    placeName: parsePlaceName(r),
    count: r.cnt,
    firstDate: r.first_date,
    lastDate: r.last_date,
    totalMs: r.total_ms,
    ...(r.has_note_tag == null ? {} : { tagState: r.has_note_tag ? 'note' : r.has_list_tag ? 'list' : 'none' }),
  };
}

/** 場所ごとに訪問を集計する。期間・範囲で絞ると、その中での回数になる */
export function listPlaces(db: DatabaseSync, query: PlaceQuery): PlacesResponse {
  const visitWhere: string[] = [];
  const placeWhere: string[] = [];
  const params: (string | number)[] = [];
  if (query.from) {
    visitWhere.push('v.local_date >= ?');
    params.push(query.from);
  }
  if (query.to) {
    visitWhere.push('v.local_date <= ?');
    params.push(query.to);
  }
  const placeParams: (string | number)[] = [];
  if (query.bbox) {
    const [s, w, n, e] = query.bbox;
    placeWhere.push('p.lat BETWEEN ? AND ?');
    placeParams.push(s, n);
    // 日付変更線をまたぐ範囲（西 > 東）にも対応する
    if (w <= e) {
      placeWhere.push('p.lng BETWEEN ? AND ?');
      placeParams.push(w, e);
    } else {
      placeWhere.push('(p.lng >= ? OR p.lng <= ?)');
      placeParams.push(w, e);
    }
  }
  if (query.kind === 'home') placeWhere.push("p.semantic_type IN ('HOME', 'INFERRED_HOME')");
  if (query.kind === 'work') placeWhere.push("p.semantic_type IN ('WORK', 'INFERRED_WORK')");
  if (query.kind === 'named') placeWhere.push("COALESCE(n.name, '') <> ''");
  if (query.kind === 'unnamed') placeWhere.push("COALESCE(n.name, '') = ''");
  if (query.q) {
    const f = textFilter(query.q, 'a.place_id');
    placeWhere.push(...f.where);
    placeParams.push(...f.params);
  }

  // まとめてタグ付け用に、指定したタグが付いているか（自分で付けたタグ・Takeout の保存リスト）も返す
  const tagCols = query.checkTag
    ? {
        sql: `EXISTS (SELECT 1 FROM json_each(COALESCE(n.tags, '[]')) jt WHERE replace(jt.value, ' ', '_') = ?) AS has_note_tag,
         EXISTS (SELECT 1 FROM place_labels lt WHERE lt.place_id = a.place_id AND lt.source = 'takeout-saved'
           AND ('、' || replace(COALESCE(json_extract(lt.detail, '$.lists'), ''), ' ', '_') || '、') LIKE ? ESCAPE '\\') AS has_list_tag`,
        params: [query.checkTag, `%、${query.checkTag.replace(/[\\%_]/g, (c) => `\\${c}`)}、%`],
      }
    : { sql: 'NULL AS has_note_tag, NULL AS has_list_tag', params: [] as string[] };
  const sql = `
    WITH agg AS (
      SELECT v.place_id, COUNT(*) AS cnt, MIN(v.start_ms) AS first_ms, MAX(v.start_ms) AS last_ms,
        MIN(v.local_date) AS first_date, MAX(v.local_date) AS last_date, SUM(v.end_ms - v.start_ms) AS total_ms
      FROM visits v
      ${visitWhere.length ? `WHERE ${visitWhere.join(' AND ')}` : ''}
      GROUP BY v.place_id
    )
    SELECT a.*, p.lat, p.lng, p.semantic_type,
      n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
         ${ADDRESS_COLUMNS},
         ${NAME_COLUMNS},
         ${tagCols.sql}
    FROM agg a
    JOIN places p ON p.place_id = a.place_id
    LEFT JOIN place_notes n ON n.place_id = a.place_id
       ${bestAddressJoin('a.place_id')}
       ${bestNameJoin('a.place_id')}
    ${placeWhere.length ? `WHERE ${placeWhere.join(' AND ')}` : ''}`;
  // SQL の中の順（期間 → タグの状態 → 場所の条件）に並べる
  const allParams = [...params, ...tagCols.params, ...placeParams];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...allParams) as Row).n as number;
  const items = db
    .prepare(`${sql} ORDER BY ${SORT_SQL[query.sort]} LIMIT ? OFFSET ?`)
    .all(...allParams, query.limit, query.offset)
    .map(toPlaceSummary);
  return { total, items };
}

export function getPlace(db: DatabaseSync, placeId: string): PlaceDetailResponse | null {
  const place = db
    .prepare(
      `SELECT p.place_id, p.lat, p.lng, p.semantic_type,
         COUNT(*) AS cnt, MIN(v.local_date) AS first_date, MAX(v.local_date) AS last_date,
         SUM(v.end_ms - v.start_ms) AS total_ms,
         n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
         ${ADDRESS_COLUMNS},
         ${NAME_COLUMNS}
       FROM places p
       JOIN visits v ON v.place_id = p.place_id
       LEFT JOIN place_notes n ON n.place_id = p.place_id
       ${bestAddressJoin('p.place_id')}
       ${bestNameJoin('p.place_id')}
       WHERE p.place_id = ?
       GROUP BY p.place_id`,
    )
    .get(placeId) as Row | undefined;
  if (!place) return null;
  const visits = db
    .prepare('SELECT id, start_local, end_local, start_ms, end_ms, hierarchy_level FROM visits WHERE place_id = ? ORDER BY start_ms DESC')
    .all(placeId)
    .map((r: Row): PlaceVisit => ({
      id: r.id,
      start: r.start_local,
      end: r.end_local,
      startMs: r.start_ms,
      endMs: r.end_ms,
      hierarchyLevel: r.hierarchy_level,
    }));
  const years: Record<string, number> = {};
  for (const v of visits) {
    const y = v.start.slice(0, 4);
    years[y] = (years[y] ?? 0) + 1;
  }
  const labels = db
    .prepare(`SELECT * FROM place_labels l WHERE l.place_id = ? ORDER BY ${labelOrderSql('l')}`)
    .all(placeId)
    .map((r: Row): PlaceLabel => ({
      source: r.source,
      sourceName: sourceName(r.source),
      kind: r.kind,
      text: r.text,
      shortText: r.short_text,
      distM: r.dist_m,
      detail: r.detail ? JSON.parse(r.detail) : undefined,
      updatedAt: r.updated_at,
    }));
  return { place: toPlaceSummary(place), visits, years, labels, sources: sourceStatuses(db, placeId) };
}

export interface SearchQuery {
  target: SearchTarget;
  from: string;
  to: string;
  /** 0〜6（日〜土）。空なら全曜日 */
  weekdays: number[];
  /** 滞在だけ：名前・メモ・タグ、種類 */
  q: string;
  kind: PlaceKind;
  /** 移動だけ：移動手段。空ならすべて */
  modes: string[];
  group: SearchGroup;
  limit: number;
  offset: number;
}

/** タグの表記をそろえる：先頭の #（全角の ＃ も）を外し、空白は _ にする（ハッシュタグは空白を含められないため） */
export function normalizeTag(tag: string): string {
  return tag.replace(/^[#＃]+/, '').trim().replace(/\s+/g, '_');
}

/** 検索語を「#タグ」と、それ以外の語に分ける */
function splitQuery(q: string): { tags: string[]; text: string } {
  const tags: string[] = [];
  const text = q
    .replace(/[#＃](\S+)/g, (_, t: string) => {
      tags.push(normalizeTag(t));
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { tags: tags.filter(Boolean), text };
}

/**
 * 検索語の条件。#タグは、自分で付けたタグか Google Takeout の保存リストの名前に「ぴったり」一致するもの。
 * それ以外の語は、名前・メモ・タグ・住所・地点名など（取得方法の細かい項目も含む）の一部に当たるもの。両方あれば両方を満たすもの
 */
function textFilter(q: string, placeIdExpr: string): { where: string[]; params: string[] } {
  const { tags, text } = splitQuery(q);
  const where: string[] = [];
  const params: string[] = [];
  if (text) {
    where.push(`(n.name LIKE ? ESCAPE '\\' OR n.memo LIKE ? ESCAPE '\\' OR n.tags LIKE ? ESCAPE '\\' OR ${labelLikeSql(placeIdExpr)})`);
    const like = likePattern(text);
    params.push(like, like, like, like, like);
  }
  for (const tag of tags) {
    where.push(
      `(EXISTS (SELECT 1 FROM json_each(COALESCE(n.tags, '[]')) jt WHERE replace(jt.value, ' ', '_') = ?)
        OR EXISTS (SELECT 1 FROM place_labels lt WHERE lt.place_id = ${placeIdExpr} AND lt.source = 'takeout-saved'
          AND ('、' || replace(COALESCE(json_extract(lt.detail, '$.lists'), ''), ' ', '_') || '、') LIKE ? ESCAPE '\\'))`,
    );
    params.push(tag, `%、${tag.replace(/[\\%_]/g, (c) => `\\${c}`)}、%`);
  }
  return { where, params };
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * 滞在または移動を条件で絞り込み、合計・グループごとの集計・記録の一覧を返す。
 * 滞在は、場所の条件（q / kind）がなければ主な滞在（hierarchy_level 0）だけを数える
 * （入れ子まで数えると時間が二重になるため）。場所で絞ったときは入れ子も含める。
 */
export function search(db: DatabaseSync, query: SearchQuery): SearchResponse {
  const isVisits = query.target === 'visits';
  const t = isVisits ? 'v' : 'a';
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.from) {
    where.push(`${t}.local_date >= ?`);
    params.push(query.from);
  }
  if (query.to) {
    where.push(`${t}.local_date <= ?`);
    params.push(query.to);
  }
  if (query.weekdays.length) {
    where.push(`CAST(strftime('%w', ${t}.local_date) AS INTEGER) IN (${query.weekdays.map(() => '?').join(',')})`);
    params.push(...query.weekdays);
  }
  let from: string;
  if (isVisits) {
    from = `visits v LEFT JOIN places p ON p.place_id = v.place_id LEFT JOIN place_notes n ON n.place_id = v.place_id
       ${bestAddressJoin('v.place_id')}
       ${bestNameJoin('v.place_id')}`;
    if (query.kind === 'home') where.push("v.semantic_type IN ('HOME', 'INFERRED_HOME')");
    if (query.kind === 'work') where.push("v.semantic_type IN ('WORK', 'INFERRED_WORK')");
    if (query.kind === 'named') where.push("COALESCE(n.name, '') <> ''");
    if (query.kind === 'unnamed') where.push("COALESCE(n.name, '') = ''");
    if (query.q) {
      const f = textFilter(query.q, 'v.place_id');
      where.push(...f.where);
      params.push(...f.params);
    }
    if (!query.q && !query.kind) where.push('v.hierarchy_level = 0');
  } else {
    from = 'activities a';
    if (query.modes.length) {
      where.push(`a.type IN (${query.modes.map(() => '?').join(',')})`);
      params.push(...query.modes);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const distance = isVisits ? '0' : 'SUM(a.distance_m)';
  const measures = `COUNT(*) AS cnt, COUNT(DISTINCT ${t}.local_date) AS days,
    SUM(${t}.end_ms - ${t}.start_ms) AS total_ms, ${distance} AS distance_m`;
  const groupExpr: Record<SearchGroup, string> = {
    year: `substr(${t}.local_date, 1, 4)`,
    month: `substr(${t}.local_date, 1, 7)`,
    weekday: `strftime('%w', ${t}.local_date)`,
    hour: `substr(${t}.start_local, 12, 2)`,
    mode: isVisits ? `substr(${t}.local_date, 1, 4)` : 'a.type',
  };
  const toTotals = (r: Row): SearchTotals => ({
    count: r.cnt ?? 0,
    days: r.days ?? 0,
    totalMs: r.total_ms ?? 0,
    distanceM: r.distance_m ?? 0,
  });

  const totals = toTotals(db.prepare(`SELECT ${measures} FROM ${from} ${whereSql}`).get(...params) as Row);
  const groups = db
    .prepare(`SELECT ${groupExpr[query.group]} AS k, ${measures} FROM ${from} ${whereSql} GROUP BY k ORDER BY k`)
    .all(...params)
    .map((r: Row): SearchGroupRow => ({ key: String(r.k), ...toTotals(r) }));

  let visits: Visit[] = [];
  let activities: Activity[] = [];
  if (isVisits) {
    visits = db
      .prepare(
        `SELECT v.*, p.visit_count, n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
         ${ADDRESS_COLUMNS},
         ${NAME_COLUMNS}
         FROM ${from} ${whereSql} ORDER BY v.start_ms DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset)
      .map(toVisit);
  } else {
    activities = db
      .prepare(`SELECT a.* FROM ${from} ${whereSql} ORDER BY a.start_ms DESC LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset)
      .map(toActivity);
  }
  return { target: query.target, totals, groups, visits, activities };
}

/** 旅行の地図に出す経路の点の上限（多いときは間引く） */
const TRIP_PATH_MAX = 5000;

function tripSummary(db: DatabaseSync, r: Row): TripSummary {
  const trip = toTrip(r);
  const startDate = trip.start.slice(0, 10);
  const endDate = trip.end.slice(0, 10);
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400_000) + 1;
  const placeStmt = db.prepare(
    `SELECT p.lat, p.lng, p.semantic_type, n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
         ${ADDRESS_COLUMNS},
         ${NAME_COLUMNS}
     FROM (SELECT ? AS place_id) x
     LEFT JOIN places p ON p.place_id = x.place_id
     LEFT JOIN place_notes n ON n.place_id = x.place_id
       ${bestAddressJoin('x.place_id')}
       ${bestNameJoin('x.place_id')}`,
  );
  const destinationPlaces = trip.destinations.map((placeId): TripDestination => {
    const p = placeStmt.get(placeId) as Row;
    return { placeId, lat: p.lat ?? null, lng: p.lng ?? null, semanticType: p.semantic_type ?? 'UNKNOWN', note: parseNote(p) };
  });
  const visitCount = (db
    .prepare('SELECT COUNT(*) AS n FROM visits WHERE hierarchy_level = 0 AND start_ms >= ? AND start_ms < ?')
    .get(trip.startMs, trip.endMs) as Row).n as number;
  const act = db
    .prepare('SELECT COUNT(*) AS n, SUM(distance_m) AS m FROM activities WHERE start_ms >= ? AND start_ms < ?')
    .get(trip.startMs, trip.endMs) as Row;
  return { ...trip, days, destinationPlaces, visitCount, activityCount: act.n, distanceM: act.m ?? 0 };
}

export function listTrips(db: DatabaseSync, from: string, to: string): TripsResponse {
  const where: string[] = [];
  const params: string[] = [];
  // 期間に少しでもかかる旅行
  if (from) {
    where.push('substr(end_local, 1, 10) >= ?');
    params.push(from);
  }
  if (to) {
    where.push('substr(start_local, 1, 10) <= ?');
    params.push(to);
  }
  const rows = db
    .prepare(`SELECT * FROM trips ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start_ms DESC`)
    .all(...params) as Row[];
  return { items: rows.map((r) => tripSummary(db, r)) };
}

/** 旅行は取り込みのたびに作り直されて id が変わるので、開始時刻で探す */
export function getTrip(db: DatabaseSync, startMs: number): TripDetailResponse | null {
  const row = db.prepare('SELECT * FROM trips WHERE start_ms = ? ORDER BY id LIMIT 1').get(startMs) as Row | undefined;
  if (!row) return null;
  const trip = tripSummary(db, row);
  const visits = db
    .prepare(
      `SELECT v.*, p.visit_count, n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
         ${ADDRESS_COLUMNS},
         ${NAME_COLUMNS}
       FROM visits v
       LEFT JOIN places p ON p.place_id = v.place_id
       LEFT JOIN place_notes n ON n.place_id = v.place_id
       ${bestAddressJoin('v.place_id')}
       ${bestNameJoin('v.place_id')}
       WHERE v.hierarchy_level = 0 AND v.start_ms >= ? AND v.start_ms < ?
       ORDER BY v.start_ms`,
    )
    .all(trip.startMs, trip.endMs)
    .map(toVisit);
  const dayMap = new Map<string, TripDay>();
  const startDate = trip.start.slice(0, 10);
  for (let i = 0; i < trip.days; i++) {
    const d = new Date(Date.parse(`${startDate}T00:00:00Z`) + i * 86400_000).toISOString().slice(0, 10);
    dayMap.set(d, { date: d, visits: 0, distanceM: 0 });
  }
  for (const v of visits) {
    const day = dayMap.get(v.start.slice(0, 10));
    if (day) day.visits++;
  }
  for (const r of db
    .prepare('SELECT local_date, SUM(distance_m) AS m FROM activities WHERE start_ms >= ? AND start_ms < ? GROUP BY local_date')
    .all(trip.startMs, trip.endMs) as Row[]) {
    const day = dayMap.get(r.local_date);
    if (day) day.distanceM = r.m;
  }
  let path = db
    .prepare('SELECT t_ms, lat, lng FROM path_points WHERE t_ms >= ? AND t_ms < ? ORDER BY t_ms')
    .all(trip.startMs, trip.endMs)
    .map((r: Row): PathPoint => [r.t_ms, r.lat, r.lng]);
  if (path.length > TRIP_PATH_MAX) {
    const step = path.length / TRIP_PATH_MAX;
    path = Array.from({ length: TRIP_PATH_MAX }, (_, i) => path[Math.floor(i * step)]);
  }
  return { trip, days: [...dayMap.values()], visits, path };
}

/**
 * まとめてタグを付ける・外す。名前とメモはそのまま。実際にタグが変わった場所の placeId を返す（「元に戻す」に使う）。
 * タグはそろえたもの（# なし、空白は _）を渡す
 */
export function bulkTags(db: DatabaseSync, placeIds: string[], add: string[], remove: string[]): string[] {
  const get = db.prepare('SELECT name, memo, tags FROM place_notes WHERE place_id = ?');
  const del = db.prepare('DELETE FROM place_notes WHERE place_id = ?');
  const changed: string[] = [];
  transaction(db, () => {
    for (const id of placeIds) {
      const row = get.get(id) as Row | undefined;
      const before: string[] = row ? JSON.parse(row.tags) : [];
      const after = [...new Set([...before.filter((t) => !remove.includes(t)), ...add])];
      if (after.length === before.length && after.every((t) => before.includes(t))) continue;
      // 名前もメモもタグも空になったノートは残さない
      if (!after.length && !row?.name && !row?.memo) del.run(id);
      else savePlaceNote(db, id, { name: row?.name ?? '', memo: row?.memo ?? '', tags: after });
      changed.push(id);
    }
  });
  return changed;
}

export function savePlaceNote(db: DatabaseSync, placeId: string, note: PlaceNote): void {
  db.prepare(
    `INSERT INTO place_notes (place_id, name, memo, tags, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(place_id) DO UPDATE SET name = excluded.name, memo = excluded.memo,
       tags = excluded.tags, updated_at = excluded.updated_at`,
  ).run(placeId, note.name, note.memo, JSON.stringify(note.tags), new Date().toISOString());
}
