// Drive a dev instance of ARES over CDP (CLAUDE.md, "Testing a running instance"):
//   node scripts/harness.mjs start                  starts one in /private/tmp/ares-harness-panels (port 9334) if none runs
//   node scripts/harness.mjs eval "<js>"            evaluates in the main window (await-able; the result is printed as JSON)
//   node scripts/harness.mjs shot <name> [selector] screenshots the window (or one element) to the scratch folder
//   node scripts/harness.mjs stop
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = Number(process.env.ARES_HARNESS_PORT) || 9334;
const DIR = process.env.ARES_USER_DATA || '/private/tmp/ares-harness-panels';
const OUT = process.env.ARES_HARNESS_OUT || path.join(DIR, 'shots');
const [cmd, ...args] = process.argv.slice(2);

async function page() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 5000 });
  const pages = browser.contexts().flatMap((c) => c.pages());
  const want = process.env.ARES_HARNESS_PAGE || 'renderer/index.html'; // ARES_HARNESS_PAGE=wallpaper.html drives the backdrop page instead
  const main = pages.find((p) => p.url().includes(want)) || pages[0];
  if (!main) throw new Error('no window');
  return { browser, main };
}

if (cmd === 'start') {
  try { execSync(`curl -s http://127.0.0.1:${PORT}/json/version`, { stdio: 'ignore' }); console.log('already running'); process.exit(0); } catch {}
  fs.mkdirSync(path.join(DIR, 'models'), { recursive: true });
  const kokoro = path.join(os.homedir(), 'Library/Application Support/ARES/models/kokoro-v1_0');
  if (fs.existsSync(kokoro) && !fs.existsSync(path.join(DIR, 'models/kokoro-v1_0'))) fs.symlinkSync(kokoro, path.join(DIR, 'models/kokoro-v1_0'));
  const log = fs.openSync(path.join(DIR, 'harness.log'), 'a');
  const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..'), detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, ARES_USER_DATA: DIR, ARES_PHONE_PORT: '8799', ARES_TEST_PAIR_CODE: '123456' },
  });
  child.unref();
  console.log(`started pid ${child.pid} in ${DIR}`);
} else if (cmd === 'stop') {
  const { browser } = await page().catch(() => ({}));
  try { execSync(`pkill -f "remote-debugging-port=${PORT}"`); } catch {}
  await browser?.close().catch(() => {});
  console.log('stopped');
} else if (cmd === 'reload') {
  const { browser, main } = await page();
  await main.reload({ waitUntil: 'load' }).catch(() => {});
  await main.waitForFunction(() => typeof Dash !== 'undefined', null, { timeout: 15000 }).catch(() => {});
  await browser.close();
  console.log('reloaded');
} else if (cmd === 'eval') {
  const { browser, main } = await page();
  try {
    const r = await main.evaluate(`(async () => { ${args[0].includes('return') ? args[0] : `return (${args[0]});`} })()`);
    console.log(JSON.stringify(r, null, 1));
  } finally { await browser.close(); }
} else if (cmd === 'shot') {
  const { browser, main } = await page();
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${args[0] || 'shot'}.png`);
  try {
    // As the live desktop the page is transparent: a dark backdrop behind everything for the picture only
    await main.evaluate(() => { if (!document.getElementById('shotBg')) { const d = document.createElement('div'); d.id = 'shotBg'; d.style.cssText = 'position:fixed;inset:0;background:#030a12;z-index:-1'; document.body.prepend(d); } });
    if (args[1]) await main.locator(args[1]).first().screenshot({ path: file });
    else await main.screenshot({ path: file });
    await main.evaluate(() => document.getElementById('shotBg')?.remove());
    console.log(file);
  } finally { await browser.close(); }
} else {
  console.log('usage: harness.mjs start | eval <js> | shot <name> [selector] | stop');
}
