# gtexp をサーバーで動かす

サーバーにリポジトリを展開してビルドし、サービスとして常駐させる手順です。
Web サーバー（Apache または nginx）が HTTPS を受け、Node.js のサーバー（127.0.0.1:8787）に中継します。

Linux（Debian / Ubuntu）を前提に説明し、FreeBSD で異なる点は「FreeBSD の場合」として補足します。
以下、公開するホスト名を `gtexp.example.com`、アプリを動かすユーザーを `gtexp` として記載します。環境に合わせて読み替えてください。

この文書はサーバーの管理者向けです。サーバーでは、2 つのアカウントを使い分けます。

| アカウント | 役割 |
|---|---|
| 管理者（sudo できる、自分のアカウント） | パッケージ・サービス・Web サーバーの設定。この文書の `sudo` で始まるコマンドは、すべてこのアカウントで実行します |
| 動かすユーザー（`gtexp`） | gtexp を動かし、ファイルを持つ。sudo の権限は持たせません（持たせるとセキュリティ上の問題になるため）。管理者から `sudo -iu gtexp` で切り替えて使います |

データの取り込みは、次のように分担します。

| 入れる人 | データ | 方法 |
|---|---|---|
| 利用者 | 自分のタイムラインのエクスポート、自分の Google Takeout の書き出し | 画面の「取り込み」の「ファイルを選ぶ」で送る（説明は画面にあります） |
| 管理者 | 位置参照情報、OpenStreetMap の施設、OpenStreetMap の住所の定期取得（cron） | この文書の「9」「10」の手順でサーバーに入れる（全利用者で共通に使われます） |

## フォルダー構成

リポジトリを展開したフォルダー（以下 `~/gtexp`）が、そのまま実行場所になります。

```
~/gtexp/
├ dist/                 ビルド出力（server.mjs と画面のファイル。npm run build で作成）
├ gtexp.config.json     設定
├ data/                 バックアップ対象データ
│ ├ shared.sqlite       全員で使うデータ（利用者の一覧、位置参照情報、OSM の施設）
│ └ users/<利用者名>/   利用者ごとの記録（gtexp.sqlite）と、取り込んだ元ファイル（imports/*.gz）
├ log/                  cron のログ（FreeBSD ではサーバーのログも）
├ deploy/               サービス・Web サーバーの設定例と、サーバーで使うスクリプト
└ src/ など             ソース
```

`gtexp.config.json`・`data/`・`log/`・`dist/` は Git の管理対象外のため、更新（`git pull`）で消えたり上書きされたりすることはありません。

`~/gtexp` の外に置くのは、サービスと Web サーバーの設定だけです。

| 置き場所（Linux） | 置き場所（FreeBSD） | 中身 |
|---|---|---|
| `/etc/systemd/system/gtexp.service` | `/usr/local/etc/rc.d/gtexp` | サービスの定義（`deploy/install.sh` が `deploy/linux/gtexp.service` / `deploy/freebsd/gtexp.rc` から作る） |
| `/etc/apache2/sites-available/gtexp.conf` または `/etc/nginx/sites-available/gtexp` | `/usr/local/etc/apache24/Includes/gtexp.conf` または `/usr/local/etc/nginx/conf.d/gtexp.conf` | Web サーバーの設定（`deploy/linux/` / `deploy/freebsd/` の例を元に作成） |

## 1. 準備

必要なものは、Node.js 22.13 以上（npm を含む）と Git です。ビルドに使うパッケージは `npm ci` で入り、動作時に追加のライブラリは要りません。

```sh
# Node.js（ディストリビューション標準のものは古いことが多いので、NodeSource のパッケージを使う例）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git sqlite3
node --version                     # v22.13 以上であること

# アプリを動かすユーザー
sudo useradd -m -s /bin/bash gtexp
```

- `sqlite3` はバックアップに使います。
- nvm などで Node.js を入れた場合は、サービスの定義と cron で node のフルパスを指定する必要があります（後述）。

**FreeBSD の場合**

```sh
sudo pkg install node24 npm-node24 git sqlite3
sudo pw useradd gtexp -m -s /bin/sh
```

## 2. 展開して設置する

管理者のアカウントで、リポジトリを動かすユーザーのホームに展開し、設置スクリプトを実行します。

