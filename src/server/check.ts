import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config';
import type { HealthResponse } from '../shared/types';
import { configPath, unknownConfigKeys } from './config';
import { openSharedDb } from './db';
import { listUsers } from './users';
import { PROFILE } from '../shared/profile.gen';

// 設置の確認（node dist/server.mjs check）。設置や更新で忘れやすい・間違えやすいところを一覧で確かめ、
// 問題があれば直し方と一緒に出す。deploy/install.sh と deploy/update.sh の最後にも実行する。
// 動作に影響しないもの（前の置き方の名残りのファイルなど）は「消してかまわない」と知らせるだけで、何も消さない。

type Level = 'ok' | 'info' | 'warn' | 'error';
const MARK: Record<Level, string> = { ok: '[OK]  ', info: '[情報]', warn: '[注意]', error: '[要対応]' };

/** /api/health の応答（動いているサーバーの版と、そのビルドの日時） */
export type Health = HealthResponse;

/** 動いている server.mjs のビルドの日時（ファイルの更新日時） */
export function builtAt(): string {
  try {
    return statSync(process.argv[1]).mtime.toISOString();
  } catch {
    return '';
  }
}

export async function runCheck(config: Config): Promise<boolean> {
  const results: { level: Level; text: string; fix?: string }[] = [];
  const add = (level: Level, text: string, fix?: string) => results.push({ level, text, fix });

  // 展開したフォルダー（dist/server.mjs の一つ上）
  const script = resolve(process.argv[1] ?? '');
  const appDir = resolve(dirname(script), '..');
  console.log(`${PROFILE.title} ${PROFILE.version} の設置を確かめます（${appDir}）`);
  // 直し方の案内（install.sh は、sudo できる管理者のアカウントで実行する。動かすユーザーには sudo の権限を持たせない）
  const install = `管理者のアカウントで sudo sh ${join(appDir, 'deploy', 'install.sh')}`;

  // Node.js
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) add('ok', `Node.js ${process.version}`);
  else add('error', `Node.js ${process.version} は古い`, 'Node.js 22.13 以上を入れてください');

  // ビルド
  if (!/[\\/]dist[\\/]server\.mjs$/.test(script)) {
    add('error', `動かしているのが dist/server.mjs ではない（${script}）`, 'リポジトリを展開したフォルダーで npm run build し、node dist/server.mjs を使ってください');
  } else {
    const built = statSync(script).mtimeMs;
    const newest = newestMtime(join(appDir, 'src'));
    if (newest > built) add('error', 'ビルドがソースより古い', 'npm run build（または sh deploy/update.sh）を実行してください');
    else add('ok', `ビルド ${new Date(built).toLocaleString()}`);
  }

  // 設定
  const cfgPath = configPath();
  if (existsSync(cfgPath)) add('ok', `設定ファイル ${cfgPath}`);
  else add('warn', `設定ファイルがない（既定値で動く）：${cfgPath}`, 'cp deploy/gtexp.config.example.json gtexp.config.json');
  const unknown = unknownConfigKeys();
  if (unknown.length) add('warn', `設定ファイルに使っていない項目がある：${unknown.join(', ')}`, '古い項目か書き間違いです。消してかまいません');
  if (!config.mapsApiKey || /^（/.test(config.mapsApiKey)) add('warn', 'mapsApiKey が設定されていない（地図が出ない）', '設置手順の「Google Maps の API キーを作る」を参照');
  const index = join(config.publicDir, 'index.html');
  if (!existsSync(index)) {
    add('error', `画面のファイルがない：${index}`, 'npm run build を実行し、publicDir を消すか ./dist/public にしてください');
  } else {
    const missing = [...readFileSync(index, 'utf8').matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]).filter((a) => !existsSync(join(config.publicDir, a)));
    if (missing.length) add('error', `画面のファイルが欠けている：${missing.join(', ')}`, 'npm run build を実行してください');
    else if (resolve(config.publicDir) !== resolve(appDir, 'dist', 'public')) {
      add('warn', `publicDir が今のビルドの場所（dist/public）ではない：${config.publicDir}`, '設定ファイルの publicDir を消すか ./dist/public にしてください');
    } else add('ok', `画面のファイル ${config.publicDir}`);
  }

  // 前の置き方の名残り（動作には影響しないので消さない）
  for (const old of ['server.mjs', 'public']) {
    const p = join(appDir, old);
    if (existsSync(p) && resolve(p) !== resolve(config.publicDir)) add('info', `使っていないファイルがある：${p}`, '前の置き方の名残りです。動作には影響しないので、消してもそのままでもかまいません');
  }

  // データの置き場所と持ち主
  for (const [label, p] of [['dataDir', config.dataDir], ['ログ', join(appDir, 'log')]] as const) {
    if (!existsSync(p)) {
      add('info', `${label} のフォルダーがまだない：${p}`);
      continue;
    }
    try {
      accessSync(p, constants.W_OK);
      add('ok', `${label} ${p}（書き込める）`);
    } catch {
      add('error', `${label} に書き込めない：${p}`, `${install} で持ち主をそろえてください`);
    }
  }

  // 利用者
  try {
    const shared = openSharedDb(config.dataDir);
    const n = listUsers(shared).length;
    if (n) add('ok', `利用者 ${n} 人`);
    else add('warn', '利用者がいない（ログインできない）', 'node dist/server.mjs user-add <名前>');
    // 2 段階認証のコードは時刻から作るので、サーバーの時計がずれると合わなくなる。使っている人がいれば、時刻を合わせる仕組みを確かめる
    const mfaUsers = (shared.prepare('SELECT COUNT(*) AS n FROM user_mfa WHERE secret IS NOT NULL').get() as any).n as number;
    if (mfaUsers) {
      const sync = TIME_SYNC_DAEMONS.find(running);
      if (sync) add('ok', `2 段階認証 ${mfaUsers} 人・時刻合わせ ${sync}`);
      else add('warn', `2 段階認証を ${mfaUsers} 人が使っているが、時刻を合わせる仕組み（ntpd など）が動いていない`, 'サーバーの時計がずれると確認コードが合わなくなります。ntpd などで時刻を合わせてください');
    }
  } catch (e) {
    add('error', `全員で使う DB を開けない：${(e as Error).message}`);
  }

  // サービスの定義
  const unit = '/etc/systemd/system/gtexp.service';
  const rc = '/usr/local/etc/rc.d/gtexp';
  const def = [unit, rc].find((p) => existsSync(p));
  if (!def) add('warn', 'サービスの定義が入っていない', install);
  else {
    const text = readFileSync(def, 'utf8');
    // FreeBSD の /home は /usr/home へのリンクのことがあるので、実体のパスでも比べる
    const dirOk = def === unit ? [appDir, real(appDir)].some((d) => text.includes(`WorkingDirectory=${d}`)) : real(rcValue('gtexp_dir') || `/home/${rcValue('gtexp_user') || 'gtexp'}/gtexp`) === real(appDir);
    if (!text.includes('dist/server.mjs')) add('error', `サービスの定義が前のバージョンのまま（dist/server.mjs を動かしていない）：${def}`, install);
    else if (!dirOk) add('warn', `サービスの定義が別のフォルダーを指している：${def}`, install);
    else add('ok', `サービスの定義 ${def}`);
  }

  // 動いているサーバー
  try {
    const res = await fetch(`http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}/api/health`, { signal: AbortSignal.timeout(3000) });
    const h = res.ok ? ((await res.json()) as Health) : null;
    if (!h?.builtAt) add('error', `動いているサーバーが前のバージョン（${config.host}:${config.port}）`, `${install}（サービスを入れ直して再起動します）`);
    else if (Math.abs(Date.parse(h.builtAt) - statSync(script).mtimeMs) > 1000) {
      add('error', `動いているサーバーが今のビルドと違う（${new Date(h.builtAt).toLocaleString()} のビルドで動いている）`, `サービスを再起動してください（${install} でもよい）`);
    } else add('ok', `サーバーが動いている（${new Date(h.startedAt).toLocaleString()} から、今のビルドで）`);
  } catch {
    add('warn', `サーバーが動いていない（${config.host}:${config.port} に繋がらない）`, 'サービスを起動してください');
  }

  // cron（Nominatim から住所を取る。任意）
  try {
    const tab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = tab.split('\n').filter((l) => l.includes('fetch-osm.sh') && !l.trim().startsWith('#'));
    if (!lines.length) add('info', 'cron に fetch-osm の行がない（OpenStreetMap の住所を取らない）', `使うなら ${install} --osm-cron`);
    else if (!lines.some((l) => l.includes(join(appDir, 'deploy', 'fetch-osm.sh')) || l.includes('$HOME/gtexp/deploy/fetch-osm.sh'))) {
      add('warn', 'cron の fetch-osm の行が別のフォルダーを指している', `${install} --osm-cron`);
    } else add('ok', 'cron に fetch-osm の行がある');
  } catch {
    add('info', 'cron に fetch-osm の行がない（OpenStreetMap の住所を取らない）', `使うなら ${install} --osm-cron`);
  }

  for (const r of results) {
    console.log(`${MARK[r.level]} ${r.text}`);
    if (r.fix && r.level !== 'ok') console.log(`        → ${r.fix}`);
  }
  const errors = results.filter((r) => r.level === 'error').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(errors ? `要対応が ${errors} 件あります（注意 ${warns} 件）。` : warns ? `要対応はありません（注意 ${warns} 件）。` : '問題は見つかりませんでした。');
  return errors === 0;
}

/** フォルダーの中のファイルのいちばん新しい更新日時 */
function newestMtime(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    // 作るファイル（profile.gen.ts）はビルドのたびに変わりうるので比べない
    if (e.name.endsWith('.gen.ts')) continue;
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/** 時刻を合わせる仕組みのプロセス名 */
const TIME_SYNC_DAEMONS = ['ntpd', 'chronyd', 'openntpd', 'systemd-timesyncd', 'timesyncd'];

/** その名前のプロセスが動いているか */
function running(name: string): boolean {
  try {
    execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** FreeBSD の rc.conf の値（なければ空） */
function rcValue(name: string): string {
  try {
    return execFileSync('sysrc', ['-n', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 実体のパス（なければそのまま） */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
