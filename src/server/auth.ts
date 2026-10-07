import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// パスワードは scrypt のハッシュで、利用者ごとに data/shared.sqlite に持つ（users.ts）。
// ログイン状態は「利用者名＋有効期限＋署名」だけの Cookie で表し、サーバーにセッションを保存しない。
// 署名には利用者ごとの session_key を混ぜるので、パスワードを変えるか利用者を消すと、前の Cookie は使えなくなる。

const COOKIE = 'gtexp_session';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSessionCookie(secret: string, user: string, sessionKey: string, days: number, secure: boolean): string {
  const exp = Date.now() + days * 86400_000;
  // 利用者名は英小文字・数字・_・- だけなので、区切りの「.」とは混ざらない
  const payload = `${user}.${exp}`;
  const value = `${payload}.${sign(payload, secret + sessionKey)}`;
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${days * 86400}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * ログインしている利用者の名前（していなければ null）。sessionKeyOf はその利用者の session_key
 * （いなければ null）を返す関数
 */
export function loggedInUser(req: IncomingMessage, secret: string, sessionKeyOf: (user: string) => string | null): string | null {
  const cookie = req.headers.cookie ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [user, exp, sig] = m[1].split('.');
  if (!user || !exp || !sig) return null;
  const key = sessionKeyOf(user);
  if (key == null) return null;
  const expected = Buffer.from(sign(`${user}.${exp}`, secret + key));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return Number(exp) > Date.now() ? user : null;
}

/** Apache の後ろでは X-Forwarded-Proto で HTTPS かどうかを判断する */
export function isHttps(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}
