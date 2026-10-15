import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// 2 段階認証（TOTP、RFC 6238）。Google Authenticator などのアプリが 30 秒ごとに出す 6 桁のコードで確かめる。
// 利用者ごとに任意（最初はオフ）。鍵は設定の sessionSecret から作った鍵で暗号化して data/shared.sqlite の user_mfa に持つ
// （DB のファイルだけが漏れても、コードを作れないように）。sessionSecret を変えると鍵を読めなくなるので、
// そのときは管理者が user-mfa-reset で外し、利用者が設定し直す。
// 同じコードを 2 回使えないよう、最後に使った時刻の区切り（30 秒ごとの番号）を覚える。
// アプリを使えなくなったときのために、1 回ずつ使える予備のコードを 10 個渡す（ハッシュだけを持つ）

const PERIOD_SEC = 30;
const DIGITS = 6;
/** 端末とサーバーの時計のずれをどこまで許すか（前後の区切りの数） */
const WINDOW = 1;
const RECOVERY_COUNT = 10;
/** 予備のコードの文字（見間違えやすい 0・1・o・l・i を除く） */
const RECOVERY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

// ---- TOTP ----

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of s.toUpperCase().replace(/[\s=]/g, '')) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error('鍵の形が正しくありません');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 時刻の区切り（step）のコード（HOTP、RFC 4226） */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / PERIOD_SEC);

/** コードが合えば、その区切りの番号。lastStep 以前（使い済み）と、合わないときは null */
export function verifyTotp(secret: Buffer, code: string, lastStep: number, nowMs = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentStep(nowMs);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

/** アプリに登録する URI（QR コードにする） */
export function otpauthUri(issuer: string, user: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${user}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SEC}`;
}

// ---- 鍵の暗号化 ----

const keyOf = (sessionSecret: string) => createHash('sha256').update(`gtexp-mfa\0${sessionSecret}`).digest();

export function encryptSecret(secret: Buffer, sessionSecret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(sessionSecret), iv);
  const data = Buffer.concat([c.update(secret), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** 読めない（sessionSecret が変わった・壊れている）ときは null */
export function decryptSecret(stored: string, sessionSecret: string): Buffer | null {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', keyOf(sessionSecret), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]);
  } catch {
    return null;
  }
}

// ---- 予備のコード ----

const hashRecovery = (code: string) => createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

/** 予備のコードを作る（xxxx-xxxx の形。渡すのはこの 1 回だけ） */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => RECOVERY_CHARS[x % RECOVERY_CHARS.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  return { codes, hashes: codes.map(hashRecovery) };
}

// ---- 保存（data/shared.sqlite の user_mfa） ----

export interface MfaRow {
  /** 有効にした鍵（暗号化したもの）。null は無効 */
  secret: string | null;
  /** 設定の途中の鍵（確認のコードが通るまで有効にしない） */
  pending: string | null;
  lastStep: number;
  recovery: string[];
}

export function getMfa(shared: DatabaseSync, name: string): MfaRow {
  const r = shared.prepare('SELECT secret, pending, last_step, recovery FROM user_mfa WHERE name = ?').get(name) as any;
  return r
    ? { secret: r.secret, pending: r.pending, lastStep: r.last_step, recovery: JSON.parse(r.recovery || '[]') }
    : { secret: null, pending: null, lastStep: 0, recovery: [] };
}

export const mfaEnabled = (shared: DatabaseSync, name: string) => !!getMfa(shared, name).secret;

function saveMfa(shared: DatabaseSync, name: string, m: MfaRow): void {
  shared
    .prepare(
      `INSERT INTO user_mfa (name, secret, pending, last_step, recovery) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET secret = excluded.secret, pending = excluded.pending, last_step = excluded.last_step, recovery = excluded.recovery`,
    )
    .run(name, m.secret, m.pending, m.lastStep, JSON.stringify(m.recovery));
}

/** 設定を始める：新しい鍵を作り、設定の途中として持つ。アプリに登録する鍵（Base32）を返す */
export function startMfaSetup(shared: DatabaseSync, name: string, sessionSecret: string): string {
  const secret = randomBytes(20);
  saveMfa(shared, name, { ...getMfa(shared, name), pending: encryptSecret(secret, sessionSecret) });
  return base32Encode(secret);
}

/** 設定の途中の鍵で作ったコードが合えば有効にし、予備のコードを返す。合わなければ null */
export function finishMfaSetup(shared: DatabaseSync, name: string, code: string, sessionSecret: string): string[] | null {
  const m = getMfa(shared, name);
  const secret = m.pending ? decryptSecret(m.pending, sessionSecret) : null;
  const step = secret ? verifyTotp(secret, code, 0) : null;
  if (step == null) return null;
  const { codes, hashes } = newRecoveryCodes();
  saveMfa(shared, name, { secret: m.pending, pending: null, lastStep: step, recovery: hashes });
  return codes;
}

/**
 * 有効にした 2 段階認証のコード（6 桁）か、予備のコードを確かめる。合えば使い済みにして true。
 * 予備のコードは 1 回だけ使える
 */
export function checkMfaCode(shared: DatabaseSync, name: string, code: string, sessionSecret: string): boolean {
  const m = getMfa(shared, name);
  if (!m.secret) return false;
  const secret = decryptSecret(m.secret, sessionSecret);
  if (secret) {
    const step = verifyTotp(secret, code, m.lastStep);
    if (step != null) {
      saveMfa(shared, name, { ...m, lastStep: step });
      return true;
    }
  }
  const h = hashRecovery(code);
  if (code.replace(/[^a-z0-9]/gi, '').length === 8 && m.recovery.includes(h)) {
    saveMfa(shared, name, { ...m, recovery: m.recovery.filter((x) => x !== h) });
    return true;
  }
  return false;
}

/** 予備のコードを作り直す（前のものは使えなくなる） */
export function renewRecoveryCodes(shared: DatabaseSync, name: string): string[] {
  const { codes, hashes } = newRecoveryCodes();
  saveMfa(shared, name, { ...getMfa(shared, name), recovery: hashes });
  return codes;
}

export const recoveryLeft = (shared: DatabaseSync, name: string) => getMfa(shared, name).recovery.length;

/** 無効にする（鍵も予備のコードも消す）。管理者の user-mfa-reset もこれ */
export function disableMfa(shared: DatabaseSync, name: string): boolean {
  return shared.prepare('DELETE FROM user_mfa WHERE name = ?').run(name).changes > 0;
}
