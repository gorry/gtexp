// G Timeline Explorer (gtexp) の Service Worker
// 役目は「共有」で送られてきたエクスポートファイルを受け取り、取り込み画面に渡すことだけ。
// それ以外のリクエストには手を出さない（データは常にサーバーから取る）。

const SHARE_CACHE = 'gtexp-share';
const SHARE_KEY = '/shared-file';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const file = form.get('file');
        if (!(file instanceof File)) throw new Error('no file');
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(
          SHARE_KEY,
          new Response(file, { headers: { 'X-File-Name': encodeURIComponent(file.name || 'shared.json') } }),
        );
        return Response.redirect('/#/import?shared=1', 303);
      } catch {
        return Response.redirect('/#/import?share=failed', 303);
      }
    })(),
  );
});