```sh
sudo -iu gtexp git clone https://github.com/gorry/gtexp.git /home/gtexp/gtexp
sudo sh /home/gtexp/gtexp/deploy/install.sh
```

`install.sh` は次のことを行います。何度実行しても構いません（今の状態を見て、足りないところだけ直します）。ファイルは消しません。

- 動かすユーザーを決める（展開したフォルダーの持ち主。`--user <名前>` で指定もできる）
- Node.js の版を確かめる（`node` が見つからないときは `NODE=/path/to/node` を付けて実行）
- フォルダーの持ち主を、動かすユーザーにそろえる
- まだビルドしていなければビルドする（`npm ci && npm run build`）
- 設定ファイルがなければ、例（`deploy/gtexp.config.example.json`）から作る。ログのフォルダーを作る
- サービスを入れて（再）起動する（Linux：`/etc/systemd/system/gtexp.service` を、展開した場所・ユーザー・node のパスを埋めて作る。FreeBSD：`/usr/local/etc/rc.d/gtexp` を置き、`sysrc` で設定する）
- cron の fetch-osm の行が別の場所を指していれば直す（`--osm-cron` を付けると、なければ入れる。「10」を参照）
- 最後に設置を確かめる（`node dist/server.mjs check`）

Web サーバー（Apache / nginx）の設定は、ほかのサイトとの兼ね合いがあるので入れません（「5」で行います）。

## 3. 設定ファイルを書き、利用者を追加する

`install.sh` が作った設定ファイルに API キーを書き、利用者を追加します。以降のコマンドは、特に記載がなければアプリを動かすユーザーで実行します。

```sh
cd ~/gtexp
vi gtexp.config.json                    # mapsApiKey を書く（「6」を参照）
node dist/server.mjs user-add alice     # 利用者を追加する（パスワードを 2 回聞かれる）
```

設定を変えたら、管理者のアカウントでサービスを再起動します（`sudo systemctl restart gtexp`。FreeBSD は `sudo service gtexp restart`。`sudo sh /home/gtexp/gtexp/deploy/install.sh` でもよい）。

| 項目 | 内容 |
|---|---|
| `dataDir` | DB と取り込んだ元ファイルの置き場所。設定ファイルからの相対パスで、既定は `./data` |
| `publicDir` | 画面のファイルの置き場所。既定は `./dist/public`（ふつうは変えない） |
| `mapsApiKey` | Maps JavaScript API のキー（「6」を参照）。空のままでも地図以外は動作する |
| `mapId` | 地図のスタイル ID。作成していなければ `DEMO_MAP_ID` のままでよい |
| `tzOffsetMinutes` | 日付の区切りに使う時差（分）。日本は 540 |

その他の項目は [memo/doc/spec.md](../memo/doc/spec.md) の「設定」を参照してください。

### 利用者

利用者どうしは独立しており、記録（タイムライン・名前・メモ・タグ・Takeout）は `data/users/<利用者名>/` に別々に保持します。共有はしません。
全員で使うのは、位置参照情報と OSM の施設（`data/shared.sqlite`）だけです。管理はコマンドで行います（サーバーは動かしたままで構いません）。

| コマンド | 内容 |
|---|---|
| `node dist/server.mjs user-add <名前>` | 利用者を追加する。名前は英小文字・数字・`_`・`-` で 32 文字まで |
| `node dist/server.mjs user-passwd <名前>` | パスワードを変更する。その利用者のログイン中の端末はすべてログアウトされる |
| `node dist/server.mjs user-del <名前>` | 対象ユーザーのログインを無効化する。記録のフォルダーは残るため、不要であれば手動で削除する |
| `node dist/server.mjs user-list` | 利用者の一覧 |

利用者の記録を扱うコマンド（`import`・`import-takeout`・`assign-areas`）は、利用者が 2 人以上いる場合は `--user <名前>` を付けます。
`fetch-osm`（cron）は、全員の分を順に回しながら取得します。

## 4. 設置を確かめる

設置の状態は、いつでも次のコマンドで確かめられます（`install.sh` と、管理者で実行した `update.sh` の最後にも実行されます）。

```sh
cd ~/gtexp && node dist/server.mjs check
```

