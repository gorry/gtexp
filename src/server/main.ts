import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import { basename, extname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, describeConfig, type Config } from './config';
import { clearMfaPendingCookie, clearSessionCookie, hashPassword, isHttps, issueMfaPendingCookie, issueSessionCookie, loggedInUser, mfaPendingUser, verifyPassword } from './auth';
import { checkMfaCode, disableMfa, finishMfaSetup, mfaEnabled, otpauthUri, recoveryLeft, renewRecoveryCodes, startMfaSetup } from './mfa';
import { addUser, checkUserName, deleteUser, getUser, listUsers, rotateSessionKey, setPassword } from './users';
import { recordImport, addBookmark, deleteBookmark, listBookmarks, renameBookmark, reorderBookmarks, bulkTags, normalizeTag, getCalendar, getDay, getPlace, getSummary, getTrip, listImports, listPlaces, placesExtent, listTrips, openSharedDb, openUserDb, savePlaceNote, userDir, search, type PlaceQuery, type SearchQuery } from './db';
import { importTimeline, isTimelineExport } from './importer';
import { assignAll, assignForImport, importAreas, type AssignOptions } from './areas';
import { importTakeoutZips } from './takeout';
import { importSwarmZip, splitSwarmZips } from './swarm';
import { newInflateBudget } from './zip';
import { errorDetail, fetchOsm, lookupOsm, osmRun } from './osm';
import { importOsmPois } from './osmpoi';
import { buildPoiKeys, listEntries, listNames } from './lists';
import { deleteSwarm, deleteTakeout, deleteTimeline } from './purge';
import { deleteUserData, exportUserData, importUserData } from './userdata';
import { ICON_MAX_BYTES, deleteIcon, iconType, iconVersion, readIcon, saveIcon } from './usericon';
import { CONTENT_TYPES, EXPORT_FORMATS, render, type ExportData, type ExportFormat } from './exporter';
import type { ClientConfig, PlaceKind, PlaceNote, PlaceSort, SearchGroup, SearchTarget, ZipImportResult } from '../shared/types';
import { PROFILE } from '../shared/profile.gen';
import { BUILD } from '../shared/build.gen';
import { builtAt, runCheck, type Health } from './check';

/** サーバーを起動した日時 */
const startedAt = new Date().toISOString();
// 起動したときのビルドの日時（あとで dist/server.mjs を作り直しても、動いているのは起動したときのもの）
const BUILT_AT = builtAt();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

/**
 * 大事な操作の前に本人を確かめる。password を渡したらパスワードを、2 段階認証がオンならコード（6 桁かバックアップコード）を確かめる。
 * 間違いはログインの失敗と同じに数え、続いたら断る。401 だと画面がログアウトしたとみなすので、400 で返す
 */
async function confirmIdentity(
  config: Config,
  shared: DatabaseSync,
  req: IncomingMessage,
  user: string,
  given: { password?: unknown; code?: unknown },
): Promise<void> {
  const release = reserveAttempt(failureKeys(req, user), '認証の失敗が続いたため、一時的に制限されています。しばらく待ってから再度お試しください。');
  if ('password' in given) {
    const u = getUser(shared, user);
    if (!u || typeof given.password !== 'string' || !verifyPassword(given.password, u.passwordHash)) {
      return authFailed(400, '現在のパスワードが正しくありません。');
    }
  }
  if (mfaEnabled(shared, user) && (typeof given.code !== 'string' || !checkMfaCode(shared, user, given.code, config.sessionSecret))) {
    return authFailed(400, '確認コードが正しくありません。認証アプリの 6 桁のコードを確認してください。');
  }
  release();
}

/** 画面から変えるときの、新しいパスワードの最短の長さ */
const PASSWORD_MIN = 8;

/** 本文をそのまま受け取る（上限を超えたら断る） */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '画像サイズが大きすぎます。別の画像を選択してください。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '送信されたデータが大きすぎます。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
}

function serveStatic(config: Config, req: IncomingMessage, res: ServerResponse, pathname: string): void {
  let file = resolve(config.publicDir, '.' + decodeURIComponent(pathname));
  if (file !== config.publicDir && !file.startsWith(config.publicDir + sep)) throw new HttpError(404, 'Not Found');
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // 画面内のページ（クライアント側のルーティング）は index.html を返す
    file = join(config.publicDir, 'index.html');
    if (!existsSync(file)) {
      console.error(`画面のファイルがありません（${file}。npm run build を実行してください）`);
      throw new HttpError(404, '画面のファイルが見つかりません。サーバーの管理者に連絡してください。');
    }
  }
  const immutable = pathname.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: PlaceKind[] = ['', 'home', 'work', 'named', 'unnamed'];
const SORTS: PlaceSort[] = ['count', 'last', 'first', 'duration'];

function parsePlaceQuery(p: URLSearchParams): PlaceQuery {
  const date = (key: string) => {
    const v = p.get(key) ?? '';
    if (v && !DATE_RE.test(v)) throw new HttpError(400, '日付の形式が正しくありません（YYYY-MM-DD）。');
    return v;
  };
  const kind = (p.get('kind') ?? '') as PlaceKind;
  const sort = (p.get('sort') ?? 'count') as PlaceSort;
  if (!KINDS.includes(kind)) throw new HttpError(400, '種類の指定が正しくありません。');
  if (!SORTS.includes(sort)) throw new HttpError(400, '並び順の指定が正しくありません。');
  let bbox: PlaceQuery['bbox'] = null;
  if (p.get('bbox')) {
    const nums = p.get('bbox')!.split(',').map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new HttpError(400, '地図範囲（bbox）の指定が正しくありません。');
    bbox = nums as [number, number, number, number];
  }
  const int = (key: string, def: number, max: number) => Math.min(Math.max(Number(p.get(key) ?? def) || 0, 0), max);
  return {
    q: (p.get('q') ?? '').trim().slice(0, 100),
    kind,
    from: date('from'),
    to: date('to'),
    bbox,
    sort,
    limit: int('limit', 100, 1000) || 100,
    offset: int('offset', 0, 1_000_000),
    checkTag: normalizeTag(p.get('checkTag') ?? '').slice(0, 100),
  };
}

const TARGETS: SearchTarget[] = ['visits', 'activities', 'gaps', 'departures', 'arrivals'];
const GROUPS: SearchGroup[] = ['year', 'month', 'weekday', 'hour', 'mode'];

