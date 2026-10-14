import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { rebuildLabelStops, type LabelStopOptions } from './labelstops';
import { loadedKey } from './labelstore';
import { OSM_ADDR_SOURCE } from './osm';
import { SWARM_SOURCE } from './swarm';
import { TAKEOUT_SOURCES } from './takeout';
import { transaction } from './tx';

// 取り込みの画面から、送ったデータを消す（タイムライン・Google Takeout・Foursquare Swarm のそれぞれ）。
// 自分で付けた名前・メモ・タグ（place_notes）とブックマークは、送ったデータではないので残す。
// dir は利用者のフォルダー（data/users/<名前>）

/**
 * タイムラインを消す：滞在（推定の立ち寄りも）・移動・経路の点・旅行・場所の集計・取り込みの履歴と、取り込んだ元のファイル。
 * 場所に付けた住所・地点名（と調べた記録）も、場所がなくなるので消す（取り込み直したときに調べ直す）。
 * ただし OpenStreetMap の住所は、公開サーバーに少しずつ問い合わせて貯めたもので取り直しに時間がかかるので残す
 * （場所の ID ごとに持つので、取り込み直せば同じ場所にまた付く）
 */
export function deleteTimeline(db: DatabaseSync, dir: string): void {
  transaction(db, () => {
    db.exec(`
      DELETE FROM visits; DELETE FROM activities; DELETE FROM path_points; DELETE FROM trips; DELETE FROM places;
      DELETE FROM imports;
    `);
    db.prepare('DELETE FROM place_labels WHERE source <> ?').run(OSM_ADDR_SOURCE);
    db.prepare('DELETE FROM label_checks WHERE source <> ?').run(OSM_ADDR_SOURCE);
  });
  rmSync(join(dir, 'imports'), { recursive: true, force: true });
}

/** 取得方法ごとの、地点に付けた名前・住所と、調べた記録・入れた日時を消す */
function deleteSources(db: DatabaseSync, sources: readonly string[]): void {
  const marks = sources.map(() => '?').join(',');
  db.prepare(`DELETE FROM place_labels WHERE source IN (${marks})`).run(...sources);
  db.prepare(`DELETE FROM label_checks WHERE source IN (${marks})`).run(...sources);
  db.prepare(`DELETE FROM kv WHERE key IN (${marks})`).run(...sources.map(loadedKey));
}

/**
 * Google Takeout を消す：保存した場所・ラベル・保存リスト・クチコミ・マイマップと、そこから付けた地点名・住所、
 * 取り出して置いたファイル。ラベルを付けた場所への推定の立ち寄りもなくなるので、作り直す（ラベルがなければ消えるだけ）
 */
export function deleteTakeout(db: DatabaseSync, dir: string, stops: LabelStopOptions): void {
  transaction(db, () => {
    db.exec('DELETE FROM takeout_places; DELETE FROM takeout_lists; DELETE FROM takeout_mymaps;');
    deleteSources(db, TAKEOUT_SOURCES);
  });
  rebuildLabelStops(db, stops);
  rmSync(join(dir, 'takeout'), { recursive: true, force: true });
}

/** Foursquare Swarm を消す：チェックインと、そこから付けた店の名前、取り出して置いたファイル */
export function deleteSwarm(db: DatabaseSync, dir: string): void {
  transaction(db, () => {
    db.exec('DELETE FROM swarm_checkins');
    deleteSources(db, [SWARM_SOURCE]);
  });
  rmSync(join(dir, 'swarm'), { recursive: true, force: true });
}
