import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { areaStatus, sourceStatuses } from './areas';
import { osmAddrStatus } from './osm';
import { osmPoiStatus } from './osmpoi';
import { takeoutStatus } from './takeout';
import { swarmStatus } from './swarm';
import { ADDRESS_COLUMNS, NAME_COLUMNS, bestAddressJoin, bestNameJoin, labelLikeSql, labelOrderSql, sourceName } from './labels';
import type {
  Activity,
  Bookmark,
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
  PlacesExtentResponse,
  PlacesResponse,
  PlaceVisit,
  RecordGap,
  MoveEvent,
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
  hierarchy_level INTEGER,
  -- 1 は元データにない推定の滞在（ラベルを付けた場所への立ち寄り。labelstops.ts が作り直す）
  estimated INTEGER NOT NULL DEFAULT 0
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

-- ブックマーク：画面の URL（# 以降）と名前。一覧は position の小さい順
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
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

-- Foursquare の Swarm アプリのチェックイン（swarm.ts）。時刻は UTC のミリ秒、tz_min はその土地の時差（分）、位置は端末の位置
CREATE TABLE IF NOT EXISTS swarm_checkins (
  id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  tz_min INTEGER,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  venue_url TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  hacc REAL,
  shout TEXT NOT NULL,
  event TEXT NOT NULL
);

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
  // 前の版で作った DB には、あとから足した列がない
  const visitCols = (db.prepare('PRAGMA table_info(visits)').all() as any[]).map((r) => r.name as string);
  if (visitCols.length && !visitCols.includes('estimated')) db.exec('ALTER TABLE visits ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0');
  const bookmarkCols = (db.prepare('PRAGMA table_info(bookmarks)').all() as any[]).map((r) => r.name as string);
  if (bookmarkCols.length && !bookmarkCols.includes('position')) {
    // 並べ替えを足す前は新しい順だった
    db.exec('ALTER TABLE bookmarks ADD COLUMN position INTEGER NOT NULL DEFAULT 0; UPDATE bookmarks SET position = -id;');
  }
  db.exec(SCHEMA);
  db.prepare('ATTACH DATABASE ? AS shared').run(sharedDbPath(dataDir));
  db.exec('PRAGMA shared.journal_mode = WAL;');
  return db;
}

import { userDataStatus } from './userdata';
import { transaction } from './tx';
export { transaction };

/** 滞在記録から場所ごとの集計を作り直す。座標と種類は最後に行ったときのもの（推定の滞在より元データの滞在を優先） */
export function rebuildPlaces(db: DatabaseSync): void {
  db.exec(`
    DELETE FROM places;
    INSERT INTO places (place_id, lat, lng, semantic_type, visit_count, first_ms, last_ms)
    SELECT place_id, lat, lng, semantic_type, cnt, first_ms, last_ms FROM (
      SELECT place_id, lat, lng, semantic_type,
        COUNT(*) OVER w AS cnt, MIN(start_ms) OVER w AS first_ms, MAX(start_ms) OVER w AS last_ms,
        ROW_NUMBER() OVER (PARTITION BY place_id ORDER BY estimated, start_ms DESC) AS rn
      FROM visits
      WINDOW w AS (PARTITION BY place_id)
    ) WHERE rn = 1;
  `);
}

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
    estimated: r.estimated === 1,
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
  const gaps = gapsIn(db, from, to).map(toGap);
  return { date, visits, activities, path, trips, gaps };
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
      labelStops: (db.prepare('SELECT COUNT(*) AS n FROM visits WHERE estimated = 1').get() as Row).n,
    },
    swarm: swarmStatus(db),
    userData: userDataStatus(db),
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

/**
 * 記録のある場所全体が入る範囲（場所の画面で、地図の最初の位置を決めるのに使う）。
 * 遠くへの旅行が少しあるだけで地図が世界全体になってしまわないよう、訪問の回数で重みを付けて、
 * 南北・東西それぞれの端の 5% ずつを除いた範囲にする
 */
