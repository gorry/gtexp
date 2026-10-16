import type { AssignStats, PlaceLabel, Visit } from '../shared/types';

// 表示用の変換

const SEMANTIC_LABELS: Record<string, string> = {
  HOME: '自宅',
  INFERRED_HOME: '自宅（推定）',
  WORK: '職場',
  INFERRED_WORK: '職場（推定）',
  SEARCHED_ADDRESS: '検索した住所',
  ALIASED_LOCATION: '登録した場所',
};

/** 住所の短い表記（例：千代田区丸の内一丁目）。名前の代わりに使う */
export function areaShort(label: PlaceLabel | null | undefined): string {
  return label ? label.shortText || label.text : '';
}

/** 住所の全体の表記（都道府県から） */
export function areaFull(label: PlaceLabel | null | undefined): string {
  return label?.text ?? '';
}

export function semanticLabel(type: string): string {
  return SEMANTIC_LABELS[type] ?? '';
}

const ACTIVITY_LABELS: Record<string, [string, string]> = {
  WALKING: ['🚶', '徒歩'],
  RUNNING: ['🏃', 'ランニング'],
  CYCLING: ['🚲', '自転車'],
  IN_PASSENGER_VEHICLE: ['🚗', '車'],
  MOTORCYCLING: ['🏍️', 'バイク'],
  IN_BUS: ['🚌', 'バス'],
  IN_TRAIN: ['🚆', '電車'],
  IN_SUBWAY: ['🚇', '地下鉄'],
  IN_TRAM: ['🚋', '路面電車'],
  IN_FERRY: ['⛴️', 'フェリー'],
  FLYING: ['✈️', '飛行機'],
  SKIING: ['⛷️', 'スキー'],
};

/** 移動手段の一覧（表示順） */
export const ACTIVITY_TYPES = Object.keys(ACTIVITY_LABELS);

export function activityLabel(type: string): [string, string] {
  return ACTIVITY_LABELS[type] ?? ['➡️', '移動'];
}

/** 元データの時刻文字列から、その土地の時刻 HH:MM を取り出す */
export function hhmm(local: string): string {
  return local.slice(11, 16);
}

/** 選んだ日と違う日なら日付も付ける */
export function timeOnDay(local: string, date: string): string {
  const d = local.slice(0, 10);
  return d === date ? hhmm(local) : `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${hhmm(local)}`;
}

export function duration(startMs: number, endMs: number): string {
  const min = Math.round((endMs - startMs) / 60_000);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間${min % 60 ? `${min % 60}分` : ''}`;
  // 日の単位になったら、時間が 0 でも「5日 0時間」のように出す
  return `${Math.floor(h / 24)}日 ${h % 24}時間`;
}

export function km(meters: number): string {
  return meters >= 10_000 ? `${Math.round(meters / 1000).toLocaleString()}km` : `${(meters / 1000).toFixed(1)}km`;
}

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function dateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEKDAYS[d.getUTCDay()]}）`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayIn(tzOffsetMinutes: number): string {
  return new Date(Date.now() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

// 「ChIJAAAAAAAAAAAR」で始まる placeId は自宅など非公開の場所で、Google マップでは開けない
function isPublicPlaceId(placeId: string | undefined): placeId is string {
  // label: で始まるのは、ラベルを付けた場所への推定の立ち寄りのために作った場所（Google の placeId ではない）
  return !!placeId && !placeId.startsWith('ChIJAAAAAAAAAAAR') && !placeId.startsWith('label:');
}

export function googleMapsUrl(lat: number, lng: number, placeId?: string): string {
  const q = new URLSearchParams({ api: '1', query: `${lat},${lng}` });
  if (isPublicPlaceId(placeId)) q.set('query_place_id', placeId);
  return `https://www.google.com/maps/search/?${q}`;
}

/** placeId だけで Google マップを開く（旅行の行き先など、座標の分からない場所用） */
export function googleMapsPlaceUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
}

export function googleEarthUrl(lat: number, lng: number): string {
  return `https://earth.google.com/web/search/${lat},${lng}`;
}

/** 主な滞在（hierarchyLevel 0）にだけ 1, 2, 3… と番号を振る */
export function visitNumbers(visits: Visit[]): Map<number, number> {
  const map = new Map<number, number>();
  let n = 0;
  for (const v of visits) if (v.hierarchyLevel === 0) map.set(v.id, ++n);
  return map;
}

/** 滞在時間の合計。長いものは日と時間で出す（時間が 0 でも「5日 0時間」のように出す） */
export function totalDuration(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}分`;
  if (h < 48) return `${Math.round(h)}時間`;
  const hours = Math.round(h);
  return `${Math.floor(hours / 24).toLocaleString()}日 ${hours % 24}時間`;
}

/** YYYY-MM-DD → 2024/5/25（土） */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS[d.getUTCDay()]}）`;
}

/** 住所・地点名の割り当ての結果の説明。調べた取得方法だけを出す */
export function assignSummary(r: AssignStats): string {
  const parts = r.bySource.map((s) => `${s.name}: ${s.assigned.toLocaleString()}件`);
  return `${r.checked.toLocaleString()} か所の住所・地点名を照合しました（${parts.join('、')}）`;
}
