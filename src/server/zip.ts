import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// 位置参照情報の配布ファイル（zip）を読むための最小限の zip 読み込み。
// 無圧縮（0）と deflate（8）だけに対応する。

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * 利用者が送る zip（Google Takeout・Foursquare Swarm）の中の 1 つのファイルを展開したあとの上限。使うのは JSON・CSV・KML なので十分に大きい。
 * 小さな zip が巨大に膨らむ「圧縮爆弾」対策（管理者が入れる位置参照情報の zip には付けない）
 */
export const USER_ZIP_ENTRY_MAX = 200 * 1024 * 1024;

/**
 * 1 回の取り込みで展開してよい量の残り（複数の zip・zip の中の複数のファイル・zip の中の zip をまとめて数える）。
 * 1 つずつの上限だけだと、上限の少し下のファイルを数多く並べた zip で、合計が巨大になるため
 */
export interface InflateBudget {
  left: number;
}

/** 利用者が送る zip を 1 回の取り込みで展開してよい合計（実際の Takeout は数 MB、Swarm のチェックインは数十 MB） */
export const USER_ZIP_TOTAL_MAX = 300 * 1024 * 1024;

export const newInflateBudget = (): InflateBudget => ({ left: USER_ZIP_TOTAL_MAX });

const TOO_LARGE_TOTAL = '取り込むファイル全体を展開したサイズが大きすぎます。';

/** 展開しない（無圧縮の）ファイルも、合計には数える */
function spend(budget: InflateBudget | undefined, bytes: number): void {
  if (!budget) return;
  budget.left -= bytes;
  if (budget.left < 0) throw new Error(TOO_LARGE_TOTAL);
}

function inflateLimited(raw: Buffer, maxBytes: number, budget?: InflateBudget): Buffer {
  const limit = Math.min(maxBytes, budget ? budget.left : Infinity);
  if (!Number.isFinite(limit)) return inflateRawSync(raw);
  try {
    const out = inflateRawSync(raw, { maxOutputLength: Math.max(0, limit) });
    spend(budget, out.length);
    return out;
  } catch (e) {
    if (e instanceof RangeError || (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      // どちらの上限に当たったか（合計の残りの方が小さければ、合計）
      throw new Error(budget && budget.left < maxBytes ? TOO_LARGE_TOTAL : 'zip ファイル内のファイルを展開したサイズが大きすぎます。');
    }
    if (e instanceof Error && e.message === TOO_LARGE_TOTAL) throw e;
    throw new Error('zip ファイルの中身を読み込めませんでした。');
  }
}
/** maxBytes：1 つのファイルを展開したあとの上限（省くと上限なし）。budget：取り込み全体で展開してよい量の残り（省くと数えない） */
export function readZip(buf: Buffer, maxBytes = Infinity, budget?: InflateBudget): ZipEntry[] {
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
    if (method === 0) {
      spend(budget, raw.length);
      entries.push({ name, data: Buffer.from(raw) });
    }
    else if (method === 8) entries.push({ name, data: inflateLimited(raw, maxBytes, budget) });
    // それ以外の圧縮方式は飛ばす
  }
  return entries;
}

/**
 * zip ファイルから、want が true を返すファイルだけを読む。ファイル全体はメモリーに読まず、
 * 末尾の目次（中央ディレクトリ）を読んでから、必要なファイルの部分だけを読む（Takeout の数 GB の zip 用）。
 * ファイル名は UTF-8 として読む（Takeout はそうなっている）。ZIP64 には対応しない（4GB 未満の zip だけ）
 */
/** maxBytes：1 つのファイルを展開したあとの上限（利用者が送る zip を読むので、既定で上限を付ける） */
export function readZipEntriesFromFile(path: string, want: (name: string) => boolean, maxBytes = USER_ZIP_ENTRY_MAX, budget?: InflateBudget): ZipEntry[] {
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
      if (method === 0) {
        spend(budget, raw.length);
        entries.push({ name, data: raw });
      }
      else if (method === 8) entries.push({ name, data: inflateLimited(raw, maxBytes, budget) });
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}