export function placesExtent(db: DatabaseSync): PlacesExtentResponse {
  const rows = db.prepare('SELECT lat, lng, visit_count AS n FROM places').all() as { lat: number; lng: number; n: number }[];
  if (!rows.length) return { bounds: null };
  const total = rows.reduce((t, r) => t + r.n, 0);
  const range = (key: 'lat' | 'lng'): [number, number] => {
    const sorted = [...rows].sort((a, b) => a[key] - b[key]);
    let low = sorted[0][key];
    let high = sorted[sorted.length - 1][key];
    let acc = 0;
    let lowSet = false;
    for (const r of sorted) {
      acc += r.n;
      if (!lowSet && acc >= total * 0.05) {
        low = r[key];
        lowSet = true;
      }
      if (acc >= total * 0.95) {
        high = r[key];
        break;
      }
    }
    return [low, high];
  };
  const [s, n] = range('lat');
  const [w, e] = range('lng');
  return { bounds: [s, w, n, e] };
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
    .prepare('SELECT id, start_local, end_local, start_ms, end_ms, hierarchy_level, estimated FROM visits WHERE place_id = ? ORDER BY start_ms DESC')
    .all(placeId)
    .map((r: Row): PlaceVisit => ({
      id: r.id,
      start: r.start_local,
      end: r.end_local,
      startMs: r.start_ms,
      endMs: r.end_ms,
      hierarchyLevel: r.hierarchy_level,
      estimated: r.estimated === 1,
    }));
  // 入れ子の滞在には、その時間を含む外側の滞在（階層がいちばん近く、短いもの）の場所を添える
  const parentOf = db.prepare(
    `SELECT pv.place_id, p.semantic_type, n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
       ${ADDRESS_COLUMNS},
       ${NAME_COLUMNS}
     FROM visits pv
     JOIN places p ON p.place_id = pv.place_id
     LEFT JOIN place_notes n ON n.place_id = pv.place_id
     ${bestAddressJoin('pv.place_id')}
     ${bestNameJoin('pv.place_id')}
     WHERE pv.hierarchy_level < ? AND pv.start_ms <= ? AND pv.end_ms >= ? AND pv.place_id <> ?
     ORDER BY pv.hierarchy_level DESC, pv.end_ms - pv.start_ms
     LIMIT 1`,
  );
  for (const v of visits) {
    if (v.hierarchyLevel <= 0) continue;
    const r = parentOf.get(v.hierarchyLevel, v.startMs, v.endMs, placeId) as Row | undefined;
    v.parent = r ? { placeId: r.place_id, semanticType: r.semantic_type, note: parseNote(r), address: parseAddress(r), placeName: parsePlaceName(r) } : null;
  }
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
  if (query.target === 'gaps') return searchGaps(db, query);
  if (query.target === 'departures' || query.target === 'arrivals') return searchMoves(db, query);
  const isVisits = query.target === 'visits';
  const t = isVisits ? 'v' : 'a';
  // 期間・曜日（始まった日で絞る）と、それ以外の条件を分けて持つ（時間の合計は、期間・曜日を切り分けで扱うため）
  const dateWhere: string[] = [];
  const dateParams: (string | number)[] = [];
  if (query.from) {
    dateWhere.push(`${t}.local_date >= ?`);
    dateParams.push(query.from);
  }
  if (query.to) {
    dateWhere.push(`${t}.local_date <= ?`);
    dateParams.push(query.to);
  }
  if (query.weekdays.length) {
    dateWhere.push(`CAST(strftime('%w', ${t}.local_date) AS INTEGER) IN (${query.weekdays.map(() => '?').join(',')})`);
    dateParams.push(...query.weekdays);
  }
  const where: string[] = [];
  const params: (string | number)[] = [];
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
  const otherWhere = [...where];
  const otherParams = [...params];
  where.unshift(...dateWhere);
  params.unshift(...dateParams);
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

  // 時間の合計は、期間・曜日・まとめ方の切れ目で切り分け、重なった時間は 1 回だけ数える（回数・日数は始まった日で数える）
  const time = searchTime(db, from, otherWhere, otherParams, t, query, isVisits);
  totals.totalMs = time.total;
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const [key, ms] of time.byKey) {
    const g = byKey.get(key);
    if (g) g.totalMs = ms;
    else if (ms > 0) {
      const row: SearchGroupRow = { key, count: 0, days: 0, totalMs: ms, distanceM: 0 };
      groups.push(row);
      byKey.set(key, row);
    }
  }
  for (const g of groups) if (!time.byKey.has(g.key)) g.totalMs = 0;
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

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
  return { target: query.target, totals, groups, visits, activities, gaps: [] };
}

