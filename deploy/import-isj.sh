#!/bin/sh
# data/isj/ に置いた位置参照情報の zip を入れる（全員で使うデータ）: sh deploy/import-isj.sh
cd "$(dirname "$0")/.." || exit 1
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH
exec "${NODE:-node}" --max-old-space-size=2048 ./dist/server.mjs import-isj data/isj/*.zip
