// ARES relay: a tiny Cloudflare Worker (free tier) so call notifications reach the phone with the Mac off.
//
//   POST /elevenlabs  ElevenLabs' post-call webhook (HMAC-verified) -> an FCM data message to the ARES Android app
//   POST /register    the Mac registers the phone's FCM token             (signed by the Mac)
//   POST /notify      the Mac's own notifications, sent through FCM too  (signed by the Mac)
//   POST /delivered   which calls the relay already notified, so the Mac's catch-up doesn't repeat them (signed)
//   POST /wake        the phone asks for ARES to be started while she's fully quit (signed by the PHONE's wake key, see below)
//   POST /wake/status the phone asks whether the ignition helper has polled lately (= the Mac is awake with ARES quit)
//   POST /helper/poll the ignition helper on the Mac, every ~20 s while ARES is quit (signed by the Mac): takes a pending wake
//   GET  /health
//
// Wake from off (docs/ignition-prompt.md §4d): the Mac registers each phone with a short id and a random WAKE KEY along with its
// push token. The phone signs POST /wake with that key; the Worker keeps the request in KV for 3 minutes; the helper's next poll
// takes it and launches ARES. The helper's polls are also its heartbeat (written to KV at most every 4 minutes: the free tier
// allows 1000 writes a day), so the phone can tell "ARES quit, Mac awake" from "Mac asleep". Nothing else is accepted this way.
//
// Secrets (wrangler secret put): ELEVENLABS_WEBHOOK_SECRET, FCM_SERVICE_ACCOUNT (the service-account JSON),
// RELAY_SECRET (shared with the Mac's .env). KV binding ARES_KV holds only the phone's push token(s) and, for
// 7 days, the ids of calls already notified. Transcripts are never stored: only who called, a short summary and
// the callback number pass through, straight to the phone.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** Constant-time compare of two hex strings. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** ElevenLabs: "elevenlabs-signature: t=<unix secs>,v0=<hex hmac of `${t}.${body}`>", within 30 minutes. */
async function elevenLabsSigned(req, body, secret) {
  const parts = (req.headers.get('elevenlabs-signature') || '').split(',');
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith('v0=')).map((p) => p.slice(3));
  if (!t || !sigs.length || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 30 * 60) return false;
  const want = await hmac(secret, `${t}.${body}`);
  return sigs.some((s) => same(s, want));
}

/** The Mac: "x-ares-time: <unix ms>", "x-ares-sig: <hex hmac of `${time}.${body}`>", within 5 minutes. */
async function macSigned(req, body, secret) {
  const t = req.headers.get('x-ares-time');
  if (!secret || !t || Math.abs(Date.now() - Number(t)) > 5 * 60_000) return false;
  return same(req.headers.get('x-ares-sig') || '', await hmac(secret, `${t}.${body}`));
}

// ---- FCM HTTP v1 (OAuth token from the service account, signed with WebCrypto) ---------------------------
let cachedToken = null; // { token, exp } for the life of this isolate

function b64url(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessToken(sa) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${claims}`));
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${head}.${claims}.${b64url(sig)}`,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`oauth ${res.status}: ${out.error_description || out.error}`);
  cachedToken = { token: out.access_token, exp: Date.now() + out.expires_in * 1000 };
  return cachedToken.token;
}

async function tokens(env) { return JSON.parse((await env.ARES_KV.get('tokens')) || '[]'); }

/** The phone: "x-ares-id: <device id>", "x-ares-time", "x-ares-sig: <hex hmac of `${time}.${body}` with that device's wake key>". */
async function phoneSigned(req, body, env) {
  const id = req.headers.get('x-ares-id') || '';
  const t = req.headers.get('x-ares-time');
  if (!/^[0-9a-f]{8,32}$/.test(id) || !t || Math.abs(Date.now() - Number(t)) > 5 * 60_000) return null;
  const entry = (await tokens(env)).find((x) => x.id === id && x.wake);
  if (!entry) return null;
  return same(req.headers.get('x-ares-sig') || '', await hmac(entry.wake, `${t}.${body}`)) ? entry : null;
}
const ageSec = (at) => (at ? Math.round((Date.now() - Number(at)) / 1000) : null);
/** How long ago the helper last polled (seconds), or null. */
async function helperAge(env) { return ageSec(await env.ARES_KV.get('helper')); }