const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;

/**
 * 集計の時間の合計。条件に合う滞在（移動）のうち、期間にかかるものを集め、重なった時間は 1 回だけ数えたうえで、
 * 現地時刻の日（まとめ方が時間帯なら時）の切れ目で切り分け、期間・曜日に入る部分だけを、まとめ方の区切りごとに足す。
 * 月をまたぐ滞在は、それぞれの月に分けて数える（始まった月にまとめると、月の日数を超えることがある）。
 * 現地時刻は、それぞれの記録の始まりの時差を使う
 */
function searchTime(
  db: DatabaseSync,
  from: string,
  where: string[],
  params: (string | number)[],
  t: string,
  query: SearchQuery,
  isVisits: boolean,
): { total: number; byKey: Map<string, number> } {
  const w = [...where];
  const p = [...params];
  // 期間の前後 1 日ずつ広く取る（時差があるため。切り分けたあとに日付で絞る）
  if (query.from) {
    w.push(`${t}.end_ms > ?`);
    p.push(Date.parse(`${query.from}T00:00:00Z`) - DAY_MS);
  }
  if (query.to) {
    w.push(`${t}.start_ms < ?`);
    p.push(Date.parse(`${query.to}T00:00:00Z`) + 2 * DAY_MS);
  }
  const typeCol = isVisits ? `''` : 'a.type';
  const rows = db
    .prepare(`SELECT ${t}.start_ms AS s, ${t}.end_ms AS e, ${t}.start_local AS sl, ${typeCol} AS ty FROM ${from} ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY ${t}.start_ms`)
    .all(...p) as { s: number; e: number; sl: string; ty: string }[];

  // 重なった時間を 1 つにまとめる（移動手段ごとにまとめるときは、手段ごとに）
  const byMode = query.group === 'mode' && !isVisits;
  const merged: { s: number; e: number; off: number; ty: string }[] = [];
  const lastOf = new Map<string, { s: number; e: number; off: number; ty: string }>();
  for (const r of rows) {
    if (!(r.e > r.s)) continue;
    const k = byMode ? r.ty : '';
    const last = lastOf.get(k);
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else {
      const m = { s: r.s, e: r.e, off: offsetMs(r.sl), ty: r.ty };
      merged.push(m);
      lastOf.set(k, m);
    }
  }

  let total = 0;
  const byKey = new Map<string, number>();
  for (const m of merged) {
    eachPiece(m.s, m.e, m.off, query, (ms, local) => {
      total += ms;
      const k = groupKeyOf(query.group, local, isVisits ? '' : m.ty);
      byKey.set(k, (byKey.get(k) ?? 0) + ms);
    });
  }
  // 移動手段ごとのときは、全体の合計も重なりを 1 回だけ数えたものにする
  if (byMode) total = searchTime(db, from, where, params, t, { ...query, group: 'year' }, isVisits).total;
  return { total, byKey };
}

