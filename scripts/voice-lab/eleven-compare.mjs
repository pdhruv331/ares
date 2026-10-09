// A7 (docs/voice-prompt.md): Katherine on today's eleven_v3 (one HTTPS stream per sentence, exactly as voice.js asks),
// eleven_flash_v2_5 (same endpoint) and eleven_v4_turbo (Text to Dialogue WebSocket, beta), on five short lines.
// SPENDS REAL CREDITS (~500): run only with the owner's go, once. No retries, no loops beyond the 15 requests.
// Saves each clip under <support>/voice-lab/a7/ with compare.html for listening side by side, and prints timings + the
// credits actually used (subscription character count before/after).
//   node scripts/voice-lab/eleven-compare.mjs --yes-spend-credits
import fs from 'fs';
import os from 'os';
import path from 'path';

if (!process.argv.includes('--yes-spend-credits')) { console.error('This spends ElevenLabs credits. Pass --yes-spend-credits (owner approved).'); process.exit(1); }
const SUPPORT = path.join(os.homedir(), 'Library/Application Support/ARES');
const env = {};
for (const file of [path.join(SUPPORT, '.env'), path.join(import.meta.dirname, '../../.env')]) {
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } break; } catch {}
}
const KEY = env.ELEVENLABS_API_KEY, VOICE = env.ELEVENLABS_VOICE_ID || 'NTqGiNK8P02i66yY2GOH';
const SPEED = Math.min(1.2, Math.max(0.7, Number(env.ELEVENLABS_SPEED) || 1.1));
if (!KEY) throw new Error('no ELEVENLABS_API_KEY');
const API = 'https://api.elevenlabs.io';
const OUT = path.join(SUPPORT, 'voice-lab', 'a7');
fs.mkdirSync(OUT, { recursive: true });

const LINES = [
  "Morning, sir. You've got a clear diary until eleven.",
  "[laughs softly] Fair enough, I'll leave the biscuits out of it.",
  "Your timer's set for twenty-five minutes.",
  'One sec, let me check the forecast.',
  'It should stay dry until about five, then light rain moves in.',
];
const settings = (model) => (model === 'eleven_v3' ? { similarity_boost: 0.8, speed: SPEED, stability: 0.5 }
  : { similarity_boost: 0.8, speed: SPEED, stability: 0.45, style: 0.2, use_speaker_boost: true });
const stripCues = (t) => t.replace(/\[[a-z ,]+\]\s*/gi, '');

async function credits() {
  const r = await fetch(`${API}/v1/user/subscription`, { headers: { 'xi-api-key': KEY } });
  const j = await r.json();
  return j.character_count;
}

