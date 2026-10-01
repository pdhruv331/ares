#!/usr/bin/env node
// One-time setup of the ARES relay (relay/worker.js on Cloudflare's free tier), after the Firebase console steps
// in relay/README.md. It deploys the Worker, stores every secret in Cloudflare's secret store (piped straight in,
// never printed), creates the ElevenLabs post-call webhook and assigns it to the phone agent, and writes the relay
// address and shared secret to the ARES .env files.
//
//   npx wrangler login     (once, in a browser)
//   node scripts/setup-relay.mjs --service-account ~/Downloads/<project>-firebase-adminsdk-….json \
//                                --google-services ~/Downloads/google-services.json
//
// Re-running is safe; add --rotate to replace the relay and webhook secrets.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // decodes the space in "My AI"
const relayDir = path.join(root, 'relay');
const support = path.join(os.homedir(), 'Library', 'Application Support', 'ARES');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]?.replace(/^~/, os.homedir()) : null; };
const rotate = args.includes('--rotate');
const step = (s) => console.log(`› ${s}`);
const fail = (s) => { console.error(`✗ ${s}`); process.exit(1); };

// ---- Inputs ---------------------------------------------------------------------------------------------
const envFile = fs.existsSync(path.join(support, '.env')) ? path.join(support, '.env') : path.join(root, '.env');
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) fail('ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be in the ARES .env');

const saFile = arg('service-account');
const gsFile = arg('google-services');
if (!saFile || !gsFile) fail('usage: node scripts/setup-relay.mjs --service-account <file.json> --google-services <google-services.json>');
let sa, gs;
try { sa = JSON.parse(fs.readFileSync(saFile, 'utf8')); } catch { fail(`can't read ${saFile}`); }
try { gs = JSON.parse(fs.readFileSync(gsFile, 'utf8')); } catch { fail(`can't read ${gsFile}`); }
if (sa.type !== 'service_account' || !sa.private_key || !sa.client_email) fail('that service-account file doesn\'t look right (Firebase → Project settings → Service accounts → Generate new private key)');
if (!gs.client?.some((c) => c.client_info?.android_client_info?.package_name === 'com.dhruv.ares')) fail('google-services.json has no Android app com.dhruv.ares (add the app with that package name)');
if (gs.project_info?.project_id !== sa.project_id) fail(`the two files are from different Firebase projects (${gs.project_info?.project_id} vs ${sa.project_id})`);

// ---- Cloudflare -------------------------------------------------------------------------------------------
const wrangler = (cmdArgs, input) => execFileSync('npx', ['-y', 'wrangler@4', ...cmdArgs], { cwd: relayDir, input, encoding: 'utf8', stdio: [input ? 'pipe' : 'inherit', 'pipe', 'pipe'] });
step('Checking the Cloudflare login');
try { wrangler(['whoami']); } catch (err) { fail(/not authenticated|login/i.test(String(err.stderr || err.stdout || '')) ? 'not logged in to Cloudflare: run  npx wrangler login  first' : `wrangler failed: ${err.message.split('\n')[0]}`); }

const tomlFile = path.join(relayDir, 'wrangler.toml');
let toml = fs.readFileSync(tomlFile, 'utf8');
toml = toml.replace(/AGENT_ID = ".*"/, `AGENT_ID = "${env.ELEVENLABS_AGENT_ID}"`);
if (toml.includes('PASTE_KV_NAMESPACE_ID')) {
  step('Creating the KV namespace (holds only the phone\'s push token and ids of calls already notified)');
  const out = wrangler(['kv', 'namespace', 'create', 'ARES_KV']);
  const id = out.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1] || out.match(/"id":\s*"([0-9a-f]{32})"/)?.[1];
  if (!id) fail(`couldn't read the new namespace id:\n${out}`);
  toml = toml.replace('PASTE_KV_NAMESPACE_ID', id);
}
fs.writeFileSync(tomlFile, toml);

step('Deploying the Worker');
const deployed = wrangler(['deploy']);
const url = deployed.match(/https:\/\/ares-relay\.[\w-]+\.workers\.dev/)?.[0];
if (!url) fail(`couldn't find the Worker's address in:\n${deployed}`);
console.log(`  ${url}`);

const putSecret = (name, value) => { wrangler(['secret', 'put', name], value); console.log(`  ${name} stored in Cloudflare`); };
step('Storing secrets in Cloudflare');
putSecret('FCM_SERVICE_ACCOUNT', JSON.stringify(sa));
const relaySecret = !rotate && env.ARES_RELAY_URL === url && env.ARES_RELAY_SECRET ? env.ARES_RELAY_SECRET : crypto.randomBytes(32).toString('hex');
putSecret('RELAY_SECRET', relaySecret);

// ---- ElevenLabs post-call webhook ----------------------------------------------------------------------------
const el = async (method, p, body) => {
  const res = await fetch(`https://api.elevenlabs.io${p}`, { method, headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) fail(`ElevenLabs ${res.status} on ${p}: ${JSON.stringify(out.detail || out).slice(0, 200)}`);
  return out;
};
const agent = await el('GET', `/v1/convai/agents/${env.ELEVENLABS_AGENT_ID}`);
const hooks = agent.platform_settings?.workspace_overrides?.webhooks || {};
const stateFile = path.join(support, 'relay-setup.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (rotate || !state.webhookId || state.url !== url || hooks.post_call_webhook_id !== state.webhookId) {
  step('Creating the ElevenLabs post-call webhook');
  const hook = await el('POST', '/v1/workspace/webhooks', { settings: { auth_type: 'hmac', name: 'ARES relay', webhook_url: `${url}/elevenlabs` } });
  if (!hook.webhook_secret) fail('ElevenLabs didn\'t return a webhook secret');
  putSecret('ELEVENLABS_WEBHOOK_SECRET', hook.webhook_secret);
  await el('PATCH', `/v1/convai/agents/${env.ELEVENLABS_AGENT_ID}`, {
    platform_settings: { workspace_overrides: { ...agent.platform_settings.workspace_overrides, webhooks: { ...hooks, post_call_webhook_id: hook.webhook_id, events: ['transcript'], send_audio: false } } },
    version_description: 'ARES relay: post-call webhook',
  });
  state.webhookId = hook.webhook_id;
  console.log('  assigned to the ARES Calls agent (transcripts only, no audio)');
} else {
  console.log('  webhook already set up (use --rotate to replace it)');
}
state.url = url;
state.project = sa.project_id;
fs.mkdirSync(support, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 1), { mode: 0o600 });

// ---- The Mac ------------------------------------------------------------------------------------------------
step('Configuring the Mac');
fs.copyFileSync(gsFile, path.join(support, 'google-services.json'));
fs.chmodSync(path.join(support, 'google-services.json'), 0o600);
for (const file of [path.join(root, '.env'), path.join(support, '.env')]) {
  if (!fs.existsSync(file)) continue;
  let text = fs.readFileSync(file, 'utf8').replace(/^ARES_RELAY_(URL|SECRET)=.*\n?/gm, '');
  if (!text.endsWith('\n')) text += '\n';
  text += `ARES_RELAY_URL=${url}\nARES_RELAY_SECRET=${relaySecret}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
}
console.log('  relay address and secret written to the ARES .env files; google-services.json copied to the support folder');

const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) fail(`the Worker didn't answer at ${url}/health`);
console.log(`✓ Relay is live (${health.phones} phone${health.phones === 1 ? '' : 's'} registered so far).`);
console.log('  Next: restart ARES (quit it from the menu bar and open it again), then open the ARES app on your phone.');
console.log('  You can delete the downloaded service-account file now: its only copy that matters is in Cloudflare.');
