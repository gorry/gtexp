#!/bin/sh
# 最新版に更新してビルドする。リポジトリを展開したフォルダーの中のどこからでも実行できる:
#   sh deploy/update.sh
# 終わったらサービスを再起動する（Linux: sudo systemctl restart gtexp / FreeBSD: sudo service gtexp restart）。
# 設定（gtexp.config.json）・データ（data/）・ログ（log/）は git の管理外なので、更新しても変わらない。
cd "$(dirname "$0")/.." || exit 1
set -e
git pull --ff-only
# ビルドに devDependencies が要るので、NODE_ENV=production の環境でも入れる
npm ci --include=dev
npm run build
echo "ビルドしました。サービスを再起動してください（Linux: sudo systemctl restart gtexp / FreeBSD: sudo service gtexp restart）"
