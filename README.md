# gtexp - G Timeline Explorer

## これはなに？

<img alt="Image" src="https://github.com/user-attachments/assets/6c5251e6-4efb-4603-9798-29227770ccb1" align="right" width="300" />

サーバに蓄積したGoogle マップのタイムラインを、「いつ・どこに行ったか」をいろいろな形で
調べられるようにする Web アプリです。PWAとしても使用できます。

- 端末内のタイムラインを手動でエクスポートして、サーバへ送信することで蓄積します。
- 日付・場所・旅行・リストの4つの視点からタイムラインを眺めることができます。
- タイムラインの地点データには、名前やタグを付加することができます。
- タイムラインの地点データは座標のみのため、住所や施設名を解決する必要があります。国土交通省「位置参照情報」、OpenStreetMapデータ、自分のマップ情報を Google Takeout でエクスポートしたものから、解決を行います。
- 蓄積・編集したデータを、CSV / KML / GPX / GeoJSON などの形式で書き出せます。

本アプリは Google とは関係のない個人のプロジェクトです。

## 手元で動かす

Node.js 22.13 以上が必要です。

```sh
npm install
cp deploy/gtexp.config.example.json gtexp.config.json
npm run cli -- user-add alice      # 利用者を足す（パスワードを聞かれる）
```

設定例のまま（`dataDir` は `./data`、`publicDir` は `./dist/public`）で、リポジトリのフォルダーの中にデータを置いて動きます。

```sh
npm run cli -- import timeline/xxxx.json   # エクスポートしたファイルを取り込む
npm run build                              # 画面とサーバーをビルド
node dist/server.mjs serve                 # http://localhost:8787/ で開く
```

フロントエンドを開発・デバッグする際は、`npm run dev:server` と `npm run dev:client` を別々に動かし、
http://localhost:5173/ を開きます（API リクエストは 8787 にプロキシされます）。

## サーバーで動かす

[deploy/README.md](deploy/README.md) を参照してください。仕様は [memo/doc/spec.md](memo/doc/spec.md)、設計方針は [memo/doc/design.md](memo/doc/design.md) にあります。

## 構成

| 場所 | 中身 |
|---|---|
| `src/server/` | Node.js のサーバー。`node:sqlite` を使い、外部ライブラリなしで動く |
| `src/client/` | フロントエンド実装（Preact + Vite） |
| `src/shared/` | サーバーと画面で共通の型 |
| `deploy/` | サーバーへの設置手順、設置・更新・cron 用スクリプト（`install.sh`・`update.sh` など）、設定例（`linux/`：systemd・Apache・nginx、`freebsd/`：rc.d・Apache・nginx） |
| `tools/` | アイコン画像の生成、Profile.ini を読むスクリプト |
| `Profile.ini` | アプリ名・バージョン・著作権表示などの定数定義 |
| `memo/doc/` | 設計方針・仕様・元データの形式などの文書 |
| `memo/log/` | 作業ログ（`YYYYMMDD.md`） |

開発中に生成・利用される以下のファイルやディレクトリは、個人情報などを含むため Git の管理対象外（`.gitignore` 適用済み）となっています。
- `data/` : データベースおよび取り込んだファイルなど
- `timeline/` : エクスポートされたタイムラインデータの配置場所
- `gtexp.config.json` : ローカル設定ファイル
- `dist/` : ビルド出力先
- `log/` : サーバーで動かすときのログ

## 著作権表記

Copyright (C) 2026 GORRY. \
本パッケージは Apache License 2.0（LICENSE ファイル）のもとで利用・改変・再配布できます。著作権と第三者の表示は NOTICEファイルを参照してください。

## 連絡先

https://github.com/gorry/gtexp

## [EOF]