/** A data message to every registered phone (the app builds the notification itself). Drops dead tokens. */
async function sendToPhones(env, data, { ttl = 3600 } = {}) {
  const list = await tokens(env);
  if (!list.length) return { sent: 0, error: 'no phone registered' };
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const auth = await accessToken(sa);
  const strings = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  let sent = 0;
  const dead = [];
  for (const t of list) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: t.token, data: strings, android: { priority: 'HIGH', ttl: `${ttl}s` } } }),
    });
    if (res.ok) { sent++; continue; }
    const err = await res.text();
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*token/i.test(err)) dead.push(t.token);
    console.log('fcm error', res.status, err.slice(0, 200));
  }
  if (dead.length) await env.ARES_KV.put('tokens', JSON.stringify(list.filter((t) => !dead.includes(t.token))));
  return { sent };
}

// ---- The post-call webhook -----------------------------------------------------------------------------
const say = (n = '') => { const d = String(n).replace(/\D/g, '').slice(-10); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : n; };
const e164 = (raw = '') => {
  const d = String(raw).replace(/\D/g, '');
  if (String(raw).trim().startsWith('+') && d.length >= 8) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return '';
};

/** Only what the notification needs: who, what, the callback number. */
function callNote(data) {
  const dc = data.analysis?.data_collection_results || {};
  const v = (k) => { const x = dc[k]?.value; return x === null || x === undefined ? '' : String(x); };
  const pc = data.metadata?.phone_call || {};
  const from = pc.external_number || data.conversation_initiation_client_data?.dynamic_variables?.system__caller_id || '';
  const cbRaw = v('callback_number');
  const callback = e164(cbRaw) || (!cbRaw || /this number|same/i.test(cbRaw) ? e164(from) : '');
  const urgent = v('urgent') === 'true';
  const spam = v('spam') === 'true';
  const topic = v('topic') || (data.analysis?.call_summary_title || '').toLowerCase();
  const caller = v('caller_name');
  const message = v('message') || data.analysis?.transcript_summary || '';
  const who = caller || (from ? say(from) : 'Someone');
  return {
    type: 'call',
    id: data.conversation_id,
    at: String((data.metadata?.start_time_unix_secs || Math.floor(Date.now() / 1000)) * 1000),
    from, caller, callback, topic, urgent: String(urgent), spam: String(spam),
    title: spam ? `Spam call from ${who}` : `${urgent ? 'URGENT: ' : ''}Call from ${who}${topic ? ` about ${topic}` : ''}`,
    body: `${message.slice(0, 600)}${callback ? ` Callback: ${say(callback)}.` : ''}`,
    secs: String(data.metadata?.call_duration_secs || 0),
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true, phones: (await tokens(env)).length });
    if (req.method !== 'POST') return new Response('Not found', { status: 404 });
    const body = await req.text();
    if (body.length > 2_000_000) return new Response('Too large', { status: 413 });

    // ---- Wake from off: the phone's side (signed with its own wake key, never the Mac's secret) ----
    if (url.pathname === '/wake' || url.pathname === '/wake/status') {
      const phone = await phoneSigned(req, body, env);
      if (!phone) return new Response('Bad signature', { status: 401 });
      const helper = await helperAge(env);
      const pending = await env.ARES_KV.get('wake');
      if (url.pathname === '/wake/status') return json({ ok: true, helper, pending: Boolean(pending) });
      // 'helper' null or stale (> 6 min) = the Mac is asleep or has no helper running: say so, but keep the wake for 3 minutes anyway
      await env.ARES_KV.put('wake', JSON.stringify({ at: Date.now(), device: phone.device, id: phone.id }), { expirationTtl: 180 });
      console.log('wake requested by', phone.device, 'helper age', helper);
      return json({ ok: true, helper, awake: helper != null && helper < 6 * 60 });
    }

    if (url.pathname === '/elevenlabs') {
      if (!(await elevenLabsSigned(req, body, env.ELEVENLABS_WEBHOOK_SECRET))) return new Response('Bad signature', { status: 401 });
      const evt = JSON.parse(body);
      if (evt.type !== 'post_call_transcription') return json({ ok: true, ignored: evt.type });
      const data = evt.data || {};
      // Calls ARES placed are reported by the Mac (it stays awake for them); here only calls to the line
      if ((data.metadata?.phone_call?.direction || 'inbound') !== 'inbound') return json({ ok: true, ignored: 'outbound' });
      if (data.agent_id && env.AGENT_ID && data.agent_id !== env.AGENT_ID) return json({ ok: true, ignored: 'agent' });
      const note = callNote(data);
      if (await env.ARES_KV.get(`d:${note.id}`)) return json({ ok: true, duplicate: true });
      const out = await sendToPhones(env, note, { ttl: 86400 });
      if (out.sent) await env.ARES_KV.put(`d:${note.id}`, '1', { expirationTtl: 7 * 86400 });
      return json({ ok: true, ...out });
    }

    if (!(await macSigned(req, body, env.RELAY_SECRET))) return new Response('Bad signature', { status: 401 });
    const msg = JSON.parse(body || '{}');
    if (url.pathname === '/register') {
      if (!/^[\w:.-]{20,4096}$/.test(msg.token || '')) return json({ error: 'bad token' }, 400);
      const list = (await tokens(env)).filter((t) => t.token !== msg.token && t.device !== msg.device && (!msg.id || t.id !== msg.id));
      const entry = { token: msg.token, device: String(msg.device || '').slice(0, 80), at: Date.now() };
      if (/^[0-9a-f]{8,32}$/.test(msg.id || '') && /^[0-9a-f]{32,128}$/.test(msg.wake || '')) { entry.id = msg.id; entry.wake = msg.wake; }
      list.push(entry);
      await env.ARES_KV.put('tokens', JSON.stringify(list.slice(-5)));
      return json({ ok: true, phones: list.length });
    }
    if (url.pathname === '/unregister') {
      const list = (await tokens(env)).filter((t) => t.token !== msg.token && (!msg.device || t.device !== msg.device));
      await env.ARES_KV.put('tokens', JSON.stringify(msg.all ? [] : list));
      return json({ ok: true });
    }
    if (url.pathname === '/notify') {
      const data = { type: 'note', ...msg.data };
      if (JSON.stringify(data).length > 3800) return json({ error: 'too large for a push' }, 413);
      return json({ ok: true, ...(await sendToPhones(env, data, { ttl: Number(msg.ttl) || 3600 })) });
    }
    // ---- Wake from off: the helper's side (the Mac's signature) ----
    if (url.pathname === '/helper/poll') {
      const last = Number(await env.ARES_KV.get('helper')) || 0;
      if (Date.now() - last > 4 * 60_000) await env.ARES_KV.put('helper', String(Date.now()), { expirationTtl: 86400 }); // the heartbeat, sparsely
      const pending = await env.ARES_KV.get('wake');
      if (pending) { await env.ARES_KV.delete('wake'); console.log('wake handed to the helper'); }
      return json({ ok: true, wake: pending ? JSON.parse(pending) : null });
    }
    if (url.pathname === '/delivered') {
      const ids = (msg.ids || []).slice(0, 50);
      const hits = await Promise.all(ids.map((id) => env.ARES_KV.get(`d:${id}`)));
      return json({ delivered: ids.filter((_, i) => hits[i]) });
    }
    return new Response('Not found', { status: 404 });
  },
};
