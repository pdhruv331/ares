// Time the brain on quick turns (docs/voice-prompt.md A7): the same long-lived Claude Code session ARES runs (claude.js:
// persona, tools, effort, ARES's MCP tools from a running dev instance), one model per session, plus one session that
// switches model per turn the way the router does. Subscription only. Prints time to first text per turn and p50/p95.
// Usage: node scripts/bench-brain.mjs [--mcp /private/tmp/ares-harness-voice/mcp.json] [--models sonnet,haiku] [--turns 10]
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MCP = opt('--mcp', '/private/tmp/ares-harness-voice/mcp.json');
const MODELS = opt('--models', 'sonnet,haiku').split(',');
const TURNS = Number(opt('--turns', 10));
const EFFORT = opt('--effort', 'low');
const QUICK = [
  "hey, how's it going?", "what's fifteen times twelve?", 'thanks', "what's the capital of Australia?", 'how do you spell necessary?',
  'convert ten miles to kilometres', 'tell me a one-line joke', 'what day is it today?', 'cheers, that was quick', 'give me a word that rhymes with orange',
  'what is the boiling point of water in fahrenheit?', 'say goodnight like a butler would',
];

// The brain's own arguments, read from claude.js so the prefix (persona + tools) is byte-identical to ARES's
const require = createRequire(import.meta.url);
const src = fs.readFileSync(new URL('../claude.js', import.meta.url), 'utf8');
const PERSONA = eval(src.match(/const PERSONA = (`[\s\S]*?`);/)[1]);
const { CLI } = require('../claude.js');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-bench-'));

function session(model) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const child = spawn(CLI, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model, '--effort', EFFORT, '--system-prompt', PERSONA, '--tools', 'WebSearch,WebFetch', '--setting-sources', '',
    ...(fs.existsSync(MCP) ? ['--mcp-config', MCP, '--allowedTools', 'mcp__ares', 'WebSearch', 'WebFetch', '--permission-prompt-tool', 'mcp__ares__approve'] : ['--strict-mcp-config']),
    '--disallowedTools', 'mcp__claude_ai_ElevenLabs', 'mcp__claude_ai_Claude_Docs', 'mcp__claude_ai_Slack'],
  { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let pending = null;
  const info = { model: null, tools: 0 };
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'system' && m.subtype === 'init') { info.model = m.model; info.tools = m.tools?.length; }
      if (!pending) continue;
      if (m.type === 'stream_event' && m.event?.type === 'message_start') pending.model = m.event.message?.model;
      if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
        pending.first ??= Date.now() - pending.t0; pending.text += m.event.delta.text;
      }
      if (m.type === 'result') {
        const u = m.usage || {};
        const p = pending; pending = null;
        p.resolve({ firstMs: p.first, doneMs: Date.now() - p.t0, chars: p.text.length, model: p.model, text: p.text.slice(0, 60),
          cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, input: u.input_tokens });
      }
    }
  });
  return {
    info,
    ask(text, switchTo) {
      return new Promise((resolve) => {
        if (switchTo) child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `model-${Date.now()}`, request: { subtype: 'set_model', model: switchTo } }) + '\n');
        pending = { t0: Date.now(), first: null, text: '', resolve };
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: `(Current local date and time: ${new Date().toLocaleString('en-GB')}.)\n\n${text}` } }) + '\n');
      });
    },
    close() { child.kill(); },
  };
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]; };
const results = {};
async function run(label, model, switching = null) {
  const s = session(model);
  const rows = [];
  for (let i = 0; i < TURNS; i++) {
    const want = switching ? switching[i % switching.length] : null;
    const r = await s.ask(QUICK[i % QUICK.length], want && (i === 0 && want === model ? null : want));
    rows.push(r);
    console.log(`${label.padEnd(16)} #${i + 1} ${String(r.firstMs).padStart(5)} ms first text, ${String(r.doneMs).padStart(5)} ms done  ${r.model || ''}  cache read ${r.cacheRead ?? '-'} write ${r.cacheWrite ?? '-'}  "${r.text.replace(/\s+/g, ' ')}"`);
  }
  s.close();
  const warm = rows.slice(1).map((r) => r.firstMs);
  results[label] = { model: rows.at(-1).model, tools: s.info.tools, cold: rows[0].firstMs, warmP50: pct(warm, 0.5), warmP95: pct(warm, 0.95), doneP50: pct(rows.slice(1).map((r) => r.doneMs), 0.5) };
}

for (const m of MODELS) await run(m, m);
await run('switching', MODELS[0], MODELS); // the router's way: one session, the model changed per turn
console.log('\n' + JSON.stringify(results, null, 1));
fs.rmSync(workdir, { recursive: true, force: true });
