// サーバーと画面で共有する API の型

export interface PlaceNote {
  name: string;
  memo: string;
  tags: string[];
}

/** ブックマーク：画面の URL（# 以降）と名前 */
export interface Bookmark {
  id: number;
  /** 画面の URL の # 以降（#/day/2024-05-25 など） */
  hash: string;
  title: string;
  createdAt: string;
}

/**
 * 場所の住所・地点名。取得方法（source）ごとに1件ずつある。
 * 一覧などでは、取得方法の優先順位でいちばん良い住所を1つ（address）だけ返す
 */
export interface PlaceLabel {
  source: string;
  /** 取得方法の表示名（例：位置参照情報（大字・町丁目）） */
  sourceName: string;
  kind: 'address' | 'name';
  /** 全体の表記（例：東京都千代田区丸の内一丁目） */
  text: string;
  /** 短い表記（例：千代田区丸の内一丁目）。名前の代わりに使う */
  shortText: string;
  /** 取得方法の基準点までの距離（m）。分からなければ null */
  distM: number | null;
  /** 取得方法ごとの細かい項目（都道府県・市区町村コードなど） */
  detail?: Record<string, string>;
  updatedAt?: string;
}

/** 住所・地点名の割り当ての結果。取得方法ごとに、調べた地点の数（checked）とそのうち付いた数（assigned） */
export interface AssignStats {
  /** 調べた地点の数（重複なし） */
  checked: number;
  bySource: { source: string; name: string; assigned: number; checked: number }[];
}

/** Takeout・Swarm の zip を画面から入れた結果（POST /api/takeout）。送られなかったほうは null */
export interface ZipImportResult {
  ok: true;
  takeout: TakeoutImportStats | null;
  swarm: { checkins: number; venues: number } | null;
  addresses: AssignStats;
}

/** Takeout の zip を入れた結果 */
export interface TakeoutImportStats {
  saved: number;
  labeled: number;
  listEntries: number;
  lists: string[];
  reviews: number;
  mymaps: number;
  mymapPoints: number;
  /** 今回の zip に入っていて置き換えた種類（入っていなかった種類は前のまま） */
  replaced: ('saved' | 'labeled' | 'lists' | 'reviews' | 'mymaps')[];
}

export interface LabelSourceStatus {
  source: string;
  sourceName: string;
  kind: 'address' | 'name';
  /** found：住所あり / missing：調べたが見つからなかった / pending：まだ調べていない / no-data：その取得方法のデータを入れていない */
  status: 'found' | 'missing' | 'pending' | 'no-data';
  /** missing・pending のときの説明 */
  note?: string;
  checkedAt?: string;
}

export interface Visit {
  id: number;
  start: string; // 元データの時刻文字列（オフセット付き）
  end: string;
  startMs: number;
  endMs: number;
  placeId: string;
  semanticType: string;
  lat: number;
  lng: number;
  probability: number;
  /** 0 が主な滞在、1 以上は同じ時間帯の入れ子の場所 */
  hierarchyLevel: number;
  /** 元データにない推定の滞在（ラベルを付けた場所への立ち寄り） */
  estimated: boolean;
  note: PlaceNote | null;
  /** いちばん良い住所（取得方法の優先順） */
  address: PlaceLabel | null;
  /** いちばん良い地点名（OpenStreetMap の施設名など。取得方法の優先順） */
  placeName: PlaceLabel | null;
  visitCount: number;
}

export interface Activity {
  id: number;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  type: string;
  distanceM: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
}

export interface Trip {
  id: number;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  distanceKm: number;
  destinations: string[]; // placeId
}

/** [時刻(ms), 緯度, 経度] */
export type PathPoint = [number, number, number];

export interface DayResponse {
  date: string;
  visits: Visit[];
  activities: Activity[];
  path: PathPoint[];
  trips: Trip[];
}

export interface CalendarDay {
  visits: number;
  distanceKm: number;
}

export interface CalendarResponse {
  year: number;
  days: Record<string, CalendarDay>;
}

