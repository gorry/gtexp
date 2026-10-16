// 場所の住所・地点名は、取得方法ごとに別々に保存する（place_labels テーブル。主キーは placeId＋取得方法）。
// 取得方法によって細かさや表記が違うので、どれか1つに決め打ちせず、全部を並べて持つ。
// 一覧や「名前の代わり」に1つだけ出すときは、ここの優先順位でいちばん良いものを選ぶ。
// 自分で付けた名前・メモ（place_notes）はこれとは別で、常に最優先。

export type LabelKind = 'address' | 'name';

export interface LabelSource {
  id: string;
  name: string;
  kind: LabelKind;
  /** 小さいほど優先 */
  priority: number;
  /** 調べたが見つからなかったときの説明 */
  missingNote: string;
  /** まだ調べていないときの説明（いつ調べるか） */
  pendingNote: string;
  /**
   * 先にデータを入れる必要がある取得方法か（位置参照情報など）。true なら、データを入れた日時（kv の
   * `${id}:loaded_at`）より前に調べた地点は「まだ調べていない」扱いになる
   */
  needsData: boolean;
}

export const LABEL_SOURCES: LabelSource[] = [
  {
    id: 'takeout-label', name: 'Google Takeout（ラベルを付けた場所）', kind: 'name', priority: 10,
    missingNote: '周辺に該当するラベル付きの場所はありません',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'takeout-saved', name: 'Google Takeout（保存した場所）', kind: 'name', priority: 20,
    missingNote: '周辺に該当する保存済みの場所はありません',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'swarm-checkin', name: 'Foursquare Swarm（チェックイン）', kind: 'name', priority: 22,
    missingNote: 'この場所に滞在していた時刻のチェックインはありません',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'takeout-review', name: 'Google Takeout（クチコミを書いた場所）', kind: 'name', priority: 25,
    missingNote: '周辺に該当するクチコミ投稿済みの場所はありません',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'takeout-mymap', name: 'Google Takeout（マイマップ）', kind: 'name', priority: 35,
    missingNote: '周辺に該当するマイマップの地点はありません',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'takeout-addr', name: 'Google Takeout（保存した場所の住所）', kind: 'address', priority: 30,
    missingNote: '周辺に該当する保存済みの場所はありません',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'isj-gaiku', name: '位置参照情報（街区）', kind: 'address', priority: 40,
    missingNote: '周辺の街区データが見つかりませんでした（都市計画区域外や郊外ではデータがない場合があります）',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'isj-oaza', name: '位置参照情報（大字・町丁目）', kind: 'address', priority: 50,
    missingNote: '周辺の住所データが見つかりませんでした（海外・海上、または位置参照情報未登録の地域）',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'osm-poi', name: 'OpenStreetMap（施設名）', kind: 'name', priority: 60,
    missingNote: '周辺に該当する施設データが見つかりませんでした（OpenStreetMap 未登録、または日本国外の地点）',
    needsData: true,
    pendingNote: '次回のデータ取り込み時、または「このアプリについて」画面の「今すぐ照合する」で照合されます',
  },
  {
    id: 'osm-addr', name: 'OpenStreetMap（住所）', kind: 'address', priority: 60,
    missingNote: 'OpenStreetMap から住所を取得できませんでした',
    needsData: false,
    pendingNote: 'サーバーの定期取得処理により、訪問頻度の高い地点から順に照合されます',
  },
];

export function sourceName(id: string): string {
  return LABEL_SOURCES.find((s) => s.id === id)?.name ?? id;
}

/** 取得方法の優先順位を返す SQL の式（alias は place_labels の別名） */
function prioritySql(alias: string): string {
  const cases = LABEL_SOURCES.map((s) => `WHEN '${s.id}' THEN ${s.priority}`).join(' ');
  return `CASE ${alias}.source ${cases} ELSE 1000 END`;
}

/**
 * placeId の列（例: "v.place_id"）に対して、いちばん良い住所を別名 pa で結合する SQL。
 * 選んだ住所の列は ADDRESS_COLUMNS で取り出す。
 */
export function bestAddressJoin(placeIdExpr: string): string {
  return `LEFT JOIN place_labels pa ON pa.place_id = ${placeIdExpr} AND pa.kind = 'address' AND pa.source = (
    SELECT l2.source FROM place_labels l2 WHERE l2.place_id = ${placeIdExpr} AND l2.kind = 'address'
    ORDER BY ${prioritySql('l2')} LIMIT 1)`;
}

export const ADDRESS_COLUMNS = 'pa.source AS addr_source, pa.text AS addr_text, pa.short_text AS addr_short, pa.dist_m AS addr_dist';

/** placeId の列に対して、いちばん良い地点名（施設名など）を別名 pn で結合する SQL。列は NAME_COLUMNS で取り出す */
export function bestNameJoin(placeIdExpr: string): string {
  return `LEFT JOIN place_labels pn ON pn.place_id = ${placeIdExpr} AND pn.kind = 'name' AND pn.source = (
    SELECT l3.source FROM place_labels l3 WHERE l3.place_id = ${placeIdExpr} AND l3.kind = 'name'
    ORDER BY ${prioritySql('l3')} LIMIT 1)`;
}

export const NAME_COLUMNS = 'pn.source AS pname_source, pn.text AS pname_text, pn.short_text AS pname_short, pn.dist_m AS pname_dist';

/** どの取得方法の住所・地点名にでも当たる検索条件（パラメーターは2つ。どちらにも同じ検索語を渡す） */
export function labelLikeSql(placeIdExpr: string): string {
  // 細かい項目（Takeout の保存リストの名前やコメントなど）でも探せるようにする
  return `EXISTS (SELECT 1 FROM place_labels lq WHERE lq.place_id = ${placeIdExpr} AND (lq.text LIKE ? ESCAPE '\\' OR lq.detail LIKE ? ESCAPE '\\'))`;
}

/** 取得方法の優先順に並べるための ORDER BY 句の式 */
export function labelOrderSql(alias: string): string {
  return prioritySql(alias);
}
