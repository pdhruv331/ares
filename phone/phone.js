// ARES phone app: talk to the ARES running on your Mac. Hold-to-talk (speech recognition on the phone,
// with the Mac transcribing as a fallback), streamed replies, and her voice played as it arrives.
const $ = (id) => document.getElementById(id);
const hud = () => (typeof HUD !== 'undefined' ? HUD : null); // declared by neural.js (not a window property)
const logEl = $('log');
const input = $('input');
const talk = $('talk');
let busy = false;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}
function setState(s) {
  hud()?.setState(s);
  $('stateText').textContent = { idle: 'ONLINE', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'SPEAKING' }[s];
}
const clean = (t) => t.replace(/\[[a-z ]+\]\s*/gi, '').replace(/\[[^\]]*$/, '').trim();

function addMessage(who, text, source) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  const label = who === 'ares' ? 'ARES' : 'YOU';
  const src = source && source !== 'phone' ? ` <span class="src">· ${source === 'mac' ? 'MAC' : source.toUpperCase()}</span>` : '';
  el.innerHTML = `<span class="who">${label}${src}</span><span class="text"></span>`;
  const body = el.querySelector('.text');
  const set = (t) => { body.textContent = clean(t); logEl.scrollTop = logEl.scrollHeight; };
  set(text);
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return set;
}

// ---- Audio: her voice arrives as raw 24kHz PCM chunks, scheduled back to back ----------------------
let ctx = null;
let analyser = null;
let at = 0;
let sources = [];
let meter = null;
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume(); // iOS: must happen during a tap
  return ctx;
}
function playPcm(b64) {
  const c = audio();
  const bin = atob(b64);
  const n = Math.floor(bin.length / 2);
  if (!n) return;
  const buf = c.createBuffer(1, n, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (v >= 32768) v -= 65536;
    ch[i] = v / 32768;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(analyser);
  at = Math.max(at, c.currentTime + 0.05);
  src.start(at);
  at += buf.duration;
  sources.push(src);
  src.onended = () => {
    sources = sources.filter((s) => s !== src);
    if (!sources.length && !busy) setState('idle');
  };
  setState('speaking');
  startMeter();
}
function stopVoice() {
  for (const s of sources) { try { s.stop(); } catch {} }
  sources = [];
  at = 0;
}
function startMeter() {
  if (meter) return;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += bins[i];
    hud()?.setLevel(Math.min(1, (sum / 64 / 255) * 2.2));
    meter = sources.length ? requestAnimationFrame(tick) : (hud()?.setLevel(0), null);
  };
  meter = requestAnimationFrame(tick);
}

// ---- Phone actions: open straight away if Android still counts it as part of your tap ------------------
let lastGesture = 0;
for (const ev of ['pointerdown', 'pointerup', 'keydown']) addEventListener(ev, () => { lastGesture = Date.now(); }, true);
function openLink(url) {
  if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener');
  else location.href = url; // tel:, sms:, mailto: hand over to the phone's own apps
}
function actionCard({ url, label }) {
  const a = document.createElement('a');
  a.className = 'action';
  a.href = url;
  a.textContent = label;
  a.target = /^https?:/i.test(url) ? '_blank' : '_self';
  a.rel = 'noopener';
  logEl.appendChild(a);
  logEl.scrollTop = logEl.scrollHeight;
  if (Date.now() - lastGesture < 4500) { try { openLink(url); } catch {} } // otherwise: tap the card
}

