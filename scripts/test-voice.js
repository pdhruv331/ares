// Tests voice.js without spending ElevenLabs credits: ElevenLabs is MOCKED (global fetch), the backup voice is the
// real local Kokoro model. Covers: first-audio latency, seamless fallback on quota / bad key / 429s / network /
// timeout, the once-only announcement, switching back, the phrase cache, budget mode, the call reserve and the
// credit warnings, and Telegram voice notes from the backup voice.
// Usage: node scripts/test-voice.js      (needs the model: zsh scripts/get-voice-model.sh)
process.env.ARES_TTS_TIMEOUT_MS = '1500';
process.env.ARES_DEV_ELEVEN = '1'; // the "dev build" flag below is false anyway; nothing here reaches ElevenLabs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Voice } = require('../voice');

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'ARES');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-voice-test-'));
fs.mkdirSync(path.join(dir, 'models'));
fs.symlinkSync(path.join(SUPPORT, 'models', 'kokoro-v1_0'), path.join(dir, 'models', 'kokoro-v1_0'));

// ---- Mock ElevenLabs ----
let mode = 'ok';            // ok | quota | badkey | busy | offline | hang
const calls = { tts: 0, sub: 0 };
let sub = { character_count: 10_000, character_limit: 121_000, next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 20 * 86400, tier: 'creator' };
const pcmStream = () => new Response(new ReadableStream({
  start(c) { c.enqueue(new Uint8Array(4800)); c.enqueue(new Uint8Array(4801)); c.enqueue(new Uint8Array(3)); c.close(); },
}), { status: 200, headers: { 'x-character-count': '20' } });
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('/v1/user/subscription')) { calls.sub++; return new Response(JSON.stringify(sub), { status: 200 }); }
  if (!url.includes('/text-to-speech/')) throw new Error(`unexpected ${url}`);
  calls.tts++;
  if (mode === 'quota') return new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 121000.' } }), { status: 401 });
  if (mode === 'badkey') return new Response(JSON.stringify({ detail: { status: 'invalid_api_key' } }), { status: 401 });
  if (mode === 'busy') return new Response('{"detail":{"status":"too_many_concurrent_requests"}}', { status: 429 });
  if (mode === 'offline') throw new TypeError('fetch failed');
  if (mode === 'hang') return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  if (url.includes('opus_48000')) return new Response(new Uint8Array(100), { status: 200 });
  return pcmStream();
};

let settings = { voiceBudget: 'off' };
const logs = [];
const voice = new Voice({
  dir, log: (...a) => logs.push(a), settings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; }, devBuild: false,
  eleven: { key: 'test-key-not-real', voice: 'NTqGiNK8P02i66yY2GOH', model: 'eleven_v3', speed: 1.1, settings: () => ({ stability: 0.5 }) },
});
const events = [];
for (const e of ['down', 'restored', 'warn']) voice.on(e, (x) => events.push([e, x]));

async function say(text) {
  let bytes = 0, odd = false;
  const r = await voice.speak(text, { onChunk: (b) => { bytes += b.length; if (b.length % 2) odd = true; } });
  assert(!odd, 'chunks must be whole 16-bit samples');
  assert(bytes > 0, `no audio for "${text}"`);
  return { ...r, bytes };
}
const step = (name) => console.log(`\n▸ ${name}`);

