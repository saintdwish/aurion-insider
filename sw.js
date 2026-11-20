// sw.js - service worker AURION Insider (taruh di root repo aurion-insider)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: 'AURION Insider', body: e.data ? e.data.text() : '' }; }
  const opts = {
    body: d.body || '',
    icon: d.icon || 'icon.png',
    badge: d.icon || 'icon.png',
    data: { url: 'dashboard.html' }
  };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
  e.waitUntil(self.registration.showNotification(d.title || 'AURION Insider', opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if (c.url.indexOf('/aurion-insider/') !== -1 && 'focus' in c) return c.focus(); }
      return self.clients.openWindow('dashboard.html');
    })
  );
});