// ---- Shared from other apps ("Share → ARES") -------------------------------------------------------------
let attachment = null; // { text, url, title, files: [{ name, type, data }] }
function showAttachment() {
  $('attach').hidden = !attachment;
  if (!attachment) return;
  const files = attachment.files || [];
  const bits = [files.length ? files.map((f) => f.name || 'file').join(', ') : '', attachment.title, attachment.url || attachment.text].filter(Boolean);
  $('attachText').textContent = `📎 ${bits.join(' · ').slice(0, 120)}`;
  input.placeholder = 'What should I do with this?';
}
$('attachClear').addEventListener('click', () => { attachment = null; showAttachment(); input.placeholder = 'Type to ARES…'; });
// Share → ARES → "Make it a job": the link, PDF or screenshot goes to a background worker on the Mac
$('attachJob').addEventListener('click', async () => {
  if (!attachment) return;
  const a = attachment;
  const said = input.value.trim() || 'Read this and give me the key points.';
  const extra = [a.title && `Title: ${a.title}`, a.text && a.text !== a.url && `Text: ${a.text}`].filter(Boolean);
  const text = extra.length ? `${said}\n\n(Shared from another app on the phone)\n${extra.join('\n')}` : said;
  $('attachJob').disabled = true;
  const r = await Work.start({ text, files: a.files || [], link: a.url || (/^https?:\/\/\S+$/.test(a.text || '') ? a.text : '') });
  $('attachJob').disabled = false;
  if (r.error) return addMessage('ares', `I couldn't start that job: ${r.error}`);
  input.value = '';
  attachment = null;
  showAttachment();
  input.placeholder = 'Type to ARES…';
  addMessage('ares', `On it: "${r.job.title}" is a job now. I'll let you know when it's ready.`);
});
async function loadShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('ares-share');
    const res = await cache.match('/shared');
    if (!res) return;
    attachment = await res.json();
    attachment.files ??= (attachment.images || []).map((im) => ({ name: im.name || 'image', type: im.media_type, data: im.data })); // shared before this version
    await cache.delete('/shared');
    showAttachment();
    input.focus();
  } catch {}
}

// ---- Asking ARES -------------------------------------------------------------------------------------
async function ask(text, voice) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  stopVoice();
  addMessage('user', attachment ? `${text}  📎` : text, 'phone');
  let images = [];
  if (attachment) {
    const bits = [attachment.title && `Title: ${attachment.title}`, attachment.url && `Link: ${attachment.url}`, attachment.text && `Text: ${attachment.text}`].filter(Boolean);
    if (bits.length) text = `${text}\n\n(Shared from another app on the phone)\n${bits.join('\n')}`;
    images = (attachment.files || []).filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type)).slice(0, 3).map((f) => ({ media_type: f.type, data: f.data }));
    const other = (attachment.files || []).filter((f) => !/^image\//.test(f.type));
    if (other.length) text = `${text}\n(They also shared ${other.map((f) => f.name).join(', ')}, which you can't open in chat: if they want it read, tell them to tap Make it a job.)`;
    attachment = null;
    showAttachment();
    input.placeholder = 'Type to ARES…';
  }
  setState('thinking');
  let update = null;
  let reply = '';
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, images }) });
    if (res.status === 401) return showPair();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'text') { reply += msg.delta; update ??= addMessage('ares', ''); update(reply); }
        else if (msg.type === 'audio') playPcm(msg.pcm);
        else if (msg.type === 'action') actionCard(msg);
        else if (msg.type === 'job') msg.id ? Work.showJob(msg.id) : Work.openList(); // "show me the research"

        else if (msg.type === 'done') { update ??= addMessage('ares', ''); update(msg.text); }
      }
    }
    setStatus('connected', 'ok');
  } catch (err) {
    addMessage('ares', "I can't reach the Mac right now, sir. Is it awake, and is Tailscale on?");
    setStatus('offline', 'bad');
  } finally {
    busy = false;
    if (!sources.length) setState('idle');
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  audio(); // unlock sound while we have the tap
  const t = input.value;
  input.value = '';
  input.blur();
  ask(t, false);
});

// ---- Hold to talk ------------------------------------------------------------------------------------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let heard = '';
let recorder = null;
let chunks = [];