function parseSearchQuery(p: URLSearchParams): SearchQuery {
  const base = parsePlaceQuery(p); // 期間・q・kind・limit・offset の読み方は場所の一覧と同じ
  const target = (p.get('target') ?? 'visits') as SearchTarget;
  const group = (p.get('group') ?? 'year') as SearchGroup;
  if (!TARGETS.includes(target)) throw new HttpError(400, '集計対象の指定が正しくありません。');
  if (!GROUPS.includes(group)) throw new HttpError(400, '集計単位の指定が正しくありません。');
  const list = (key: string) => (p.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const weekdays = list('weekdays').map(Number);
  if (weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) throw new HttpError(400, '曜日の指定が正しくありません。');
  const modes = list('modes');
  if (modes.some((m) => !/^[A-Z_]+$/.test(m))) throw new HttpError(400, '移動手段の指定が正しくありません。');
  return { target, from: base.from, to: base.to, weekdays, q: base.q, kind: base.kind, modes, group, limit: base.limit, offset: base.offset };
}

/**
 * 絞り込んだ記録をファイルとして返す。source=search は集計の条件（滞在か移動）、
 * source=places は場所の一覧の条件。件数の上限はかけず、条件に合うものを全部書き出す。
 */
function handleExport(db: DatabaseSync, p: URLSearchParams, res: ServerResponse): void {
  const format = (p.get('format') ?? '') as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw new HttpError(400, '出力形式の指定が正しくありません。');
  const source = p.get('source') ?? 'search';
  let data: ExportData;
  let from = '';
  let to = '';
  if (source === 'places') {
    const q = parsePlaceQuery(p);
    ({ from, to } = q);
    data = { kind: 'places', items: listPlaces(db, { ...q, limit: -1, offset: 0 }).items };
  } else if (source === 'search') {
    const q = parseSearchQuery(p);
    if (q.target !== 'visits' && q.target !== 'activities') throw new HttpError(400, 'エクスポートできるのは「滞在」と「移動」のみです。');
    ({ from, to } = q);
    const r = search(db, { ...q, limit: -1, offset: 0 });
    data = q.target === 'visits' ? { kind: 'visits', items: r.visits } : { kind: 'activities', items: r.activities };
  } else {
    throw new HttpError(400, '出力元の指定が正しくありません。');
  }
  const kindName = { visits: '滞在', activities: '移動', places: '場所' }[data.kind];
  const period = from || to ? `${from || '…'} 〜 ${to || '…'}` : '全期間';
  const body = render(db, format, data, `${PROFILE.title}：${kindName}（${period}）`);
  const stamp = (d: string) => d.replace(/-/g, '');
  const fileName = `gtexp-${data.kind}${from || to ? `-${stamp(from) || 'start'}-${stamp(to) || 'end'}` : ''}.${format}`;
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[format],
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 住所・地点名の割り当ての設定 */
function assignOptions(config: Config): AssignOptions {
  return {
    isjDir: config.isjDir,
    takeout: { sameM: config.takeoutSameM, nearM: config.takeoutNearM, labelM: config.takeoutLabelM },
    labelStopM: config.labelStopM,
    tzOffsetMinutes: config.tzOffsetMinutes,
  };
}

/**
 * 認証の失敗が続いたら断る（パスワード・確認コードの総当たり対策）。利用者ごと（10 分に 10 回）と、接続元ごと（10 分に 50 回）に数える。
 * 全員まとめて数えると、誰かがわざと失敗を重ねるだけで、ほかの人もログインできなくなるため
 */
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURE_LIMIT = { user: 10, ip: 50 };
const failures = new Map<string, number[]>();

/** 接続元。Apache・nginx の後ろでは、中継したときに付く X-Forwarded-For の最後（中継の直前）を使う */
function clientIp(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? '';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  return loopback && forwarded.length ? forwarded[forwarded.length - 1] : direct;
}

const failureKeys = (req: IncomingMessage, user: string) => [`user:${user}`, `ip:${clientIp(req)}`];

function recentFailures(key: string): number {
  const since = Date.now() - FAILURE_WINDOW_MS;
  const list = (failures.get(key) ?? []).filter((t) => t >= since);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list.length;
}

function tooManyFailures(keys: string[]): boolean {
  return keys.some((k) => recentFailures(k) >= (k.startsWith('user:') ? FAILURE_LIMIT.user : FAILURE_LIMIT.ip));
}

/**
 * 認証を 1 回試す前に、先に「失敗 1 回」として数えておき、合っていたら取り消す関数を返す。上限に達していれば断る。
 * 確かめたあとで失敗を数えると、同時に大量に送られたとき、どれも「まだ上限前」と判定されて、上限を超えて試せてしまう
 * （確認コードの総当たりの並列すり抜け）。先に数えれば、上限の判定と数えることの間に待ち時間が入らないので、同時に送られても上限で止まる
 */
function reserveAttempt(keys: string[], message: string): () => void {
  if (tooManyFailures(keys)) throw new HttpError(429, message);
  // 存在しない利用者名で数え続けられても、覚える数が増えすぎないようにする
  if (failures.size > 10_000) for (const k of [...failures.keys()]) recentFailures(k);
  const at = Date.now();
  for (const k of keys) failures.set(k, [...(failures.get(k) ?? []), at]);
  return () => {
    for (const k of keys) {
      const list = failures.get(k);
      const i = list?.indexOf(at) ?? -1;
      if (list && i >= 0) list.splice(i, 1);
    }
  };
}

/** 認証に失敗したとき：少し待たせてから断る（数えるのは reserveAttempt で済んでいる） */
async function authFailed(status: number, message: string): Promise<never> {
  await new Promise((r) => setTimeout(r, 1000));
  throw new HttpError(status, message);
}

const LOGIN_LIMITED = 'ログインの失敗が続いたため、一時的に制限されています。しばらく待ってから再度お試しください。';

/** タイムラインのエクスポートとして受け取る上限（画面は gzip で送るので 1 割ほど。素の JSON で送られても 100MB 前後） */
const IMPORT_MAX_BYTES = 300 * 1024 * 1024;
/** 展開したあとの上限（JSON の文字列として扱える大きさの範囲で） */
const IMPORT_MAX_EXPANDED = 400 * 1024 * 1024;

/** gzip なら展開する（展開したあとの大きさに上限を付ける。小さな圧縮ファイルが巨大に膨らむ「圧縮爆弾」対策） */
function gunzipLimited(raw: Buffer): Buffer {
  if (!(raw[0] === 0x1f && raw[1] === 0x8b)) return raw;
  try {
    return gunzipSync(raw, { maxOutputLength: IMPORT_MAX_EXPANDED });
  } catch (e) {
    if (e instanceof RangeError || (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new HttpError(413, 'ファイルを展開したサイズが大きすぎます。');
    }
    throw new HttpError(400, 'ファイルを読み込めませんでした。タイムラインのエクスポートファイルを選択してください。');
  }
}

/** 送られた本文を数えながら流し、上限を超えたら止める */
function limitBytes(limit: number): Transform {
  let size = 0;
  return new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > limit) done(new HttpError(413, 'ファイルサイズが大きすぎます。'));
      else done(null, chunk);
    },
  });
}

