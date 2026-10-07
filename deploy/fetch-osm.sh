#!/bin/sh
# OpenStreetMap（Nominatim）から、まだ調べていない地点の住所を少しずつ取る。cron から毎時起動する。
# 例（crontab -e）: 5 * * * * sh $HOME/gtexp/deploy/fetch-osm.sh >> $HOME/gtexp/log/osm.log 2>&1
# node が PATH にない場所（nvm など）にあるときは、NODE=/path/to/node を crontab の行の前に書く。
cd "$(dirname "$0")/.." || exit 1
# cron の PATH は短いので、よく使う場所を足す（FreeBSD のパッケージは /usr/local/bin）
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH
# 毎回出る SQLite の ExperimentalWarning をログに出さない
export NODE_NO_WARNINGS=1
exec "${NODE:-node}" ./dist/server.mjs fetch-osm --limit 150