/** まとめ方の区切り（年 "2025"・月 "2025-08"・曜日 "0"〜"6"・時 "00"〜"23"・移動手段）。local は現地時刻の ISO 形式 */
function groupKeyOf(group: SearchGroup, local: string, mode: string): string {
  switch (group) {
    case 'year':
      return local.slice(0, 4);
    case 'month':
      return local.slice(0, 7);
    case 'weekday':
      return String(new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay());
    case 'hour':
      return local.slice(11, 13);
    case 'mode':
      return mode || local.slice(0, 4);
  }
}

/** 日付（YYYY-MM-DD）が集計の期間・曜日に入るか */
function inSearchPeriod(query: SearchQuery, date: string): boolean {
  return (
    (!query.from || date >= query.from) &&
    (!query.to || date <= query.to) &&
    (!query.weekdays.length || query.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()))
  );
}

/**
 * [s, e) を現地時刻の日（まとめ方が時間帯なら時）の切れ目で切り分け、期間・曜日に入る部分ごとに fn を呼ぶ。
 * local は切り分けた部分の始まりの現地時刻（ISO 形式。末尾の Z は、時差を足した値という意味で付いている）
 */
function eachPiece(s: number, e: number, off: number, query: SearchQuery, fn: (ms: number, local: string) => void): void {
  const step = query.group === 'hour' ? HOUR_MS : DAY_MS;
  for (let c = s; c < e; ) {
    const local = c + off;
    const end = Math.min(e, Math.floor(local / step) * step + step - off);
    const iso = new Date(local).toISOString();
    if (inSearchPeriod(query, iso.slice(0, 10))) fn(end - c, iso);
    c = end;
  }
}

/** 記録なしとみなす最短の長さ（前後の記録のつなぎ目の短い隙間は数えない） */
const GAP_MIN_MS = 10 * 60_000;

interface GapSpan {
  s: number;
  e: number;
  /** 直前の記録の時差 */
  off: number;
}

/**
 * [lo, hi) にかかる記録なしの時間（滞在にも移動にも入っていない、GAP_MIN_MS 以上の時間）。範囲の外まで続く空白は、
 * 切らずにそのまま返す。最初の記録より前と、最後の記録より後は記録なしとしない（取り込む前・まだ取り込んでいない時間なので）
 */
export function gapsIn(db: DatabaseSync, lo: number, hi: number): GapSpan[] {
  type R = { s: number; e: number; sl: string };
  const rows = db
    .prepare(
      `SELECT start_ms AS s, end_ms AS e, start_local AS sl FROM visits WHERE end_ms > ? AND start_ms < ?
       UNION ALL SELECT start_ms, end_ms, start_local FROM activities WHERE end_ms > ? AND start_ms < ?
       ORDER BY s`,
    )
    .all(lo, hi, lo, hi) as R[];
  // 範囲の前の最後の記録と、後の最初の記録（範囲をまたぐ空白の端を決める）
  const pick = (sql: string, v: number[]) =>
    (['visits', 'activities'] as const).map((tb) => db.prepare(sql.replace('{t}', tb)).get(...v) as R | undefined).filter((r): r is R => !!r);
  const before = pick('SELECT start_ms AS s, end_ms AS e, start_local AS sl FROM {t} WHERE start_ms < ? AND end_ms <= ? ORDER BY start_ms DESC LIMIT 1', [lo, lo]).sort((a, b) => b.e - a.e)[0];
  const after = pick('SELECT start_ms AS s, end_ms AS e, start_local AS sl FROM {t} WHERE start_ms >= ? ORDER BY start_ms LIMIT 1', [hi]).sort((a, b) => a.s - b.s)[0];
  const all = [...(before ? [before] : []), ...rows, ...(after ? [after] : [])];
  const gaps: GapSpan[] = [];
  let cursor: number | null = null;
  let off = 0;
  for (const r of all) {
    if (cursor != null && r.s - cursor >= GAP_MIN_MS) gaps.push({ s: cursor, e: r.s, off });
    if (cursor == null || r.e > cursor) {
      cursor = r.e;
      off = offsetMs(r.sl);
    }
  }
  return gaps.filter((g) => g.e > lo && g.s < hi);
}

