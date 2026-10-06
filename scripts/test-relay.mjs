#!/usr/bin/env node
// The relay Worker (relay/worker.js) without Cloudflare: a fake KV, signed requests from the Mac and from a phone.
// Covers registration with wake keys, the phone's wake and status, the helper's poll (heartbeat + taking the wake).
//   node scripts/test-relay.mjs
import worker from '../relay/worker.js';
import crypto from 'node:crypto';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  ${String(detail).slice(0, 140)}` : ''}`); if (!ok) failures++; };
const kv = new Map();
const env = {
  RELAY_SECRET: 'mac-secret', ELEVENLABS_WEBHOOK_SECRET: 'x', FCM_SERVICE_ACCOUNT: '{}',
  ARES_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
};
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
async function call(path, body, { secret, id, time = Date.now() } = {}) {
  const text = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (secret) { headers['x-ares-time'] = String(time); headers['x-ares-sig'] = hmac(secret, `${time}.${text}`); }
  if (id) headers['x-ares-id'] = id;
  const res = await worker.fetch(new Request(`https://relay.test${path}`, { method: 'POST', headers, body: text }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const now0 = Date.now();

// Registration from the Mac, with the phone's id and wake key
const wake = crypto.randomBytes(32).toString('hex');
let r = await call('/register', { token: 'fcm-token-0123456789abcdef', device: 'Galaxy (app)', id: 'abcdef0123456789', wake }, { secret: 'mac-secret' });
check('the Mac registers a phone with its wake key', r.status === 200 && r.body.phones === 1, JSON.stringify(r.body));
check('the key is kept with the token', JSON.parse(kv.get('tokens'))[0].wake === wake);
r = await call('/register', { token: 'fcm-token-0123456789abcdef', device: 'Galaxy (app)', id: 'abcdef0123456789', wake }, { secret: 'wrong' });
check('a bad Mac signature is refused', r.status === 401);

// The phone asks about the helper before any poll: nothing known
r = await call('/wake/status', { id: 'abcdef0123456789' }, { secret: wake, id: 'abcdef0123456789' });
check('status before any helper poll: helper null, nothing pending', r.status === 200 && r.body.helper === null && r.body.pending === false, JSON.stringify(r.body));
r = await call('/wake', { id: 'abcdef0123456789' }, { secret: 'not-the-key', id: 'abcdef0123456789' });
check('a wake with the wrong key is refused', r.status === 401);
r = await call('/wake', { id: 'abcdef0123456789' }, { secret: wake, id: 'abcdef0123456789', time: now0 - 10 * 60_000 });
check('a stale wake (10 min old) is refused', r.status === 401);
r = await call('/wake', { id: 'abcdef0123456789' }, { secret: 'mac-secret', id: 'abcdef0123456789' });
check("the Mac's secret doesn't sign a phone wake", r.status === 401);

// The helper polls: heartbeat written, no wake
r = await call('/helper/poll', { at: now0 }, { secret: 'mac-secret' });
check('the helper poll is accepted with no wake pending', r.status === 200 && r.body.wake === null, JSON.stringify(r.body));
check('the heartbeat is written', Number(kv.get('helper')) >= now0);
const beat = kv.get('helper');
r = await call('/helper/poll', { at: now0 }, { secret: 'mac-secret' });
check('a second poll a moment later does not rewrite the heartbeat (KV write budget)', kv.get('helper') === beat);
r = await call('/helper/poll', {}, { secret: 'nope' });
check('an unsigned helper poll is refused', r.status === 401);

// The phone wakes
r = await call('/wake', { id: 'abcdef0123456789' }, { secret: wake, id: 'abcdef0123456789' });
check('the phone\'s wake is taken and the helper is reported awake', r.status === 200 && r.body.ok && r.body.awake === true && r.body.helper < 60, JSON.stringify(r.body));
r = await call('/wake/status', { id: 'abcdef0123456789' }, { secret: wake, id: 'abcdef0123456789' });
check('status now shows it pending', r.body.pending === true);
r = await call('/helper/poll', {}, { secret: 'mac-secret' });
check('the next helper poll gets the wake', r.body.wake?.device === 'Galaxy (app)', JSON.stringify(r.body));
r = await call('/helper/poll', {}, { secret: 'mac-secret' });
check('…and only once', r.body.wake === null);

// A stale heartbeat reads as "asleep"
kv.set('helper', String(now0 - 10 * 60_000));
r = await call('/wake', { id: 'abcdef0123456789' }, { secret: wake, id: 'abcdef0123456789' });
check('with a stale heartbeat the wake is kept but the phone is told the Mac looks asleep', r.body.ok && r.body.awake === false && r.body.helper > 500, JSON.stringify(r.body));

// Unregister drops the key too
r = await call('/unregister', { all: true }, { secret: 'mac-secret' });
r = await call('/wake', { id: 'abcdef0123456789' }, { secret: wake, id: 'abcdef0123456789' });
check('after unpairing, the phone\'s wake key no longer works', r.status === 401);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
