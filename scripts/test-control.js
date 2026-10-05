// Exercises full Mac control (control.js) without the brain or the installed app, inside a bare Electron process:
//   npx electron scripts/test-control.js [--live]
// Reads only, plus harmless writes in a scratch folder it creates and removes. Nothing is sent to a phone (the push is
// faked), no Claude call is made, the desktop picture is untouched. --live also runs the steps that act on the real
// screen (a highlight, a window listing with Accessibility) — leave it off when someone is using the Mac.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const LIVE = process.argv.includes('--live');
const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.homedir(), 'Downloads', '.ares-control-test-')); // inside a root, so the scope allows it
const support = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-control-support-'));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`); if (!ok) failures++; };

app.whenReady().then(async () => {
  const { Control } = require(path.join(root, 'control.js'));
  const { startBridge } = require(path.join(root, 'bridge.js'));
  const pushed = [];
  let settings = { control: { folders: [] } };
  const control = new Control({
    helper: path.join(root, 'native/build/ares-control'), themeHelper: path.join(root, 'native/build/ares-theme'),
    supportDir: support, appDir: root, readSettings: () => settings, writeSettings: (p) => Object.assign(settings, p), log: () => {},
    push: async (n) => { pushed.push(n); return 1; }, phoneUrl: () => 'https://mac.example.ts.net', notice: () => {},
  });
  const yes = { source: 'phone', verified: true, turn: 1, confirm: (what) => ({ allow: true, said: 'yes' }) };
  const no = { source: 'phone', verified: true, turn: 1, confirm: () => ({ allow: false, message: 'Not confirmed yet.' }) };
  const stranger = { source: 'mac', verified: false, turn: 1, confirm: () => ({ allow: true }) };

  // ---- scope ---------------------------------------------------------------------------------------------
  check('scope line', (await control.handle('files/scope')).message.includes('Downloads'));
  check('blocked: ~/.ssh', control.classify(path.join(os.homedir(), '.ssh', 'id_rsa')) === 'blocked');
  check('blocked: .env in Downloads', control.classify(path.join(os.homedir(), 'Downloads', '.env')) === 'blocked');
  check('blocked: ~/Library', control.classify(path.join(os.homedir(), 'Library', 'Preferences', 'x.plist')) === 'blocked');
  check('blocked: ARES code', control.classify(path.join(root, 'main.js')) === 'blocked');
  check('blocked: ARES support', control.classify(path.join(support, 'settings.json')) === 'blocked');
  check('inside: Downloads', control.classify(scratch) === 'inside');
  check('inside: iCloud Drive', control.classify(path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/x.txt')) === 'inside');
  check('outside: ~/Projects', control.classify(path.join(os.homedir(), 'Projects', 'x')) === 'outside');
  const outsideRead = await control.handle('files/read', { path: '~/Projects/anything.txt' }, yes);
  check('read outside refused with the scope hint', /isn't in a folder|off limits|no ~/.test(outsideRead.message), outsideRead.message);
  const blockedRead = await control.handle('files/read', { path: '~/.ssh/id_rsa' }, yes);
  check('read blocked refused', /off limits/.test(blockedRead.message), blockedRead.message);

  // ---- files -----------------------------------------------------------------------------------------------
  fs.writeFileSync(path.join(scratch, 'notes.txt'), 'Hello from the control test.\nLine two.\n');
  fs.writeFileSync(path.join(scratch, 'data.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
  const rd = await control.handle('files/read', { path: path.join(scratch, 'notes.txt') }, yes);
  check('read text', rd.message.includes('Hello from the control test'), rd.message);
  const rb = await control.handle('files/read', { path: path.join(scratch, 'data.bin') }, yes);
  check('binary described, not dumped', /binary/.test(rb.message), rb.message);
  const rdir = await control.handle('files/read', { path: scratch }, yes);
  check('folder listing', rdir.message.includes('notes.txt'), rdir.message);
  const rel = await control.handle('files/read', { path: `Downloads/${path.basename(scratch)}/notes.txt` }, yes);
  check('relative path resolves', rel.message.includes('Line two'), rel.message);

  const mk = await control.handle('files/manage', { action: 'create_folder', path: path.join(scratch, 'sub') }, yes);
  check('create folder (tier 2)', fs.existsSync(path.join(scratch, 'sub')), mk.message);
  const rn = await control.handle('files/manage', { action: 'rename', path: path.join(scratch, 'notes.txt'), name: 'renamed.txt' }, yes);
  check('rename', fs.existsSync(path.join(scratch, 'renamed.txt')), rn.message);
  const cp = await control.handle('files/manage', { action: 'copy', path: path.join(scratch, 'renamed.txt'), to: path.join(scratch, 'sub') }, yes);
  check('copy into folder', fs.existsSync(path.join(scratch, 'sub', 'renamed.txt')), cp.message);
  const dup = await control.handle('files/manage', { action: 'copy', path: path.join(scratch, 'renamed.txt'), to: path.join(scratch, 'sub') }, yes);
  check('never overwrites', /already exists/.test(dup.message), dup.message);
  const strangerMove = await control.handle('files/manage', { action: 'move', path: path.join(scratch, 'renamed.txt'), to: path.join(scratch, 'sub', 'moved.txt') }, stranger);
  check('tier 2 needs the owner', /Refused/.test(strangerMove.message) && fs.existsSync(path.join(scratch, 'renamed.txt')), strangerMove.message);
  const trashHold = await control.handle('files/manage', { action: 'trash', path: path.join(scratch, 'data.bin') }, no);
  check('trash held without a yes (tier 3)', /Not confirmed/.test(trashHold.message) && fs.existsSync(path.join(scratch, 'data.bin')), trashHold.message);
  const trashed = await control.handle('files/manage', { action: 'trash', path: path.join(scratch, 'data.bin') }, yes);
  check('trash with a yes', !fs.existsSync(path.join(scratch, 'data.bin')) && /Trash/.test(trashed.message), trashed.message);
  const outsideMove = await control.handle('files/manage', { action: 'move', path: path.join(scratch, 'renamed.txt'), to: path.join(os.homedir(), 'ares-test-should-not-exist.txt') }, no);
  check('move outside held (tier 3)', /Not confirmed/.test(outsideMove.message) && !fs.existsSync(path.join(os.homedir(), 'ares-test-should-not-exist.txt')), outsideMove.message);
  const blockedMove = await control.handle('files/manage', { action: 'move', path: path.join(scratch, 'renamed.txt'), to: path.join(root, 'x.txt') }, yes);
  check('move into ARES code refused even with a yes', /off limits/.test(blockedMove.message) && !fs.existsSync(path.join(root, 'x.txt')), blockedMove.message);

  const found = await control.handle('files/find', { query: 'ares-control-test', folder: 'Downloads', limit: 5 }, yes).catch((e) => ({ message: e.message }));
  check('find files (Spotlight) answers', typeof found.message === 'string' && !/^Failed/.test(found.message), found.message);
  const pdfs = await control.handle('files/find', { kind: 'pdf', folder: 'Downloads', limit: 3 }, yes);
  check('find pdfs answers', !/^Failed/.test(pdfs.message), pdfs.message);
  const firstPdf = (pdfs.message.match(/^(~\/[^\n]+?\.pdf) \(/m) || [])[1];
  if (firstPdf) {
    const pr = await control.handle('files/read', { path: firstPdf, max_chars: 600 }, yes);
    check('read a PDF (PDFKit)', /page/.test(pr.message) && !/^Failed/.test(pr.message), pr.message);
  } else console.log('  -- no PDF in Downloads to read');
  const since = await control.handle('files/find', { since: 'yesterday', folder: 'Downloads', limit: 3 }, yes);
  check('find by date answers', !/^Failed/.test(since.message), since.message);
  const bad = await control.handle('files/find', {}, yes);
  check('find needs something to look for', /^Failed/.test(bad.message), bad.message);

  // ---- picture read --------------------------------------------------------------------------------------------
  const { nativeImage } = require('electron');
  fs.writeFileSync(path.join(scratch, 'pic.png'), nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 180), { width: 64, height: 64 }).toPNG());
  const pic = await control.handle('files/read', { path: path.join(scratch, 'pic.png') }, yes);
  check('read a picture → image block', pic.image?.mimeType === 'image/jpeg' && pic.image.data.length > 100, pic.message);

  // ---- screen state, windows, browser -----------------------------------------------------------------------------
  const s = await control.session();
  console.log(`  -- session: locked=${s.locked} asleep=${s.asleep} accessibility=${s.accessibility} screenRecording=${s.screenRecording} front=${s.front?.name}`);
  const wl = await control.handle('windows/list', {}, yes);
  check('windows list', /Front:/.test(wl.message), wl.message);
  const look = await control.handle('screen/look', {}, yes);
  if (s.locked || s.asleep) check('screenshot while locked: plain message', /locked|asleep/.test(look.message) && !look.image, look.message);
  else check('screenshot', Boolean(look.image) || /permission/i.test(look.message), look.message);
  const ui = await control.handle('ui/elements', {}, yes);
  if (s.locked || s.asleep) check('ui elements while locked: plain message', /locked|asleep/.test(ui.message), ui.message);
  else check('ui elements answers', !/^Failed/.test(ui.message), ui.message);
  const tab = await control.handle('browser/tab', { what: 'current' }, yes);
  check('browser tab answers', typeof tab.message === 'string', tab.message);
  const arrangeHeld = await control.handle('windows/arrange', { app: 'Finder', place: 'left' }, stranger);
  check('arrange needs the owner (or the screen)', /Refused|locked|asleep|no window/.test(arrangeHeld.message), arrangeHeld.message);

  // ---- UI act: risky steps are tier 3; stop holds the turn -------------------------------------------------------------
  if (!s.locked && !s.asleep && s.accessibility && LIVE) {
    const risky = await control.handle('ui/act', { action: 'key', key: 'return', irreversible: true }, no);
    check('irreversible step held', /Not confirmed/.test(risky.message), risky.message);
  }
  control.abort('test');
  const stopped = await control.handle('ui/act', { action: 'key', key: 'esc' }, { ...yes, turn: control.abortedTurn });
  check('after stop, automation refuses for the turn', /stop|locked|asleep/i.test(stopped.message), stopped.message);

  // ---- system, clipboard, shortcuts, permissions, audit ---------------------------------------------------------------
  const info = await control.handle('system/info', { what: 'battery storage network general' }, yes);
  check('system info', /Storage|Battery|Network/.test(info.message), info.message);
  const clip = await control.handle('clipboard', { action: 'read' }, yes);
  check('clipboard read', /Clipboard|empty|picture/.test(clip.message), clip.message);
  const sc = await control.handle('shortcuts/list', {}, yes);
  check('shortcuts list', /Shortcuts/.test(sc.message), sc.message);
  const perms = await control.handle('permissions/check', {}, yes);
  check('permissions', /Accessibility/.test(perms.message) && /never asks for Full Disk/.test(perms.message), perms.message);
  const fullDisk = await control.handle('permissions/request', { which: 'full_disk_access' }, yes);
  check('full disk access refused', /Never Full Disk/.test(fullDisk.message), fullDisk.message);
  const sys = await control.handle('system/control', { action: 'eject' }, yes);
  check('eject with no name lists volumes', /Mounted|Nothing/.test(sys.message), sys.message);

  // ---- send to phone -------------------------------------------------------------------------------------------------
  const sent = await control.handle('phone/send', { kind: 'file', path: path.join(scratch, 'renamed.txt') }, yes);
  check('send file to phone', /Sent renamed.txt/.test(sent.message) && pushed.length === 1 && pushed[0].buttons[0].file?.api.startsWith('/api/files/'), sent.message);
  const id = pushed[0].buttons[0].file.api.split('/').pop();
  check('sendbox serves the file', control.fileFor(id)?.name === 'renamed.txt');
  check('sendbox: unknown id', control.fileFor('nope') === null);
  const txt = await control.handle('phone/send', { kind: 'text', text: 'hello phone' }, yes);
  check('send text to phone', /Sent/.test(txt.message) && pushed.length === 2, txt.message);
  const link = await control.handle('phone/send', { kind: 'link', url: 'example.com/page' }, yes);
  check('send link to phone', pushed[2]?.buttons[0].url === 'https://example.com/page', link.message);
  const outsideSend = await control.handle('phone/send', { kind: 'file', path: '~/.zshrc' }, yes);
  check('blocked file never sent', /off limits|isn't in a folder/.test(outsideSend.message), outsideSend.message);

  // ---- the phone API serves sendbox files only to a paired device --------------------------------------------------------
  const { PhoneServer } = require(path.join(root, 'phone.js'));
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const phone = new PhoneServer({ port: 18799, root, readSettings: () => ({ phoneDevices: [{ hash, name: 'test' }] }), writeSettings: () => {}, ask: async () => {}, transcribe: async () => '', history: () => [],
    pushKey: () => '', apkDir: support, work: null, calls: null, firebase: () => null, fileFor: (i) => control.fileFor(i), log: () => {} });
  phone.start();
  await new Promise((r) => setTimeout(r, 300));
  const get = (p, cookie) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: 18799, path: p, headers: cookie ? { Cookie: `ares_token=${token}` } : {} }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }));
  const unauth = await get(`/api/files/${id}`);
  check('phone API: file needs pairing', unauth.status === 401);
  const ok = await get(`/api/files/${id}?download`, true);
  check('phone API: paired download', ok.status === 200 && /attachment/.test(ok.headers['content-disposition']) && ok.body.includes('Hello from'), `${ok.status} ${ok.headers['content-disposition']}`);
  const gone = await get('/api/files/doesnotexist', true);
  check('phone API: unknown file 404', gone.status === 404);
  phone.stop();

  // ---- the bridge: /control/* reaches control with the yes-gate; the MCP tool returns an image --------------------------------
  const bridge = await startBridge({ onTimerDone: () => {}, onPhoneAction: () => {}, onNotify: () => {}, findContact: () => ({}), memory: { add() {}, facts: () => [], forget: () => [] },
    teachPhrase: () => ({}), work: {}, calls: null, claudeUsage: () => '', control, log: () => {} });
  control.attach({ turn: bridge.turn });
  const post = (route, body, auth = bridge.token) => new Promise((resolve) => {
    const req = http.request(`${bridge.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.end(JSON.stringify(body));
  });
  bridge.userSaid('move it please', 'phone', true);
  const viaBridge = await post('/control/files/read', { path: path.join(scratch, 'renamed.txt') });
  check('bridge → control read', viaBridge.status === 200 && JSON.parse(viaBridge.body).message.includes('Hello from'), viaBridge.body);
  const badToken = await post('/control/files/read', { path: path.join(scratch, 'renamed.txt') }, 'nope');
  check('bridge: bad token 404', badToken.status === 404);
  bridge.userSaid('maybe', 'phone', true);
  const held = JSON.parse((await post('/control/files/manage', { action: 'trash', path: path.join(scratch, 'renamed.txt') })).body);
  check('bridge gate: no yes → held', /Not confirmed/.test(held.message) && fs.existsSync(path.join(scratch, 'renamed.txt')), held.message);
  bridge.userSaid('yes, trash it', 'phone', true);
  const done = JSON.parse((await post('/control/files/manage', { action: 'trash', path: path.join(scratch, 'renamed.txt') })).body);
  check('bridge gate: yes → done', /Trash/.test(done.message) && !fs.existsSync(path.join(scratch, 'renamed.txt')), done.message);
  bridge.userSaid('what is on my screen', 'phone', false);
  const unverified = JSON.parse((await post('/control/files/manage', { action: 'create_folder', path: path.join(scratch, 'nope') })).body);
  check('bridge: unverified owner refused for tier 2', /Refused/.test(unverified.message), unverified.message);

  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'tools/mac.js')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ARES_BRIDGE: bridge.url, ARES_TOKEN: bridge.token }, stderr: 'pipe' }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('MCP server lists the control tools', ['find_files', 'read_file', 'ui_act', 'send_to_phone', 'look_at_screen', 'recent_actions'].every((t) => tools.includes(t)), `${tools.length} tools`);
  const picTool = await client.callTool({ name: 'read_file', arguments: { path: path.join(scratch, 'pic.png') } });
  check('MCP read_file returns text + image', picTool.content.some((c) => c.type === 'image') && picTool.content.some((c) => c.type === 'text'), JSON.stringify(picTool.content.map((c) => c.type)));
  const audit = await client.callTool({ name: 'recent_actions', arguments: { limit: 5 } });
  check('MCP recent_actions reads the audit log', /tier/.test(audit.content[0].text), audit.content[0].text);
  await client.close();

  const log = control.audit.recent(200);
  check('audit log has tiers 1, 2 and 3', [1, 2, 3].every((t) => log.some((e) => e.tier === t)), `${log.length} entries`);
  check('audit log never keeps a secret-looking value', !log.some((e) => /sk-[A-Za-z0-9]{16}/.test(JSON.stringify(e))));

  if (LIVE && !s.locked) { control.highlight([200, 200, 300, 120]); await new Promise((r) => setTimeout(r, 1300)); console.log('  -- highlight shown'); }

  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(support, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  app.exit(failures ? 1 : 0);
}).catch((err) => { console.error(err); fs.rmSync(scratch, { recursive: true, force: true }); app.exit(2); });