async function startTalking() {
  audio();
  stopVoice(); // talking over her stops her, like on the Mac
  talk.classList.add('live');
  talk.textContent = 'Listening…';
  setState('listening');
  heard = '';
  if (Recognition) {
    rec = new Recognition();
    rec.lang = 'en-GB';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      heard = [...e.results].map((r) => r[0].transcript).join(' ');
      input.value = heard;
    };
    rec.onerror = () => {};
    try { rec.start(); return; } catch { rec = null; }
  }
  // Fallback: record, and let the Mac transcribe it
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.start();
  } catch {
    addMessage('ares', 'I need microphone access on the phone, sir.');
  }
}

async function stopTalking() {
  talk.classList.remove('live');
  talk.textContent = 'Hold to talk';
  if (rec) {
    const r = rec;
    rec = null;
    await new Promise((resolve) => { r.onend = resolve; r.stop(); setTimeout(resolve, 1500); });
    input.value = '';
    if (heard.trim()) return ask(heard, true);
    return setState('idle');
  }
  if (recorder) {
    const r = recorder;
    recorder = null;
    await new Promise((resolve) => { r.onstop = resolve; r.stop(); });
    r.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: r.mimeType || 'audio/mp4' });
    setState('thinking');
    try {
      const res = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const { text } = await res.json();
      if (text) return ask(text, true);
    } catch {}
    setState('idle');
  }
}

talk.addEventListener('pointerdown', (e) => { e.preventDefault(); talk.setPointerCapture(e.pointerId); startTalking(); });
talk.addEventListener('pointerup', () => stopTalking());
talk.addEventListener('pointercancel', () => stopTalking());
talk.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- Pairing & start-up ------------------------------------------------------------------------------
function showPair() {
  $('app').hidden = true;
  $('pair').hidden = false;
  setStatus('not paired', 'bad');
  $('code').focus();
}
$('pairBtn').addEventListener('click', async () => {
  const code = $('code').value.replace(/\D/g, '');
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: /Android/.test(navigator.userAgent) ? (navigator.userAgent.match(/;\s*([^;)]*?)\s+Build/)?.[1] || 'Android phone') : /iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone' }) });
  const out = await res.json().catch(() => ({}));
  if (out.ok) location.reload();
  else $('pairErr').textContent = out.error || 'Pairing failed.';
});

// ---- Notifications -----------------------------------------------------------------------------------------
const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
async function enableNotifications() {
  try {
    if ((await Notification.requestPermission()) !== 'granted') return addMessage('ares', 'Notifications are blocked for this app, sir. You can allow them in Chrome\'s site settings.');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/push/key')).json();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
    $('bell').hidden = true;
    addMessage('ares', "Notifications are on. I'll let you know about timers and anything you ask me to remind you of.");
  } catch (err) {
    addMessage('ares', `I couldn't turn notifications on: ${err.message}`);
  }
}
$('bell').addEventListener('click', enableNotifications);
const EMBEDDED = new URLSearchParams(location.search).get('app') === '1'; // the Android app's Work view
if (EMBEDDED) document.body.classList.add('embed');
else if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

async function boot() {
  try {
    const me = await fetch('/api/me');
    if (me.status === 401) return showPair();
    const { push, reduceMotion } = await me.json();
    $('bell').hidden = push || !('PushManager' in window);
    $('pair').hidden = true;
    $('app').hidden = false;
    setStatus('connected', 'ok');
    if (EMBEDDED) return Work.boot({ reduceMotion });
    const { history } = await (await fetch('/api/history')).json();
    for (const m of history) addMessage(m.who, m.text, m.source);
    if (!history.length) addMessage('ares', 'At your service, sir. Hold the button and talk, or type below.');
    setState('idle');
    loadShared();
    Work.boot({ reduceMotion });
  } catch {
    setStatus('offline', 'bad');
    $('app').hidden = false;
    addMessage('ares', "I can't reach the Mac, sir. Check it's awake and Tailscale is on.");
  }
}
boot();
