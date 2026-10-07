import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// 位置参照情報の配布ファイル（zip）を読むための最小限の zip 読み込み。
// 無圧縮（0）と deflate（8）だけに対応する。

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function readZip(buf: Buffer): ZipEntry[] {
  // 末尾の「中央ディレクトリの終わり」レコードを探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip ファイルとして読めませんでした');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip の中央ディレクトリが壊れています');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    // ファイル名は Shift_JIS のこともあるが、使うのは拡張子だけなので latin1 で読む
    const name = buf.toString('latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    // それ以外の圧縮方式は飛ばす
  }
  return entries;
}

/**
 * zip ファイルから、want が true を返すファイルだけを読む。ファイル全体はメモリーに読まず、
 * 末尾の目次（中央ディレクトリ）を読んでから、必要なファイルの部分だけを読む（Takeout の数 GB の zip 用）。
 * ファイル名は UTF-8 として読む（Takeout はそうなっている）。ZIP64 には対応しない（4GB 未満の zip だけ）
 */
export function readZipEntriesFromFile(path: string, want: (name: string) => boolean): ZipEntry[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${path}: zip ファイルとして読めませんでした`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error(`${path}: ZIP64 形式の zip には対応していません`);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: zip の中央ディレクトリが壊れています`);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (!want(name)) continue;
      const local = Buffer.alloc(30);
      readSync(fd, local, 0, 30, localOffset);
      const start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = Buffer.alloc(compressedSize);
      readSync(fd, raw, 0, compressedSize, start);
      if (method === 0) entries.push({ name, data: raw });
      else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}
