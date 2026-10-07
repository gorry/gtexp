// Profile.ini（アプリ名・バージョン・著作権表示などの定数。著作者だけが書き換える）を読む。
// コマンドとして動かすと、プログラムから使う src/shared/profile.gen.ts を作る（npm の各スクリプトの前に自動で動く）:
//   node tools/profile.mjs
// vite.config.ts からも readProfile を使う（ページの題名と manifest のアプリ名）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Profile.ini を { 節: { キー: 値 } } にして返す */
export function readIni(path = join(root, 'Profile.ini')) {
  const ini = {};
  let section = null;
  for (const raw of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = ini[s[1]] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (section && eq > 0) section[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return ini;
}

/** プログラムで使う値。ないと困るものは、なければ止める */
export function readProfile() {
  const ini = readIni();
  const need = (section, key) => {
    const v = ini[section]?.[key];
    if (!v) throw new Error(`Profile.ini に [${section}] ${key} がありません`);
    return v;
  };
  return {
    title: need('Title', 'Text'),
    shortTitle: need('Title', 'ShortText'),
    version: need('Version', 'Text'),
    versionNumber: Number(need('Version', 'Number')),
    copyright: need('Copyright', 'Text'),
    author: ini.Copyright?.Name ?? '',
    namespace: ini.AppId?.Namespace ?? '',
    projectUrl: ini.URL?.Project ?? '',
    noticeUrl: ini.URL?.Notice ?? '',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = readProfile();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== p.version) console.warn(`注意: package.json の version（${pkg.version}）が Profile.ini（${p.version}）と違います`);
  const out = join(root, 'src/shared/profile.gen.ts');
  const text =
    '// Profile.ini から tools/profile.mjs が作るファイル。手で直さない（git にも入れない）\n' +
    `export const PROFILE = ${JSON.stringify(p, null, 2)} as const;\n`;
  let old = '';
  try {
    old = readFileSync(out, 'utf8');
  } catch {}
  // 変わらないときは書かない（開発中の再読み込みを起こさないため）
  if (old !== text) writeFileSync(out, text);
}
