import type { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { transaction } from './tx';
import { distM, getKv, loadedKey, markChecked, setKv, type Target } from './labelstore';
import { buildPoiKeys, poiCounts } from './lists';

// OpenStreetMap の施設名を手元のデータから付ける（取得方法 osm-poi）。
//
// 公開の Overpass サーバーは混雑で応答しないことが多く、問い合わせて取る方式は不安定なので、
// 日本の OSM データ（Geofabrik の japan-latest.osm.pbf）から osmium-tool で「名前の付いた店・施設・駅・建物」だけを
// 取り出した GeoJSON（1行1施設、osmium export -f geojsonseq）を osm_pois テーブルに入れ、手元で探す。
// 作業は位置参照情報と同じく2つに分かれる：
// 1. データを入れる（import-osm-poi。データを新しくしたいときだけ）。入れた日時を kv に記録する
// 2. 地点に割り当てる（タイムラインの取り込みのたびと「今すぐ照合する」。areas.ts の assignForImport から呼ぶ）
// 出典：© OpenStreetMap contributors（ODbL）

const SOURCE = 'osm-poi';

/** 施設がこれより離れていたら、その地点の施設名とはみなさない */
const POI_MAX_M = 60;

/** 施設とみなすタグのキー（この順に見て、最初にあったものを種類とする） */
export const POI_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft', 'historic', 'aeroway', 'railway', 'public_transport', 'building'];

/**
 * 施設の種類による「距離の上乗せ（m）」。店や施設そのものを優先し、駅・建物・ホームなどは少し不利にする
 * （店に行ったのに、隣接する駅や建物の名前が選ばれないように）
 */
export function poiPenalty(kind: string, type: string): number {
  if (['amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft', 'historic'].includes(kind)) return 0;
  if ((kind === 'railway' && type === 'station') || (kind === 'public_transport' && type === 'station') || (kind === 'aeroway' && ['aerodrome', 'terminal'].includes(type))) return 15;
  if (kind === 'building') return 25;
  return 40; // ホーム・停留所・線路など
}

/** GeoJSON の形から代表点を求める（点はそのまま、面は外周の頂点の平均） */
function centerOf(geometry: any): [number, number] | null {
  if (!geometry) return null;
  let ring: number[][] | undefined;
  if (geometry.type === 'Point') return [geometry.coordinates[1], geometry.coordinates[0]];
  if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
  else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates[0]?.[0];
  else if (geometry.type === 'LineString') ring = geometry.coordinates;
  if (!ring?.length) return null;
  let lat = 0;
  let lng = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  return [lat / ring.length, lng / ring.length];
}

/**
 * osmium export -f geojsonseq の出力を osm_pois に入れる（全部を置き換える）。地点への割り当てはしない。
 * 1行が1施設。行頭のレコード区切り文字（0x1E）は付いていてもいなくてもよい
 */
export async function importOsmPois(db: DatabaseSync, path: string): Promise<{ pois: number; skipped: number }> {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  const ins = db.prepare('INSERT INTO osm_pois (osm_id, name, kind, type, lat, lng) VALUES (?, ?, ?, ?, ?, ?)');
  let pois = 0;
  let skipped = 0;
  let batch = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM osm_pois');
    for await (const raw of rl) {
      const line = raw.replace(/^\x1e/, '').trim();
      if (!line) continue;
      let f: any;
      try {
        f = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      const p = f.properties ?? {};
      let name: string = p['name:ja'] || p.name;
      // チェーン店は name が「〇〇ストア」、branch が「△△駅前店」のように分かれていることがあるので、つなげる
      if (name && p.branch && !name.includes(p.branch)) name = `${name} ${p.branch}`;
      const kind = POI_KEYS.find((k) => p[k]);
      const c = centerOf(f.geometry);
      if (!name || !kind || !c) {
        skipped++;
        continue;
      }
      const id = p['@type'] && p['@id'] ? `${p['@type']}/${p['@id']}` : String(f.id ?? '');
      ins.run(id, name, kind, String(p[kind]), c[0], c[1]);
      pois++;
      // 大きいファイルでもトランザクションが膨らみすぎないよう、ときどき区切る
      if (++batch >= 50_000) {
        db.exec('COMMIT');
        db.exec('BEGIN');
        batch = 0;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  buildPoiKeys(db);
  setKv(db, loadedKey(SOURCE), new Date().toISOString());
  return { pois, skipped };
}

/** 地点に施設名を付ける。60m 以内の施設から「距離＋種類による上乗せ」がいちばん小さいものを選ぶ。付けた数を返す */
export function assignOsmPoi(db: DatabaseSync, targets: Target[]): number {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM osm_pois').get() as any).n as number;
  if (!count || !targets.length) return 0;
  // 60m を緯度経度に直した範囲（経度は緯度によって縮むので、日本の北端でも足りるよう広めにとる）
  const dLat = POI_MAX_M / 111_320;
  const near = db.prepare('SELECT osm_id, name, kind, type, lat, lng FROM osm_pois WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
  const upsert = db.prepare(
    `INSERT INTO place_labels (place_id, source, kind, text, short_text, detail, dist_m, updated_at) VALUES (?, '${SOURCE}', 'name', ?, ?, ?, ?, ?)
     ON CONFLICT(place_id, source) DO UPDATE SET text = excluded.text, short_text = excluded.short_text,
       detail = excluded.detail, dist_m = excluded.dist_m, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare(`DELETE FROM place_labels WHERE place_id = ? AND source = '${SOURCE}'`);
  const now = new Date().toISOString();
  let assigned = 0;
  transaction(db, () => {
    for (const t of targets) {
      const dLng = dLat / Math.cos((t.lat * Math.PI) / 180);
      let best: any = null;
      let bestScore = Infinity;
      let bestD = 0;
      for (const r of near.all(t.lat - dLat, t.lat + dLat, t.lng - dLng, t.lng + dLng) as any[]) {
        const d = distM(t.lat, t.lng, r.lat, r.lng);
        if (d > POI_MAX_M) continue;
        const score = d + poiPenalty(r.kind, r.type);
        if (score < bestScore) [best, bestScore, bestD] = [r, score, d];
      }
      if (best) {
        const detail = JSON.stringify({ category: best.kind, type: best.type, osm: best.osm_id });
        upsert.run(t.place_id, best.name, best.name, detail, Math.round(bestD), now);
        assigned++;
      } else {
        remove.run(t.place_id);
      }
    }
    markChecked(db, SOURCE, targets, now);
  });
  return assigned;
}

export function osmPoiStatus(db: DatabaseSync): { pois: number; loadedAt: string | null } {
  const { pois } = poiCounts(db);
  const loadedAt = getKv(db, loadedKey(SOURCE));
  return { pois, loadedAt };
}
