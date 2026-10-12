import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { PROFILE } from '../shared/profile.gen';

export interface Config {
  /** 待ち受けアドレス。Apache の後ろに置くので通常は 127.0.0.1 */
  host: string;
  port: number;
  /** DB・取り込んだファイルの置き場所 */
  dataDir: string;
  /** 位置参照情報の zip を置くフォルダー。空なら dataDir/isj。街区レベルはここに置いたまま使う */
  isjDir: string;
  /** 画面のビルド結果（index.html など）の置き場所。既定は展開したフォルダーの dist/public */
  publicDir: string;
  /** ログイン Cookie の署名鍵。空なら dataDir/session.key を自動生成して使う */
  sessionSecret: string;
  /** ログイン状態を保つ日数 */
  sessionDays: number;
  /** Maps JavaScript API のキー（ドメイン制限をかけたもの） */
  mapsApiKey: string;
  /** Advanced Marker 用の Map ID。未作成なら DEMO_MAP_ID のままでよい */
  mapId: string;
  /** 日付の区切りに使う UTC からのオフセット（分）。日本なら 540 */
  tzOffsetMinutes: number;
  /** Takeout の保存した場所を、滞在先と「同じ場所」とみなす距離（m）。変えたら assign-areas で付け直す */
  takeoutSameM: number;
  /** 同じ場所の滞在先がなかった保存した場所を、いちばん近い滞在先 1 か所に付ける距離（m）。takeoutSameM 以下なら付けない */
  takeoutNearM: number;
  /** Takeout のラベルを付けた場所を割り当てる距離（m） */
  takeoutLabelM: number;
  /** ラベルを付けた場所に、経路の点がこの距離（m）以内に来たら立ち寄ったとみなす */
  labelStopM: number;
  /** OpenStreetMap（Nominatim）の問い合わせ先。住所に使う（施設名は手元のデータから） */
  osmEndpoint: string;
  /** Nominatim の規約で必要な、アプリを識別できる User-Agent */
  osmUserAgent: string;
}

const defaults: Config = {
  host: '127.0.0.1',
  port: 8787,
  dataDir: './data',
  isjDir: '',
  publicDir: './dist/public',
  sessionSecret: '',
  sessionDays: 180,
  mapsApiKey: '',
  mapId: 'DEMO_MAP_ID',
  tzOffsetMinutes: 540,
  takeoutSameM: 2,
  takeoutNearM: 30,
  takeoutLabelM: 30,
  labelStopM: 50,
  osmEndpoint: 'https://nominatim.openstreetmap.org',
  osmUserAgent: `${PROFILE.shortTitle}/${PROFILE.version} (${PROFILE.title}; personal use)`,
};

/**
 * 設定ファイルの場所: 環境変数 GTEXP_CONFIG → カレントの gtexp.config.json →
 * server.mjs の一つ上（展開したフォルダー。server.mjs は dist/ にある）→ server.mjs と同じフォルダーの順に探す。
 * どれもなければカレントの gtexp.config.json（ない場合は既定値で動く）
 */
export function configPath(): string {
  if (process.env.GTEXP_CONFIG) return resolve(process.env.GTEXP_CONFIG);
  const scriptDir = dirname(process.argv[1] ?? '.');
  const candidates = [resolve('gtexp.config.json'), resolve(scriptDir, '..', 'gtexp.config.json'), resolve(scriptDir, 'gtexp.config.json')];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function loadConfig(): Config {
  const path = configPath();
  const fromFile = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const base = dirname(path);
  const config: Config = { ...defaults, ...fromFile };
  config.dataDir = resolve(base, config.dataDir);
  config.publicDir = resolve(base, config.publicDir);
  config.isjDir = config.isjDir ? resolve(base, config.isjDir) : resolve(config.dataDir, 'isj');
  mkdirSync(config.dataDir, { recursive: true });
  if (!config.sessionSecret) {
    const keyPath = resolve(config.dataDir, 'session.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
    config.sessionSecret = readFileSync(keyPath, 'utf8').trim();
  }
  return config;
}

/** 秘密の値とみなす項目（ログには、設定してあるかどうかだけを出す）。項目の名前で判定するので、新しい秘密の項目もこの形の名前にする */
const SECRET_RE = /secret|password|key|token|hash/i;

/**
 * 起動時のログに出す、実際に使う設定の一覧（1 項目 1 行）。秘密の値は伏せる。
 * 設定ファイルに書いていない項目には「（既定）」を付け、設定ファイルにあっても使っていない項目（古い項目や書き間違い）は知らせる
 */
export function describeConfig(config: Config): string[] {
  const path = configPath();
  const fileKeys = configFileKeys();
  const lines = [`設定ファイル: ${existsSync(path) ? path : `${path}（ないので既定値で動く）`}`];
  for (const key of Object.keys(defaults) as (keyof Config)[]) {
    const v = config[key];
    const inFile = fileKeys.includes(key);
    let shown: string;
    if (key === 'sessionSecret' && !inFile) shown = '（dataDir の session.key を使う）';
    else if (SECRET_RE.test(key)) shown = v ? '（設定済み）' : '（未設定）';
    else shown = typeof v === 'string' ? v || '""' : JSON.stringify(v);
    lines.push(`  ${key}: ${shown}${inFile || key === 'sessionSecret' ? '' : '（既定）'}`);
  }
  const unknown = unknownConfigKeys();
  if (unknown.length) lines.push(`  使っていない項目（古い項目か書き間違い）: ${unknown.join(', ')}`);
  return lines;
}

/** 設定ファイルに書いてある項目の名前 */
function configFileKeys(): string[] {
  const path = configPath();
  try {
    return existsSync(path) ? Object.keys(JSON.parse(readFileSync(path, 'utf8'))) : [];
  } catch {
    return []; // 読めない設定ファイルは loadConfig の時点で止まっている
  }
}

/** 設定ファイルにあっても使っていない項目（古い項目や書き間違い） */
export function unknownConfigKeys(): string[] {
  return configFileKeys().filter((k) => !(k in defaults));
}
