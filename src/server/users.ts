import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth';

// 利用者の一覧（data/shared.sqlite の users）。利用者どうしは独立していて、記録は data/users/<名前>/ に別々に持つ。
// 管理はコマンドだけで行う（main.ts の user-add / user-passwd / user-del / user-list）。

export interface User {
  name: string;
  passwordHash: string;
  sessionKey: string;
  createdAt: string;
}

/** 利用者名はフォルダー名と Cookie に使うので、英小文字・数字・_・- だけ（先頭は英字か数字）、32 文字まで */
export const USER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function checkUserName(name: string): void {
  if (!USER_NAME_RE.test(name)) throw new Error('利用者名は英小文字・数字・_・- で 32 文字まで（先頭は英小文字か数字）にしてください');
}

const newSessionKey = () => randomBytes(16).toString('hex');

export function listUsers(shared: DatabaseSync): User[] {
  return (shared.prepare('SELECT name, password_hash, session_key, created_at FROM users ORDER BY name').all() as any[]).map(toUser);
}

export function getUser(shared: DatabaseSync, name: string): User | null {
  const r = shared.prepare('SELECT name, password_hash, session_key, created_at FROM users WHERE name = ?').get(name) as any;
  return r ? toUser(r) : null;
}

function toUser(r: any): User {
  return { name: r.name, passwordHash: r.password_hash, sessionKey: r.session_key, createdAt: r.created_at };
}

/** 利用者を足す。passwordHash は hashPassword の形 */
export function addUser(shared: DatabaseSync, name: string, passwordHash: string): void {
  checkUserName(name);
  if (getUser(shared, name)) throw new Error(`${name} はもういます`);
  shared.prepare('INSERT INTO users (name, password_hash, session_key, created_at) VALUES (?, ?, ?, ?)').run(name, passwordHash, newSessionKey(), new Date().toISOString());
}

/** パスワードを変える。ログイン中の端末はすべてログアウトされる */
export function setPassword(shared: DatabaseSync, name: string, password: string): void {
  const r = shared.prepare('UPDATE users SET password_hash = ?, session_key = ? WHERE name = ?').run(hashPassword(password), newSessionKey(), name);
  if (!r.changes) throw new Error(`${name} という利用者はいません`);
}

/** 利用者を消す（ログインできなくするだけで、記録のフォルダーは消さない） */
export function deleteUser(shared: DatabaseSync, name: string): void {
  const r = shared.prepare('DELETE FROM users WHERE name = ?').run(name);
  if (!r.changes) throw new Error(`${name} という利用者はいません`);
}
