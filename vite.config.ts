import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
// @ts-ignore 型のない .mjs
import { readProfile } from './tools/profile.mjs';

const profile = readProfile();
const manifestSrc = 'src/client/public/manifest.webmanifest';
const manifestOut = 'dist/public/manifest.webmanifest';

/** manifest のアプリ名を Profile.ini の値にする */
function manifestText(): string {
  const m = JSON.parse(readFileSync(manifestSrc, 'utf8'));
  m.name = profile.title;
  m.short_name = profile.shortTitle;
  return JSON.stringify(m, null, 2) + '\n';
}

/** ページの題名と manifest に Profile.ini の名前を入れる */
function profilePlugin(): Plugin {
  return {
    name: 'gtexp-profile',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('__APP_TITLE__', profile.title) },
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(manifestText());
      });
    },
    closeBundle() {
      writeFileSync(manifestOut, manifestText());
    },
  };
}

export default defineConfig({
  root: 'src/client',
  plugins: [preact(), profilePlugin()],
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
