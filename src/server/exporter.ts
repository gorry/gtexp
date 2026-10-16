import type { DatabaseSync } from 'node:sqlite';
import type { Activity, PlaceSummary, Visit } from '../shared/types';
import { PROFILE } from '../shared/profile.gen';

// 絞り込んだ記録を CSV / KML / GPX / GeoJSON に書き出す。
// 滞在と場所は点、移動は経路の点を結んだ線（経路の点がなければ始点と終点を結ぶ）。

export type ExportFormat = 'csv' | 'kml' | 'gpx' | 'geojson';
export const EXPORT_FORMATS: ExportFormat[] = ['csv', 'kml', 'gpx', 'geojson'];

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  kml: 'application/vnd.google-earth.kml+xml; charset=utf-8',
  gpx: 'application/gpx+xml; charset=utf-8',
  geojson: 'application/geo+json; charset=utf-8',
};

export type ExportData =
  | { kind: 'visits'; items: Visit[] }
  | { kind: 'activities'; items: Activity[] }
  | { kind: 'places'; items: PlaceSummary[] };

const SEMANTIC: Record<string, string> = {
  HOME: '自宅',
  INFERRED_HOME: '自宅（推定）',
  WORK: '職場',
  INFERRED_WORK: '職場（推定）',
  SEARCHED_ADDRESS: '検索した住所',
  ALIASED_LOCATION: '登録した場所',
};

const MODES: Record<string, string> = {
  WALKING: '徒歩',
  RUNNING: 'ランニング',
  CYCLING: '自転車',
  IN_PASSENGER_VEHICLE: '車',
  MOTORCYCLING: 'バイク',
  IN_BUS: 'バス',
  IN_TRAIN: '電車',
  IN_SUBWAY: '地下鉄',
  IN_TRAM: '路面電車',
  IN_FERRY: 'フェリー',
  FLYING: '飛行機',
  SKIING: 'スキー',
};

const modeName = (type: string) => MODES[type] ?? '移動';

/** 名前の決め方は画面と同じ：自分で付けた名前 → 自宅・職場など → 住所 → 名前なし */
function placeName(note: Visit['note'], semanticType: string, addr?: Visit['address'], pname?: Visit['placeName']): string {
  return note?.name || SEMANTIC[semanticType] || pname?.shortText || addr?.shortText || '名前なし';
}

/** いちばん良い住所（取得方法の優先順）の全体の表記 */
const address = (addr: Visit['address']) => addr?.text ?? '';

// 「ChIJAAAAAAAAAAAR」で始まる placeId は自宅などの非公開の場所で、Google マップでは開けない
function mapsUrl(lat: number, lng: number, placeId?: string): string {
  const q = new URLSearchParams({ api: '1', query: `${lat},${lng}` });
  if (placeId && !placeId.startsWith('ChIJAAAAAAAAAAAR')) q.set('query_place_id', placeId);
  return `https://www.google.com/maps/search/?${q}`;
}

const minutes = (startMs: number, endMs: number) => Math.round((endMs - startMs) / 60_000);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * 移動の軌跡：始点 → その時間帯の経路の点 → 終点。
 * 経路の点は Google 側で記録されていない時間帯も多く、その場合は始点と終点を結ぶだけになる
 */
function trackOf(a: Activity, stmt: ReturnType<DatabaseSync['prepare']>): [number, number, number][] {
  const pts = stmt.all(a.startMs, a.endMs).map((r: any): [number, number, number] => [r.t_ms, r.lat, r.lng]);
  const start: [number, number, number] = [a.startMs, a.startLat, a.startLng];
  const end: [number, number, number] = [a.endMs, a.endLat, a.endLng];
  const same = (p: [number, number, number], q: [number, number, number]) => p[1] === q[1] && p[2] === q[2];
  if (pts.length && same(pts[0], start)) pts.shift();
  if (pts.length && same(pts[pts.length - 1], end)) pts.pop();
  return [start, ...pts, end];
}