/** 取り込みか住所の割り当てを処理中の利用者 */
const importing = new Set<string>();

/** アップロードされたファイル（gzip でも素の JSON でもよい）を、利用者のフォルダーに保存して取り込む */
async function handleImport(config: Config, user: string, db: DatabaseSync, req: IncomingMessage) {
  if (Number(req.headers['content-length'] ?? 0) > IMPORT_MAX_BYTES) throw new HttpError(413, 'ファイルサイズが大きすぎます。');
  if (importing.has(user)) throw new HttpError(409, '現在、別のデータ処理を実行中です。完了してから再度お試しください。');
  importing.add(user);
  const dir = join(userDir(config.dataDir, user), 'imports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const rawName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'timeline.json'));
  const fileName = rawName.replace(/[^\w.\-]/g, '_').slice(0, 100);
  const tmp = join(dir, `${stamp}.upload`);
  try {
    await pipeline(req, limitBytes(IMPORT_MAX_BYTES), createWriteStream(tmp));
    const raw = readFileSync(tmp);
    const gzipped = raw[0] === 0x1f && raw[1] === 0x8b;
    const text = gunzipLimited(raw).toString('utf8');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'ファイルを読み込めませんでした。タイムラインのエクスポートファイルを選択してください。');
    }
    if (!isTimelineExport(data)) throw new HttpError(400, 'タイムラインのエクスポートファイルではありません。端末の「タイムライン データをエクスポート」で保存したファイルを選択してください。');

    // 元ファイルは gzip で残しておく（後で作り直せるように）
    const stored = join(dir, `${stamp}_${fileName.replace(/\.gz$/, '')}.gz`);
    if (gzipped) renameSync(tmp, stored);
    else await pipeline(createReadStream(tmp), createGzip(), createWriteStream(stored));

    const stats = importTimeline(db, data, fileName, stored, assignOptions(config));
    return { ok: true, ...stats };
  } finally {
    importing.delete(user);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** 利用者ごとの記録の DB（開いたものは閉じずに使い回す） */
const userDbs = new Map<string, DatabaseSync>();
function userDb(config: Config, user: string): DatabaseSync {
  let db = userDbs.get(user);
  if (!db) {
    db = openUserDb(config.dataDir, user);
    userDbs.set(user, db);
  }
  return db;
}

/** Takeout・Swarm の zip を受け取る上限。「マップ」「保存済み」だけなら数 MB。写真まで含めた書き出しは断る */
const TAKEOUT_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Google Takeout か Foursquare Swarm の zip（複数可。混ざっていてもよい。multipart/form-data の file）を受け取って入れる。
 * zip は残さず、使うファイルだけを利用者のフォルダーの takeout/（zip に入っていた種類だけ置き換える）か swarm/（全部置き換える）に取り出す。
 * Swarm かどうかは zip の中身（チェックインのファイルがあるか）で決める。
 * 入れたあと、取り込みのときと同じ割り当てを行う（地点名がすぐ付くように）
 */
async function handleTakeout(config: Config, user: string, db: DatabaseSync, req: IncomingMessage) {
  if (Number(req.headers['content-length'] ?? 0) > TAKEOUT_MAX_BYTES) {
    throw new HttpError(413, 'ファイルサイズが大きすぎます。Takeout では「マップ」と「保存済み」のみを選択し、「マップ」内の「写真と動画」を除外してエクスポートしてください。');
  }
  if (importing.has(user)) throw new HttpError(409, '現在、別のデータ処理を実行中です。完了してから再度お試しください。');
  importing.add(user);
  // 受け取った zip を一時的に置く場所（取り出したら消す）
  const tmp = join(userDir(config.dataDir, user), 'takeout-upload');
  try {
    let form: FormData;
    try {
      form = await new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': String(req.headers['content-type'] ?? '') },
        // 大きさを申告しない送り方（chunked）でも、上限を超えたら止める
        body: Readable.toWeb(req.pipe(limitBytes(TAKEOUT_MAX_BYTES))) as ReadableStream,
        duplex: 'half',
      } as RequestInit).formData();
    } catch (e) {
      // 上限を超えたときは、その理由を返す（受信の途中で止めた HttpError が、原因として包まれて届く）
      const cause = e instanceof HttpError ? e : (e as { cause?: unknown })?.cause;
      if (cause instanceof HttpError) throw cause;
      throw new HttpError(400, 'ファイルを受信できませんでした。再度お試しください。');
    }
    const files = form.getAll('file').filter((v): v is File => typeof v !== 'string');
    if (!files.length) throw new HttpError(400, 'ファイルが選択されていません。');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const [i, file] of files.entries()) {
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, `${file.name} は zip ファイルではありません。Takeout または Swarm のエクスポートファイル（.zip）を選択してください。`);
      writeFileSync(join(tmp, `${String(i + 1).padStart(2, '0')}_${file.name.replace(/[^\w.\-]/g, '_').slice(0, 100)}`), buf);
    }
    let result: Omit<ZipImportResult, 'ok' | 'addresses'>;
    try {
      const { swarm, others } = splitSwarmZips([tmp]);
      if (swarm.length > 1) throw new Error('Swarm の zip ファイルは 1 つずつ取り込んでください。');
      // 送られた zip をまとめて展開してよい量（Takeout と Swarm で共通。1 つずつの上限だけでは、上限の少し下のファイルを数多く並べた zip で合計が巨大になる）
      const budget = newInflateBudget();
      result = {
        takeout: others.length ? importTakeoutZips(db, join(userDir(config.dataDir, user), 'takeout'), others, budget) : null,
        swarm: swarm.length ? importSwarmZip(db, join(userDir(config.dataDir, user), 'swarm'), swarm[0], budget) : null,
      };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const body: ZipImportResult = { ok: true, ...result, addresses: assignForImport(db, assignOptions(config)) };
    // 取り込みの履歴に残す（ファイル名は、受け取ったときに付けた番号を外す）
    const names = (paths: string[]) => paths.map((p) => basename(p).replace(/^\d+_/, '')).join('、');
    const { swarm, others } = splitSwarmZips([tmp]);
    if (result.takeout) recordImport(db, 'takeout', names(others), result.takeout);
    if (result.swarm) recordImport(db, 'swarm', names(swarm), result.swarm);
    return body;
  } finally {
    importing.delete(user);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** ブックマークの名前（空なら fallback、200 文字まで） */
function bookmarkTitle(v: unknown, fallback: string): string {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t && !fallback) throw new HttpError(400, '名前を指定してください');
  return t || fallback;
}