export interface ImportRecord {
  id: number;
  importedAt: string;
  fileName: string;
  rangeStart: string | null;
  rangeEnd: string | null;
  visits: number;
  activities: number;
  points: number;
  trips: number;
}

export interface SummaryResponse {
  visits: number;
  activities: number;
  points: number;
  trips: number;
  places: number;
  firstDate: string | null;
  lastDate: string | null;
  lastImport: ImportRecord | null;
  /** 位置参照情報（住所）の状態 */
  areas: { areas: number; prefectures: number; places: number; gaikuPlaces: number; pending: number };
  /** Google Takeout の状態（入れたデータの件数と、地点名の付いた地点の数） */
  takeout: {
    saved: number;
    labeled: number;
    listEntries: number;
    reviews: number;
    mymaps: number;
    mymapPoints: number;
    loadedAt: string | null;
    savedPlaces: number;
    labelPlaces: number;
    reviewPlaces: number;
    mymapPlaces: number;
    /** ラベルを付けた場所への、経路から推定した立ち寄り（推定の滞在）の数 */
    labelStops: number;
  };
  /** Foursquare Swarm の状態（チェックインの件数・店の数・店の名前が付いた地点の数・入れた日時） */
  swarm: { checkins: number; venues: number; places: number; loadedAt: string | null };
  /** OpenStreetMap の状態。施設名は手元のデータ（pois 件・loadedAt に入れた）から、住所は Nominatim から少しずつ */
  osm: {
    pois: number;
    loadedAt: string | null;
    poiPlaces: number;
    checked: number;
    addr: number;
    lastRun: { at: string; done: number; addr: number; remaining: number; stopped?: string } | null;
  };
}

/** 場所の一覧の絞り込み条件 */
export type PlaceKind = '' | 'home' | 'work' | 'named' | 'unnamed';
export type PlaceSort = 'count' | 'last' | 'first' | 'duration';

export interface PlaceSummary {
  placeId: string;
  lat: number;
  lng: number;
  semanticType: string;
  note: PlaceNote | null;
  /** いちばん良い住所（取得方法の優先順） */
  address: PlaceLabel | null;
  /** いちばん良い地点名（OpenStreetMap の施設名など。取得方法の優先順） */
  placeName: PlaceLabel | null;
  /** 条件の期間・範囲の中での訪問回数 */
  count: number;
  firstDate: string;
  lastDate: string;
  /** 滞在時間の合計（ms） */
  totalMs: number;
  /**
   * 一覧を取るときに checkTag を指定したときだけ：そのタグの状態。note は自分で付けたタグで付いている、
   * list は Google Takeout の保存リストで付いている（自分で付けたタグにはない）、none は付いていない
   */
  tagState?: 'note' | 'list' | 'none';
}

/** 記録のある場所の大部分が入る範囲 [南, 西, 北, 東]（遠くへの旅行など、端の少しは除く）。記録がなければ null */
export interface PlacesExtentResponse {
  bounds: [number, number, number, number] | null;
}

export interface PlacesResponse {
  total: number;
  items: PlaceSummary[];
}

export interface PlaceVisit {
  id: number;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  hierarchyLevel: number;
  /** 元データにない推定の滞在（ラベルを付けた場所への立ち寄り） */
  estimated: boolean;
  /** 入れ子の滞在のとき、その時間を含む主な滞在の場所（名前を「（○○内）」と添えるため）。見つからなければ null */
  parent?: VisitParent | null;
}

/** 入れ子の滞在の外側の場所（名前の決め方は滞在と同じ） */
export interface VisitParent {
  placeId: string;
  semanticType: string;
  note: PlaceNote | null;
  address: PlaceLabel | null;
  placeName: PlaceLabel | null;
}

export interface PlaceDetailResponse {
  place: PlaceSummary;
  visits: PlaceVisit[]; // 新しい順
  /** すべての取得方法の住所・地点名（優先順） */
  labels: PlaceLabel[];
  /** 取得方法ごとの状態（見つからなかったもの・まだ調べていないものも含む。優先順） */
  sources: LabelSourceStatus[];
  years: Record<string, number>;
}

