// ARES phone app service worker: notifications (with buttons) and "Share to ARES".

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ---- Notifications ----------------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let n = {};
  try { n = event.data.json(); } catch { n = { title: 'ARES', body: event.data?.text() || '' }; }
  // Seen or answered on another device: take it off this phone
  if (n.clear) return event.waitUntil(closeTagged(n.clear));
  const buttons = n.buttons || [];
  event.waitUntil(self.registration.showNotification(n.title || 'ARES', {
    body: n.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: n.tag,
    vibrate: [80, 40, 80],
    actions: buttons.map((b, i) => ({ action: `b${i}`, title: b.title })),
    data: { buttons, url: n.url, job: n.job },
  }));
});

async function closeTagged(tags) {
  for (const tag of tags) for (const n of await self.registration.getNotifications({ tag })) n.close();
}

/** Ask ARES something in the background and show her answer as a notification. */
async function askInBackground(text) {
  try {
    const res = await fetch('/api/ask', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: false }) });
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const done = lines.find((m) => m.type === 'done');
    const actions = lines.filter((m) => m.type === 'action');
    for (const a of actions) await self.clients.openWindow(a.url);
    await self.registration.showNotification('ARES', { body: done?.text || 'Done.', icon: '/icon.png', badge: '/icon.png' });
  } catch {
    await self.registration.showNotification('ARES', { body: "Couldn't reach your Mac.", icon: '/icon.png' });
  }
}

/** A button that acts straight away through the Mac's API (Yes / No, Send to Mac): the tap is the answer. */
async function callApi(button) {
  let out = {};
  try {
    const res = await fetch(button.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(button.body || {}) });
    out = await res.json().catch(() => ({ ok: res.ok }));
  } catch {
    out = { error: "Couldn't reach your Mac." };
  }
  if (out.ok && /send-to-mac$/.test(button.api)) {
    await self.registration.showNotification('ARES', { body: out.now ? "It's open on your Mac now." : "It'll open on your Mac when you're back at it.", icon: '/icon.png', badge: '/icon.png', tag: 'ares-sent', silent: true });
  } else if (!out.ok) {
    await self.registration.showNotification('ARES', { body: out.error || "That didn't work.", icon: '/icon.png', badge: '/icon.png' });
  }
}

/** Open a job in the app: the open window if there is one, otherwise a new one. */
async function openJob(id) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = wins.find((w) => new URL(w.url).origin === self.location.origin);
  if (app) {
    app.postMessage({ type: 'open-job', id });
    return app.focus().catch(() => {}); // allowed from a notification tap; harmless otherwise
  }
  return self.clients.openWindow(`/?job=${encodeURIComponent(id)}`);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { buttons = [], url, job } = event.notification.data || {};
  const button = buttons[Number(event.action?.slice(1))];
  if (button?.job) return event.waitUntil(openJob(button.job));
  if (button?.api) return event.waitUntil(callApi(button));
  if (button?.url) return event.waitUntil(self.clients.openWindow(button.url));
  if (button?.ask) return event.waitUntil(askInBackground(button.ask));
  // Tapped the notification itself: open the job, or ARES
  if (job) return event.waitUntil(openJob(job));
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (url) return self.clients.openWindow(url);
    return app ? app.focus() : self.clients.openWindow('/');
  })());
});

// ---- Share to ARES ------------------------------------------------------------------------------------
// Android's share sheet POSTs here; keep what was shared (links, text, pictures, PDFs, documents) and hand
// it to the app, which offers "Ask" or "Make it a job".
const MAX_FILES = 5;
const MAX_BYTES = 30e6;
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share') return;
  event.respondWith((async () => {
    const form = await event.request.formData();
    const shared = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: [] };
    let total = 0;
    for (const file of form.getAll('media')) {
      if (!(file instanceof File) || shared.files.length >= MAX_FILES || total + file.size > MAX_BYTES) continue;
      total += file.size;
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      shared.files.push({ name: file.name || 'shared', type: file.type, data: btoa(bin) });
    }
    const cache = await caches.open('ares-share');
    await cache.put('/shared', new Response(JSON.stringify(shared), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect('/?shared=1', 303);
  })());
});