/** 現地時刻の ISO 形式（2025-01-12T23:10:00.000+09:00） */
function localIso(ms: number, off: number): string {
  const sign = off < 0 ? '-' : '+';
  const min = Math.abs(off) / 60_000;
  return `${new Date(ms + off).toISOString().slice(0, 23)}${sign}${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function toGap(g: GapSpan): RecordGap {
  return { start: localIso(g.s, g.off), end: localIso(g.e, g.off), startMs: g.s, endMs: g.e };
}

/**
 * 集計の「記録なし」。回数は、始まった日が期間・曜日に入る空白の数。日数と時間は、空白を日（時）の切れ目で切り分けて、
 * 期間・曜日に入る部分から数える（日数は、空白が少しでもかかった日の数）。一覧は回数に数えた空白の新しい順
 */
function searchGaps(db: DatabaseSync, query: SearchQuery): SearchResponse {
  const lo = query.from ? Date.parse(`${query.from}T00:00:00Z`) - DAY_MS : 0;
  const hi = query.to ? Date.parse(`${query.to}T00:00:00Z`) + 2 * DAY_MS : Number.MAX_SAFE_INTEGER;
  const group: SearchGroup = query.group === 'mode' ? 'year' : query.group;
  const q = { ...query, group };
  const totals: SearchTotals = { count: 0, days: 0, totalMs: 0, distanceM: 0 };
  const rows = new Map<string, SearchGroupRow & { dates: Set<string> }>();
  const rowOf = (key: string) => {
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { key, count: 0, days: 0, totalMs: 0, distanceM: 0, dates: new Set() }));
    return r;
  };
  const allDates = new Set<string>();
  const counted: GapSpan[] = [];
  for (const g of gapsIn(db, lo, hi)) {
    const start = new Date(g.s + g.off).toISOString();
    if (inSearchPeriod(q, start.slice(0, 10))) {
      totals.count++;
      rowOf(groupKeyOf(group, start, '')).count++;
      counted.push(g);
    }
    eachPiece(g.s, g.e, g.off, q, (ms, local) => {
      totals.totalMs += ms;
      allDates.add(local.slice(0, 10));
      const r = rowOf(groupKeyOf(group, local, ''));
      r.totalMs += ms;
      r.dates.add(local.slice(0, 10));
    });
  }
  totals.days = allDates.size;
  const groups = [...rows.values()]
    .map(({ dates, ...r }): SearchGroupRow => ({ ...r, days: dates.size }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const list = counted.reverse();
  const page = query.limit < 0 ? list.slice(query.offset) : list.slice(query.offset, query.offset + query.limit);
  return { target: 'gaps', totals, groups, visits: [], activities: [], gaps: page.map(toGap) };
}

/** 滞在の終わり（始まり）と移動の始まり（終わり）がこれ以内なら、続けて移動した（移動から着いた）とみなす */
const MOVE_LINK_MS = 10 * 60_000;
/** 一覧で、行き先（来た場所）を探す範囲 */
const MOVE_OTHER_MS = DAY_MS;

/**
 * 集計の「出発」（主な滞在を終えて移動を始めたとき）と「到着」（移動を終えて主な滞在を始めたとき）。
 * 移動どうしの乗り換えと、推定の立ち寄りは数えない。場所の条件は、出発では出た場所、到着では着いた場所に当てはめる。
 * 期間・曜日・まとめ方は、出発（到着）した現地時刻で決める。数えるのは回数と日数だけ
 */
function searchMoves(db: DatabaseSync, query: SearchQuery): SearchResponse {
  const departure = query.target === 'departures';
  const group: SearchGroup = query.group === 'mode' ? 'year' : query.group;
  const atLocal = departure ? 'v.end_local' : 'v.start_local';
  const where = ['v.hierarchy_level = 0', 'v.estimated = 0'];
  const params: (string | number)[] = [];
  // 移動の始まり（終わり）が滞在の終わり（始まり）の前後 MOVE_LINK_MS 以内（activities_time の索引を使えるよう、始まりで範囲を絞る）
  where.push(
    departure
      ? `EXISTS (SELECT 1 FROM activities a WHERE a.start_ms BETWEEN v.end_ms - ${MOVE_LINK_MS} AND v.end_ms + ${MOVE_LINK_MS})`
      : `EXISTS (SELECT 1 FROM activities a WHERE a.start_ms BETWEEN v.start_ms - ${MOVE_OTHER_MS} AND v.start_ms + ${MOVE_LINK_MS}
           AND a.end_ms BETWEEN v.start_ms - ${MOVE_LINK_MS} AND v.start_ms + ${MOVE_LINK_MS})`,
  );
  // 期間は前後 1 日広く絞り、出発（到着）した現地の日付で確かめる
  if (query.from) {
    where.push('v.local_date >= ?');
    params.push(addDaysIso(query.from, -2));
  }
  if (query.to) {
    where.push('v.local_date <= ?');
    params.push(addDaysIso(query.to, 1));
  }
  if (query.kind === 'home') where.push("v.semantic_type IN ('HOME', 'INFERRED_HOME')");
  if (query.kind === 'work') where.push("v.semantic_type IN ('WORK', 'INFERRED_WORK')");
  if (query.kind === 'named') where.push("COALESCE(n.name, '') <> ''");
  if (query.kind === 'unnamed') where.push("COALESCE(n.name, '') = ''");
  if (query.q) {
    const f = textFilter(query.q, 'v.place_id');
    where.push(...f.where);
    params.push(...f.params);
  }
  const from = `visits v LEFT JOIN place_notes n ON n.place_id = v.place_id
     ${bestAddressJoin('v.place_id')}
     ${bestNameJoin('v.place_id')}`;
  const events = (
    db.prepare(`SELECT v.id, ${atLocal} AS at FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${departure ? 'v.end_ms' : 'v.start_ms'}`).all(...params) as {
      id: number;
      at: string;
    }[]
  ).filter((e) => inSearchPeriod(query, e.at.slice(0, 10)));

  const totals: SearchTotals = { count: events.length, days: 0, totalMs: 0, distanceM: 0 };
  const rows = new Map<string, { count: number; dates: Set<string> }>();
  const allDates = new Set<string>();
  for (const e of events) {
    const date = e.at.slice(0, 10);
    allDates.add(date);
    const k = groupKeyOf(group, e.at, '');
    const r = rows.get(k) ?? { count: 0, dates: new Set<string>() };
    r.count++;
    r.dates.add(date);
    rows.set(k, r);
  }
  totals.days = allDates.size;
  const groups = [...rows.entries()]
    .map(([key, r]): SearchGroupRow => ({ key, count: r.count, days: r.dates.size, totalMs: 0, distanceM: 0 }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const list = events.reverse();
  const page = query.limit < 0 ? list.slice(query.offset) : list.slice(query.offset, query.offset + query.limit);
  const visitById = db.prepare(
    `SELECT v.*, p.visit_count, n.name AS note_name, n.memo AS note_memo, n.tags AS note_tags,
       ${ADDRESS_COLUMNS},
       ${NAME_COLUMNS}
     FROM visits v LEFT JOIN places p ON p.place_id = v.place_id LEFT JOIN place_notes n ON n.place_id = v.place_id
       ${bestAddressJoin('v.place_id')}
       ${bestNameJoin('v.place_id')}
     WHERE v.id = ?`,
  );
  // 行き先（出発のとき：次の主な滞在）・来た場所（到着のとき：前の主な滞在）
  const nextVisit = db.prepare('SELECT id, start_ms FROM visits WHERE hierarchy_level = 0 AND estimated = 0 AND start_ms >= ? AND start_ms < ? ORDER BY start_ms LIMIT 1');
  const prevVisit = db.prepare('SELECT id, end_ms FROM visits WHERE hierarchy_level = 0 AND estimated = 0 AND end_ms <= ? AND end_ms > ? AND start_ms < ? ORDER BY end_ms DESC LIMIT 1');
  // 間の移動のうち、いちばん長い距離のものの手段
  const mainMode = db.prepare('SELECT type FROM activities WHERE start_ms >= ? AND start_ms < ? ORDER BY distance_m DESC LIMIT 1');
  const moves: MoveEvent[] = page.map((e) => {
    const visit = toVisit(visitById.get(e.id) as Row);
    let other: Visit | null = null;
    let travelMs: number | null = null;
    let mode: string | null = null;
    if (departure) {
      const n = nextVisit.get(visit.endMs, visit.endMs + MOVE_OTHER_MS) as Row | undefined;
      if (n) {
        other = toVisit(visitById.get(n.id) as Row);
        travelMs = n.start_ms - visit.endMs;
      }
      mode = ((mainMode.get(visit.endMs - MOVE_LINK_MS, n ? n.start_ms : visit.endMs + MOVE_LINK_MS) as Row | undefined)?.type as string) ?? null;
    } else {
      const pv = prevVisit.get(visit.startMs, visit.startMs - MOVE_OTHER_MS, visit.startMs) as Row | undefined;
      if (pv) {
        other = toVisit(visitById.get(pv.id) as Row);
        travelMs = visit.startMs - pv.end_ms;
      }
      mode = ((mainMode.get(pv ? pv.end_ms - MOVE_LINK_MS : visit.startMs - MOVE_OTHER_MS, visit.startMs) as Row | undefined)?.type as string) ?? null;
    }
    return { at: e.at, visit, other, mode, travelMs };
  });
  return { target: query.target, totals, groups, visits: [], activities: [], gaps: [], moves };
}

/** YYYY-MM-DD に日数を足す */
function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 記録の現地時刻（2025-08-31T23:00:00.000+09:00）から、時差をミリ秒で */
function offsetMs(local: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(local ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
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

function toBookmark(r: Row): Bookmark {
  return { id: r.id, hash: r.hash, title: r.title, createdAt: r.created_at };
}

/** ブックマークの一覧（並べた順） */
export function listBookmarks(db: DatabaseSync): Bookmark[] {
  return (db.prepare('SELECT * FROM bookmarks ORDER BY position, id DESC').all() as Row[]).map(toBookmark);
}

/** ブックマークを足す（いちばん上に）。同じ画面がもうあれば、名前だけ変える */
export function addBookmark(db: DatabaseSync, hash: string, title: string): Bookmark {
  db.prepare(
    `INSERT INTO bookmarks (hash, title, created_at, position)
     VALUES (?, ?, ?, (SELECT COALESCE(MIN(position), 0) - 1 FROM bookmarks))
     ON CONFLICT(hash) DO UPDATE SET title = excluded.title`,
  ).run(hash, title, new Date().toISOString());
  return toBookmark(db.prepare('SELECT * FROM bookmarks WHERE hash = ?').get(hash) as Row);
}

/** ブックマークの名前を変える。なければ null */
export function renameBookmark(db: DatabaseSync, id: number, title: string): Bookmark | null {
  db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').run(title, id);
  const r = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as Row | undefined;
  return r ? toBookmark(r) : null;
}

/** ブックマークを並べ替える（ids の順に。ids にないものは後ろに、今の順のまま） */
export function reorderBookmarks(db: DatabaseSync, ids: number[]): void {
  const rest = listBookmarks(db).map((b) => b.id).filter((id) => !ids.includes(id));
  const set = db.prepare('UPDATE bookmarks SET position = ? WHERE id = ?');
  transaction(db, () => [...ids, ...rest].forEach((id, i) => set.run(i, id)));
}

export function deleteBookmark(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
}
