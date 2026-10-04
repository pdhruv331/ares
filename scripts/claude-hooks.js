#!/usr/bin/env node
// Connect (or disconnect) the user's Claude Code sessions to ARES: global hooks in ~/.claude/settings.json that
// run ARES's hook script on Stop, StopFailure and Notification. The script posts the event to ARES on localhost
// and exits 0 straight away when ARES isn't running, so sessions never wait on ARES or fail because of it.
// ARES's own Claude processes run with --setting-sources '' and never load these hooks (no loops).
//
//   node scripts/claude-hooks.js            show the change (nothing written)
//   node scripts/claude-hooks.js --write    back up settings.json, then apply it
//   node scripts/claude-hooks.js --remove   take ARES's hooks out again (backup first)
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const SCRIPT = '$HOME/Library/Application Support/ares/claude-hook.sh';
const COMMAND = `f="${SCRIPT}"; [ -x "$f" ] && "$f"; exit 0`;
const EVENTS = ['Stop', 'StopFailure', 'Notification'];
const ours = (group) => JSON.stringify(group).includes('claude-hook.sh');

const before = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const after = JSON.parse(JSON.stringify(before));
const remove = process.argv.includes('--remove');
after.hooks ||= {};
for (const e of EVENTS) {
  const kept = (after.hooks[e] || []).filter((g) => !ours(g));
  after.hooks[e] = remove ? kept : [...kept, { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }];
  if (!after.hooks[e].length) delete after.hooks[e];
}
if (!Object.keys(after.hooks).length) delete after.hooks;

const a = JSON.stringify(before, null, 2).split('\n');
const b = JSON.stringify(after, null, 2).split('\n');
if (a.join('\n') === b.join('\n')) { console.log('No change needed.'); process.exit(0); }
// A plain line diff (settings.json is small)
let i = 0; while (i < a.length && a[i] === b[i]) i++;
let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
console.log(`--- ${FILE}\n+++ ${FILE} (${remove ? 'without' : 'with'} ARES hooks)`);
for (const l of a.slice(Math.max(0, i - 2), i)) console.log(`  ${l}`);
for (const l of a.slice(i, a.length - j)) console.log(`- ${l}`);
for (const l of b.slice(i, b.length - j)) console.log(`+ ${l}`);
for (const l of a.slice(a.length - j, a.length - j + 2)) console.log(`  ${l}`);

if (process.argv.includes('--write') || remove) {
  const backup = `${FILE}.before-ares-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (fs.existsSync(FILE)) fs.copyFileSync(FILE, backup);
  fs.writeFileSync(FILE, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`\nWritten. Backup: ${backup}`);
} else console.log('\n(Nothing written. Run with --write to apply.)');
