import type { DatabaseSync } from 'node:sqlite';
import type { ListEntriesResponse, ListEntry, ListSummary } from '../shared/types';
import { distM } from './labelstore';
import { poiPenalty } from './osmpoi';
import { transaction } from './tx';

// Takeout の保存リストを見る（保存リストのタブ）。タイムラインのデータは読むだけで変えない。
//
// 保存リストの CSV には座標がない（店名・メモ・URL だけ）ので、店の位置は次の順に探す：
// 1. takeout：Takeout の「保存した場所」に同じ店（cid）があれば、その座標
// 2. pin：地図に落としたピンなら、URL（/maps/search/緯度,経度）の座標
// 3. osm：店名を OSM の施設の名前と照らし合わせる（nameKey でそろえて完全一致）。同じ名前の施設が離れて複数あれば決めない
//
// タイムラインにあるかは、1 なら地点名の割り当て（takeout-saved の cid）、2・3 ならその位置から takeoutNearM 以内の
// いちばん近い滞在先で決める

/** 同じ名前の施設がこれより離れて複数あれば、どれか決めない（同じ店が点と建物で 2 回描かれていることはある） */
const SAME_POI_M = 300;

/** 名前の照らし合わせ用にそろえる（全角・半角、大文字・小文字、空白や記号の違い、末尾の「店」の有無を無視） */
export function nameKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・·･\-‐‑–—―_.,、。'’"“”()（）[\]［］【】「」『』〈〉<>/&!?:〜~]/g, '')
    .replace(/店$/, '');
}

/** 保存リストの店名から、照らし合わせに使う名前（括弧の中の別名などを除いたものも） */
function titleKeys(title: string): string[] {
  const keys = [nameKey(title), nameKey(title.replace(/[【（(［[].*?[】）)］\]]/g, ''))];
  return [...new Set(keys.filter((k) => k.length >= 2))];
}

/** OSM の施設を名前で探す索引を作り直す（import-osm-poi のあと） */
export function buildPoiKeys(db: DatabaseSync): number {
  const ins = db.prepare('INSERT INTO osm_poi_keys (key, poi) VALUES (?, ?)');
  let n = 0;
  transaction(db, () => {
    db.exec('DELETE FROM osm_poi_keys');
    for (const r of db.prepare('SELECT rowid AS id, name FROM osm_pois').iterate() as Iterable<any>) {
      const key = nameKey(r.name);
      if (key.length < 2) continue;
      ins.run(key, r.id);
      n++;
    }
  });
  return n;
}

export function listNames(db: DatabaseSync): ListSummary[] {
  return db.prepare('SELECT list, COUNT(*) AS count FROM takeout_lists GROUP BY list ORDER BY count DESC, list').all() as any[];
}

export function listEntries(db: DatabaseSync, list: string, nearM: number): ListEntriesResponse {
  const rows = db.prepare('SELECT rowid, cid, title, memo, comment, url FROM takeout_lists WHERE list = ? ORDER BY rowid').all(list) as any[];
  // 店（cid）ごとの、保存した場所の座標と、地点名の割り当てでその店が付いた滞在先（複数あれば回数の多いもの）。
  // 1 店ずつ問い合わせると索引がなく遅いので、先にまとめて読む
  const savedOf = new Map<string, { lat: number; lng: number }>();
  for (const r of db.prepare("SELECT cid, lat, lng FROM takeout_places WHERE kind = 'saved' AND cid IS NOT NULL").all() as any[]) {
    if (!savedOf.has(r.cid)) savedOf.set(r.cid, { lat: r.lat, lng: r.lng });
  }
  const labeledOf = new Map<string, { place_id: string; dist_m: number }>();
  for (const r of db
    .prepare(
      `SELECT json_extract(l.detail, '$.cid') AS cid, l.place_id, l.dist_m FROM place_labels l JOIN places p ON p.place_id = l.place_id
       WHERE l.source = 'takeout-saved' ORDER BY p.visit_count DESC`,
    )
    .all() as any[]) {
    if (r.cid && !labeledOf.has(r.cid)) labeledOf.set(r.cid, r);
  }
  const placesIn = db.prepare('SELECT place_id, lat, lng FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
  const visitsOf = db.prepare('SELECT COUNT(*) AS n, MAX(local_date) AS last FROM visits WHERE place_id = ?');
  const keyCount = (db.prepare('SELECT COUNT(*) AS n FROM osm_poi_keys').get() as any).n as number;
  const poiCount = (db.prepare('SELECT COUNT(*) AS n FROM osm_pois').get() as any).n as number;
  const poisOf = db.prepare('SELECT p.name, p.kind, p.type, p.lat, p.lng FROM osm_poi_keys k JOIN osm_pois p ON p.rowid = k.poi WHERE k.key = ?');

  const placeInfo = (placeId: string, d: number): ListEntry['place'] => {
    const v = visitsOf.get(placeId) as any;
    return { placeId, count: v.n, lastDate: v.last ?? '', distM: Math.round(d * 10) / 10 };
  };
  const nearestPlace = (lat: number, lng: number): ListEntry['place'] => {
    const dLat = nearM / 111_320;
    const dLng = dLat / Math.cos((lat * Math.PI) / 180);
    let best: string | null = null;
    let bestD = Infinity;
    for (const p of placesIn.all(lat - dLat, lat + dLat, lng - dLng, lng + dLng) as any[]) {
      const d = distM(lat, lng, p.lat, p.lng);
      if (d <= nearM && d < bestD) [best, bestD] = [p.place_id, d];
    }
    return best ? placeInfo(best, bestD) : null;
  };
  /** 店名で OSM の施設を探す。見つからなければ null、離れて複数あれば候補の数 */
  const findPoi = (title: string): { name: string; lat: number; lng: number } | number | null => {
    if (!keyCount) return null;
    for (const key of titleKeys(title)) {
      const found = poisOf.all(key) as any[];
      if (!found.length) continue;
      if (found.some((p) => distM(found[0].lat, found[0].lng, p.lat, p.lng) > SAME_POI_M)) return found.length;
      // 同じ店が点と建物などで重なっているときは、店そのものを選ぶ
      found.sort((a, b) => poiPenalty(a.kind, a.type) - poiPenalty(b.kind, b.type));
      return found[0];
    }
    return null;
  };

  const entries: ListEntry[] = rows.map((r) => {
    const e: ListEntry = {
      title: r.title,
      memo: r.memo,
      comment: r.comment,
      mapsUrl: r.url || (r.cid ? `https://maps.google.com/?cid=${r.cid}` : ''),
      lat: null,
      lng: null,
      geo: null,
      place: null,
    };
    const saved = r.cid ? savedOf.get(r.cid) : null;
    if (saved) {
      [e.lat, e.lng, e.geo] = [saved.lat, saved.lng, 'takeout'];
      const l = labeledOf.get(r.cid);
      e.place = l ? placeInfo(l.place_id, l.dist_m ?? 0) : null;
      return e;
    }
    const pin = /\/maps\/search\/(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(r.url ?? '');
    if (pin) [e.lat, e.lng, e.geo] = [Number(pin[1]), Number(pin[2]), 'pin'];
    else {
      const poi = findPoi(r.title);
      if (typeof poi === 'number') e.candidates = poi;
      else if (poi) [e.lat, e.lng, e.geo, e.osmName] = [poi.lat, poi.lng, 'osm', poi.name];
    }
    if (e.lat != null && e.lng != null) e.place = nearestPlace(e.lat, e.lng);
    return e;
  });
  return { list, entries, osm: { pois: poiCount, keys: keyCount } };
}