(async () => {
  voice.start();
  await voice.refreshCredits();

  step('Kokoro first-audio latency (target < 400 ms)');
  voice.down = { kind: 'test', since: Date.now(), retryAt: Date.now() + 60_000, fails: 1, announced: true }; // force local
  await say('Warming up.');
  const lat = [];
  for (const t of ['One moment, sir.', 'Your three o\'clock moved to four.', 'It looks like rain after six, so I would take the umbrella, and the traffic on the parkway is heavy too.', 'Done.']) {
    const r = await say(t);
    assert.equal(r.engine, 'kokoro');
    lat.push(r.firstMs);
    console.log(`  ${String(r.firstMs).padStart(4)} ms  ${(r.bytes / 48000).toFixed(1)} s  "${t}"`);
  }
  voice.down = null;

  step('Katherine (mocked) works, and short lines go into the phrase cache');
  assert.equal((await say('Let me check.')).engine, 'eleven');
  assert.equal((await say('Let me check.')).engine, 'cache');
  assert.equal((await say('Let me  check.')).engine, 'cache', 'whitespace-insensitive key');
  const before = calls.tts;
  assert.equal((await say('Let me check.')).engine, 'cache');
  assert.equal(calls.tts, before, 'a cache hit makes no request');
  assert.equal((await say('Your flight to Denver boards at 6:40 from gate B22, and it is on time.')).engine, 'eleven');
  console.log('  cache', voice.cache.stats());

  step('Quota exhausted mid-reply: seamless switch, announced once, Kokoro for the rest');
  mode = 'quota';
  const r1 = await say('Here is the first sentence of a long answer.');
  const r2 = await say('And here is the second one.');
  const r3 = await say('And a third.');
  assert.deepEqual([r1.engine, r2.engine, r3.engine], ['kokoro', 'kokoro', 'kokoro']);
  const downs = events.filter(([e]) => e === 'down');
  assert.equal(downs.length, 1, 'told once');
  assert.equal(downs[0][1].kind, 'credits');
  console.log('  note:', downs[0][1].note);
  const n = calls.tts;
  await say('Nothing should reach ElevenLabs now.');
  assert.equal(calls.tts, n, 'no retries until retryAt');
  console.log('  status:', voice.status().reason, '| retry in', Math.round((voice.down.retryAt - Date.now()) / 60000), 'min');

  step('Credits come back (retry time reached): Katherine again, automatically');
  mode = 'ok';
  voice.down.retryAt = 0;
  assert.equal((await say('Back to normal, then.')).engine, 'eleven');
  assert(events.some(([e]) => e === 'restored'));
  assert.equal(voice.down, null);

  step('Bad key, repeated 429s and network failure all fall back without silence');
  for (const m of ['badkey', 'busy', 'offline']) {
    mode = m;
    voice.down = null;
    const t0 = Date.now();
    const r = await say(`Testing the ${m} case now.`);
    assert.equal(r.engine, 'kokoro');
    console.log(`  ${m}: kokoro, ${Date.now() - t0} ms total, down=${voice.down?.kind}`);
  }

  step('Timeouts: one slow sentence falls back alone; two in a row count as an outage');
  mode = 'hang';
  voice.down = null;
  voice.timeouts = 0;
  assert.equal((await say('First slow one.')).engine, 'kokoro');
  assert.equal(voice.down, null, 'a single timeout is not an outage');
  assert.equal((await say('Second slow one.')).engine, 'kokoro');
  assert.equal(voice.down?.kind, 'network');
  mode = 'ok';
  voice.down = null;

  step('Budget mode: fillers in the backup voice, answers in Katherine');
  settings.voiceBudget = 'always';
  assert.equal((await say('Timer\'s set, sir.')).engine, 'kokoro');
  assert.equal((await say('Your meeting with Priya is at four in the large conference room.')).engine, 'eleven');
  assert.equal((await say('Let me check.')).engine, 'cache', 'cached Katherine lines are free, so they still play');
  settings.voiceBudget = 'off';
  assert.equal((await say('Certainly.')).engine, 'eleven');

  step('Credit watch: 80% / 95% warnings once each, budget AUTO, the call reserve');
  settings.voiceBudget = 'auto';
  sub = { ...sub, character_count: 99_000 };
  await voice.refreshCredits();
  assert(voice.autoBudget, 'auto budget at >= 80%');
  assert.equal((await say('One moment.')).engine, 'kokoro');
  sub = { ...sub, character_count: 116_000 };
  await voice.refreshCredits();
  await voice.refreshCredits();
  const warns = events.filter(([e]) => e === 'warn').map(([, w]) => w.level);
  assert.deepEqual(warns, [80, 95], 'each level warned once');
  assert(voice.reserve, `under the reserve (${voice.reserveCredits} credits for ~60 call minutes)`);
  assert.equal((await say('Your package arrives on Thursday between nine and noon.')).engine, 'kokoro', 'reserve: everything local');
  console.log('  credits', voice.credits());

  step('Telegram voice note from the backup voice (M4A)');
  voice.down = { kind: 'credits', since: Date.now(), retryAt: Date.now() + 60_000, fails: 1, announced: true };
  const note = await voice.voiceNote('This is a voice note from my backup voice.');
  assert.equal(note.type, 'audio/mp4');
  assert(note.audio.length > 1000 && note.audio.toString('ascii', 4, 8) === 'ftyp', 'an M4A file');
  console.log(`  ${note.audio.length} bytes M4A`);

  step('Cancel mid-sentence stops Kokoro');
  const ctrl = new AbortController();
  const p = voice.speak('This is a very long sentence that will be cut off, part way through, by a barge-in, before it can finish speaking.', { signal: ctrl.signal, onChunk: () => ctrl.abort() });
  await assert.rejects(p, (e) => e.kind === 'cancelled');

  voice.stop();
  console.log(`\n✓ all voice tests passed · Kokoro first audio: ${lat.join(', ')} ms`);
  process.exit(0);
})().catch((err) => { console.error('\n✗', err); console.error(logs.slice(-8)); voice.stop(); process.exit(1); });
