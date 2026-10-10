/* Service worker: deixa o sistema abrir e funcionar sem sinal. */
const V = '20261010140853';
const SHELL = 'lag-shell-' + V;
const RUN = 'lag-run';
const FOTOS = 'lag-fotos';
const SB = 'https://poimrjejrewrpgoxrfqp.supabase.co';
const FILES = ['./', './index.html', './shim.js', './manifest.webmanifest', './lib/supabase.js', './lib/three.min.js', './lib/OrbitControls.js', './lib/jspdf.umd.min.js', './lib/jspdf.plugin.autotable.min.js', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('lag-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms)); }

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Página principal: tenta a rede (pega versão nova), cai para a cópia guardada sem sinal
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { const r = await Promise.race([fetch(req, { cache: 'no-store' }), timeout(6000)]); if (r && r.ok) { const c = await caches.open(SHELL); c.put('./index.html', r.clone()); } return r; }
      catch (x) { return (await caches.match('./index.html', { ignoreSearch: true })) || (await caches.match('./', { ignoreSearch: true })) || Response.error(); }
    })());
    return;
  }
  // Fotos das inspeções: guarda no aparelho depois da primeira vez
  if (SB && req.url.startsWith(SB + '/storage/v1/object/public/')) {
    e.respondWith(caches.open(FOTOS).then(async c => { const hit = await c.match(req); if (hit) return hit; const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }));
    return;
  }
  // Banco e login: sempre pela rede (o próprio sistema guarda os dados offline)
  if (SB && req.url.startsWith(SB)) return;
  // Arquivos do sistema
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => { if (r.ok) caches.open(RUN).then(c => c.put(req, r.clone())); return r; })));
    return;
  }
  // Fontes e outros recursos externos: usa a cópia guardada e atualiza em segundo plano
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(RUN).then(async c => { const hit = await c.match(req); const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit); return hit || net; }));
  }
});

// Avisos push (enviados pelo servidor a cada nova solicitação de cadastro)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Lagoinha · Comissionamento', {
    body: d.body || '', tag: d.tag || 'lag', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url || './#permissoes' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './#permissoes', self.registration.scope).href;
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if (c.url.startsWith(self.registration.scope)) { try { await c.focus(); c.navigate ? await c.navigate(url) : c.postMessage({ go: url }); } catch (x) {} return; } }
    await self.clients.openWindow(url);
  })());
});