Node.js の版、ビルドがソースより古くないか、設定ファイル（使っていない項目がないか）、画面のファイル、データのフォルダーに書き込めるか、利用者がいるか、サービスの定義が今の置き場所の `dist/server.mjs` を動かしているか、動いているサーバーが今のビルドか、cron の行を確かめ、`[要対応]`・`[注意]`・`[情報]` を直し方と一緒に出します。前の置き方の名残りのファイルなど、動作に影響しないものは `[情報]` として知らせるだけです。

サービスのログ（Linux：`journalctl -u gtexp -n 30`、FreeBSD：`tail -n 30 ~gtexp/gtexp/log/gtexp.log`）には、起動の日時・バージョン・ビルドの日時と、実際に使っている設定が 1 項目 1 行で出ます（API キーなどの秘密の値は、設定してあるかどうかだけ）。設定ファイルに書いていない項目には「（既定）」が付き、使っていない項目や、画面のファイルが見つからないときは、その旨が出ます。

### 手で入れる場合

`install.sh` を使わずにサービスを入れる場合の手順です。

- Linux：`deploy/linux/gtexp.service` の `User`・`Group`・`WorkingDirectory`・`GTEXP_CONFIG`・node のパス（`command -v node` で確認）を書き換えて `/etc/systemd/system/gtexp.service` に置き、`sudo systemctl daemon-reload && sudo systemctl enable --now gtexp`
- FreeBSD：`deploy/freebsd/gtexp.rc` を `/usr/local/etc/rc.d/gtexp` にコピーし（root で実行されるため、リンクではなくコピー）、`sudo chmod 555 /usr/local/etc/rc.d/gtexp`、`sudo sysrc gtexp_enable=YES gtexp_user=gtexp`（展開先が `/home/<ユーザー>/gtexp` 以外なら `gtexp_dir=`、node の場所が異なるなら `gtexp_node=` も）、`sudo service gtexp start`

### Web サーバーの前に

この時点で、gtexp はサーバーの中だけで `127.0.0.1:8787` を待ち受けています（設定の `host`・`port`）。サーバーの中から応答を確かめます。

```sh
curl -I http://127.0.0.1:8787/     # 「HTTP/1.1 200 OK」が返れば動いている
```

`127.0.0.1` で待ち受けているため、ほかの端末からはまだ開けません。外に公開するのは、次の「5」で設定する Web サーバーの役目です。

## 5. Web サーバーで公開する（リバースプロキシと証明書）

### 仕組み

gtexp（Node.js）は HTTPS を扱わず、サーバーの中で HTTP を待ち受けるだけです。外からの接続は、Apache または nginx のバーチャルホストで受け、gtexp に中継（リバースプロキシ）します。

```
ブラウザ ── https://gtexp.example.com/ ──▶ Apache / nginx（443 番。証明書を持ち、HTTPS を受ける）
                                                │ http://127.0.0.1:8787/ に中継
                                                ▼
                                           gtexp（Node.js）
```

HTTPS は必須です。PWA としてのインストール、「共有」からのファイルの受け取り、現在地の表示は、ブラウザが HTTPS のページでしか使わせないためです。また、ログイン Cookie にも Secure を付けます。

設定例（`deploy/linux/`・`deploy/freebsd/`）は、ホスト名ごとのバーチャルホストとして書いてあります。同じ Web サーバーでほかのサイトを動かしていても、そのまま追加できます。どの設定例も、次のことを行います。

- 80 番（HTTP）で受けたアクセスを、443 番（HTTPS）に転送する（証明書の取得に使う `/.well-known/acme-challenge/` を除く）
- 443 番で HTTPS を受け、`http://127.0.0.1:8787/` に中継する（`port` を変えた場合は、設定例の 8787 も合わせる）
- HTTPS で受けたことを `X-Forwarded-Proto: https` で gtexp に伝える（ログイン Cookie に Secure を付けるため）
- 大きいファイルを取り込めるよう、リクエストの大きさの上限（500MB）と待ち時間（10 分）を広げる

### 前提

- `gtexp.example.com` の DNS の A（IPv6 なら AAAA）レコードが、このサーバーを指していること
- 80 番と 443 番に外からつながること（ファイアウォールやルーターの設定）
- 証明書の取得に certbot（Let's Encrypt）を使う場合は、入れておくこと（Debian / Ubuntu：`sudo apt install certbot python3-certbot-apache` または `python3-certbot-nginx`、FreeBSD：`pkg search certbot` で出る `py3xx-certbot` と `py3xx-certbot-apache` または `py3xx-certbot-nginx`。xx は Python の版）

