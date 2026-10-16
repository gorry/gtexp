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

/**
 * package.json と package-lock.json の version を Profile.ini の [Version] Text にそろえる（Profile.ini だけを書き換えれば済むように）。
 * 違うときだけ書き換える（npm と同じく、2 文字の字下げと末尾の改行で書く）
 */
function syncPackageVersion(version) {
  const update = (name, apply) => {
    const path = join(root, name);
    let json;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return; // ない（package-lock.json を作っていない）ときは何もしない
    }
    if (!apply(json)) return;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}
`);
    console.log(`${name} の version を ${version} にそろえました`);
  };
  update('package.json', (pkg) => pkg.version !== version && ((pkg.version = version), true));
  update('package-lock.json', (lock) => {
    const root = lock.packages?.[''];
    if (lock.version === version && (!root || root.version === version)) return false;
    lock.version = version;
    if (root) root.version = version;
    return true;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = readProfile();
  syncPackageVersion(p.version);
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
