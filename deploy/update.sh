#!/bin/sh
# 最新版に更新してビルドする（どこから実行してもよい）:
#   sudo sh /home/gtexp/gtexp/deploy/update.sh [install.sh への指定]
#       … sudo できる管理者のアカウントで。更新・ビルドを動かすユーザーとして行ったあと、install.sh でサービスを入れ直して再起動し、確かめる（おすすめ）
#   sh ~/gtexp/deploy/update.sh
#       … 動かすユーザーで。更新・ビルドと確認だけ（動かすユーザーには sudo の権限を持たせないので、再起動は管理者が行う）
# 設定（gtexp.config.json）・データ（data/）・ログ（log/）は Git の管理対象外なので、更新しても変わらない。
set -eu
cd "$(dirname "$0")/.."
APP_DIR=$(pwd -P)
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH
# ビルドに devDependencies が要るので、NODE_ENV=production の環境でも入れる
UPDATE="git pull --ff-only && npm ci --include=dev && npm run build"

# 動かすユーザーとしてコマンドを実行する。su は PAM の設定によっては（Kerberos など）root からでもパスワードを聞くので、
# root からなら認証しない sudo -u か runuser（Linux）を先に使う
as_user() {
  if command -v sudo >/dev/null 2>&1; then
    sudo -H -u "$APP_USER" sh -c "PATH='$PATH'; export PATH; cd '$APP_DIR' && $1"
  elif command -v runuser >/dev/null 2>&1; then
    HOME="$USER_HOME" runuser -u "$APP_USER" -- sh -c "cd '$APP_DIR' && $1"
  else
    HOME="$USER_HOME" su -m "$APP_USER" -c "cd '$APP_DIR' && $1"
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  # 管理者で実行したときは、更新とビルドは展開したフォルダーの持ち主で行う（root の持ち物のファイルを作らない）
  if [ "$(uname -s)" = FreeBSD ]; then OWNER=$(stat -f %Su "$APP_DIR"); else OWNER=$(stat -c %U "$APP_DIR"); fi
  [ "$OWNER" != root ] || { echo "エラー: 展開したフォルダーが root の持ち物です。動かすユーザーの持ち物にしてください" >&2; exit 1; }
  APP_USER=$OWNER
  USER_HOME=$(eval echo "~$OWNER")
  as_user "$UPDATE"
  exec sh deploy/install.sh "$@"
fi

sh -c "$UPDATE"
node dist/server.mjs check || true
echo "ビルドしました。管理者のアカウントで、サービスを入れ直して再起動してください: sudo sh $APP_DIR/deploy/install.sh"