### 手順

証明書を取得するまでは HTTPS の部分が動かないため、次の順に進めます。

1. 設定例をコピーし、`gtexp.example.com` を自分のホスト名に書き換える
2. HTTPS（443 番）の部分をコメントアウトして、HTTP だけで Web サーバーに読み込ませる
3. 証明書を取得する（`certbot certonly` は証明書を取るだけで、設定ファイルは書き換えません）
4. HTTPS の部分のコメントを外して、Web サーバーに読み込み直させる
5. ブラウザで `https://gtexp.example.com/` を開き、ログイン画面が出ることを確かめる

**Apache（Debian / Ubuntu）**

```sh
sudo cp /home/gtexp/gtexp/deploy/linux/apache-gtexp.conf /etc/apache2/sites-available/gtexp.conf
sudo vi /etc/apache2/sites-available/gtexp.conf           # ホスト名を書き換え、<VirtualHost *:443> の部分をコメントアウト
sudo a2enmod proxy proxy_http headers ssl rewrite
sudo a2ensite gtexp
sudo apachectl configtest && sudo systemctl reload apache2
sudo certbot certonly --apache -d gtexp.example.com
sudo vi /etc/apache2/sites-available/gtexp.conf           # <VirtualHost *:443> のコメントを外す
sudo apachectl configtest && sudo systemctl reload apache2
```

**nginx**

```sh
sudo cp /home/gtexp/gtexp/deploy/linux/nginx-gtexp.conf /etc/nginx/sites-available/gtexp
sudo vi /etc/nginx/sites-available/gtexp                  # ホスト名を書き換え、listen 443 の server ブロックをコメントアウト
sudo ln -s /etc/nginx/sites-available/gtexp /etc/nginx/sites-enabled/gtexp
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --nginx -d gtexp.example.com
sudo vi /etc/nginx/sites-available/gtexp                  # listen 443 の server ブロックのコメントを外す
sudo nginx -t && sudo systemctl reload nginx
```

**FreeBSD の場合（Apache）**

`deploy/freebsd/apache-gtexp.conf` を元に `/usr/local/etc/apache24/Includes/gtexp.conf` を作り、同じ順に進めます。読み込み直しは `sudo apachectl configtest && sudo apachectl graceful`、証明書の取得は `sudo certbot certonly --apache -d gtexp.example.com` です。

**FreeBSD の場合（nginx）**

`/usr/local/etc/nginx/nginx.conf` の `http { }` の中に `include conf.d/*.conf;` がなければ足してから、同じ順に進めます。

```sh
sudo mkdir -p /usr/local/etc/nginx/conf.d
sudo cp /home/gtexp/gtexp/deploy/freebsd/nginx-gtexp.conf /usr/local/etc/nginx/conf.d/gtexp.conf
sudo vi /usr/local/etc/nginx/conf.d/gtexp.conf          # ホスト名を書き換え、listen 443 の server ブロックをコメントアウト
sudo nginx -t && sudo service nginx reload
sudo certbot certonly --nginx -d gtexp.example.com
sudo vi /usr/local/etc/nginx/conf.d/gtexp.conf          # listen 443 の server ブロックのコメントを外す
sudo nginx -t && sudo service nginx reload
```

FreeBSD では、証明書の置き場所が `/usr/local/etc/letsencrypt/live/` になります（FreeBSD 用の設定例はその場所を指しています）。

証明書の更新は、certbot が自動で行います（Linux はパッケージに含まれるタイマー、FreeBSD は certbot の periodic を有効にする）。更新後に Web サーバーへ読み込み直させるには、`--deploy-hook "systemctl reload apache2"` などを付けて取得しておきます。

### うまくいかないとき

| 症状 | 確かめること |
|---|---|
| 502 / 503 が返る | gtexp が動いているか（「4」の check や curl）、設定例の中継先のポートが設定の `port` と合っているか |
| ログインしても、すぐログイン画面に戻る | `https://` で開いているか（Secure を付けた Cookie は、HTTP のページではブラウザが保存しない） |
| 取り込みが 413 で失敗する | リクエストの大きさの上限（Apache は `LimitRequestBody`、nginx は `client_max_body_size`） |
| 取り込みが途中で 504 になる | 待ち時間（Apache は `ProxyPass` の `timeout`、nginx は `proxy_read_timeout`） |

