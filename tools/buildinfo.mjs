// ビルドの情報（元にしたコミットとビルドの日時）を src/shared/build.gen.ts に書く。「このアプリについて」の画面と /api/health で、
// 動いている画面とサーバーがどのコミットから作ったものかを示すため。npm run build の前に自動で動く:
//   node tools/buildinfo.mjs              … 今のコミットと日時で書く（画面とサーバーのビルドの前）
//   node tools/buildinfo.mjs --if-missing … なければ「開発中」として書く（開発用サーバー・型チェックの前）
// Git がない場所（zip で展開したなど）では、コミットは空になる。
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src/shared/build.gen.ts');

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

if (!(process.argv.includes('--if-missing') && existsSync(out))) {
  const dev = process.argv.includes('--if-missing');
  const commit = dev ? '' : git('rev-parse', '--short', 'HEAD');
  // 追跡しているファイルに、コミットしていない変更があるか（あれば画面に「+」を付ける）
  const dirty = !!commit && git('status', '--porcelain', '--untracked-files=no') !== '';
  const build = { commit, dirty, builtAt: dev ? '' : new Date().toISOString() };
  writeFileSync(
    out,
    '// tools/buildinfo.mjs が作るファイル。手で直さない（git にも入れない）\n' + `export const BUILD: { commit: string; dirty: boolean; builtAt: string } = ${JSON.stringify(build, null, 2)};\n`,
  );
}
