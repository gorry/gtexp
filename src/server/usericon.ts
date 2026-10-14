import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 利用者のアイコン（data/users/<名前>/icon）。画像の切り抜き・縮小は画面の側で済ませてから送る
// （中央の正方形に切り抜き、512px 四方まで縮める）。サーバーは種類と大きさを確かめて置くだけ。

/** 受け取るアイコンの上限（512px 四方なら WebP・PNG でも十分に収まる） */
export const ICON_MAX_BYTES = 2 * 1024 * 1024;

const iconPath = (dir: string) => join(dir, 'icon');

/** 画像の種類を先頭の数バイトから決める（PNG・JPEG・WebP だけ受け付ける） */
export function iconType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** アイコンの版（置いた日時のミリ秒）。なければ null（画面は初期のアイコンを出す） */
export function iconVersion(dir: string): string | null {
  const p = iconPath(dir);
  return existsSync(p) ? String(Math.floor(statSync(p).mtimeMs)) : null;
}

export function readIcon(dir: string): { data: Buffer; type: string } | null {
  const p = iconPath(dir);
  if (!existsSync(p)) return null;
  const data = readFileSync(p);
  const type = iconType(data);
  return type ? { data, type } : null;
}

/** 置き換える（書きかけのファイルを読まれないよう、別の名前で書いてから入れ替える） */
export function saveIcon(dir: string, data: Buffer): void {
  const tmp = `${iconPath(dir)}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, iconPath(dir));
}

export function deleteIcon(dir: string): void {
  rmSync(iconPath(dir), { force: true });
}