// ---- CSV ----

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(data: ExportData): string {
  let rows: unknown[][];
  if (data.kind === 'visits') {
    rows = [
      ['日付', '開始', '終了', '滞在（分）', '名前', '種類', '住所', 'メモ', 'タグ', '施設内', '緯度', '経度', 'placeId', 'Google マップ'],
      ...data.items.map((v) => [
        v.start.slice(0, 10), v.start, v.end, minutes(v.startMs, v.endMs), placeName(v.note, v.semanticType, v.address, v.placeName),
        SEMANTIC[v.semanticType] ?? '', address(v.address), v.note?.memo ?? '', (v.note?.tags ?? []).map((t) => `#${t}`).join(' '), v.hierarchyLevel > 0 ? '1' : '',
        v.lat, v.lng, v.placeId, mapsUrl(v.lat, v.lng, v.placeId),
      ]),
    ];
  } else if (data.kind === 'activities') {
    rows = [
      ['日付', '開始', '終了', '時間（分）', '移動手段', '距離（km）', '出発の緯度', '出発の経度', '到着の緯度', '到着の経度'],
      ...data.items.map((a) => [
        a.start.slice(0, 10), a.start, a.end, minutes(a.startMs, a.endMs), modeName(a.type),
        (a.distanceM / 1000).toFixed(2), a.startLat, a.startLng, a.endLat, a.endLng,
      ]),
    ];
  } else {
    rows = [
      ['名前', '種類', '住所', '訪問回数', '初回訪問', '最終訪問', '合計滞在時間（時間）', 'メモ', 'タグ', '緯度', '経度', 'placeId', 'Google マップ'],
      ...data.items.map((p) => [
        placeName(p.note, p.semanticType, p.address, p.placeName), SEMANTIC[p.semanticType] ?? '', address(p.address), p.count, p.firstDate, p.lastDate,
        (p.totalMs / 3_600_000).toFixed(1), p.note?.memo ?? '', (p.note?.tags ?? []).map((t) => `#${t}`).join(' '),
        p.lat, p.lng, p.placeId, mapsUrl(p.lat, p.lng, p.placeId),
      ]),
    ];
  }
  // Excel で文字化けしないよう BOM を付け、改行は CRLF にする
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---- KML ----

function xml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function toKml(db: DatabaseSync, data: ExportData, title: string): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  out.push(`<name>${xml(title)}</name>`);
  out.push('<Style id="track"><LineStyle><color>ffe8731a</color><width>3</width></LineStyle></Style>');
  if (data.kind === 'visits') {
    for (const v of data.items) {
      const desc = [`${v.start} 〜 ${v.end}（${minutes(v.startMs, v.endMs)}分）`, v.note?.memo, (v.note?.tags ?? []).map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n');
      out.push(
        `<Placemark><name>${xml(placeName(v.note, v.semanticType, v.address, v.placeName))}</name><description>${xml(desc)}</description>` +
          `<TimeSpan><begin>${xml(v.start)}</begin><end>${xml(v.end)}</end></TimeSpan>` +
          `<Point><coordinates>${v.lng},${v.lat}</coordinates></Point></Placemark>`,
      );
    }
  } else if (data.kind === 'activities') {
    const stmt = db.prepare('SELECT t_ms, lat, lng FROM path_points WHERE t_ms >= ? AND t_ms <= ? ORDER BY t_ms');
    for (const a of data.items) {
      const coords = trackOf(a, stmt).map(([, lat, lng]) => `${lng},${lat}`).join(' ');
      const desc = `${a.start} 〜 ${a.end}（${minutes(a.startMs, a.endMs)}分・${(a.distanceM / 1000).toFixed(1)}km）`;
      out.push(
        `<Placemark><name>${xml(`${a.start.slice(0, 10)} ${modeName(a.type)}`)}</name><description>${xml(desc)}</description>` +
          `<TimeSpan><begin>${xml(a.start)}</begin><end>${xml(a.end)}</end></TimeSpan><styleUrl>#track</styleUrl>` +
          `<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>`,
      );
    }
  } else {
    for (const p of data.items) {
      const desc = [`${p.count}回（${p.firstDate} 〜 ${p.lastDate}）`, p.note?.memo, (p.note?.tags ?? []).map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n');
      out.push(
        `<Placemark><name>${xml(placeName(p.note, p.semanticType, p.address, p.placeName))}</name><description>${xml(desc)}</description>` +
          `<Point><coordinates>${p.lng},${p.lat}</coordinates></Point></Placemark>`,
      );
    }
  }
  out.push('</Document></kml>');
  return out.join('\n');
}

// ---- GPX ----

function toGpx(db: DatabaseSync, data: ExportData, title: string): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<gpx version="1.1" creator="${xml(`${PROFILE.title} (${PROFILE.shortTitle}) ${PROFILE.version}`)}" xmlns="http://www.topografix.com/GPX/1/1">`);
  out.push(`<metadata><name>${xml(title)}</name></metadata>`);
  if (data.kind === 'visits') {
    for (const v of data.items) {
      const desc = [`${v.start} 〜 ${v.end}（${minutes(v.startMs, v.endMs)}分）`, v.note?.memo].filter(Boolean).join('\n');
      out.push(`<wpt lat="${v.lat}" lon="${v.lng}"><time>${iso(v.startMs)}</time><name>${xml(placeName(v.note, v.semanticType, v.address, v.placeName))}</name><desc>${xml(desc)}</desc></wpt>`);
    }
  } else if (data.kind === 'places') {
    for (const p of data.items) {
      const desc = [`${p.count}回（${p.firstDate} 〜 ${p.lastDate}）`, p.note?.memo].filter(Boolean).join('\n');
      out.push(`<wpt lat="${p.lat}" lon="${p.lng}"><name>${xml(placeName(p.note, p.semanticType, p.address, p.placeName))}</name><desc>${xml(desc)}</desc></wpt>`);
    }
  } else {
    const stmt = db.prepare('SELECT t_ms, lat, lng FROM path_points WHERE t_ms >= ? AND t_ms <= ? ORDER BY t_ms');
    for (const a of data.items) {
      const pts = trackOf(a, stmt).map(([t, lat, lng]) => `<trkpt lat="${lat}" lon="${lng}"><time>${iso(t)}</time></trkpt>`).join('');
      out.push(
        `<trk><name>${xml(`${a.start.slice(0, 10)} ${modeName(a.type)}`)}</name><desc>${xml(`${(a.distanceM / 1000).toFixed(1)}km`)}</desc>` +
          `<type>${xml(a.type)}</type><trkseg>${pts}</trkseg></trk>`,
      );
    }
  }
  out.push('</gpx>');
  return out.join('\n');
}

// ---- GeoJSON ----

function toGeoJson(db: DatabaseSync, data: ExportData): string {
  let features: unknown[];
  if (data.kind === 'visits') {
    features = data.items.map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
      properties: {
        name: placeName(v.note, v.semanticType, v.address, v.placeName), start: v.start, end: v.end, minutes: minutes(v.startMs, v.endMs),
        semanticType: v.semanticType, address: address(v.address), memo: v.note?.memo ?? '', tags: v.note?.tags ?? [], nested: v.hierarchyLevel > 0, placeId: v.placeId,
      },
    }));
  } else if (data.kind === 'activities') {
    const stmt = db.prepare('SELECT t_ms, lat, lng FROM path_points WHERE t_ms >= ? AND t_ms <= ? ORDER BY t_ms');
    features = data.items.map((a) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: trackOf(a, stmt).map(([, lat, lng]) => [lng, lat]) },
      properties: { mode: a.type, modeName: modeName(a.type), start: a.start, end: a.end, minutes: minutes(a.startMs, a.endMs), distanceM: Math.round(a.distanceM) },
    }));
  } else {
    features = data.items.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        name: placeName(p.note, p.semanticType, p.address, p.placeName), count: p.count, firstDate: p.firstDate, lastDate: p.lastDate,
        totalHours: Math.round(p.totalMs / 360_000) / 10, semanticType: p.semanticType, address: address(p.address), memo: p.note?.memo ?? '', tags: p.note?.tags ?? [], placeId: p.placeId,
      },
    }));
  }
  return JSON.stringify({ type: 'FeatureCollection', features });
}

export function render(db: DatabaseSync, format: ExportFormat, data: ExportData, title: string): string {
  if (format === 'csv') return toCsv(data);
  if (format === 'kml') return toKml(db, data, title);
  if (format === 'gpx') return toGpx(db, data, title);
  return toGeoJson(db, data);
}
