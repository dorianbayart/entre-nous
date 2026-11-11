// Service worker of Entre Nous. Android share target: "Share -> Entre Nous" posts files
// here; they are parked a few seconds in a cache that the page reads and empties at once.
// Everything else goes to the network (no offline cache: the app needs the relay anyway,
// and a fresh copy of the code is always used).
const SHARE_CACHE = 'entrenous-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/app/share') {
    event.respondWith(receiveShare(event.request));
  }
});

async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  let n = 0;
  for (const file of form.getAll('files')) {
    if (!(file instanceof File)) continue;
    await cache.put(
      `/__share/${Date.now()}-${n++}`,
      new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Name': encodeURIComponent(file.name) } }),
    );
  }
  const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n').trim();
  if (n === 0 && text) {
    await cache.put(`/__share/${Date.now()}-text`, new Response(text, { headers: { 'Content-Type': 'text/plain', 'X-Name': 'texte' } }));
  }
  return Response.redirect(new URL('/app/?share=1', self.location.origin).href, 303);
}