/**
 * どの応答にも付けるヘッダー。ほかのサイトの中に gtexp を重ねて表示させない（クリックジャッキング対策）、
 * 応答の種類をブラウザーに推測させない、リンク先に URL の全体を渡さない。
 * スクリプトの読み込み元を絞る CSP は、Google マップが読み込む先が多く変わりうるので付けない（frame-ancestors などだけ）
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * 書き込みの要求（GET・HEAD 以外の /api/）には、画面が付ける X-Gtexp ヘッダーを求める。
 * ほかのサイトのフォームや、ヘッダーを付けられない単純な要求からは送れないので、ログインの Cookie を使った書き込み（CSRF）を防げる
 * （独自のヘッダーを付けた要求は、ほかのサイトからは事前の確認で断られる）
 */
const CSRF_HEADER = 'x-gtexp';

async function route(config: Config, shared: DatabaseSync, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  if (!path.startsWith('/api/')) {
    if (method === 'POST' && path === '/share-target') {
      // 通常は Service Worker が受け取る。届いてしまったら取り込み画面へ案内する
      res.writeHead(303, { Location: '/#/import?share=failed' });
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
    serveStatic(config, req, res, path);
    return;
  }
  if (method !== 'GET' && method !== 'HEAD' && req.headers[CSRF_HEADER] !== '1') {
    throw new HttpError(403, 'リクエストを受け付けられませんでした。ページを再読み込みしてから再度お試しください。');
  }

  if (path === '/api/login' && method === 'POST') {
    const { user: rawUser, password } = await readJsonBody(req);
    const name = String(rawUser ?? '').trim().toLowerCase().slice(0, 64);
    if (!listUsers(shared).length) {
      console.error('利用者がいません（node dist/server.mjs user-add で登録してください）');
      throw new HttpError(500, 'ユーザーが登録されていません。サーバー管理者に連絡してください。');
    }
    const release = reserveAttempt(failureKeys(req, name), LOGIN_LIMITED);
    const user = name ? getUser(shared, name) : null;
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.passwordHash)) {
      return authFailed(401, 'ユーザー名またはパスワードが正しくありません。');
    }
    release();
    if (mfaEnabled(shared, user.name)) {
      // 2 段階認証がオン：ログインの Cookie はまだ渡さず、確認コードを待つ（5 分）
      sendJson(res, 200, { loggedIn: false, mfaRequired: true }, {
        'Set-Cookie': issueMfaPendingCookie(config.sessionSecret, user.name, user.sessionKey, isHttps(req)),
      });
      return;
    }
    sendJson(res, 200, { loggedIn: true, user: user.name }, {
      'Set-Cookie': issueSessionCookie(config.sessionSecret, user.name, user.sessionKey, config.sessionDays, isHttps(req)),
    });
    return;
  }
  if (path === '/api/login/mfa' && method === 'POST') {
    // ログインの 2 段階目：アプリの 6 桁のコードか、バックアップコードを確かめる（間違いはログインの失敗と同じに数える）
    const name = mfaPendingUser(req, config.sessionSecret, (n) => getUser(shared, n)?.sessionKey ?? null);
    if (!name) throw new HttpError(400, '確認コードの有効期限が切れました。もう一度パスワード入力からやり直してください。');
    const { code } = await readJsonBody(req);
    const release = reserveAttempt(failureKeys(req, name), LOGIN_LIMITED);
    if (typeof code !== 'string' || !checkMfaCode(shared, name, code, config.sessionSecret)) {
      return authFailed(400, '確認コードが正しくありません。認証アプリの 6 桁のコードを確認してください。');
    }
    release();
    const u = getUser(shared, name)!;
    sendJson(res, 200, { loggedIn: true, user: name }, {
      'Set-Cookie': [issueSessionCookie(config.sessionSecret, name, u.sessionKey, config.sessionDays, isHttps(req)), clearMfaPendingCookie()],
    });
    return;
  }
  if (path === '/api/logout' && method === 'POST') {
    sendJson(res, 200, { loggedIn: false }, { 'Set-Cookie': clearSessionCookie() });
    return;
  }
  const user = loggedInUser(req, config.sessionSecret, (name) => getUser(shared, name)?.sessionKey ?? null);
  if (path === '/api/health') {
    // 設置の確認（check コマンド）用。ログインは要らない。版とビルドの日時だけを返す
    const body: Health = { version: PROFILE.version, startedAt, builtAt: BUILT_AT, commit: BUILD.commit, dirty: BUILD.dirty };
    sendJson(res, 200, body);
    return;
  }
  if (path === '/api/me') {
    sendJson(
      res,
      200,
      user
        ? { loggedIn: true, user, icon: iconVersion(userDir(config.dataDir, user)), mfa: mfaEnabled(shared, user), recoveryLeft: recoveryLeft(shared, user) }
        : { loggedIn: false },
    );
    return;
  }
  if (!user) throw new HttpError(401, 'セッションの有効期限が切れました。再度ログインしてください。');
  // ここから先は、ログインしている利用者の記録だけを扱う
  const db = userDb(config, user);

  if (path === '/api/me/icon') {
    // 利用者のアイコン。URL に版（?v=）を付けて読むので、長くキャッシュしてよい
    const dir = userDir(config.dataDir, user);
    if (method === 'GET') {
      const icon = readIcon(dir);
      if (!icon) throw new HttpError(404, 'アイコンはまだ設定されていません。');
      res.writeHead(200, { 'Content-Type': icon.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.end(icon.data);
      return;
    }
    if (method === 'PUT') {
      const data = await readRawBody(req, ICON_MAX_BYTES);
      if (!iconType(data)) throw new HttpError(400, '画像を読み込めませんでした。別の画像を選択してください。');
      mkdirSync(dir, { recursive: true });
      saveIcon(dir, data);
      sendJson(res, 200, { icon: iconVersion(dir) });
      return;
    }
    if (method === 'DELETE') {
      deleteIcon(dir);
      sendJson(res, 200, { icon: null });
      return;
    }
  }
  if (path === '/api/me/password' && method === 'POST') {
    // パスワードを変える。今のパスワードを確かめる（間違いはログインの失敗と同じに数える）。
    // ほかの端末はログアウトされ、この端末には新しいログインを渡す
    const { current, next, code } = await readJsonBody(req);
    if (typeof next !== 'string' || next.length < PASSWORD_MIN) throw new HttpError(400, `新しいパスワードは ${PASSWORD_MIN} 文字以上にしてください。`);
    await confirmIdentity(config, shared, req, user, { password: current, code });
    setPassword(shared, user, next);
    const updated = getUser(shared, user)!;
    sendJson(res, 200, { ok: true }, {
      'Set-Cookie': issueSessionCookie(config.sessionSecret, user, updated.sessionKey, config.sessionDays, isHttps(req)),
    });
    return;
  }
  if (path === '/api/me/mfa/setup' && method === 'POST') {
    // 2 段階認証の設定を始める：新しい鍵を作り、アプリに登録する URI（QR コードにする）と鍵の文字列を返す
    if (mfaEnabled(shared, user)) throw new HttpError(400, '2 段階認証はすでに有効です。');
    const secret = startMfaSetup(shared, user, config.sessionSecret);
    sendJson(res, 200, { uri: otpauthUri(PROFILE.shortTitle, user, secret), secret });
    return;
  }
  if (path === '/api/me/mfa/enable' && method === 'POST') {
    // アプリの 6 桁が合えば有効にし、バックアップコードを 1 回だけ返す。ほかの端末はログアウトさせる
    // （2 段階認証なしでログインした端末を残さない）。この端末には新しいログインを渡す
    const { code } = await readJsonBody(req);
    const codes = typeof code === 'string' ? finishMfaSetup(shared, user, code, config.sessionSecret) : null;
    if (!codes) throw new HttpError(400, '確認コードが正しくありません。認証アプリの 6 桁のコードを確認してください。');
    const key = rotateSessionKey(shared, user);
    sendJson(res, 200, { recoveryCodes: codes }, {
      'Set-Cookie': issueSessionCookie(config.sessionSecret, user, key, config.sessionDays, isHttps(req)),
    });
    return;
  }
  if (path === '/api/me/mfa/disable' && method === 'POST') {
    // 無効にする：パスワードとコードの両方を確かめる
    const { password, code } = await readJsonBody(req);
    await confirmIdentity(config, shared, req, user, { password, code });
    disableMfa(shared, user);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/me/mfa/recovery' && method === 'POST') {
    // バックアップコードを再発行する（前のものは使えなくなる）。コードを確かめる
    const { code } = await readJsonBody(req);
    await confirmIdentity(config, shared, req, user, { code });
    sendJson(res, 200, { recoveryCodes: renewRecoveryCodes(shared, user) });
    return;
  }
  const purge = /^\/api\/data\/(timeline|takeout|swarm|userdata)$/.exec(path);
  if (purge && method === 'DELETE') {
    // 取り込みの画面から、送ったデータを消す（取り込みの途中は断る）
    if (importing.has(user)) throw new HttpError(409, '現在、別のデータ処理を実行中です。完了してから再度お試しください。');
    importing.add(user);
    try {
      const dir = userDir(config.dataDir, user);
      if (purge[1] === 'timeline') deleteTimeline(db, dir);
      else if (purge[1] === 'takeout') {
        const o = assignOptions(config);
        deleteTakeout(db, dir, { stopM: o.labelStopM, labelM: o.takeout.labelM, tzOffsetMinutes: o.tzOffsetMinutes });
      } else if (purge[1] === 'swarm') deleteSwarm(db, dir);
      else deleteUserData(db);
    } finally {
      importing.delete(user);
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/userdata' && method === 'GET') {
    // 自分で付けた名前・メモ・タグとブックマークを JSON で書き出す（ファイルとして保存させる）
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Content-Disposition': `attachment; filename="gtexp-userdata-${user}-${day}.json"`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(exportUserData(db), null, 2));
    return;
  }
  if (path === '/api/userdata' && method === 'POST') {
    let data: unknown;
    try {
      data = await readJsonBody(req, 50_000_000);
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) throw new HttpError(400, 'ファイルを読み込めませんでした。「エクスポート（JSON）」で保存したファイルを選択してください。');
      throw e;
    }
    let counts: { notes: number; bookmarks: number };
    try {
      counts = importUserData(db, data);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    recordImport(db, 'userdata', decodeURIComponent(String(req.headers['x-file-name'] ?? '')), counts);
    sendJson(res, 200, counts);
    return;
  }
  if (path === '/api/config' && method === 'GET') {
    const body: ClientConfig = { mapsApiKey: config.mapsApiKey, mapId: config.mapId, tzOffsetMinutes: config.tzOffsetMinutes };
    sendJson(res, 200, body);
    return;
  }
  if (path === '/api/import' && method === 'POST') {
    sendJson(res, 200, await handleImport(config, user, db, req));
    return;
  }
  if (path === '/api/takeout' && method === 'POST') {
    sendJson(res, 200, await handleTakeout(config, user, db, req));
    return;
  }
  if (path === '/api/areas/assign' && method === 'POST') {
    // 取り込みのときと同じ割り当てを、取り込み直さずに行う（位置参照情報を入れた直後など）
    if (importing.has(user)) throw new HttpError(409, '現在、別のデータ処理を実行中です。完了してから再度お試しください。');
    importing.add(user);
    try {
      sendJson(res, 200, assignForImport(db, assignOptions(config)));
    } finally {
      importing.delete(user);
    }
    return;
  }
  if (path === '/api/imports' && method === 'GET') {
    sendJson(res, 200, listImports(db));
    return;
  }
  if (path === '/api/summary' && method === 'GET') {
    sendJson(res, 200, getSummary(db));
    return;
  }
  if (path === '/api/day' && method === 'GET') {
    const date = url.searchParams.get('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, '日付の形式が正しくありません（YYYY-MM-DD）。');
    sendJson(res, 200, getDay(db, date, config.tzOffsetMinutes));
    return;
  }
  if (path === '/api/calendar' && method === 'GET') {
    const year = Number(url.searchParams.get('year'));
    if (!Number.isInteger(year)) throw new HttpError(400, '年の指定が正しくありません。');
    sendJson(res, 200, getCalendar(db, year));
    return;
  }
  if (path === '/api/search' && method === 'GET') {
    sendJson(res, 200, search(db, parseSearchQuery(url.searchParams)));
    return;
  }
  if (path === '/api/trips' && method === 'GET') {
    const q = parsePlaceQuery(url.searchParams); // 期間の読み方は同じ
    sendJson(res, 200, listTrips(db, q.from, q.to));
    return;
  }
  const tripMatch = path.match(/^\/api\/trips\/(\d+)$/);
  if (tripMatch && method === 'GET') {
    const detail = getTrip(db, Number(tripMatch[1])); // 開始時刻（ms）
    if (!detail) throw new HttpError(404, '該当する旅行の記録が見つかりません。');
    sendJson(res, 200, detail);
    return;
  }
  if (path === '/api/export' && method === 'GET') {
    handleExport(db, url.searchParams, res);
    return;
  }
  if (path === '/api/lists' && method === 'GET') {
    // Takeout の保存リストの一覧
    sendJson(res, 200, listNames(db));
    return;
  }
  if (path === '/api/lists/entries' && method === 'GET') {
    const list = url.searchParams.get('list') ?? '';
    if (!list) throw new HttpError(400, 'リストが指定されていません。');
    sendJson(res, 200, listEntries(db, list, config.takeoutNearM));
    return;
  }
  if (path === '/api/places' && method === 'GET') {
    sendJson(res, 200, listPlaces(db, parsePlaceQuery(url.searchParams)));
    return;
  }
  if (path === '/api/places/extent' && method === 'GET') {
    sendJson(res, 200, placesExtent(db));
    return;
  }
  const placeMatch = path.match(/^\/api\/places\/([^/]+)$/);
  if (placeMatch && method === 'GET') {
    const detail = getPlace(db, decodeURIComponent(placeMatch[1]));
    if (!detail) throw new HttpError(404, '該当する場所の記録が見つかりません。');
    sendJson(res, 200, detail);
    return;
  }
  if (path === '/api/places/tags' && method === 'POST') {
    // まとめてタグ付け：{ placeIds, add, remove }。実際に変わった場所の placeId を返す
    const body = await readJsonBody(req);
    const ids: string[] = Array.isArray(body.placeIds) ? body.placeIds.map(String) : [];
    if (!ids.length || ids.length > 2000) throw new HttpError(400, '対象の場所（1〜2,000 件）を指定してください。');
    const tags = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((t) => normalizeTag(String(t))).filter(Boolean))] : []);
    const add = tags(body.add);
    const remove = tags(body.remove);
    if (!add.length && !remove.length) throw new HttpError(400, '追加または解除するタグを指定してください');
    sendJson(res, 200, { changed: bulkTags(db, ids, add, remove) });
    return;
  }
  if (path === '/api/bookmarks' && method === 'GET') {
    sendJson(res, 200, listBookmarks(db));
    return;
  }
  if (path === '/api/bookmarks' && method === 'POST') {
    // { hash, title }。同じ画面がもうあれば、名前だけ変える
    const body = await readJsonBody(req);
    const hash = String(body.hash ?? '');
    if (!/^#\/[^\s]*$/.test(hash) || hash.length > 2000) throw new HttpError(400, 'ブックマーク先の URL 指定が正しくありません。');
    sendJson(res, 200, addBookmark(db, hash, bookmarkTitle(body.title, hash)));
    return;
  }
  if (path === '/api/bookmarks/order' && method === 'PUT') {
    // { ids }：並べたい順の id
    const body = await readJsonBody(req);
    const ids: number[] = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isInteger))] as number[] : [];
    if (!ids.length || ids.length > 10_000) throw new HttpError(400, '並び順の指定が正しくありません。');
    reorderBookmarks(db, ids);
    sendJson(res, 200, listBookmarks(db));
    return;
  }
  const bookmarkMatch = path.match(/^\/api\/bookmarks\/(\d+)$/);
  if (bookmarkMatch && method === 'PUT') {
    const body = await readJsonBody(req);
    const b = renameBookmark(db, Number(bookmarkMatch[1]), bookmarkTitle(body.title, ''));
    if (!b) throw new HttpError(404, '該当するブックマークが見つかりません。');
    sendJson(res, 200, b);
    return;
  }
  if (bookmarkMatch && method === 'DELETE') {
    deleteBookmark(db, Number(bookmarkMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }
  const noteMatch = path.match(/^\/api\/places\/([^/]+)\/note$/);
  if (noteMatch && method === 'PUT') {
    const body = await readJsonBody(req);
    const note: PlaceNote = {
      name: String(body.name ?? '').slice(0, 200),
      memo: String(body.memo ?? '').slice(0, 5000),
      tags: Array.isArray(body.tags) ? [...new Set(body.tags.map((t: unknown) => normalizeTag(String(t))).filter(Boolean))].slice(0, 50) as string[] : [],
    };
    savePlaceNote(db, decodeURIComponent(noteMatch[1]), note);
    sendJson(res, 200, note);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function serve(): void {
  const config = loadConfig();
  const shared = openSharedDb(config.dataDir);
  const server = createServer((req, res) => {
    route(config, shared, req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'サーバーでエラーが発生しました。しばらく待ってから再度お試しください。' });
      else res.end();
    });
  });
  // 取り込みは大きいファイルを受け取るので、タイムアウトを長めにする
  server.requestTimeout = 30 * 60_000;
  server.listen(config.port, config.host, () => {
    console.log(`${startedAt} ${PROFILE.shortTitle} ${PROFILE.version}: http://${config.host}:${config.port}/（Node.js ${process.version}、利用者 ${listUsers(shared).length} 人、ビルド ${BUILT_AT}${BUILD.commit ? ` ${BUILD.commit}${BUILD.dirty ? "+" : ""}` : ""}）`);
    // 秘密の値以外の設定を全部出しておく（どの設定で動いているかを、ログだけで確かめられるように）
    for (const line of describeConfig(config)) console.log(line);
    if (!existsSync(join(config.publicDir, 'index.html'))) {
      console.warn(`注意: ${config.publicDir} に画面のファイル（index.html）がありません（npm run build を実行したか、publicDir が正しいか確かめてください）`);
    }
  });
}

