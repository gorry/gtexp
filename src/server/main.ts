import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import { extname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, describeConfig, type Config } from './config';
import { clearSessionCookie, hashPassword, isHttps, issueSessionCookie, loggedInUser, verifyPassword } from './auth';
import { addUser, checkUserName, deleteUser, getUser, listUsers, setPassword } from './users';
import { bulkTags, normalizeTag, getCalendar, getDay, getPlace, getSummary, getTrip, listImports, listPlaces, placesExtent, listTrips, openSharedDb, openUserDb, savePlaceNote, userDir, search, type PlaceQuery, type SearchQuery } from './db';
import { importTimeline, isTimelineExport } from './importer';
import { assignAll, assignForImport, importAreas, type AssignOptions } from './areas';
import { importTakeoutZips } from './takeout';
import { errorDetail, fetchOsm, lookupOsm, osmRun } from './osm';
import { importOsmPois } from './osmpoi';
import { buildPoiKeys, listEntries, listNames } from './lists';
import { CONTENT_TYPES, EXPORT_FORMATS, render, type ExportData, type ExportFormat } from './exporter';
import type { ClientConfig, PlaceKind, PlaceNote, PlaceSort, SearchGroup, SearchTarget } from '../shared/types';
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

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readJsonBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'リクエストが大きすぎます');
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
    if (!existsSync(file)) throw new HttpError(404, '画面のファイルがありません（npm run build を実行してください）');
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
    if (v && !DATE_RE.test(v)) throw new HttpError(400, `${key} は YYYY-MM-DD で指定してください`);
    return v;
  };
  const kind = (p.get('kind') ?? '') as PlaceKind;
  const sort = (p.get('sort') ?? 'count') as PlaceSort;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'kind の値が正しくありません');
  if (!SORTS.includes(sort)) throw new HttpError(400, 'sort の値が正しくありません');
  let bbox: PlaceQuery['bbox'] = null;
  if (p.get('bbox')) {
    const nums = p.get('bbox')!.split(',').map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new HttpError(400, 'bbox は 南,西,北,東 で指定してください');
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

const TARGETS: SearchTarget[] = ['visits', 'activities'];
const GROUPS: SearchGroup[] = ['year', 'month', 'weekday', 'hour', 'mode'];

function parseSearchQuery(p: URLSearchParams): SearchQuery {
  const base = parsePlaceQuery(p); // 期間・q・kind・limit・offset の読み方は場所の一覧と同じ
  const target = (p.get('target') ?? 'visits') as SearchTarget;
  const group = (p.get('group') ?? 'year') as SearchGroup;
  if (!TARGETS.includes(target)) throw new HttpError(400, 'target の値が正しくありません');
  if (!GROUPS.includes(group)) throw new HttpError(400, 'group の値が正しくありません');
  const list = (key: string) => (p.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const weekdays = list('weekdays').map(Number);
  if (weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) throw new HttpError(400, 'weekdays は 0〜6 で指定してください');
  const modes = list('modes');
  if (modes.some((m) => !/^[A-Z_]+$/.test(m))) throw new HttpError(400, 'modes の値が正しくありません');
  return { target, from: base.from, to: base.to, weekdays, q: base.q, kind: base.kind, modes, group, limit: base.limit, offset: base.offset };
}

/**
 * 絞り込んだ記録をファイルとして返す。source=search は集計の条件（滞在か移動）、
 * source=places は場所の一覧の条件。件数の上限はかけず、条件に合うものを全部書き出す。
 */
function handleExport(db: DatabaseSync, p: URLSearchParams, res: ServerResponse): void {
  const format = (p.get('format') ?? '') as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw new HttpError(400, 'format は csv / kml / gpx / geojson のどれかです');
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
    ({ from, to } = q);
    const r = search(db, { ...q, limit: -1, offset: 0 });
    data = q.target === 'visits' ? { kind: 'visits', items: r.visits } : { kind: 'activities', items: r.activities };
  } else {
    throw new HttpError(400, 'source は search か places です');
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
  return { isjDir: config.isjDir, takeout: { sameM: config.takeoutSameM, nearM: config.takeoutNearM, labelM: config.takeoutLabelM } };
}

/** ログイン失敗が続いたら待たせる（パスワード総当たり対策） */
const loginFailures: number[] = [];
function tooManyFailures(): boolean {
  const since = Date.now() - 10 * 60_000;
  while (loginFailures.length && loginFailures[0] < since) loginFailures.shift();
  return loginFailures.length >= 10;
}

/** 取り込みか住所の割り当てを処理中の利用者 */
const importing = new Set<string>();

/** アップロードされたファイル（gzip でも素の JSON でもよい）を、利用者のフォルダーに保存して取り込む */
async function handleImport(config: Config, user: string, db: DatabaseSync, req: IncomingMessage) {
  if (importing.has(user)) throw new HttpError(409, '別の取り込みを処理中です');
  importing.add(user);
  const dir = join(userDir(config.dataDir, user), 'imports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const rawName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'timeline.json'));
  const fileName = rawName.replace(/[^\w.\-]/g, '_').slice(0, 100);
  const tmp = join(dir, `${stamp}.upload`);
  try {
    await pipeline(req, createWriteStream(tmp));
    const head = Buffer.alloc(2);
    const fh = await open(tmp, 'r');
    await fh.read(head, 0, 2, 0);
    await fh.close();
    const gzipped = head[0] === 0x1f && head[1] === 0x8b;

    const raw = readFileSync(tmp);
    const text = (gzipped ? gunzipSync(raw) : raw).toString('utf8');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'JSON として読めませんでした');
    }
    if (!isTimelineExport(data)) throw new HttpError(400, 'タイムラインのエクスポートファイルではありません（semanticSegments がありません）');

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

/** Takeout の zip を受け取る上限。「マップ」「保存済み」だけなら数 MB。写真まで含めた書き出しは断る */
const TAKEOUT_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Google Takeout の zip（複数可。multipart/form-data の file）を受け取って入れる。zip は残さず、使うファイルだけを
 * 利用者のフォルダーの takeout/ に取り出す（zip に入っていた種類だけ置き換える）。
 * 入れたあと、取り込みのときと同じ割り当てを行う（地点名がすぐ付くように）
 */
async function handleTakeout(config: Config, user: string, db: DatabaseSync, req: IncomingMessage) {
  if (Number(req.headers['content-length'] ?? 0) > TAKEOUT_MAX_BYTES) {
    throw new HttpError(413, 'ファイルが大きすぎます。Takeout では「マップ」と「保存済み」だけを選び、「マップ」の「写真と動画」を外して書き出してください');
  }
  if (importing.has(user)) throw new HttpError(409, '別の取り込みを処理中です');
  importing.add(user);
  // 受け取った zip を一時的に置く場所（取り出したら消す）
  const tmp = join(userDir(config.dataDir, user), 'takeout-upload');
  try {
    let form: FormData;
    try {
      form = await new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': String(req.headers['content-type'] ?? '') },
        body: Readable.toWeb(req) as ReadableStream,
        duplex: 'half',
      } as RequestInit).formData();
    } catch {
      throw new HttpError(400, 'ファイルを受け取れませんでした');
    }
    const files = form.getAll('file').filter((v): v is File => typeof v !== 'string');
    if (!files.length) throw new HttpError(400, 'ファイルがありません');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const [i, file] of files.entries()) {
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, `${file.name} は zip ファイルではありません`);
      writeFileSync(join(tmp, `${String(i + 1).padStart(2, '0')}_${file.name.replace(/[^\w.\-]/g, '_').slice(0, 100)}`), buf);
    }
    let stats;
    try {
      stats = importTakeoutZips(db, join(userDir(config.dataDir, user), 'takeout'), [tmp]);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return { ok: true, ...stats, addresses: assignForImport(db, assignOptions(config)) };
  } finally {
    importing.delete(user);
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function route(config: Config, shared: DatabaseSync, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

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

  if (path === '/api/login' && method === 'POST') {
    if (tooManyFailures()) throw new HttpError(429, 'しばらく時間をおいてから試してください');
    const { user: rawUser, password } = await readJsonBody(req);
    const name = String(rawUser ?? '').trim().toLowerCase();
    const user = name ? getUser(shared, name) : null;
    if (!listUsers(shared).length) throw new HttpError(500, '利用者がいません（サーバーで node dist/server.mjs user-add を実行してください）');
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.passwordHash)) {
      loginFailures.push(Date.now());
      await new Promise((r) => setTimeout(r, 1000));
      throw new HttpError(401, '利用者名かパスワードが違います');
    }
    sendJson(res, 200, { loggedIn: true, user: user.name }, {
      'Set-Cookie': issueSessionCookie(config.sessionSecret, user.name, user.sessionKey, config.sessionDays, isHttps(req)),
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
    sendJson(res, 200, user ? { loggedIn: true, user } : { loggedIn: false });
    return;
  }
  if (!user) throw new HttpError(401, 'ログインしてください');
  // ここから先は、ログインしている利用者の記録だけを扱う
  const db = userDb(config, user);

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
    if (importing.has(user)) throw new HttpError(409, '取り込みか住所の割り当てを処理中です');
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date は YYYY-MM-DD で指定してください');
    sendJson(res, 200, getDay(db, date, config.tzOffsetMinutes));
    return;
  }
  if (path === '/api/calendar' && method === 'GET') {
    const year = Number(url.searchParams.get('year'));
    if (!Number.isInteger(year)) throw new HttpError(400, 'year を指定してください');
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
    if (!detail) throw new HttpError(404, 'その旅行の記録はありません');
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
    if (!list) throw new HttpError(400, 'list を指定してください');
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
    if (!detail) throw new HttpError(404, 'その場所の記録はありません');
    sendJson(res, 200, detail);
    return;
  }
  if (path === '/api/places/tags' && method === 'POST') {
    // まとめてタグ付け：{ placeIds, add, remove }。実際に変わった場所の placeId を返す
    const body = await readJsonBody(req);
    const ids: string[] = Array.isArray(body.placeIds) ? body.placeIds.map(String) : [];
    if (!ids.length || ids.length > 2000) throw new HttpError(400, 'placeIds は 1〜2000 件で指定してください');
    const tags = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((t) => normalizeTag(String(t))).filter(Boolean))] : []);
    const add = tags(body.add);
    const remove = tags(body.remove);
    if (!add.length && !remove.length) throw new HttpError(400, '付けるか外すタグを指定してください');
    sendJson(res, 200, { changed: bulkTags(db, ids, add, remove) });
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
      if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'サーバーでエラーが起きました' });
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
      const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
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
      console.log('地点への割り当ては、次にタイムラインを取り込んだとき（か、取り込み画面の「今すぐ調べる」）に行われます。');
      break;
    }
    case 'import-osm-poi': {
      // osmium export -f geojsonseq で作った「名前の付いた施設」のファイルを入れる（全員で使うデータ。地点への割り当てはしない）
      if (!args[0]) throw new Error('使い方: import-osm-poi <施設の geojsonseq ファイル>');
      const config = loadConfig();
      console.log(await importOsmPois(openSharedDb(config.dataDir), args[0]));
      console.log('地点への施設名の割り当ては、次にタイムラインを取り込んだとき（か、取り込み画面の「今すぐ調べる」）に行われます。');
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
  check                  設置を確かめる（サービスの定義・ビルド・画面のファイル・設定・持ち主・動いているサーバーの版など）
  user-add <名前>        利用者を足す（パスワードを聞く）。名前は英小文字・数字・_・- で 32 文字まで
  user-passwd <名前>     パスワードを変える（その利用者のログイン中の端末はすべてログアウトされる）
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
