import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { transaction } from './tx';
import { setKv } from './labelstore';

// OpenStreetMap の Nominatim（逆ジオコーディング）で、地点の住所を少しずつ取って貯める（取得方法 osm-addr）。
// 海外の地点にも住所が付く。施設名は手元の OSM データから付ける（osmpoi.ts）。
// cron から毎時 fetch-osm を起動し、まだ調べていない地点をよく行く順に、1回あたり最大 150 件取る
// （間隔は平均 20 秒なので約 50 分）。利用者が複数いるときは、全員で 150 件を、利用者を順に回しながら分け合う
// （問い合わせの間隔の決まりはサーバー全体で守る必要があるので）。結果は利用者ごとの DB に保存する。
//
// Nominatim 公開サーバーの利用規約（https://operations.osmfoundation.org/policies/nominatim/）を守る：
// - 1日以上かけて動かすスクリプトは 1分あたり 4 件まで → 15〜25 秒に1件（平均 20 秒）
// - 並列にしない（ロックファイルで同時実行を防ぐ）、アプリを識別できる User-Agent を付ける
// - 結果は手元に保存する、「© OpenStreetMap contributors」を表示する（ODbL）
// - 混雑・拒否の応答（429 / 403 / 503 / 509）が来たら、その回はすぐ止める
//
// 結果は place_labels に取得方法 osm-addr として保存し、調べたこと（見つからなかった場合も）は label_checks に記録する。

const ADDR = 'osm-addr';

/** 規約の「1分あたり 4 件まで」を守るための、問い合わせの間隔の下限（秒） */
const MIN_WAIT_FLOOR = 15;

export interface OsmOptions {
  endpoint: string;
  userAgent: string;
  dataDir: string;
  limit: number;
  minWait: number;
  maxWait: number;
}

interface NominatimResult {
  error?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
}

export interface OsmAddress {
  text: string;
  shortText: string;
  detail: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

/**
 * エラーの詳しい内容。fetch の失敗は「fetch failed」としか出ず、本当の原因（名前解決・時間切れ・
 * 接続拒否・証明書など）は cause に入っているので、それも並べる
 */
export function errorDetail(e: unknown): string {
  const parts: string[] = [];
  let cur: any = e;
  for (let depth = 0; cur && depth < 4; depth++) {
    const code = cur.code ? `[${cur.code}] ` : '';
    // IPv4・IPv6 の宛先を順に試して全部失敗すると、個々の失敗をまとめた AggregateError（説明は空）になる
    const each = Array.isArray(cur.errors)
      ? ` {${cur.errors.map((x: any) => `${x.code ?? ''} ${x.address ?? ''}${x.port ? `:${x.port}` : ''}`.trim()).join(', ')}}`
      : '';
    parts.push(`${code}${cur.message ?? String(cur)}${each}`);
    cur = cur.cause;
  }
  return parts.join(' ← ');
}

/** ISO 3166-2 の都道府県コード（JP-01〜47）。東京都などは都道府県名の項目がなくコードだけのことがある */
const JP_PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

/** 日本の住所は大きい順につなげる（区切りなし）。番地は付いているときだけ */
const JP_ORDER = ['county', 'city', 'town', 'village', 'city_district', 'suburb', 'quarter', 'neighbourhood', 'hamlet', 'house_number'];

/** Nominatim の応答から住所を取り出す */
export function parseNominatim(r: NominatimResult): OsmAddress | null {
  if (r.error || !r.address) return null;
  const a = r.address;
  if (a.country_code === 'jp') {
    const code = /^JP-(\d{2})$/.exec(a['ISO3166-2-lvl4'] ?? '')?.[1];
    const pref = a.province || a.state || (code ? JP_PREFS[Number(code) - 1] : '');
    const parts = JP_ORDER.map((k) => a[k]).filter(Boolean);
    // 重複と、後ろの項目に含まれる項目（「丸の内」と「丸の内一丁目」など）を除く
    const uniq = parts.filter((p, i) => parts.indexOf(p) === i && !parts.slice(i + 1).some((q) => q !== p && q.startsWith(p)));
    return uniq.length ? { text: `${pref ?? ''}${uniq.join('')}`, shortText: uniq.join(''), detail: a } : null;
  }
  if (r.display_name) {
    // 海外は Nominatim の表記（小さい順・カンマ区切り）から施設名と郵便番号を除いて使う
    const parts = r.display_name.split(', ').filter((p) => p !== r.name && p !== a.postcode);
    return { text: parts.join(', '), shortText: parts.slice(0, 3).join(', '), detail: a };
  }
  return null;
}

/**
 * 海外（ドイツ）の公開サーバーに繋ぐための設定。fetch-osm / osm-lookup のときだけ呼ぶ。
 * Node は IPv4・IPv6 の宛先を順に試すとき、1つの宛先を 250 ミリ秒しか待たずに次へ移る。日本からは接続の確立に
 * それ以上かかることがあり、IPv6 で外に出られないサーバーでは全部失敗する（IPv6 は EHOSTUNREACH、
 * IPv4 は ETIMEDOUT になる）。IPv4 を先に試し、1つの宛先を 2.5 秒まで待つ
 */
function prepareNetwork(): void {
  setDefaultResultOrder('ipv4first');
  setDefaultAutoSelectFamilyAttemptTimeout(2500);
}

/** Nominatim の逆ジオコーディング（住所だけを対象にする） */
async function reverse(opts: Pick<OsmOptions, 'endpoint' | 'userAgent'>, lat: number, lng: number): Promise<{ status: number; body: NominatimResult | null }> {
  const q = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    zoom: '18',
    layer: 'address',
    addressdetails: '1',
    'accept-language': 'ja,en',
  });
  const res = await fetch(`${opts.endpoint.replace(/\/$/, '')}/reverse?${q}`, { headers: { 'User-Agent': opts.userAgent } });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: (await res.json()) as NominatimResult };
}

