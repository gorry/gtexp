#!/bin/sh
# OpenStreetMap の日本のデータから「名前の付いた店・施設・駅・建物」を取り出して、gtexp に入れる。
# データを入れる・新しくするときだけ実行する（地点への割り当ては、タイムラインの取り込みのたびにアプリが行う）。
#
# 準備（最初だけ）:
#   osmium-tool を入れる（Debian / Ubuntu: sudo apt install osmium-tool、FreeBSD: sudo pkg install osmium-tool）
#   mkdir -p ~/gtexp/data/osm
#   curl -L -o ~/gtexp/data/osm/japan-latest.osm.pbf https://download.geofabrik.de/asia/japan-latest.osm.pbf
#   （約 2GB。Geofabrik は毎日更新している。新しくしたいときは同じようにダウンロードし直す）
#
# 実行: sh ~/gtexp/deploy/make-osm-poi.sh [pbf ファイル]
# 出典：© OpenStreetMap contributors（ODbL）

cd "$(dirname "$0")/.." || exit 1
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH
PBF="${1:-data/osm/japan-latest.osm.pbf}"
OUT=data/osm
set -e

if [ ! -f "$PBF" ]; then
  echo "$PBF がありません。上の「準備」を見て、OSM のデータをダウンロードしてください。" >&2
  exit 1
fi
mkdir -p "$OUT"

echo "$(date) 1/4 施設のタグを持つものを取り出す"
osmium tags-filter "$PBF" \
  nwr/amenity nwr/shop nwr/tourism nwr/leisure nwr/office nwr/healthcare nwr/craft nwr/historic \
  nwr/aeroway nwr/railway=station,halt nwr/public_transport=station nwr/building \
  -o "$OUT/poi-keys.osm.pbf" --overwrite

echo "$(date) 2/4 そのうち名前の付いたものだけにする"
osmium tags-filter "$OUT/poi-keys.osm.pbf" nwr/name -o "$OUT/poi.osm.pbf" --overwrite

echo "$(date) 3/4 1行1施設の GeoJSON にする"
osmium export "$OUT/poi.osm.pbf" -f geojsonseq -a type,id --geometry-types=point,polygon \
  -o "$OUT/poi.geojsonseq" --overwrite

echo "$(date) 4/4 gtexp に入れる"
export NODE_NO_WARNINGS=1
"${NODE:-node}" --max-old-space-size=2048 ./dist/server.mjs import-osm-poi "$OUT/poi.geojsonseq"

rm -f "$OUT/poi-keys.osm.pbf"
echo "$(date) 終わりました。画面の「取り込み」の「今すぐ調べる」か、次のタイムラインの取り込みで、地点に施設名が付きます。"