## 6. Google Maps の API キーを作る

1. [Google Cloud コンソール](https://console.cloud.google.com/) でプロジェクトを作成し、請求先アカウントを紐づける
2. 「API とサービス」→「ライブラリ」で **Maps JavaScript API** を有効にする
3. 「認証情報」→「認証情報を作成」→「API キー」
4. 作成したキーに制限をかける
   - **アプリケーションの制限**：「ウェブサイト」を選び、`https://gtexp.example.com/*` を追加
     （手元で開発中も地図を表示するなら `http://localhost:8787/*` と `http://localhost:5173/*` も追加。開発用に別のキーを作成してもよい）
   - **API の制限**：「Maps JavaScript API」だけを許可
5. キーを `~/gtexp/gtexp.config.json` の `mapsApiKey` に書き、サービスを再起動する
6. （任意）想定外の課金を防ぐため、「割り当て」で Maps JavaScript API の 1 日あたりの上限を設定しておく

地図の表示は、毎月一定の回数までは無料です。個人で使う分には、まず無料枠に収まります。

## 7. 使い始める

1. `https://gtexp.example.com/` を開き、利用者名とパスワードでログインする
2. Android 端末の「設定 → 位置情報 → 位置情報サービス → タイムライン → タイムライン データをエクスポート」でファイルを作成し、「取り込み」で送信する
   （全期間で 100MB 前後になることがあります。送信前にブラウザで圧縮するため、実際に送るのは 1 割程度です）
3. Android の Chrome で開き、メニューの「ホーム画面に追加」（またはインストール）を行う。
   これで、エクスポートしたファイルを「共有」→「G Timeline Explorer」で直接送れるようになります

コマンドから取り込むこともできます。

```sh
cd ~/gtexp && node --max-old-space-size=2048 dist/server.mjs import /path/to/timeline.json
```

## 8. 更新する

```sh
sudo sh /home/gtexp/gtexp/deploy/update.sh      # 管理者のアカウントで
```

更新とビルド（`git pull` → `npm ci` → `npm run build`）は、展開したフォルダーの持ち主で行います。そのあと `install.sh` を続けて実行し、サービスの定義を今の版に合わせて再起動し、設置を確かめます。
動かすユーザーで `sh ~/gtexp/deploy/update.sh` を実行すると、更新・ビルドと確認だけを行います（再起動は管理者が行います）。

## 9. 住所のデータを入れる（任意）

名前を付けていない場所に「〇〇市〇〇町一丁目」のような住所を付けるため、国土交通省の「位置参照情報」を入れます。

1. [位置参照情報ダウンロードサービス](https://nlftp.mlit.go.jp/isj/) で「大字・町丁目レベル」と「街区レベル」の、必要な都道府県の最新版をダウンロードする（利用規約への同意が必要）
2. zip のまま、ファイル名も変えずに `~/gtexp/data/isj/` に置く（全国分で約 130MB）
3. 取り込む

```sh
cd ~/gtexp && sh deploy/import-isj.sh
```

このコマンドは**位置参照情報を入れるだけ**で、地点への住所の割り当ては行いません（数秒で完了します）。
大字・町丁目は DB に格納されますが、街区データはサイズが大きいため DB には格納されず、住所割り当て時に `~/gtexp/data/isj/` の zip を直接参照します。**街区の zip ファイル（`*-24.0a.zip` など）は削除せずに保持してください。**

4. 画面の「取り込み」の「今すぐ調べる」か、次回のタイムライン取り込み時に、全地点に住所が付与されます

以降は、タイムラインを取り込むたびに、新しい地点にだけ住所が付与されます。位置参照情報の新しい版を入れたときは、次回の取り込みで全地点を調べ直します。
置き場所を変える場合は、設定ファイルの `isjDir` に記載します。

## 10. OpenStreetMap の施設名と住所（任意）

### 施設名：日本の OSM データを入れる
名前の付いた店や施設を、日本の OpenStreetMap のデータから取り出してサーバーに入れておきます（外部への問い合わせは行いません）。データを新しくする場合も同じ手順です。

```sh
sudo apt install osmium-tool                        # 最初だけ（FreeBSD: sudo pkg install osmium-tool）
mkdir -p ~/gtexp/data/osm
curl -L -o ~/gtexp/data/osm/japan-latest.osm.pbf https://download.geofabrik.de/asia/japan-latest.osm.pbf   # 約 2GB
sh ~/gtexp/deploy/make-osm-poi.sh
```

インポート後、画面の「取り込み」から「今すぐ調べる」を実行するか、次回のタイムライン取り込み時に、地点に施設名が付与されます。
保存リストのタブで、Takeout に位置情報がない店を店名から探すための索引も、このタイミングで作成されます。
インポート完了後、`~/gtexp/data/osm/` 以下のファイル（元データや中間ファイル）は削除して問題ありません。

### 住所：Nominatim から少しずつ取得する
cron で毎時、まだ調べていない地点をよく行く順に最大 150 か所、Nominatim に問い合わせて住所を蓄積します（15〜25 秒に 1 回の問い合わせで、公開サーバーの利用規約の範囲内です）。海外の地点にも住所が付きます。

```sh
sudo sh /home/gtexp/gtexp/deploy/install.sh --osm-cron      # 管理者のアカウントで
```

動かすユーザーの crontab に、次の 1 行が入ります（毎時 5 分に起動。すでにあれば、このフォルダーを指すように直すだけです）。手で入れる場合も、この形にしてください。

```
5 * * * * sh /home/gtexp/gtexp/deploy/fetch-osm.sh >> /home/gtexp/gtexp/log/osm.log 2>&1
```

ほかのユーザーの crontab にも fetch-osm の行があると、問い合わせが重なって利用規約の間隔を超えるため、`install.sh` が知らせます。
node が `/usr/local/bin`・`/usr/bin` 以外にある場合（nvm など）は、行の先頭に `NODE=/path/to/node` を付けます。
進み具合は、画面の「取り込み」の「施設名・住所（OpenStreetMap）」と `~/gtexp/log/osm.log` で確認できます。
1 地点だけ試しに問い合わせる場合は `cd ~/gtexp && node dist/server.mjs osm-lookup 35.681236 139.767125` を実行します（東京駅。保存はしません）。

## 11. Google Takeout について

Google Takeout の書き出し（保存した場所・ラベルを付けた場所・保存リスト・クチコミ・マイマップ）は利用者ごとのデータで、利用者が画面の「取り込み」の「ファイルを選ぶ」で zip を送ります。管理者の作業は要りません。
zip そのものは残さず、使うファイル（保存した場所・ラベルを付けた場所・保存リスト・クチコミ・マイマップ）だけを取り出して `data/users/<利用者名>/takeout/` に保存します（送り直すと、zip に入っていた種類だけ置き換わります）。受け取る大きさの上限は 200MB です（「マップ」と「保存済み」だけを選んだ書き出しなら数 MB）。

管理者がサーバー上の zip から入れることもできます。

```sh
cd ~/gtexp && node dist/server.mjs import-takeout --user alice /path/to/takeout   # zip かフォルダー
```

保存した場所は、滞在先と同じ場所（既定 2m 以内）の場合に使います。同じ場所の滞在先がない保存した場所は、30m 以内でいちばん近い滞在先 1 か所にだけ付与します（ほかの保存した場所が付いている滞在先は使いません）。距離は設定ファイルの `takeoutSameM`・`takeoutNearM` で変更でき、変更後は `node dist/server.mjs assign-areas` で付け直します。

## バックアップ

`~/gtexp/data` をまるごと保存すれば十分です。
利用者の `gtexp.sqlite` が壊れても、`data/users/<利用者名>/imports/` に残っている元ファイルを取り込み直せば元に戻せます。ただし、自分で付けた名前・メモ・タグは `gtexp.sqlite` にしかありません。
`shared.sqlite` には利用者の一覧があります（位置参照情報・OSM の施設は入れ直せます）。

DB は動作中も書き込まれることがあるため、ファイルをそのままコピーするより、次のように取得するほうが確実です。

```sh
sqlite3 ~/gtexp/data/shared.sqlite ".backup /path/to/backup/shared-$(date +%Y%m%d).sqlite"
sqlite3 ~/gtexp/data/users/alice/gtexp.sqlite ".backup /path/to/backup/alice-$(date +%Y%m%d).sqlite"   # 利用者ごとに
```