/** 集計の対象とまとめ方 */
export type SearchTarget = 'visits' | 'activities';
export type SearchGroup = 'year' | 'month' | 'weekday' | 'hour' | 'mode';

export interface SearchTotals {
  count: number;
  /** 記録のあった日数 */
  days: number;
  totalMs: number;
  distanceM: number;
}

export interface SearchGroupRow extends SearchTotals {
  /** 年 "2024"、月 "2024-05"、曜日 "0"〜"6"（日〜土）、時 "00"〜"23"、移動手段 "WALKING" など */
  key: string;
}

export interface SearchResponse {
  target: SearchTarget;
  totals: SearchTotals;
  groups: SearchGroupRow[];
  /** 新しい順。target に応じてどちらか一方だけ入る */
  visits: Visit[];
  activities: Activity[];
}

/** 旅行の行き先（場所の記録がない placeId もありうるので、座標などは省略可） */
export interface TripDestination {
  placeId: string;
  lat: number | null;
  lng: number | null;
  semanticType: string;
  note: PlaceNote | null;
}

export interface TripSummary extends Trip {
  /** 開始日から終了日までの日数 */
  days: number;
  destinationPlaces: TripDestination[];
  /** 旅行中の主な滞在の数 */
  visitCount: number;
  /** 旅行中の移動の数と距離の合計 */
  activityCount: number;
  distanceM: number;
}

export interface TripsResponse {
  items: TripSummary[]; // 新しい順
}

export interface TripDay {
  date: string;
  visits: number;
  distanceM: number;
}

export interface TripDetailResponse {
  trip: TripSummary;
  days: TripDay[];
  /** 旅行中の主な滞在（古い順） */
  visits: Visit[];
  /** 旅行中の経路の点（多いときは間引く） */
  path: PathPoint[];
}

export interface ClientConfig {
  mapsApiKey: string;
  mapId: string;
  tzOffsetMinutes: number;
}

export interface MeResponse {
  loggedIn: boolean;
  /** ログインしている利用者の名前 */
  user?: string;
}

/** Takeout の保存リスト（保存リストのタブ） */
export interface ListSummary {
  /** API と URL で使う鍵。保存リストはリストの名前、マイマップは「mymap:地図の名前」 */
  key: string;
  /** 表示する名前 */
  list: string;
  kind: 'list' | 'mymap';
  count: number;
}

/** 保存リストの店の位置をどこから得たか：保存した場所（Takeout）・地図に落としたピンの URL・OSM の施設の名前 */
/** 位置の出どころ。takeout は保存した場所・クチコミ・マイマップの同じ店（cid）、mymap はマイマップの点、pin は地図に落としたピン */
export type ListGeo = 'takeout' | 'mymap' | 'pin' | 'osm';

export interface ListEntry {
  title: string;
  memo: string;
  comment: string;
  /** Google マップで開く URL */
  mapsUrl: string;
  lat: number | null;
  lng: number | null;
  geo: ListGeo | null;
  /** geo が osm のとき、照らし合わせた施設の名前 */
  osmName?: string;
  /** 位置が分からないとき、同じ名前の OSM の施設が離れて複数あった数（どれか決められなかった） */
  candidates?: number;
  /** タイムラインにある場所（なければ null） */
  place: { placeId: string; count: number; lastDate: string; distM: number } | null;
}

export interface ListEntriesResponse {
  list: string;
  entries: ListEntry[];
  /** OSM の施設のデータを入れてあるか、名前で照らし合わせる索引があるか */
  osm: { pois: number; keys: number };
}

/** GET /api/health（ログインなしで見られる）：動いているサーバーの版・起動の日時・ビルドの日時とコミット */
export interface HealthResponse {
  version: string;
  /** 起動した日時 */
  startedAt: string;
  /** 動いている dist/server.mjs の日時（起動したときの値） */
  builtAt: string;
  /** ビルドの元にしたコミット（短い形。Git のない場所でビルドしたときは空）と、コミットしていない変更があったか */
  commit: string;
  dirty: boolean;
}