/** HTTPS stream, as voice.js #open does it: ms to the first audio bytes, and the whole clip. */
async function https(model, text) {
  const t0 = performance.now();
  const res = await fetch(`${API}/v1/text-to-speech/${VOICE}/stream?output_format=pcm_24000`, {
    method: 'POST', headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, voice_settings: settings(model) }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const reader = res.body.getReader();
  const parts = [];
  let first = null;
  for (;;) { const { done, value } = await reader.read(); if (done) break; first ??= performance.now() - t0; parts.push(Buffer.from(value)); }
  return { firstMs: Math.round(first), doneMs: Math.round(performance.now() - t0), audio: Buffer.concat(parts), format: 'pcm_24000', chars: Number(res.headers.get('x-character-count')) || null };
}

/** Text to Dialogue WebSocket: the socket is opened first (as at the start of a turn), then the line is sent and flushed. */
function dialogue(model, text, format) {
  return new Promise((resolve) => {
    const tOpen = performance.now();
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${model}&output_format=${format}`);
    const parts = [];
    let t0 = null, first = null, openMs = null, settled = false;
    const finish = (r) => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ error: 'timed out (20 s)' }), 20_000);
    ws.onopen = () => {
      openMs = Math.round(performance.now() - tOpen);
      ws.send(JSON.stringify({ voices: [VOICE], xi_api_key: KEY }));
      t0 = performance.now();
      ws.send(JSON.stringify({ inputs: [{ text, voice_id: VOICE }], flush: true }));
      ws.send(JSON.stringify({ close_socket: true }));
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.error) { clearTimeout(timer); return finish({ error: String(m.error).slice(0, 200), openMs }); }
      if (m.audio) { first ??= performance.now() - t0; parts.push(Buffer.from(m.audio, 'base64')); }
      if (m.is_final || m.isFinal) { clearTimeout(timer); finish({ firstMs: Math.round(first), doneMs: Math.round(performance.now() - t0), openMs, audio: Buffer.concat(parts), format }); }
    };
    ws.onerror = (e) => { clearTimeout(timer); finish({ error: `socket error ${e.message || ''}`.trim(), openMs }); };
    ws.onclose = (e) => { clearTimeout(timer); if (parts.length) finish({ firstMs: Math.round(first), doneMs: Math.round(performance.now() - t0), openMs, audio: Buffer.concat(parts), format }); else finish({ error: `closed ${e.code} ${e.reason || ''}`.trim(), openMs }); };
  });
}

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const save = (name, r) => {
  if (!r.audio?.length) return null;
  const file = path.join(OUT, `${name}.${r.format.startsWith('pcm') ? 'wav' : 'mp3'}`);
  fs.writeFileSync(file, r.format.startsWith('pcm') ? wav(r.audio, Number(r.format.split('_')[1])) : r.audio);
  return path.basename(file);
};

const before = await credits();
const rows = [];
let wsFormat = 'pcm_24000';
for (const [i, line] of LINES.entries()) {
  for (const model of ['eleven_v3', 'eleven_flash_v2_5', 'eleven_v4_turbo']) {
    let r;
    if (model === 'eleven_v4_turbo') {
      r = await dialogue(model, line, wsFormat);
      if (r.error && wsFormat === 'pcm_24000') { // no PCM on the beta socket: MP3 (as documented)
        rows.push({ line: i, model, note: `pcm refused: ${r.error}` });
        wsFormat = 'mp3_44100_128';
        r = await dialogue(model, line, wsFormat);
      }
    } else {
      r = await https(model, model === 'eleven_v3' ? line : stripCues(line)); // voice.js strips cues for non-v3 models today
    }
    const file = save(`${i + 1}-${model}`, r);
    rows.push({ line: i, model, firstMs: r.firstMs, doneMs: r.doneMs, openMs: r.openMs, format: r.format, file, error: r.error });
    console.log(`${i + 1} ${model.padEnd(18)} ${r.error ? `ERROR ${r.error}` : `first audio ${r.firstMs} ms, done ${r.doneMs} ms${r.openMs != null ? `, socket open ${r.openMs} ms` : ''} (${r.format})`}`);
  }
}
const after = await credits();
const summary = { creditsUsed: after - before, lines: LINES, rows };
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 1));
const cells = (i) => ['eleven_v3', 'eleven_flash_v2_5', 'eleven_v4_turbo'].map((m) => {
  const r = rows.find((x) => x.line === i && x.model === m && (x.file || x.error));
  return `<td>${r?.file ? `<audio controls src="${r.file}"></audio><div>${r.firstMs} ms to first audio</div>` : `<em>${r?.error || '—'}</em>`}</td>`;
}).join('');
fs.writeFileSync(path.join(OUT, 'compare.html'), `<!doctype html><meta charset="utf-8"><title>Katherine: v3 vs Flash vs v4 Turbo</title>
<style>body{font:15px system-ui;margin:24px;background:#111;color:#eee}td,th{padding:10px;border-bottom:1px solid #333;vertical-align:top}audio{width:220px}em{color:#f88}</style>
<h1>Katherine: which sounds best?</h1><p>Credits used for all fifteen: ${after - before}. Listen without looking at the column headers if you can.</p>
<table><tr><th>Line</th><th>eleven_v3 (today)</th><th>eleven_flash_v2_5</th><th>eleven_v4_turbo (WebSocket)</th></tr>
${LINES.map((l, i) => `<tr><td>${l.replace(/</g, '&lt;')}</td>${cells(i)}</tr>`).join('\n')}</table>`);
console.log(`\ncredits used: ${after - before}\n${path.join(OUT, 'compare.html')}`);