/** 1地点だけ問い合わせて、保存せずに結果を返す（動作確認用） */
export async function lookupOsm(opts: Pick<OsmOptions, 'endpoint' | 'userAgent'>, lat: number, lng: number) {
  prepareNetwork();
  const r = await reverse(opts, lat, lng);
  return { status: r.status, address: r.body?.address, parsed: r.body ? parseNominatim(r.body) : null };
}

function saveAddress(db: DatabaseSync, placeId: string, addr: OsmAddress | null, now: string): void {
  transaction(db, () => {
    if (addr) {
      db.prepare(
        `INSERT INTO place_labels (place_id, source, kind, text, short_text, detail, dist_m, updated_at) VALUES (?, '${ADDR}', 'address', ?, ?, ?, NULL, ?)
         ON CONFLICT(place_id, source) DO UPDATE SET text = excluded.text, short_text = excluded.short_text,
           detail = excluded.detail, updated_at = excluded.updated_at`,
      ).run(placeId, addr.text, addr.shortText, JSON.stringify(addr.detail), now);
    } else {
      db.prepare(`DELETE FROM place_labels WHERE place_id = ? AND source = '${ADDR}'`).run(placeId);
    }
    db.prepare(
      `INSERT INTO label_checks (place_id, source, checked_at) VALUES (?, '${ADDR}', ?) ON CONFLICT(place_id, source) DO UPDATE SET checked_at = excluded.checked_at`,
    ).run(placeId, now);
  });
}

export interface OsmRunResult {
  done: number;
  addr: number;
  remaining: number;
  stopped?: string;
}

/**
 * 実行中の状態。結果を出す前にプロセスが終わってしまったときにも、
 * どこまで進んでいたかをログに出せるようにする（main.ts の exit の処理で使う）
 */
export const osmRun = { startedAt: '', target: 0, pending: 0, done: 0, addr: 0, current: '', finished: false };

/** 利用者ごとの記録の DB */
export interface OsmUser {
  name: string;
  db: DatabaseSync;
}

