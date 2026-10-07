#!/bin/sh
# gtexp をサービスとして設置する（設置のやり直し・更新後の再起動もこれで）。
# リポジトリを展開したあと、sudo できる管理者のアカウントで実行する（どこから実行してもよい）:
#   sudo sh /home/gtexp/gtexp/deploy/install.sh [--user 動かすユーザー] [--osm-cron]
# 動かすユーザーには sudo の権限を持たせない。root で行うのは、サービスの定義を入れること・持ち主をそろえること・
# 再起動・crontab の書き換えだけで、ビルドや確認は動かすユーザーとして行う。
#     --user      動かすユーザー（省くと、展開したフォルダーの持ち主）
#     --osm-cron  OpenStreetMap（Nominatim）から住所を少しずつ取る cron の行を入れる
# 対応する OS は Linux（systemd）と FreeBSD（rc.d）。何度実行してもよい（今の状態を見て、足りないところだけ直す）。
# ファイルは消さない（前の置き方の名残りがあっても、動作に影響しなければそのまま。最後の確認で知らせる）。
# Web サーバー（Apache / nginx）の設定は、ほかのサイトとの兼ね合いがあるので入れない（設置手順の「5」を参照）。
set -eu
cd "$(dirname "$0")/.."
APP_DIR=$(pwd -P)
APP_USER=""
OSM_CRON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user) APP_USER="${2:-}"; shift 2 ;;
    --osm-cron) OSM_CRON=1; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "知らない指定です: $1（sudo sh $APP_DIR/deploy/install.sh --help）" >&2; exit 1 ;;
  esac
done

step() { echo "== $*"; }
fail() { echo "エラー: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "sudo できる管理者のアカウントで実行してください: sudo sh $APP_DIR/deploy/install.sh"
OS=$(uname -s)
case "$OS" in Linux | FreeBSD) ;; *) fail "対応していない OS です: $OS" ;; esac

# ---- 動かすユーザー ----
if [ -z "$APP_USER" ]; then
  if [ "$OS" = FreeBSD ]; then APP_USER=$(stat -f %Su "$APP_DIR"); else APP_USER=$(stat -c %U "$APP_DIR"); fi
fi
[ "$APP_USER" != root ] || fail "root では動かしません。展開したフォルダーを動かすユーザーの持ち物にするか、--user で指定してください"
id "$APP_USER" >/dev/null 2>&1 || fail "ユーザー $APP_USER がいません"
APP_GROUP=$(id -gn "$APP_USER")
USER_HOME=$(eval echo "~$APP_USER")
step "展開したフォルダー: $APP_DIR　動かすユーザー: $APP_USER（$OS）"

PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH
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

# ---- Node.js ----
NODE="${NODE:-$(command -v node || true)}"
[ -n "$NODE" ] || fail "node が見つかりません（Node.js 22.13 以上を入れるか、NODE=/path/to/node を付けて実行してください）"
"$NODE" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" ||
  fail "Node.js が古い（$("$NODE" --version)）。22.13 以上を入れてください"
step "Node.js: $NODE（$("$NODE" --version)）"

# ---- 持ち主 ----
if [ -n "$(find "$APP_DIR" ! -user "$APP_USER" -print 2>/dev/null | head -n 1)" ]; then
  step "持ち主を $APP_USER にそろえます"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
fi

# ---- ビルド（まだなければ）----
if [ ! -f dist/server.mjs ] || [ ! -f dist/public/index.html ]; then
  step "ビルドします（npm ci && npm run build）"
  as_user "npm ci --include=dev && npm run build"
fi

# ---- 設定ファイルとログのフォルダー ----
if [ ! -f gtexp.config.json ]; then
  step "設定ファイルを作ります（mapsApiKey を書いてください）: $APP_DIR/gtexp.config.json"
  cp deploy/gtexp.config.example.json gtexp.config.json
  chown "$APP_USER:$APP_GROUP" gtexp.config.json
fi
chmod 600 gtexp.config.json
if [ ! -d log ]; then
  mkdir log
  chown "$APP_USER:$APP_GROUP" log
fi

# ---- サービス ----
if [ "$OS" = Linux ]; then
  UNIT=/etc/systemd/system/gtexp.service
  TMP=$(mktemp)
  sed -e "s|^User=.*|User=$APP_USER|" \
    -e "s|^Group=.*|Group=$APP_GROUP|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
    -e "s|^Environment=GTEXP_CONFIG=.*|Environment=GTEXP_CONFIG=$APP_DIR/gtexp.config.json|" \
    -e "s|^ExecStart=[^ ]*|ExecStart=$NODE|" \
    deploy/linux/gtexp.service >"$TMP"
  if ! cmp -s "$TMP" "$UNIT" 2>/dev/null; then
    step "サービスの定義を入れます: $UNIT"
    install -m 644 "$TMP" "$UNIT"
    systemctl daemon-reload
  fi
  rm -f "$TMP"
  systemctl enable gtexp >/dev/null 2>&1
  step "サービスを（再）起動します"
  systemctl restart gtexp
else
  RC=/usr/local/etc/rc.d/gtexp
  if ! cmp -s deploy/freebsd/gtexp.rc "$RC" 2>/dev/null; then
    step "サービスの定義を入れます: $RC"
    install -m 555 deploy/freebsd/gtexp.rc "$RC"
  fi
  sysrc gtexp_enable=YES gtexp_user="$APP_USER" gtexp_dir="$APP_DIR" gtexp_node="$NODE" >/dev/null
  step "サービスを（再）起動します"
  service gtexp stop >/dev/null 2>&1 || true
  service gtexp start
fi

# ---- cron（OpenStreetMap の住所。任意）----
LINE="5 * * * * sh $APP_DIR/deploy/fetch-osm.sh >> $APP_DIR/log/osm.log 2>&1"
CURRENT=$(crontab -u "$APP_USER" -l 2>/dev/null || true)
# 有効な（# で止めていない）fetch-osm の行
ACTIVE=$(printf '%s\n' "$CURRENT" | grep 'fetch-osm\.sh' | grep -v '^[[:space:]]*#' || true)
if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "$LINE" ]; then
  step "cron の fetch-osm の行を、このフォルダーを指す 1 行に直します"
  printf '%s\n' "$CURRENT" | awk -v line="$LINE" '/fetch-osm\.sh/ && !/^[[:space:]]*#/ { if (!done) print line; done = 1; next } { print }' | crontab -u "$APP_USER" -
elif [ -z "$ACTIVE" ] && [ "$OSM_CRON" -eq 1 ]; then
  step "cron に fetch-osm の行を入れます"
  { [ -n "$CURRENT" ] && printf '%s\n' "$CURRENT"; echo "$LINE"; } | crontab -u "$APP_USER" -
elif [ -z "$ACTIVE" ]; then
  echo "（OpenStreetMap の住所を取る cron は入れていません。使うなら --osm-cron を付けて実行してください）"
fi
# ほかのユーザーの crontab に fetch-osm の行があると、問い合わせが重なって Nominatim の利用規約の間隔を超える
for dir in /var/spool/cron/crontabs /var/spool/cron /var/cron/tabs; do
  [ -d "$dir" ] || continue
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    u=$(basename "$f")
    [ "$u" = "$APP_USER" ] && continue
    if grep 'fetch-osm\.sh' "$f" | grep -qv '^[[:space:]]*#'; then
      echo "注意: ユーザー $u の crontab にも fetch-osm の行があります。重ならないよう消してください（sudo crontab -u $u -e）"
    fi
  done
done

# ---- 確認 ----
sleep 2
step "設置を確かめます"
as_user "'$NODE' dist/server.mjs check" || true