/** 質問を順に聞く（1 つの readline で聞かないと、パイプで渡したときに 2 行目が失われる） */
async function ask(prompts: string[]): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const answers: string[] = [];
  try {
    for (const p of prompts) {
      process.stdout.write(p);
      const r = await lines.next();
      if (r.done) throw new Error('入力が途中で終わりました');
      answers.push(r.value);
    }
  } finally {
    rl.close();
  }
  return answers;
}

/**
 * コマンドの --user <名前> を取り出す（args からは除く）。指定がなく、利用者が 1 人だけならその人
 */
function takeUser(shared: DatabaseSync, args: string[]): string {
  const i = args.indexOf('--user');
  if (i >= 0) {
    const name = args[i + 1] ?? '';
    args.splice(i, 2);
    if (!getUser(shared, name)) throw new Error(`${name} という利用者はいません（user-list で確かめてください）`);
    return name;
  }
  const users = listUsers(shared);
  if (users.length === 1) return users[0].name;
  if (!users.length) throw new Error('利用者がいません（user-add で足してください）');
  throw new Error(`利用者が複数いるので --user で指定してください（${users.map((u) => u.name).join(', ')}）`);
}

/** パスワードを 2 回聞く（打ち間違いを防ぐ） */
async function readNewPassword(): Promise<string> {
  const [password, again] = await ask(['パスワード: ', 'もう一度: ']);
  if (!password) throw new Error('パスワードが空です');
  if (again !== password) throw new Error('パスワードが一致しません');
  return password;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'serve':
      serve();
      break;
    case 'check': {
      // 設置の確認。要対応があれば終了コード 1
      if (!(await runCheck(loadConfig()))) process.exitCode = 1;
      break;
    }
    case 'user-add': {
      // 利用者を足す。パスワードは聞く
      const name = args[0] ?? '';
      checkUserName(name);
      const config = loadConfig();
      const shared = openSharedDb(config.dataDir);
      if (getUser(shared, name)) throw new Error(`${name} はもういます`);
      addUser(shared, name, hashPassword(await readNewPassword()));
      console.log(`${name} を足しました。記録は ${userDir(config.dataDir, name)} に置きます`);
      break;
    }
    case 'user-passwd': {
      // パスワードを変える（その利用者は、ログイン中の端末もすべてログアウトされる）
      const name = args[0] ?? '';
      const config = loadConfig();
      const shared = openSharedDb(config.dataDir);
      if (!getUser(shared, name)) throw new Error(`${name} という利用者はいません`);
      setPassword(shared, name, await readNewPassword());
      console.log(`${name} のパスワードを変えました`);
      break;
    }
    case 'user-mfa-reset': {
      // 2 段階認証を外す（アプリを使えなくなり、バックアップコードもないとき。sessionSecret を変えたときも）
      const name = args[0] ?? '';
      const config = loadConfig();
      const shared = openSharedDb(config.dataDir);
      if (!getUser(shared, name)) throw new Error(`${name} という利用者はいません`);
      console.log(disableMfa(shared, name) ? `${name} の 2 段階認証を外しました。パスワードだけでログインできます` : `${name} は 2 段階認証を使っていません`);
      break;
    }
    case 'user-del': {
      // ログインできなくするだけで、記録のフォルダーは残す
      const name = args[0] ?? '';
      const config = loadConfig();
      deleteUser(openSharedDb(config.dataDir), name);
      console.log(`${name} を消しました。記録（${userDir(config.dataDir, name)}）は残してあるので、要らなければ手で消してください`);
      break;
    }
    case 'user-list': {
      const config = loadConfig();
      for (const u of listUsers(openSharedDb(config.dataDir))) console.log(`${u.name}\t${u.createdAt}\t${userDir(config.dataDir, u.name)}`);
      break;
    }
    case 'import': {
      const config = loadConfig();
      const user = takeUser(openSharedDb(config.dataDir), args);
      if (!args[0]) throw new Error('使い方: import [--user 名前] <エクスポートした JSON ファイル>');
      const db = openUserDb(config.dataDir, user);
      const raw = readFileSync(args[0]);
      const text = gunzipLimited(raw).toString('utf8');
      const data = JSON.parse(text);
      if (!isTimelineExport(data)) throw new Error('タイムラインのエクスポートファイルではありません');
      console.log(importTimeline(db, data, args[0], resolve(args[0]), assignOptions(config)));
      break;
    }
    case 'import-isj': {
      // 全員で使うデータ。地点への割り当ては、利用者ごとに次の取り込みで行う
      if (!args.length) throw new Error('使い方: import-isj <位置参照情報の zip か csv ...>');
      const config = loadConfig();
      console.log(importAreas(openSharedDb(config.dataDir), args, config.isjDir));
      console.log('地点への住所の割り当ては、次にタイムラインを取り込んだときに行われます。');
      break;
    }
    case 'fetch-osm': {
      // cron から毎時起動する。--limit 件まで、--min-wait〜--max-wait 秒おき（下限 15 秒）に問い合わせる。
      // --user がなければ全員の分を、順に回しながら取る
      const opt = (name: string, def: number) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? Number(args[i + 1]) : def;
      };
      const startedMs = Date.now();
      // 結果を出す前にプロセスが終わってしまったら、どこまで進んでいたかを出す
      process.on('exit', (code) => {
        if (osmRun.finished) return;
        console.log(
          new Date().toISOString(),
          `結果を出す前に終了しました（終了コード ${code}、${osmRun.current || '開始前'}、取得 ${osmRun.done} / ${osmRun.target} か所、` +
            `${Math.round((Date.now() - startedMs) / 1000)} 秒）。応答を待つ途中で止まった可能性があります。data/osm.lock が残っていたら消してください`,
        );
      });
      const config = loadConfig();
      const shared = openSharedDb(config.dataDir);
      const names = args.includes('--user') ? [takeUser(shared, args)] : listUsers(shared).map((u) => u.name);
      const r = await fetchOsm(names.map((name) => ({ name, db: openUserDb(config.dataDir, name) })), {
        endpoint: config.osmEndpoint,
        userAgent: config.osmUserAgent,
        dataDir: config.dataDir,
        // 間隔は平均 20 秒なので、150 件で約 50 分（毎時の起動に収まる）
        limit: opt('limit', 150),
        minWait: opt('min-wait', 15),
        maxWait: opt('max-wait', 25),
      });
      const min = Math.round((Date.now() - startedMs) / 6000) / 10;
      console.log(new Date().toISOString(), `終了（${min} 分）：`, JSON.stringify(r));
      break;
    }
    case 'import-takeout': {
      // Google Takeout の zip（複数可、フォルダーでもよい）から、保存した場所・ラベル・保存リストを入れる（割り当てはしない）
      const config = loadConfig();
      const user = takeUser(openSharedDb(config.dataDir), args);
      if (!args.length) throw new Error('使い方: import-takeout [--user 名前] <Takeout の zip かフォルダー ...>');
      console.log(importTakeoutZips(openUserDb(config.dataDir, user), join(userDir(config.dataDir, user), 'takeout'), args));
      console.log('地点への割り当ては、次にタイムラインを取り込んだとき（か、「このアプリについて」画面の「今すぐ照合する」）に行われます。');
      break;
    }
    case 'import-swarm': {
      // Foursquare Swarm の書き出しの zip から、チェックインを入れる（割り当てはしない）
      const config = loadConfig();
      const user = takeUser(openSharedDb(config.dataDir), args);
      if (!args[0]) throw new Error('使い方: import-swarm [--user 名前] <Swarm の書き出しの zip>');
      console.log(importSwarmZip(openUserDb(config.dataDir, user), join(userDir(config.dataDir, user), 'swarm'), args[0]));
      console.log('地点への割り当ては、次にタイムラインを取り込んだとき（か、「このアプリについて」画面の「今すぐ照合する」）に行われます。');
      break;
    }
    case 'import-osm-poi': {
      // osmium export -f geojsonseq で作った「名前の付いた施設」のファイルを入れる（全員で使うデータ。地点への割り当てはしない）
      if (!args[0]) throw new Error('使い方: import-osm-poi <施設の geojsonseq ファイル>');
      const config = loadConfig();
      console.log(await importOsmPois(openSharedDb(config.dataDir), args[0]));
      console.log('地点への施設名の割り当ては、次にタイムラインを取り込んだとき（か、「このアプリについて」画面の「今すぐ照合する」）に行われます。');
      break;
    }
    case 'osm-poi-keys': {
      // 入れてある OSM の施設から、名前で探す索引だけを作り直す（import-osm-poi でも作る）
      const config = loadConfig();
      console.log({ keys: buildPoiKeys(openSharedDb(config.dataDir)) });
      break;
    }
    case 'osm-lookup': {
      // 1地点だけ問い合わせて結果を表示する（保存しない）。動作確認用
      const [lat, lng] = args.map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('使い方: osm-lookup <緯度> <経度>');
      const config = loadConfig();
      console.log(JSON.stringify(await lookupOsm({ endpoint: config.osmEndpoint, userAgent: config.osmUserAgent }, lat, lng), null, 2));
      break;
    }
    case 'assign-areas': {
      const config = loadConfig();
      const user = takeUser(openSharedDb(config.dataDir), args);
      console.log(JSON.stringify(assignAll(openUserDb(config.dataDir, user), assignOptions(config)), null, 2));
      break;
    }
    default:
      console.log(`${PROFILE.title} ${PROFILE.version}
${PROFILE.copyright}

使い方（[--user 名前] は、利用者が 1 人だけなら省ける）:
  serve                  サーバーを起動する
  check                  設置を確かめる（サービスの定義・ビルド・画面のファイル・設定・持ち主・動いているサーバーのバージョンなど）
  user-add <名前>        利用者を足す（パスワードを聞く）。名前は英小文字・数字・_・- で 32 文字まで
  user-passwd <名前>     パスワードを変える（その利用者のログイン中の端末はすべてログアウトされる）
  user-mfa-reset <名前>  2 段階認証を外す（アプリを使えなくなり、バックアップコードもないとき）
  user-del <名前>        利用者を消す（ログインできなくするだけ。記録のフォルダー data/users/<名前> は残す）
  user-list              利用者の一覧
  import [--user 名前] <file>
                         エクスポートした JSON（.gz も可）をコマンドから取り込む
  import-isj <file...>   国土交通省「位置参照情報」の zip を入れる（全員で使う。zip を持ち込んだときだけ）
                         大字・町丁目レベル（*-19.0b.zip など）は DB に入れる。街区レベル（*-24.0a.zip など）は
                         isjDir（既定は data/isj）に置いたまま使う。地点への住所の割り当ては、
                         タイムラインを取り込むたびにアプリが行う
  assign-areas [--user 名前]
                         すべての地点の住所を付け直す（保守用）
  import-takeout [--user 名前] <zip..>
                         Google Takeout の zip（フォルダーでもよい）から、保存した場所・ラベルを付けた場所・
                         保存リストを入れる。地点への割り当ては取り込みのたびにアプリが行う
  import-swarm [--user 名前] <zip>
                         Foursquare Swarm の書き出しの zip から、チェックインを入れる。
                         地点への割り当ては取り込みのたびにアプリが行う
  import-osm-poi <file>  OpenStreetMap の名前の付いた施設（osmium export -f geojsonseq の出力）を入れる（全員で使う）
                         （deploy/make-osm-poi.sh が作って入れる）。地点への割り当ては取り込みのたびにアプリが行う
  osm-poi-keys           入れてある OSM の施設から、保存リストの店を名前で探す索引だけを作り直す
  fetch-osm [--user 名前] [--limit N]
                         OpenStreetMap（Nominatim）から、まだ調べていない地点の住所を最大 N 件（既定 150）取る。
                         --user がなければ全員の分を、順に回しながら取る。
                         問い合わせは 15〜25 秒に1回。cron から毎時起動する（deploy/fetch-osm.sh）
  osm-lookup <lat> <lng> 1地点だけ Nominatim に住所を問い合わせて表示する（保存しない）`);
  }
}

main().catch((e) => {
  console.error(errorDetail(e));
  process.exit(1);
});