/** まだ住所を調べていない地点を、よく行く順に最大 limit 件取る。利用者が複数なら、1 人ずつ順に回す */
export async function fetchOsm(users: OsmUser[], opts: OsmOptions): Promise<OsmRunResult> {
  prepareNetwork();
  // 同時に2つ動かないようにする（前の回が長引いても重ならない）。2時間以上前のロックは残骸とみなす
  const lock = join(opts.dataDir, 'osm.lock');
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 2 * 3600_000) {
    return { done: 0, addr: 0, remaining: -1, stopped: `前の実行が続いています（${readFileSync(lock, 'utf8').trim()}）` };
  }
  writeFileSync(lock, `pid ${process.pid} ${stamp()}`);
  const minWait = Math.max(MIN_WAIT_FLOOR, opts.minWait);
  const maxWait = Math.max(minWait, opts.maxWait);
  const result: OsmRunResult = { done: 0, addr: 0, remaining: 0 };
  try {
    const pendingOf = users.map(
      (u) =>
        u.db
          .prepare(
            `SELECT p.place_id, p.lat, p.lng FROM places p
             LEFT JOIN label_checks c ON c.place_id = p.place_id AND c.source = '${ADDR}'
             WHERE c.place_id IS NULL ORDER BY p.visit_count DESC`,
          )
          .all() as { place_id: string; lat: number; lng: number }[],
    );
    const pendingCount = pendingOf.reduce((n, p) => n + p.length, 0);
    // 利用者を順に回して、1 人 1 か所ずつ取り出す
    const targets: { user: OsmUser; place_id: string; lat: number; lng: number }[] = [];
    for (let i = 0; targets.length < opts.limit && targets.length < pendingCount; i++) {
      users.forEach((u, k) => {
        const t = pendingOf[k][i];
        if (t && targets.length < opts.limit) targets.push({ user: u, ...t });
      });
    }
    // 利用者ごとの結果（それぞれの DB の osm:last_run に記録する）
    const perUser = new Map(users.map((u, k) => [u, { done: 0, addr: 0, pending: pendingOf[k].length }]));
    Object.assign(osmRun, { startedAt: stamp(), target: targets.length, pending: pendingCount });
    const who = users.length > 1 ? `、利用者 ${users.length} 人` : '';
    console.log(stamp(), `開始：今回 ${targets.length} か所（まだ住所を調べていない地点 ${pendingCount} か所${who}、間隔 ${minWait}〜${maxWait} 秒）`);
    for (let i = 0; i < targets.length; i++) {
      if (i > 0) await sleep((minWait + Math.random() * (maxWait - minWait)) * 1000);
      const t = targets[i];
      osmRun.current = `${i + 1} か所目`;
      let r;
      try {
        r = await reverse(opts, t.lat, t.lng);
      } catch (e) {
        result.stopped = `通信エラー: ${errorDetail(e)}`;
        break;
      }
      if (!r.body) {
        result.stopped = `Nominatim から ${r.status} が返ったので止めました${[403, 429, 503, 509].includes(r.status) ? '（混雑か、アクセスを制限された可能性）' : ''}`;
        break;
      }
      const addr = parseNominatim(r.body);
      saveAddress(t.user.db, t.place_id, addr, stamp());
      const u = perUser.get(t.user)!;
      result.done++;
      u.done++;
      if (addr) {
        result.addr++;
        u.addr++;
      }
      Object.assign(osmRun, { done: result.done, addr: result.addr });
      // 1回の実行は1時間近くかかるので、途中経過もログに出す
      if (result.done % 10 === 0) console.log(stamp(), `進み具合 ${result.done} / ${targets.length}（住所 ${result.addr}）`);
    }
    result.remaining = pendingCount - result.done;
    osmRun.finished = true;
    for (const [user, u] of perUser) {
      const mine: OsmRunResult = { done: u.done, addr: u.addr, remaining: u.pending - u.done, stopped: result.stopped };
      setKv(user.db, 'osm:last_run', JSON.stringify({ at: stamp(), ...mine }));
    }
    return result;
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
}

export function osmAddrStatus(db: DatabaseSync): { checked: number; addr: number; lastRun: (OsmRunResult & { at: string }) | null } {
  const count = (sql: string) => (db.prepare(sql).get() as any).n as number;
  const last = (db.prepare("SELECT value FROM kv WHERE key = 'osm:last_run'").get() as any)?.value;
  return {
    checked: count(`SELECT COUNT(*) AS n FROM label_checks WHERE source = '${ADDR}'`),
    addr: count(`SELECT COUNT(*) AS n FROM place_labels WHERE source = '${ADDR}'`),
    lastRun: last ? JSON.parse(last) : null,
  };
}
