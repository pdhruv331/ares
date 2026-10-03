const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, powerSaveBlocker, powerMonitor, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Development only: a separate support folder (test harnesses), so tests never touch the real jobs or paired phones
if (!app.isPackaged && process.env.ARES_USER_DATA) app.setPath('userData', process.env.ARES_USER_DATA);

// Only one ARES at a time; launching it again just brings the window forward.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// Minimal .env loader (ARES_CLAUDE_MODEL, ARES_WAKE_PHRASES, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL, ELEVENLABS_SPEED).
// The installed app reads ~/Library/Application Support/ARES/.env; development falls back to the project's .env.
for (const file of [path.join(app.getPath('userData'), '.env'), path.join(__dirname, '.env')]) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  } catch {}
}

const claude = require('./claude'); // after .env so it sees ARES_CLAUDE_MODEL
const { WakeListener, listenerPath } = require('./listener');
const { VoiceId } = require('./voiceid');
const { startBridge } = require('./bridge');
const { TelegramRemote } = require('./telegram');
const { PhoneServer } = require('./phone');
const { Contacts } = require('./contacts');
const { Memory, consolidationPrompt } = require('./memory');
const { Intents, normalize: normalizeRemark } = require('./intent');
const { Remarks } = require('./remarks');
const { Jobs } = require('./jobs');
const { Calls } = require('./calls');
const { Relay } = require('./relay');
const { Dashboard } = require('./dashboard');
const { Voice } = require('./voice');
const { Voicemail } = require('./voicemail');
const { Wallpaper } = require('./wallpaper');
const { Surface } = require('./surface');
const { DeskMode } = require('./desk');
const { judge: judgeAddressed } = require('./addressed');
const { registry: workerTools } = require('./worker-tools');
const { startEgress } = require('./egress');
const workFiles = require('./work-files');
workFiles.registerScheme(); // ares-job:// (job files for the Work panel); must happen before the app is ready

const HOTKEY = 'Alt+Space';
const ELEVEN = {
  key: process.env.ELEVENLABS_API_KEY,
  voice: process.env.ELEVENLABS_VOICE_ID || 'NTqGiNK8P02i66yY2GOH', // "Katherine" — articulate, refined British
  model: process.env.ELEVENLABS_MODEL || 'eleven_v3',
  speed: Math.min(1.2, Math.max(0.7, Number(process.env.ELEVENLABS_SPEED) || 1.1)), // API allows 0.7–1.2
};
let win;
let tray;
let listener;
let voiceId;
let bridge;
let remote;
let phone;
let contacts;
let intents; // semantic intent layer (intent.js): what a short remark means, worked out on the Mac
let jobs;    // work mode (jobs.js): background Claude workers
let calls;   // the ARES phone line (calls.js): ElevenLabs agent on a Twilio number
let relay;   // the Cloudflare relay (relay.js): FCM pushes to the Android app, even with the Mac off
let dashboard; // the dashboard's live data (dashboard.js): weather, calendar, leave-by, now playing
let voicemail; // voicemails from the Twilio fallback when the phone agent can't answer (voicemail.js)
let wallpaper; // the starry backdrop below the desktop icons, the lock-screen still (wallpaper.js)
let desk;      // desk mode (desk.js): no wake word needed while the user is at the Mac
let surface;   // where the ARES window lives: the live desktop, lifted above the apps, or a window (surface.js)
let speech;    // her voice (voice.js): Katherine on ElevenLabs, the local Kokoro backup, budget mode, phrase cache, credit watch

/** A message for the window's dashboard (renderer/dash.js). */
const toDash = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('dash', msg); };

// Diagnostic log (text only, never audio): ~/Library/Application Support/ARES/ares.log
const logFile = () => path.join(app.getPath('userData'), 'ares.log');
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    fs.appendFileSync(logFile(), line);
    if (fs.statSync(logFile()).size > 512 * 1024) fs.writeFileSync(logFile(), fs.readFileSync(logFile(), 'utf8').slice(-256 * 1024));
  } catch {}
}

function createWindow({ show }) {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 540,
    frame: false,
    // Transparent, so it can be the live desktop over the icons (the page draws its own dark background as a
    // window). Native full screen still works.
    transparent: true,
    backgroundColor: '#00000000',
    acceptFirstMouse: true, // as the desktop it's never the key window: a click on a panel must still land
    fullscreenable: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // The window only ever shows ARES itself: links open in the browser, never in here
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  surface = new Surface({ win, log, opts: () => ({ enabled: wallpaper?.opts.enabled ?? readSettings().wallpaper?.enabled !== false, summon: readSettings().summon || 'lift' }),
    onChange: (name) => { wallpaper?.mainSurface(name, win); win.webContents.send('ui-prefs', uiPrefs()); setTimeout(() => dashboard?.setVisible(win.isVisible()), 50); } });
  win.once('ready-to-show', () => { if (surface.desktopOn) surface.desktop(); else if (show) win.show(); });

  // Closing the window hides it; the assistant keeps running in the menu bar.
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hideWindow();
    }
  });

  const onScreen = () => dashboard?.setVisible(win.isVisible() && !win.isMinimized());
  for (const e of ['show', 'hide', 'minimize', 'restore']) win.on(e, () => setTimeout(onScreen, 50));
  win.on('enter-full-screen', () => win.webContents.send('fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen-changed', false));
}

// Dismiss: back to being the desktop (or hidden, with the wallpaper off). surface.js also takes a fullscreen window
// out of its Space first, or macOS leaves a black screen behind.
function hideWindow() { surface.hide(); }

// ARES has something to say or heard her name: with the live desktop on she answers right there on the desktop
// (nothing jumps over the user's apps); otherwise the window comes up as before. ⌥Space / the menu still summon.
function present() {
  if (surface.desktopOn) return;
  showWindow();
}

// Summon: lift the desktop above the apps, or open the window (the ◉ menu's summon mode).
function showWindow() {
  surface.show();
  app.focus({ steal: true });
  win.focus();
}

// ⌥Space: summon ARES and start listening straight away (push-to-talk); again to hide.
function toggleWindow() {
  if (!win) return;
  if (surface.summoned && win.isFocused()) {
    hideWindow();
  } else {
    showWindow();
    win.webContents.send('summoned');
    listener.listen(6000, true); // keyboard = you're at the Mac, so no voice check
  }
}

// ---- Launch at login ---------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));
}
/** What the window needs to know about the interface: motion, magnetic panel slots, where panels were left. */
function uiPrefs() {
  const s = readSettings();
  return { reduceMotion: Boolean(s.reduceMotion), magnetic: s.ui?.magnetic !== false, panels: s.ui?.[panelsKey()] || {},
    owner: process.env.ARES_OWNER_NAME || 'Dhruv' };
}
/** Panel positions are remembered separately for the desktop (and lifted) and for the window. */
const panelsKey = () => (surface && surface.name !== 'window' ? 'desktopPanels' : 'panels');
function writeUi(patch) { writeSettings({ ui: { ...(readSettings().ui || {}), ...patch } }); }
function setLaunchAtLogin(on) {
  if (!app.isPackaged) return; // in development this would register the bare Electron binary
  app.setLoginItemSettings({ openAtLogin: on });
  writeSettings({ launchAtLogin: on });
  refreshTray();
}

// ---- Menu bar ----------------------------------------------------------------
function refreshTray() {
  if (!tray) return;
  const muted = listener.muted;
  const until = listener.muteUntil
    ? ` until ${new Date(listener.muteUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : '';
  const awake = listener.awake;
  tray.setTitle(muted ? '○' : awake ? '●' : '◉');
  tray.setToolTip(muted ? `ARES — muted${until}` : awake ? 'ARES — always listening' : 'ARES — listening for "Hey ARES"');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: muted ? `Muted${until}` : desk?.state.active && !manualAwake ? 'Desk mode: no wake word needed' : awake ? 'Always listening (no wake word)' : 'Listening for “Hey ARES”', enabled: false },
    { label: 'Stay Awake (always listening)', type: 'checkbox', checked: manualAwake, click: (item) => setAwake(item.checked) },
    muted
      ? { label: 'Start Listening', click: () => listener.unmute() }
      : { label: 'Mute', click: () => listener.mute() },
    { label: 'Mute for 1 Hour', visible: !muted, click: () => listener.mute(60) },
    // Apple's mic modes (Voice Isolation etc.) are picked per app in its own picker; Control Center may not list the listener
    { label: 'Microphone Mode (Voice Isolation)…', click: () => listener.send('micmode show') },
    { type: 'separator' },
    { label: `Show / Hide  (${HOTKEY.replace('Alt', '⌥')})`, click: toggleWindow },
    { label: 'Toggle Full Screen  (⌃⌘F)', click: toggleFullScreen },
    { type: 'separator' },
    ...wallpaperMenu(),
    { type: 'separator' },
    {
      label: 'Voice ID (only answer to you)',
      type: 'checkbox',
      enabled: voiceId.enrolled,
      checked: voiceId.enabled,
      click: (item) => { voiceId.setEnabled(item.checked); refreshTray(); win.webContents.send('voiceid-changed', voiceId.status()); },
    },
    {
      label: remoteState === 'online' ? 'Phone (Telegram): connected' : remoteInfo ? `Phone (Telegram): send code ${remoteInfo.code} to @${remoteInfo.bot}` : 'Phone (Telegram): not set up',
      enabled: false,
    },
    { label: 'Unpair Phone', visible: remoteState === 'online', click: unpairRemote },
    { label: phone?.devices.length ? `Phone app: ${phone.devices.length} paired` : 'Phone app: not paired', enabled: false },
    { label: 'Pair a Phone…', click: pairPhone },
    { type: 'separator' },
    { label: memory ? `Memory: ${memory.count} thing${memory.count === 1 ? '' : 's'} remembered` : 'Memory', enabled: false },
    { label: 'Open Memory…', click: () => { require('electron').shell.openPath(memory.file); } },
    { label: 'Clear Memory…', click: clearMemory },
    { label: 'My Phrases…', enabled: Boolean(intents?.ready), click: () => { require('electron').shell.openPath(intents.phrasesFile); } },
    { type: 'separator' },
    { label: jobs?.active.length ? `Work: ${jobs.running.length} running, ${jobs.active.length - jobs.running.length} queued` : 'Work: no jobs running', enabled: false },
    { label: 'Open Work Folder…', click: () => shell.openPath(jobs.dir) },
    { type: 'separator' },
    ...voiceMenu(),
    { label: 'Reduce Motion', type: 'checkbox', checked: Boolean(readSettings().reduceMotion), click: (item) => { writeSettings({ reduceMotion: item.checked }); win?.webContents.send('ui-prefs', uiPrefs()); wallpaper?.prefs(); refreshTray(); } },
    { label: 'Magnetic Panel Slots', type: 'checkbox', checked: readSettings().ui?.magnetic !== false, click: (item) => { writeUi({ magnetic: item.checked }); win?.webContents.send('ui-prefs', uiPrefs()); refreshTray(); } },
    { label: 'Open Calls Log…', visible: Boolean(calls?.ready), click: () => shell.openPath(calls.dir) },
    { label: 'Always Also Notify My Phone', type: 'checkbox', checked: Boolean(readSettings().workAlwaysPhone), click: (item) => { writeSettings({ workAlwaysPhone: item.checked }); refreshTray(); } },
    { type: 'separator' },
    { label: contacts?.count ? `Contacts: ${contacts.count} imported` : 'Contacts: none imported', enabled: false },
    { label: 'Import Contacts (vCard)…', click: importContacts },
    { label: 'Unpair All Phones', visible: Boolean(phone?.devices.length), click: () => { phone.unpairAll(); relay.ready && relay.unregisterAll().catch(() => {}); refreshTray(); } },
    { label: voiceId.enrolled ? 'Retrain Voice ID…' : 'Set Up Voice ID…', click: () => { showWindow(); win.webContents.send('voiceid-enroll'); } },
    { type: 'separator' },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      click: (item) => setLaunchAtLogin(item.checked),
    },
    { label: 'Quit ARES', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

/** ARES as the desktop: the live wallpaper, its options, and the lock-screen picture. */
function wallpaperMenu() {
  if (!wallpaper) return [];
  const o = wallpaper.opts;
  const act = (fn) => async (item) => { await fn(item); refreshTray(); };
  return [
    { label: 'ARES as Wallpaper', type: 'checkbox', checked: o.enabled, click: act((item) => wallpaper.setEnabled(item.checked)) },
    { label: 'Wallpaper Options', submenu: [
      { label: 'On Every Display', type: 'radio', checked: o.displays !== 'main', click: act(() => wallpaper.setDisplays('all')) },
      { label: 'Main Display Only', type: 'radio', checked: o.displays === 'main', click: act(() => wallpaper.setDisplays('main')) },
      { type: 'separator' },
      { label: 'Show Clock and Greeting', type: 'checkbox', checked: o.clock, click: act((item) => wallpaper.setClock(item.checked)) },
      { type: 'separator' },
      { label: 'ARES Lock Screen Picture', type: 'checkbox', checked: o.lockStill, click: act((item) => wallpaper.setLockStill(item.checked)) },
      { label: 'Warmer in the Evening', type: 'checkbox', checked: o.evening, enabled: o.lockStill, click: act((item) => wallpaper.setEvening(item.checked)) },
      { label: 'Re-render Lock Screen Picture', enabled: o.lockStill, click: act(() => wallpaper.renderStills()) },
    ] },
    { label: 'Restore My Original Wallpaper', enabled: Boolean(o.original), click: act(() => wallpaper.restoreOriginal()) },
    { label: 'When Summoned (Hey ARES / ⌥Space)', enabled: o.enabled, submenu: [
      { label: 'Lift the Wallpaper', type: 'radio', checked: (readSettings().summon || 'lift') === 'lift', click: act(() => writeSettings({ summon: 'lift' })) },
      { label: 'Open ARES Window', type: 'radio', checked: readSettings().summon === 'window', click: act(() => writeSettings({ summon: 'window' })) },
    ] },
    { type: 'separator' },
    ...deskMenu(),
  ];
}

/** Desk mode: no wake word while the user is at the Mac. */
function deskMenu() {
  if (!desk) return [];
  const o = desk.opts, st = desk.state;
  const idle = (m) => ({ label: `${m} minutes`, type: 'radio', checked: o.idleMin === m, click: () => { desk.set({ idleMin: m }); refreshTray(); } });
  return [
    { label: 'Desk Mode (no wake word while I\'m at the Mac)', type: 'checkbox', checked: o.enabled, click: (item) => { desk.set({ enabled: item.checked }); refreshTray(); } },
    { label: o.enabled ? `   ${st.active ? 'Listening: only your voice, only when you talk to her' : `Paused: ${st.reason}`}` : '   Off', enabled: false },
    { label: 'Desk Mode Idle Timeout', enabled: o.enabled, submenu: [2, 5, 10, 15].map(idle) },
  ];
}

/** The menu bar's voice section: what she's speaking with, credits, the Budget voice submenu, dev mode. */
function voiceMenu() {
  if (!speech) return [];
  const s = speech.status();
  const mode = s.budget;
  const radio = (m, label) => ({ label, type: 'radio', checked: mode === m, click: () => speech.setBudget(m) });
  return [
    { label: voiceLine(s), enabled: false },
    { label: creditLine(s), enabled: false },
    { label: `Budget Voice${mode === 'auto' && s.autoBudget ? ' (auto: on)' : ''}`, submenu: [radio('off', 'Off'), radio('auto', 'Auto'), radio('always', 'Always')] },
    { label: 'Use Backup Voice While I\'m Building/Testing', type: 'checkbox', checked: Boolean(readSettings().devVoice), click: (item) => speech.setDevMode(item.checked) },
  ];
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  refreshTray();
}

// ---- Barge-in -------------------------------------------------------------------------------
const words = (t) => (t.toLowerCase().match(/[a-z0-9']+/g) || []);
/** Mostly the same words ARES is saying right now = her own voice leaking into the mic. */
function isEcho(text) {
  const spoken = new Set([...speaking.values()].flatMap(words));
  const heard = words(text);
  if (!heard.length) return true;
  return heard.filter((w) => spoken.has(w)).length / heard.length >= 0.6;
}
/** What a remark is doing (stop, yes, thanks…), or plain chat while the intent model is still loading. */
const NO_INTENT = { intent: 'chat', guess: 'chat', local: false, clear: false, score: 0, margin: 0, ms: 0 };
async function classify(text) {
  if (!intents?.ready) return NO_INTENT;
  try { return await intents.classify(text); } catch (err) { log('intent error', err.message); return NO_INTENT; }
}
const recentIntents = new Map(); // normalised text -> guess, so a correction can say what she took it as
let lastBargeAt = 0;
async function onBarge(evt) {
  const echo = isEcho(evt.text);
  const r = echo ? NO_INTENT : await classify(evt.text);
  // "Mm", "yeah", "go on" while she talks is someone listening, not interrupting: she carries on.
  if (!echo && r.intent === 'continue') {
    log('barge', { echo, intent: r.intent, score: r.score, ms: r.ms, backchannel: true });
    return listener.barge(false);
  }
  // A stop needs no Voice ID: the worst a stranger can do is make her stop talking. Anything else said
  // over her still has to sound like the owner, with some leeway, as a word or two scores lower than a sentence.
  const stop = r.intent === 'stop';
  const who = echo || stop ? { ok: stop, score: null } : voiceId.verify(evt.audio);
  const bar = voiceId.enabled ? voiceId.threshold - 0.15 : 0;
  const owner = who.ok || (who.score != null && who.score >= bar);
  log('barge', { echo, owner, intent: r.intent, score: who.score, bar: +bar.toFixed(2), ms: r.ms });
  if (echo || !owner) return listener.barge(false);
  lastBargeAt = Date.now();
  listener.barge(true); // the listener stops her voice and starts capturing the new request
  for (const id of speaking.keys()) cancelledClips.add(id);
  for (const abort of ttsAborts.values()) abort();
  const heard = [...playedTexts];
  claude.interrupt();
  win.webContents.send('barge', { heard: heard.join(' ') });
}
const playedTexts = []; // what she actually got to say in the current reply
function onPlayback(evt) {
  if (evt.type === 'played') {
    if (speaking.has(evt.id) && !cancelledClips.has(evt.id)) playedTexts.push(speaking.get(evt.id));
    speaking.delete(evt.id);
    win.webContents.send('tts-played', evt.id, null);
  }
  if (evt.type === 'stopped') {
    for (const id of evt.ids) { speaking.delete(id); win.webContents.send('tts-played', id, 'stopped'); }
  }
}
ipcMain.on('reply-start', () => { playedTexts.length = 0; cancelledClips.clear(); });

// ---- Always-listening: "stay awake" (manual) and desk mode (automatic while the user is at the Mac) --------------
// Manual awake drops back to wake-word mode after a stretch with no commands, so it can't be left on by accident.
// Desk mode switches itself (desk.js). The listener is awake while either is on.
const AWAKE_TIMEOUT_MS = (Number(process.env.ARES_AWAKE_TIMEOUT_MIN) || 10) * 60_000;
let awakeTimer = null;
let manualAwake = false;
function touchAwake() {
  clearTimeout(awakeTimer);
  if (manualAwake) awakeTimer = setTimeout(() => setAwake(false, 'idle'), AWAKE_TIMEOUT_MS);
}
function syncAwake(reason) {
  const on = manualAwake || Boolean(desk?.state.active);
  if (listener.awake !== on) listener.setAwake(on);
  win?.webContents.send('listener-event', { type: 'awake', on, reason, manual: manualAwake, desk: desk?.state || null });
}
function setAwake(on, reason = 'user') {
  manualAwake = on;
  if (!on && reason === 'user') desk?.goQuiet(); // "go to sleep" / "go quiet" in desk mode: until they're away and back
  touchAwake();
  log('awake', { on, reason });
  if (!on && reason === 'idle') consolidateMemory('sleep');
  syncAwake(reason);
}
function createDesk() {
  desk = new DeskMode({ log, readSettings, writeSettings, voiceId, powerMonitor });
  desk.on('change', (st, was) => {
    if (was.active && !st.active && st.reason === 'idle' && !manualAwake) consolidateMemory('sleep');
    syncAwake(st.active ? 'desk' : `desk: ${st.reason}`);
    refreshTray();
  });
  wallpaper.on('desk', (d) => desk.setMic(d.mic));
  wallpaper.watchAlways(() => desk.opts.enabled);
  desk.check();
}
// The conversation's timing, for judging speech heard without the wake word (addressed.js)
const talk = { lastReplyAt: 0, askedQuestion: false, fromWake: false };
ipcMain.on('reply-done', (_e, asked) => { talk.lastReplyAt = Date.now(); talk.askedQuestion = Boolean(asked); });
ipcMain.on('listener-awake', (_e, on) => setAwake(on));
ipcMain.on('scene', (_e, msg) => wallpaper?.scene(msg));
ipcMain.on('wp-ready', (e) => wallpaper?.onReady(e.sender));

// ---- Wake word -----------------------------------------------------------------
function createListener() {
  // Comma-separated in .env, e.g. ARES_WAKE_PHRASES=hey ares, ok ares, ares
  const phrases = (process.env.ARES_WAKE_PHRASES || 'hey ares, ok ares, ares').split(',').map((p) => p.trim()).filter(Boolean);
  listener = new WakeListener(listenerPath(app), phrases);
  listener.on('event', (evt) => {
    if (evt.type === 'debug') return log('hearing', evt);
    if (evt.type !== 'level' && evt.type !== 'partial' && evt.type !== 'outlevel') {
      const { audio, ...rest } = evt;
      // Overheard without the wake word: no words in the log unless it turns out to be for her (onCommand)
      if (rest.type === 'command' && rest.addressed === false) rest.text = `[${(rest.text || '').split(/\s+/).filter(Boolean).length} words]`;
      log('listener', rest.type === 'command' ? { ...rest, audioSeconds: (audio?.length || 0) * 0.75 / 32000 } : rest);
    }
    if (evt.type === 'wake' || evt.type === 'listening') talk.fromWake = true;
    if (evt.type === 'timeout') talk.fromWake = false;
    // Always listening: what's being said only shows as a live subtitle once it's clearly for her
    if (evt.type === 'partial' && listener.awake && !talk.fromWake && Date.now() - talk.lastReplyAt > 20_000) return;
    if (evt.type === 'wake') {
      present();
      win.webContents.send('summoned');
    }
    if (evt.type === 'recording') return; // enrollment audio stays in the main process
    if (evt.type === 'played' || evt.type === 'stopped') return onPlayback(evt);
    if (evt.type === 'barge') return onBarge(evt);
    if (evt.type === 'command') return onCommand(evt);
    if ((evt.type !== 'level' && evt.type !== 'outlevel') || win.isVisible()) win.webContents.send('listener-event', evt);
    else wallpaper?.scene({ type: 'level', v: evt.v }); // the window isn't drawing, but the wallpaper is
  });
  listener.on('stderr', (msg) => log('listener-stderr', msg));
  listener.on('state', () => {
    refreshTray();
    win?.webContents.send('listener-event', { type: listener.muted ? 'muted' : 'unmuted', until: listener.muteUntil, awake: listener.awake });
  });
}

async function onCommand(evt) {
  const r = await classify(evt.text || '');
  rememberIntent(evt.text, r);
  // Speaker check: push-to-talk is trusted; everything else must sound like the owner. Being told to stop
  // (or, just after cutting her off, to never mind) authorises nothing, so it needs no Voice ID.
  const harmless = r.intent === 'stop' || (r.intent === 'nevermind' && r.local && Date.now() - lastBargeAt < 15_000);
  let addressed = evt.addressed !== false;
  talk.fromWake = false;
  // Heard without the wake word (desk mode / "stay awake"): only the owner's voice counts (checked against the
  // voiceprint even with Voice ID off), and only when it's clearly said TO her. Otherwise she stays quiet, and
  // nothing of it goes to the brain or the log.
  const check = evt.trusted || harmless ? { ok: true, score: null } : voiceId.verify(evt.audio, { force: !addressed });
  if (manualAwake) touchAwake();
  // In always-listening mode, other people's voices are ignored quietly rather than refused aloud.
  if (!check.ok && !addressed) return log('voice-id', { ignored: true, score: check.score });
  if (!addressed && !harmless) {
    const j = judgeAddressed(evt.text, talk);
    if (j.verdict !== 'yes') return log('overheard', { words: (evt.text || '').split(/\s+/).filter(Boolean).length, verdict: j.verdict, why: j.why });
    log('addressed', { why: j.why });
    if (j.followUp) addressed = true; // part of the conversation: no "were you talking to me?" note for the brain
  }
  log('voice-id', { authorized: check.ok, score: check.score });
  // Starting a job needs to know it's really the owner: push-to-talk, or a voice Voice ID actually checked
  lastHeard = { text: (evt.text || '').trim(), verified: check.ok && (evt.trusted || (check.score !== null && !harmless)), at: Date.now() };
  log('intent', { intent: r.intent, guess: r.guess, score: r.score, margin: r.margin, local: r.local, ms: r.ms });
  win.webContents.send('listener-event', { type: 'command', text: evt.text, authorized: check.ok, score: check.score, addressed, intent: r });
}
let lastHeard = null; // the last spoken command, and whether it's known to be the owner's
/** Was this Mac request spoken (then: did Voice ID vouch for it?) or typed at the keyboard (the owner)? */
function macVerified(said) {
  const heard = lastHeard;
  if (!heard || Date.now() - heard.at > 120_000 || !said.trim().endsWith(heard.text)) return true; // typed
  lastHeard = null;
  return heard.verified;
}
function rememberIntent(text, r) {
  recentIntents.set(normalizeRemark(text), r.guess);
  if (recentIntents.size > 50) recentIntents.delete(recentIntents.keys().next().value);
}
/**
 * What to do with a remark, from any device: { r, quick } to answer it without the brain, or { r, notes } to
 * put ahead of the brain prompt. `intent` is passed when the listener already classified it.
 */
async function planRemark(text, source, { intent = null, afterBarge = false, addressed = true } = {}) {
  const budget = budgetCommand(text);
  if (budget) {
    remember('user', text, source); remember('ares', budget, source, true);
    return { r: intent, quick: { reply: budget }, notes: '' };
  }
  let r = intent;
  if (!r) {
    r = await classify(text);
    rememberIntent(text, r);
    log('intent', { intent: r.intent, guess: r.guess, score: r.score, margin: r.margin, local: r.local, ms: r.ms, source });
  }
  const plan = remarks.plan(text, r, { afterBarge, addressed, awake: listener?.awake, remote: source !== 'mac' });
  if (plan.quick) {
    log('remark local', { intent: r.intent, source, silent: !plan.quick.reply });
    if (plan.quick.reply) { remember('user', text, source); remember('ares', plan.quick.reply, source, true); }
  }
  return { r, ...plan };
}
ipcMain.handle('remark-plan', (_e, text, opts) => planRemark(text, 'mac', opts));
/** She got one of the user's remarks wrong and they put her right (the brain's teach_phrase tool). */
async function learnPhrase(phrase, meaning, why) {
  if (!intents?.ready) throw new Error('the intent layer is still loading');
  const was = recentIntents.get(normalizeRemark(phrase)) ?? null;
  const { text, intent } = await intents.learn(phrase, meaning, { was, why });
  recentIntents.set(text, intent);
  return { message: `Learned: "${text}" means ${intent}.` };
}

ipcMain.handle('listener-state', () => ({ available: listener.available, muted: listener.muted, until: listener.muteUntil, awake: listener.awake, manual: manualAwake, desk: desk?.state || null }));
ipcMain.on('listener-mute', (_e, minutes) => listener.mute(minutes));
ipcMain.on('listener-unmute', () => listener.unmute());
ipcMain.on('listener-listen', (_e, ms, trusted) => listener.listen(ms, trusted));
ipcMain.on('listener-pause', () => { log('pause'); listener.pause(); });
ipcMain.on('log', (_e, ...parts) => log(...parts));
ipcMain.on('listener-resume', () => { log('resume'); listener.resume(); });
ipcMain.on('listener-speaking', (_e, on) => listener.speaking(on));
ipcMain.handle('native-playback', () => listener.canPlay);
ipcMain.handle('barge-capable', () => listener.canBarge);
// A clip the window played itself has finished (or was cut off): same bookkeeping as the listener's
ipcMain.on('tts-window-done', (_e, id, stopped) => {
  if (stopped) speaking.delete(id);
  else onPlayback({ type: 'played', id });
});

// ---- Voice ID -----------------------------------------------------------------------
ipcMain.handle('voiceid-status', () => voiceId.status());
ipcMain.handle('voiceid-start', () => voiceId.startEnrollment());
ipcMain.handle('voiceid-record', async () => {
  const rec = await listener.record(7000);
  return voiceId.addSample(rec.audio, rec.seconds);
});
ipcMain.handle('voiceid-finish', () => {
  const result = voiceId.finishEnrollment();
  refreshTray();
  return result;
});
ipcMain.handle('voiceid-cancel', () => voiceId.cancelEnrollment());
ipcMain.handle('voiceid-enable', (_e, on) => { voiceId.setEnabled(on); refreshTray(); return voiceId.status(); });

// ---- Remote access: Telegram -------------------------------------------------------------
const REMOTE_NOTE = (voice) => `(Via Telegram: the user is away from the Mac, messaging from their phone. Your reply is sent as a chat message${voice ? ' and as a voice note' : ''}. Keep it concise and plain text, no markdown. Tools work as usual; opening apps or web pages happens on the Mac, not their phone.)\n\n`;
const speakable = (t) => t.replace(/(^|\n)\s*Sources?:[\s\S]*$/i, '').replace(/\(?https?:\/\/\S+\)?/g, '').trim();
const readable = (t) => t.replace(/\[[a-z ]+\]\s*/gi, '').trim();

async function transcribe(audio, type = 'audio/ogg') {
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('file', new Blob([audio], { type }), type.includes('mp4') ? 'voice.m4a' : type.includes('webm') ? 'voice.webm' : type.includes('wav') ? 'voice.wav' : 'voice.ogg');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ELEVEN.key }, body: form });
  if (!res.ok) throw new Error(`transcription HTTP ${res.status}`);
  return ((await res.json()).text || '').trim();
}

let keepAwake = null;
function startRemote() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  remote = new TelegramRemote({
    token,
    ownerId: readSettings().telegramOwnerId,
    log,
    transcribe,
    onMessage: async ({ text, voice }) => {
      if (/^\/?(forget|reset)\b.*(conversation|chat|memory)?$/i.test(text)) {
        resetBrain();
        return { text: 'Consider it forgotten, sir. Clean slate.' };
      }
      const plan = await planRemark(text, 'telegram');
      const result = plan.quick ? { ok: true, text: plan.quick.reply } : await askBrain(text, REMOTE_NOTE(voice) + plan.notes + text, null, 'telegram');
      const reply = result.ok ? result.text : `Apologies, sir: ${result.error}.`;
      if (!voice || !speech.available || plan.quick?.voice === false) return { text: readable(reply) };
      try {
        const note = await speech.voiceNote(speakable(reply)); // Katherine (Ogg/Opus) or the backup voice (M4A)
        return { text: readable(reply), audio: note.audio, audioType: note.type };
      } catch (err) {
        log('telegram voice error', err.message);
        return { text: readable(reply) };
      }
    },
  });
  remote.on('ready', (info) => {
    remoteState = info.paired ? 'online' : 'pending';
    remoteInfo = info;
    refreshTray();
    pushIntegrations();
    if (!info.paired) win.webContents.send('remote-pairing', info);
  });
  remote.on('paired', ({ id, name }) => {
    writeSettings({ telegramOwnerId: id });
    log('telegram paired', { id });
    remoteState = 'online';
    refreshTray();
    pushIntegrations();
    notice(`Telegram paired with ${name}. I'm reachable from your phone now, sir.`);
  });
  remote.on('error', () => { remoteState = 'off'; pushIntegrations(); });
  remote.start();
  // Stay reachable: stop the Mac idle-sleeping while remote access is on (closing the lid on battery still sleeps)
  keepAwake ??= powerSaveBlocker.start('prevent-app-suspension');
}
// ---- Phone app (served to your phone over Tailscale) -------------------------------------------------
const PHONE_PORT = Number(process.env.ARES_PHONE_PORT) || 8765;
const PHONE_NOTE = "(ARES note: the user is using the ARES app on their phone, away from the Mac. Keep replies concise. To open, call, text, message, navigate or play something, use the phone_action tool so it happens on their phone, not the Mac; use notify_phone for anything they should be reminded of later.)\n\n";
let phoneUrl = process.env.ARES_PHONE_URL || null; // https://<mac>.<tailnet>.ts.net once Tailscale is set up

/** Stream one sentence of speech (raw 24kHz PCM) into `out.chunks`, in whichever voice is speaking now. */
function speakInto(text, out) {
  const ctrl = new AbortController();
  out.abort = () => ctrl.abort();
  speech.speak(text, { signal: ctrl.signal, source: 'phone', onChunk: (bytes) => { out.chunks.push(bytes); out.wake?.(); } })
    .catch((err) => { if (!ctrl.signal.aborted) log('phone tts error', err.message); })
    .finally(() => { out.done = true; out.wake?.(); });
}

let phoneStream = null; // the phone conversation in progress: actions are delivered straight into it
async function phoneAsk({ text, voice, images = [] }, send) {
  phoneStream = send;
  const clips = [];
  let consumed = 0;
  let sofar = '';
  const speakable = (t) => t.replace(/(^|\n)\s*Sources?:[\s\S]*$/i, '').replace(/\(?https?:\/\/\S+\)?/g, '').trim();
  const queue = (t) => { t = speakable(t); if (voice && speech.available && /[a-z0-9]/i.test(t)) { const c = { chunks: [], done: false }; clips.push(c); speakInto(t, c); } };
  const split = (final) => {
    const re = /[.!?…]+["')\]]*\s+/g;
    re.lastIndex = consumed;
    let m;
    while ((m = re.exec(sofar))) {
      const end = m.index + m[0].length;
      if (sofar.slice(consumed, end).trim().length < 6) continue;
      queue(sofar.slice(consumed, end));
      consumed = end;
    }
    if (final && sofar.length > consumed) { queue(sofar.slice(consumed)); consumed = sofar.length; }
  };
  // Send each sentence's audio in order, as soon as it's available (one sender at a time)
  let next = 0;
  let pumping = null;
  const pump = () => {
    if (pumping) return pumping;
    pumping = (async () => {
    await null; // always finish asynchronously, so `pumping` is set before it's cleared below
    while (next < clips.length) {
      const c = clips[next];
      let sent = 0;
      for (;;) {
        while (sent < c.chunks.length) send({ type: 'audio', clip: next, pcm: Buffer.from(c.chunks[sent++]).toString('base64') });
        if (c.done) break;
        await new Promise((r) => { c.wake = r; });
      }
      send({ type: 'clipend', clip: next });
      next++;
    }
    })().finally(() => { pumping = null; });
    return pumping;
  };
  let edge = null; // a sentence ending right at the end of what's streamed so far: speak it if nothing follows quickly
  // Just your words (the app may add a note with your screen or something shared): what the model router
  // judges, and what the conversation history shows
  const said = text.split(/\n\n\((?:ARES note:|Shared from another app)/)[0].trim() || text;
  // A bare remark ("cheers", "say that again") can be answered here; with a screen or share attached, the brain looks
  const plan = images.length || said !== text.trim() ? { notes: '' } : await planRemark(said, 'phone');
  const result = plan.quick ? { ok: true, text: plan.quick.reply } : await askBrain(said, PHONE_NOTE + plan.notes + text, (delta) => {
    sofar += delta;
    send({ type: 'text', delta });
    clearTimeout(edge);
    split(false);
    if (clips.length > next) pump();
    if (/[.!?…]["')\]]*$/.test(sofar)) {
      edge = setTimeout(() => {
        if (sofar.slice(consumed).trim().length < 6) return;
        queue(sofar.slice(consumed));
        consumed = sofar.length;
        pump();
      }, 120);
    }
  }, 'phone', images);
  clearTimeout(edge);
  const reply = result.ok ? result.text : `Apologies, sir: ${result.error}.`;
  if (!result.ok || plan.quick) { sofar = reply; send({ type: 'text', delta: reply }); }
  if (plan.quick?.voice === false) consumed = sofar.length; // a word on screen, nothing to say aloud
  split(true);
  while (next < clips.length || pumping) await (pumping || pump());
  send({ type: 'done', text: reply.replace(/\[[a-z ]+\]\s*/gi, '') });
  if (phoneStream === send) phoneStream = null;
}

// ---- Phone notifications (Web Push, end-to-end encrypted, delivered by Google's push service) --------
const webpush = require('web-push');
function vapid() {
  let keys = readSettings().vapid;
  if (!keys) { keys = webpush.generateVAPIDKeys(); writeSettings({ vapid: keys }); }
  return keys;
}
const pushedTags = new Set(); // notifications on the phone that "seen on the Mac" should clear
async function pushToPhones({ title, body, buttons = [], tag, job }) {
  // Every note has a tag, so the same note arriving by FCM and by the live line shows once on the phone
  tag ||= `n-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const keys = vapid();
  webpush.setVapidDetails('mailto:ares@localhost', keys.publicKey, keys.privateKey);
  const devices = readSettings().phoneDevices || [];
  const payload = JSON.stringify({ title, body, tag, job, buttons: buttons.slice(0, 2) });
  if (tag) pushedTags.add(tag);
  let sent = 0;
  let changed = false;
  for (const d of devices) {
    if (!d.subscription) continue;
    try {
      await webpush.sendNotification(d.subscription, payload, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (err) {
      log('push error', { status: err.statusCode, message: err.message?.slice(0, 120) });
      if (err.statusCode === 404 || err.statusCode === 410) { delete d.subscription; changed = true; } // unsubscribed
    }
  }
  if (changed) writeSettings({ phoneDevices: devices });
  const live = phone?.notifyNative({ title, body, tag, job, buttons: buttons.slice(0, 2) }) || 0; // the Android app, if connected
  // ...and through Firebase via the relay, which reaches it off Tailscale and with the app asleep
  const viaFcm = relay?.ready && (readSettings().phoneDevices || []).some((d) => d.fcm) ? await relay.notify({ title, body, tag, job, buttons: buttons.slice(0, 2) }) : 0;
  sent += Math.max(live, viaFcm);
  log('push', { title, sent, fcm: viaFcm });
  return sent;
}
/** Take notifications off the phone (a job opened or answered on another device). Only ones actually sent. */
async function clearPhoneNotes(tags) {
  tags = tags.filter((t) => pushedTags.delete(t));
  if (!tags.length) return;
  phone?.broadcast({ type: 'clear', tags }); // the Android app, and the web app if it's open
  const keys = vapid();
  webpush.setVapidDetails('mailto:ares@localhost', keys.publicKey, keys.privateKey);
  for (const d of readSettings().phoneDevices || []) {
    if (!d.subscription) continue;
    await webpush.sendNotification(d.subscription, JSON.stringify({ clear: tags }), { TTL: 600, urgency: 'normal' }).catch(() => {});
  }
  log('push clear', { tags });
}

// ---- Phone-aware actions: turn a request into a link the phone opens -----------------------------------
const enc = encodeURIComponent;
const digits = (t = '') => t.replace(/[^\d+]/g, '');
function phoneLink({ kind, target = '', message = '', subject = '', label }) {
  const t = target.trim();
  switch (kind) {
    case 'open_url': {
      const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
      if (!/^https?:$/.test(u.protocol)) throw new Error('only web links can be opened');
      return { url: u.href, label: label || `Open ${u.hostname}` };
    }
    case 'call': return { url: `tel:${digits(t)}`, label: label || (t ? `Call ${t}` : 'Open dialer') };
    case 'text': return { url: `sms:${digits(t)}${message ? `?body=${enc(message)}` : ''}`, label: label || 'Send text' };
    case 'whatsapp': return { url: `https://wa.me/${digits(t).replace('+', '')}${message ? `?text=${enc(message)}` : ''}`, label: label || 'WhatsApp' };
    case 'directions': return { url: `https://www.google.com/maps/dir/?api=1&destination=${enc(t)}&dir_action=navigate`, label: label || `Directions to ${t}` };
    case 'map': return { url: `https://www.google.com/maps/search/?api=1&query=${enc(t)}`, label: label || `Map: ${t}` };
    case 'email': return { url: `mailto:${t}?subject=${enc(subject)}&body=${enc(message)}`, label: label || 'Compose email' };
    case 'spotify': return { url: `https://open.spotify.com/search/${enc(t)}`, label: label || `Spotify: ${t}` };
    case 'youtube': return { url: `https://www.youtube.com/results?search_query=${enc(t)}`, label: label || `YouTube: ${t}` };
    default: throw new Error(`unknown action ${kind}`);
  }
}
async function onPhoneAction(args, source) {
  const action = phoneLink(args);
  log('phone action', { kind: args.kind, live: source === 'phone' && Boolean(phoneStream) });
  if (source === 'phone' && phoneStream) {
    phoneStream({ type: 'action', ...action });
    return { message: `Done: "${action.label}" is opening on the user's phone.` };
  }
  const sent = await pushToPhones({ title: 'ARES', body: action.label, buttons: [{ title: 'Open', url: action.url }] });
  return { message: sent ? `Sent to the user's phone as a notification: "${action.label}".` : "The phone app isn't set up for notifications yet." };
}
async function onNotify({ title, body, buttons }) {
  const sent = await pushToPhones({ title, body, buttons });
  return { message: sent ? 'Notification sent to the phone.' : "The phone app isn't set up for notifications yet (enable them in the app)." };
}

const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
function findPhoneUrl() {
  if (phoneUrl || !fs.existsSync(TAILSCALE)) return;
  require('child_process').execFile(TAILSCALE, ['status', '--json'], { timeout: 15000 }, (err, out) => {
    try {
      const dns = JSON.parse(out).Self?.DNSName?.replace(/\.$/, '');
      if (dns) { phoneUrl = `https://${dns}`; refreshTray(); }
    } catch {}
  });
}

function startPhone() {
  phone = new PhoneServer({
    port: PHONE_PORT,
    root: __dirname,
    readSettings,
    writeSettings,
    ask: phoneAsk,
    transcribe: (audio, type) => transcribe(audio, type),
    history: () => conversation.slice(-40),
    pushKey: () => vapid().publicKey,
    apkDir: process.env.ARES_APK_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'ARES', 'android'),
    work: jobs && phoneWork(),
    calls,
    firebase: () => relay.firebase(),
    log,
  });
  phone.on('fcm', (d) => {
    if (!relay.ready) return log('relay not set up: fcm token kept for later');
    relay.register(d.fcm, d.name).then((r) => log('relay registered', { phones: r.phones }), (err) => log('relay register failed', err.message));
  });
  // Tokens the Mac already knows (e.g. the relay was set up after pairing): make sure the relay has them
  if (relay.ready) for (const d of phone.devices.filter((x) => x.fcm)) relay.register(d.fcm, d.name).catch((err) => log('relay register failed', err.message));
  phone.on('paired', (d) => {
    refreshTray();
    notice(`Phone paired (${d.name}). You can reach me from the ARES app now, sir.`);
  });
  phone.start();
  if (!app.isPackaged && process.env.ARES_TEST_PAIR_CODE) phone.code = process.env.ARES_TEST_PAIR_CODE; // dev testing only
  findPhoneUrl();
  keepAwake ??= powerSaveBlocker.start('prevent-app-suspension'); // stay reachable from the phone
}
async function importContacts() {
  const { dialog } = require('electron');
  const pick = await dialog.showOpenDialog({ title: 'Import contacts', defaultPath: path.join(os.homedir(), 'Downloads'), filters: [{ name: 'vCard', extensions: ['vcf'] }], properties: ['openFile'] });
  if (pick.canceled || !pick.filePaths[0]) return;
  try {
    const n = contacts.importVcf(pick.filePaths[0]);
    log('contacts imported', { count: n });
    notice(`${n} contacts imported, sir. They stay on this Mac. You can now say things like "text Sam" or "call Mum".`);
  } catch (err) {
    notice(`I couldn't import that file: ${err.message}.`);
  }
  refreshTray();
}

function pairPhone() {
  const code = phone.newCode();
  showWindow();
  notice(phoneUrl
      ? `To pair your phone: with Tailscale on, open ${phoneUrl} in your phone's browser (Chrome on Android, Safari on iPhone), then enter code ${code}.`
      : `Pairing code ${code}. Set up Tailscale on this Mac and your phone first, then open this Mac's Tailscale address in your phone's browser.`);
  refreshTray();
}

let remoteState = 'off';
let remoteInfo = null;
function unpairRemote() {
  writeSettings({ telegramOwnerId: null });
  remote?.stop();
  remote = null;
  startRemote();
}

// ---- Integration status (for the panel) -------------------------------------------------
// Account connectors are read from `claude mcp list` (no model usage); ARES's own tools and web
// search are on whenever the brain is.
const CONNECTORS = { calendar: 'claude.ai Google Calendar', gmail: 'claude.ai Gmail', drive: 'claude.ai Google Drive' };
let integrations = null;
function checkIntegrations() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  require('child_process').execFile(claude.CLI, ['mcp', 'list'], { env, cwd: os.homedir(), timeout: 60000 }, (err, stdout = '') => {
    const status = { mac: claude.available() ? 'online' : 'off', web: claude.available() ? 'online' : 'off', phone: remoteState };
    for (const [key, name] of Object.entries(CONNECTORS)) {
      const line = stdout.split('\n').find((l) => l.startsWith(`${name}:`)) || '';
      status[key] = /Connected/.test(line) ? 'online' : /auth/i.test(line) ? 'pending' : 'off';
    }
    integrations = status;
    log('integrations', status);
    pushIntegrations();
  });
}
function pushIntegrations() {
  if (!integrations) return;
  integrations.phone = remoteState;
  win?.webContents.send('integrations', integrations);
}
ipcMain.handle('integrations', () => integrations);

// ---- System, voice, brain --------------------------------------------------------
// "Memory Used" the way Activity Monitor counts it: app memory + wired + compressed. (os.freemem()
// only counts completely empty pages, and macOS keeps nearly all spare memory as droppable cache.)
function memoryUsed() {
  return new Promise((resolve) => {
    require('child_process').execFile('/usr/bin/vm_stat', (err, out = '') => {
      const page = Number(out.match(/page size of (\d+)/)?.[1]) || 16384;
      const n = (label) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]) || 0;
      const used = (n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')) * page;
      resolve(err || !used ? 1 - os.freemem() / os.totalmem() : Math.min(1, used / os.totalmem()));
    });
  });
}

ipcMain.handle('system-stats', async () => {
  const cpus = os.cpus();
  const load = os.loadavg()[0] / cpus.length;
  return {
    cpu: Math.min(1, load),
    memUsed: await memoryUsed(),
    memTotalGB: os.totalmem() / 1024 ** 3,
    uptime: os.uptime(),
    host: os.hostname().replace(/\.local$/, ''),
    user: os.userInfo().username,
  };
});
// v3 only accepts stability 0 (creative), 0.5 (natural) or 1 (robust)
function voiceSettings() {
  const base = { similarity_boost: 0.8, speed: ELEVEN.speed };
  return ELEVEN.model === 'eleven_v3'
    ? { ...base, stability: 0.5 }
    : { ...base, stability: 0.45, style: 0.2, use_speaker_boost: true };
}

// Text-to-speech runs here so the API key never reaches the renderer (voice.js picks the engine)
ipcMain.handle('tts-available', () => speech.available);

// Clips being spoken right now (id -> text), for the echo check, plus which of them were cut off.
const speaking = new Map();
const cancelledClips = new Set();
const ttsAborts = new Map(); // id -> () => void

// Streaming TTS: raw 24kHz PCM chunks are forwarded as they arrive, so playback starts in well under a second.
ipcMain.on('tts-stream', async (e, id, text, native) => {
  const send = (...args) => { if (!e.sender.isDestroyed()) e.sender.send(...args); };
  // Native playback: audio goes to the listener (echo cancellation + barge-in), not the window
  const toListener = native && listener.canPlay;
  speaking.set(id, text); // for the echo check (whichever way it plays)
  if (toListener) listener.clip(id);
  if (native && !toListener) return send('tts-native-off', id); // the window will play it itself
  const finish = (err) => {
    ttsAborts.delete(id);
    if (toListener) listener.playEnd(id);
    send('tts-end', id, err);
  };
  if (cancelledClips.has(id)) return finish('cancelled'); // cut off before it started
  const ctrl = new AbortController();
  ttsAborts.set(id, () => ctrl.abort());
  try {
    await speech.speak(text, { signal: ctrl.signal, source: 'mac',
      onChunk: (value) => (toListener ? listener.play(id, value) : send('tts-chunk', id, value)) });
    finish(cancelledClips.has(id) ? 'cancelled' : null);
  } catch (err) {
    if (!cancelledClips.has(id) && err.kind !== 'cancelled') log('tts error', err.message);
    finish(cancelledClips.has(id) || err.kind === 'cancelled' ? 'cancelled' : err.message);
  }
});

// Brain: stream Claude's reply back to the renderer as it's written
ipcMain.handle('brain-available', () => claude.available());
/** One brain for the Mac and the phone. `said` is what the user actually said (so a "yes" can approve
 *  actions); `prompt` may carry extra context for Claude. */
// Recent conversation across the Mac, phone and Telegram (in memory; shown in the phone app)
const conversation = [];
function remember(who, text, source, quick = false) {
  if (!text) return;
  conversation.push({ who, text: text.replace(/\[[a-z ]+\]\s*/gi, '').trim(), source, t: Date.now(), ...(quick && { quick }) });
  if (conversation.length > 60) conversation.splice(0, conversation.length - 60);
  commsAdd(who, text, source);
  memoryIdle();
}

// COMMS (the window's history drawer): everything said today on any device, plus lines only the window knows
// about (local commands, announcements, pairing codes). Kept to today and saved, so a restart doesn't lose it.
const COMMS_FILE = () => path.join(app.getPath('userData'), 'comms-today.json');
const dayOf = (t) => new Date(t).toDateString();
let comms = null;
let commsSave = null;
function commsLoad() {
  if (comms) return comms;
  try { comms = JSON.parse(fs.readFileSync(COMMS_FILE(), 'utf8')); } catch { comms = []; }
  const today = dayOf(Date.now());
  comms = Array.isArray(comms) ? comms.filter((m) => dayOf(m.t) === today) : [];
  return comms;
}
function commsAdd(who, text, source = 'mac', extra = {}) {
  text = String(text || '').replace(/\[[a-z ]+\]\s*/gi, '').trim();
  if (!text) return;
  const list = commsLoad();
  if (list.length && dayOf(list[0].t) !== dayOf(Date.now())) list.length = 0; // a new day: start fresh
  const m = { who, text, source, t: Date.now(), ...extra };
  list.push(m);
  if (list.length > 500) list.splice(0, list.length - 500);
  if (win && !win.isDestroyed()) win.webContents.send('comms', m);
  clearTimeout(commsSave);
  commsSave = setTimeout(() => fs.writeFile(COMMS_FILE(), JSON.stringify(comms), () => {}), 1500);
}
/** A line for the window (shown as a subtitle and kept in COMMS) that isn't part of the brain's conversation. */
const notice = (text) => commsAdd('ares', text, 'mac', { notice: true });
ipcMain.handle('comms-history', () => commsLoad().filter((m) => dayOf(m.t) === dayOf(Date.now())));
ipcMain.on('comms-note', (_e, who, text, extra) => commsAdd(who, text, 'mac', { ...extra, local: true }));
// What she last really said (not a quick "any time"), on whichever device: for "say that again" and short replies
const remarks = new Remarks({
  lastReply: () => conversation.findLast((m) => m.who === 'ares' && !m.quick) ?? null,
});

// ---- Long-term memory ------------------------------------------------------------------------
// When a conversation ends (you say "forget our conversation", ARES goes quiet for 10 minutes, stay-awake
// times out, or you quit) the new turns are merged into memory.md by a separate one-off Claude call.
// Long sessions are also saved at checkpoints, before the in-memory history would drop turns.
let memory = null;
let memorySavedT = Date.now(); // turns after this haven't been merged into memory yet
let memoryRun = Promise.resolve();
let memoryIdleTimer = null;
const MEMORY_IDLE_MS = (Number(process.env.ARES_MEMORY_IDLE_MIN) || 10) * 60_000;
const unsavedTurns = () => conversation.filter((m) => m.t > memorySavedT);

function memoryIdle() {
  clearTimeout(memoryIdleTimer);
  memoryIdleTimer = setTimeout(() => consolidateMemory('idle'), MEMORY_IDLE_MS);
  if (unsavedTurns().length >= 30) consolidateMemory('checkpoint');
}

function consolidateMemory(reason) {
  const turns = unsavedTurns();
  if (!memory || !turns.length) return memoryRun;
  memorySavedT = turns[turns.length - 1].t; // claim these turns now, so a second trigger doesn't redo them
  const transcript = turns.map((m) => `${m.who === 'user' ? 'User' : 'ARES'}: ${m.text}`).join('\n').slice(-40_000);
  memoryRun = memoryRun.then(async () => {
    const t0 = Date.now();
    try {
      const before = memory.facts();
      const reply = await claude.oneShot(consolidationPrompt(before, transcript));
      if (/^\s*NONE\s*$/.test(reply)) { log('memory consolidate', { reason, turns: turns.length, changed: false }); return; }
      const facts = reply.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
      if (!facts.length || facts.length < before.length / 2) throw new Error(`suspicious result (${facts.length} facts, had ${before.length})`);
      const n = memory.replace(facts);
      log('memory consolidate', { reason, turns: turns.length, facts: n, ms: Date.now() - t0 });
      refreshTray();
    } catch (err) {
      log('memory consolidate failed', { reason, error: err.message });
    }
  });
  return memoryRun;
}

function resetBrain() {
  consolidateMemory('reset'); // this conversation's turns are captured before the brain forgets them
  claude.reset();
}

async function clearMemory() {
  const { dialog } = require('electron');
  const { response } = await dialog.showMessageBox({ type: 'warning', buttons: ['Clear Memory', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Clear everything ARES remembers about you?', detail: 'A backup is kept as memory.md.bak.' });
  if (response !== 0) return;
  memory.clear();
  memorySavedT = Date.now();
  claude.reset();
  log('memory cleared');
  refreshTray();
}

// "Do this as a job", "…in the background": the user wants a background worker, whatever the brain thinks
const JOB_PHRASE = /\b(as an? (background )?job|in the background|start an? job|make (it|this|that) an? job)\b/i;
const JOB_NOTE = '(ARES note: the user asked for this to be done as a background job. Call start_job with a complete brief, then just say you are on it.)\n\n';
async function askBrain(said, prompt, onDelta, source = 'mac', images = [], verified = source !== 'mac') {
  const t0 = Date.now();
  let first = null;
  if (JOB_PHRASE.test(said)) prompt = JOB_NOTE + prompt;
  if (callNotes.length) prompt = `(ARES note: since the last message, you told the user about phone calls: ${callNotes.splice(0).join(' | ')})\n\n${prompt}`;
  const result = await claude.ask(prompt, (delta) => {
    first ??= Date.now() - t0;
    onDelta?.(delta);
  }, { onStart: () => bridge?.userSaid(said, source, verified), images, said });
  log('timing brain', { firstTextMs: first, doneMs: Date.now() - t0, ok: result.ok, source, model: result.model, why: result.why });
  toDash({ type: 'health', key: 'brain', ok: result.ok, reason: result.ok ? '' : /log in/i.test(result.error) ? 'Claude login expired' : /limit/i.test(result.error) ? 'Claude usage limit' : 'Claude error' });
  if (!/^\s*\(ignore\)/i.test(result.text || '')) { remember('user', said, source); remember('ares', result.text, source); }
  return result;
}
ipcMain.handle('brain-ask', (e, text) => {
  const said = text.replace(/^(\(ARES note:[\s\S]*?\)\n\n)+/, '');
  return askBrain(said, text, (delta) => { if (!e.sender.isDestroyed()) e.sender.send('brain-delta', delta); }, 'mac', [], macVerified(said));
});
ipcMain.on('brain-reset', () => resetBrain());

ipcMain.on('window-hide', () => hideWindow());
ipcMain.on('window-fullscreen', () => toggleFullScreen());
ipcMain.on('window-pin', (_e, pinned) => { if (surface.name === 'window') win.setAlwaysOnTop(pinned, 'floating'); });
ipcMain.on('surface-interactive', (_e, on) => surface.setInteractive(Boolean(on)));
ipcMain.handle('surface-state', () => ({ name: surface.name, ...(wallpaper?.mainState() || {}) }));
// Development only: inject what the listener heard (a test can't share the mic with the installed ARES)
ipcMain.on('test-hear', (_e, evt) => { if (!app.isPackaged) listener.emit('event', evt); });
ipcMain.handle('test-desk', (_e, patch) => {
  if (app.isPackaged) return null;
  if (patch?.mic) desk.setMic(patch.mic);
  if (patch?.idleMin) desk.set({ idleMin: patch.idleMin });
  return { desk: desk.state, awake: listener.awake, manualAwake, talk };
});
// Development only: drive the surfaces from a test (⌥Space belongs to the installed ARES)
ipcMain.on('test-surface', (_e, what) => {
  if (app.isPackaged) return;
  if (what === 'show') showWindow(); else if (what === 'window') surface.window(); else hideWindow();
});
/** Full screen is the window's: from the desktop or lifted, it opens as a window first. */
function toggleFullScreen() {
  if (surface.name !== 'window') { surface.window(); setTimeout(() => win.setFullScreen(true), 80); return; }
  if (!win.isVisible()) showWindow();
  win.setFullScreen(!win.isFullScreen());
}

// ---- Work mode: background jobs (jobs.js) --------------------------------------------------------
// The brain hands real jobs to a separate full-strength Claude Code worker (start_job) and stays free to
// chat. Workers only get their own MCP server (tools/work.js: the gate), never ARES's Mac tools.
let workBlocker = null; // keeps the Mac awake while any job is running, so jobs started from the phone finish
let egress = null;      // the worker browsers' proxy: public internet only (egress.js)

/** Copy the document skills (docx, pdf, pptx, xlsx) from Claude Code's synced skills into a worker-only plugin. */
function syncWorkerSkills(runtime) {
  const plugin = path.join(runtime, 'plugin');
  try {
    const synced = path.join(os.homedir(), '.claude', 'skills', 'synced');
    const sources = fs.readdirSync(synced).map((d) => path.join(synced, d)).filter((d) => fs.existsSync(path.join(d, 'docx', 'SKILL.md')))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (!sources.length) return;
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ares-worker', version: '1.0.0', description: 'Document skills for ARES work-mode workers' }));
    for (const name of ['docx', 'pdf', 'pptx', 'xlsx']) {
      const from = path.join(sources[0], name);
      if (!fs.existsSync(path.join(from, 'SKILL.md'))) continue;
      fs.rmSync(path.join(plugin, 'skills', name), { recursive: true, force: true });
      fs.cpSync(from, path.join(plugin, 'skills', name), { recursive: true, dereference: true });
    }
  } catch (err) { log('worker skills sync failed', err.message); }
}

async function startWork() {
  const workDir = path.join(app.getPath('userData'), 'work');
  const runtime = path.join(workDir, '.runtime');
  syncWorkerSkills(runtime);
  egress = await startEgress({ log });
  jobs = new Jobs({
    dir: workDir,
    cli: claude.CLI,
    log,
    runtime,
    tools: () => workerTools({ env: process.env, appDir: __dirname, runtime, bridge, egress: () => egress.url }),
  });
  workFiles.install({ jobs, log });
  const lastStatus = new Map();
  jobs.on('change', (job) => {
    win?.webContents.send('job-change', job);
    wallpaper?.jobs(jobs.list());
    phone?.broadcast({ type: 'job', job });
    // Answered (on the Mac, by voice or from the phone): the "needs your OK" notification is out of date
    if (lastStatus.get(job.id) === 'approval' && job.status !== 'approval') clearPhoneNotes([`job-${job.id}-ok`]);
    lastStatus.set(job.id, job.status);
    refreshTray();
  });
  jobs.on('event', (id, evt) => { win?.webContents.send('job-event', id, evt); phone?.broadcast({ type: 'job-event', id, evt }); });
  jobs.on('removed', (id) => { wallpaper?.jobs(jobs.list()); win?.webContents.send('job-removed', id); phone?.broadcast({ type: 'job-removed', id }); refreshTray(); });
  // Opened on one device, seen on the other: the Mac's badge clears (job-change), and so do the phone's notifications
  jobs.on('seen', (job) => clearPhoneNotes([`job-${job.id}`, `job-${job.id}-ok`]));
  jobs.on('busy', (busy) => {
    if (busy && workBlocker == null) workBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && workBlocker != null) { powerSaveBlocker.stop(workBlocker); workBlocker = null; }
  });
  jobs.on('finished', (job) => notifyJob(job, 'done'));
  // "Send to Mac" from the phone while away: it opens as soon as they're back
  powerMonitor.on('unlock-screen', () => setTimeout(macPresent, 1500));
  powerMonitor.on('user-did-become-active', () => setTimeout(macPresent, 1500));
  jobs.on('approval', (job) => notifyJob(job, 'approval'));
  jobs.pump(); // jobs left over from last time (queued, or running when ARES quit)
}

/** Is the user at the Mac right now? Active in the last ~2 minutes and the screen isn't locked. */
const atMac = () => powerMonitor.getSystemIdleState(120) === 'active';
// Sentences end at . ! ? followed by a space or the end (so 13.5 kWh and 3.2 kVA stay whole)
const firstSentences = (t, n = 2) => (t.match(/.+?[.!?]+(?=\s|$)/g) || [t]).slice(0, n).join(' ').replace(/\s+/g, ' ').trim();

/** A job finished, or needs a yes: say it out loud if they're here, otherwise push it to the phone. */
function notifyJob(job, kind) {
  const here = atMac();
  const phoneToo = !here || readSettings().workAlwaysPhone || job.source === 'phone';
  log('job notify', { id: job.id, kind, here, phoneToo });
  if (kind === 'done' || kind === 'failed') {
    const line = job.status === 'done'
      ? `Your ${job.title} job is done. ${firstSentences(job.summary || '')}`
      : `Sorry, sir, the ${job.title} job didn't finish: ${job.error}.`;
    if (here) { present(); win.webContents.send('job-announce', { id: job.id, kind: job.status, line, open: job.status === 'done' }); }
    if (phoneToo) pushToPhones({ title: job.status === 'done' ? `Done: ${job.title}` : `Job failed: ${job.title}`, body: job.status === 'done' ? job.summary || 'Ready.' : job.error, tag: `job-${job.id}`, job: job.id, buttons: jobButtons(job) }).catch(() => {});
  } else {
    const line = `The ${job.title} job needs your OK, sir: ${job.approval.what}. Shall I let it?`;
    if (here) { present(); win.webContents.send('job-announce', { id: job.id, kind: 'approval', line, open: true }); }
    if (phoneToo) {
      // The tap is the confirmation (a paired phone, and only for this exact request); `ask` is for older apps
      const answer = (yes) => ({ title: yes ? 'Yes' : 'No', api: `/api/jobs/${job.id}/answer`, body: { yes, at: job.approval.at },
        ask: yes ? `Yes, approve what the ${job.title} job is asking.` : `No, don't let the ${job.title} job do that.` });
      pushToPhones({ title: `Needs your OK: ${job.title}`, body: job.approval.what, tag: `job-${job.id}-ok`, job: job.id, buttons: [answer(true), answer(false)] }).catch(() => {});
    }
  }
}

/** Open / Send to Mac, for a job's notification on the phone. */
function jobButtons(job) {
  return [
    { title: 'Open', job: job.id, url: `${phoneUrl || ''}/?job=${job.id}` },
    { title: 'Send to Mac', api: `/api/jobs/${job.id}/send-to-mac`, ask: `Open the ${job.title} job on my Mac.` },
  ];
}

/** "Send this to my phone": the job arrives on the phone with an Open button (and opens there if the app is up). */
async function sendJobToPhone(id) {
  const job = jobs.get(id);
  if (!job) return { error: 'no such job' };
  phone?.broadcast({ type: 'show-job', id });
  const sent = await pushToPhones({ title: `From your Mac: ${job.title}`, body: job.summary || STATUS_WORDS[job.status] || 'Open it on your phone.', tag: `job-${id}`, job: id, buttons: [jobButtons(job)[0]] });
  const open = phone?.listeners.size || 0; // an app open right now gets it live
  log('job to phone', { id, sent, open });
  return sent || open ? { ok: true } : { error: "The phone app isn't set up for notifications yet." };
}
const STATUS_WORDS = { queued: 'Queued.', running: 'Still working on it.', approval: 'Waiting for your OK.', failed: 'It failed.', cancelled: 'Cancelled.' };

/** "Send to Mac": open the job on the Mac now if they're there, otherwise the next time they are. */
let macPending = null;
function sendJobToMac(id) {
  if (!jobs.get(id)) return { error: 'no such job' };
  if (atMac()) { macPending = null; showWindow(); win.webContents.send('job-show', id); log('job to mac', { id, now: true }); return { ok: true, now: true }; }
  macPending = id;
  log('job to mac', { id, now: false });
  return { ok: true, now: false };
}
function macPresent() {
  if (!macPending || !atMac()) return;
  const id = macPending;
  macPending = null;
  if (!jobs.get(id)) return;
  showWindow();
  win.webContents.send('job-show', id);
  log('job to mac shown', { id });
}
setInterval(macPresent, 15_000).unref();

/** A job's title from what was typed on the phone: "Summary: report.pdf", or the first few words of the ask. */
function phoneJobTitle(text, files, link) {
  const said = text.split('\n\n(Shared from')[0].replace(JOB_PHRASE, '').replace(/^(please |can you |could you |ares,? )+/i, '').trim();
  const name = files[0] ? path.basename(files[0]) : link ? (() => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '';
  if (name) {
    if (/^(summari[sz]e|sum up|tl;?dr|give me the key points|read this|what does this say)/i.test(said)) return `Summary: ${name}`.slice(0, 60);
    if (/\b(slides?|deck|presentation)\b/i.test(said)) return `Slides: ${name}`.slice(0, 60);
  }
  const words = said.split(/[.!?](?=\s|$)|\n/)[0].trim().split(/\s+/).filter(Boolean).slice(0, 6);
  while (words.length > 2 && /^(a|an|the|of|in|on|to|for|and|with|about|into|my|this|that|three|short)$/i.test(words[words.length - 1])) words.pop();
  let t = words.join(' ').replace(/[,;:]+$/, '');
  if (name && words.length <= 3) t = `${t || 'Look at'}: ${name}`;
  t = t || name || 'Phone job';
  return (t[0].toUpperCase() + t.slice(1)).slice(0, 60);
}

/** The phone's Work view (phone.js): the same jobs as the Mac panel, from a paired phone (so, the owner). */
function phoneWork() {
  const tryJob = (fn) => { try { const j = fn(); return { job: j && jobs.view(j) }; } catch (err) { return { error: err.message }; } };
  return {
    get: (id) => jobs.get(id),
    list: () => jobs.list(),
    gallery: () => jobs.gallery(),
    search: (q) => jobs.search(q),
    detail: (id) => ({ job: jobs.view(jobs.get(id)), events: jobs.events(id).slice(-300), result: jobs.result(id), files: jobs.files(id), credits: jobs.credits(id), versions: jobs.versions(id) }),
    version: (id, n) => jobs.version(id, n),
    file: (id, rel) => workFiles.resolveJobFile(jobs, id, rel),
    preview: (id, rel) => workFiles.preview(jobs, id, rel),
    start({ text, title, link, files = [] }) {
      const url = typeof link === 'string' && /^https?:\/\//i.test(link) ? link.slice(0, 2000) : '';
      const task = `${text.trim()}${url && !text.includes(url) ? `\n\nLink shared from the phone: ${url}` : ''}`;
      const job = jobs.start({ title: String(title || '').trim().slice(0, 80) || phoneJobTitle(text, files, url), task, size: 'medium', source: 'phone', inputs: files });
      return jobs.view(job);
    },
    continue: (id, text, files = []) => tryJob(() => jobs.continue(id, text, 'phone', files)),
    answer(id, yes, at, device) {
      const j = jobs.get(id);
      if (j.status !== 'approval' || !j.approval) return { error: 'Nothing is waiting for your OK on that job any more.' };
      if (Number(at) !== j.approval.at) return { error: 'That request has changed. Open the job to see what it is asking now.' };
      jobs.answer(id, yes);
      log('job answer phone', { id, yes, device });
      return { job: jobs.view(j) };
    },
    cancel: (id) => (jobs.cancel(id) ? {} : { error: "It isn't running." }),
    dismiss: (id) => (jobs.dismiss(id) ? {} : { error: "Only finished jobs can be put away (and this one already is)." }),
    seen(id, device) { const was = jobs.get(id).seen; jobs.markSeen(id); if (!was) log('job seen', { id, on: device }); return {}; },
    sendToMac: (id) => sendJobToMac(id),
  };
}

const describeJob = (j) => `${j.title} [${j.id}]: ${{ queued: 'queued', running: `working (${j.steps} steps so far)`, approval: `waiting for the user's OK to ${j.approval?.what}`, done: 'done', failed: `failed (${j.error})`, cancelled: 'cancelled' }[j.status]}${j.status === 'done' && j.summary ? ` — ${j.summary}` : ''}`;
function workControls() {
  const needOwner = { message: "Refused: starting or changing a job needs the owner, and this request wasn't verified (Voice ID is off, or the voice didn't match). Tell the user briefly: they can type it, use push-to-talk, or turn Voice ID on." };
  const pick = (ref) => {
    const job = jobs.find(ref);
    if (!job) throw new Error(`no job matching "${ref}"`);
    return job;
  };
  return {
    start({ title, task, size }, { source, verified }) {
      if (!verified) { log('job refused', { source }); return needOwner; }
      const job = jobs.start({ title, task, size, source });
      const ahead = jobs.running.includes(job) ? '' : ' It is queued behind the jobs already running.';
      return { message: `Job "${job.title}" started [${job.id}].${ahead} A worker is doing it in the background and the app will tell the user when it's ready. Don't do the job yourself: just tell the user, briefly, that you're on it.` };
    },
    list() {
      const recent = jobs.list().slice(-8);
      return { message: recent.length ? recent.map(describeJob).join('\n') : 'No jobs yet.' };
    },
    cancel({ job }) {
      const j = pick(job);
      return { message: jobs.cancel(j.id) ? `Cancelled "${j.title}".` : `"${j.title}" isn't running.` };
    },
    continue({ job, instruction }, { source, verified }) {
      if (!verified) return needOwner;
      const j = jobs.continue(pick(job).id, instruction, source);
      return { message: `Follow-up sent to "${j.title}". The worker is updating it; the app will say when it's ready.` };
    },
    answer({ job, approve }, { yes }) {
      const j = job ? pick(job) : jobs.waiting[0];
      if (!j || j.status !== 'approval') return { message: 'No job is waiting for an answer.' };
      if (approve && !yes) return { message: "Not confirmed: the user's own words have to be a clear yes. Ask them." };
      jobs.answer(j.id, approve);
      return { message: approve ? `Approved; "${j.title}" carries on.` : `Declined; "${j.title}" will carry on without it.` };
    },
    show({ job, where }, { source }) {
      where = where === 'mac' || where === 'phone' ? where : source === 'mac' ? 'mac' : 'phone';
      const gallery = /^(gallery|all|everything|my work)$/i.test(String(job || '').trim());
      if (where === 'phone') {
        const j = gallery ? null : pick(job);
        if (source === 'phone' && phoneStream) { phoneStream({ type: 'job', id: j?.id ?? null }); return { message: `Showing ${j ? `"${j.title}"` : 'the Work list'} on the phone. Say nothing more than a word or two.` }; }
        if (!j) return { message: 'Open the Work tab in the phone app to see all your jobs.' };
        return sendJobToPhone(j.id).then((r) => ({ message: r.error ? r.error : `Sent "${j.title}" to the phone. Say nothing more than a word or two.` }));
      }
      if (gallery) { showWindow(); win.webContents.send('job-show', null); return { message: 'Showing the Work gallery.' }; }
      const j = pick(job);
      if (source !== 'mac') {
        const r = sendJobToMac(j.id);
        return { message: r.now ? `"${j.title}" is open on the Mac now.` : `"${j.title}" will open on the Mac as soon as the user is back at it.` };
      }
      showWindow();
      win.webContents.send('job-show', j.id);
      return { message: `Showing "${j.title}" in the Work panel. Say nothing more than a word or two.` };
    },
    async sendToPhone({ job }) {
      const j = pick(job);
      const r = await sendJobToPhone(j.id);
      return { message: r.error ? r.error : `Sent "${j.title}" to the user's phone, with an Open button. Say nothing more than a word or two.` };
    },
    gate: (id, tool, input) => jobs.gate(id, tool, input),
    decision: (id) => jobs.decision(id),
  };
}

// The Work panel
ipcMain.handle('jobs-list', () => jobs.list());
ipcMain.handle('job-detail', (_e, id) => jobs.get(id) && ({ job: jobs.view(jobs.get(id)), events: jobs.events(id), result: jobs.result(id), files: jobs.files(id), credits: jobs.credits(id), versions: jobs.versions(id) }));
ipcMain.handle('job-version', (_e, id, n) => jobs.version(id, n));
ipcMain.handle('jobs-gallery', () => jobs.gallery());
ipcMain.handle('jobs-search', (_e, q) => jobs.search(q));
// Files dropped on the window: a new job with them, or a follow-up on an open one. Dropping is physical, at
// the Mac; if the instruction was spoken, Voice ID still has to vouch for it like any other job.
ipcMain.handle('job-with-files', (_e, { instruction, files, jobId, title, spoken }) => {
  try {
    if (spoken && !macVerified(String(spoken))) return { error: "I'd need to be sure it's you: type it, or use push-to-talk." };
    const paths = (files || []).map(String).filter((f) => path.isAbsolute(f));
    if (!paths.length) return { error: 'No files.' };
    if (jobId) {
      const j = jobs.continue(jobId, String(instruction).slice(0, 4000), 'mac', paths);
      return { ok: true, id: j.id, title: j.title };
    }
    const j = jobs.start({ title: String(title || 'Files').slice(0, 80), task: String(instruction).slice(0, 4000), size: 'medium', source: 'mac', inputs: paths });
    log('job files', { id: j.id, count: paths.length });
    return { ok: true, id: j.id, title: j.title };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('job-preview', (_e, id, file) => workFiles.preview(jobs, id, file));
ipcMain.handle('job-save-pdf', async (_e, id) => {
  try {
    const file = await workFiles.saveAsPdf(jobs, id, path.join(__dirname, 'preload.js'));
    log('job pdf saved', { id });
    shell.showItemInFolder(file);
    return { file: path.basename(file) };
  } catch (err) { return { error: err.message }; }
});
// A follow-up typed in the panel: a click at the Mac, so it's the owner
ipcMain.handle('job-continue', (_e, id, text) => {
  try { jobs.continue(id, String(text).slice(0, 4000), 'mac'); return { ok: true }; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('job-cancel', (_e, id) => jobs.cancel(id));
ipcMain.handle('job-answer', (_e, id, yes) => jobs.answer(id, Boolean(yes))); // a click in the panel: the owner is here
ipcMain.handle('job-seen', (_e, id) => jobs.markSeen(id));
ipcMain.handle('job-send-phone', (_e, id) => sendJobToPhone(id));
ipcMain.handle('job-dismiss', (_e, id) => jobs.dismiss(id));
// Delete a finished job: asks first, and its folder goes to the Trash (recoverable), not gone for good
ipcMain.handle('job-delete', async (_e, id) => {
  const job = jobs.get(id);
  if (!job) return { error: 'no such job' };
  if (jobs.active.includes(job)) return { error: 'It is still in progress. Cancel it first.' };
  const { dialog } = require('electron');
  const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Move to Trash', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Delete "${job.title}"?`, detail: 'The job, its result and all its files go to the Trash. You can put them back from there until you empty it.' });
  if (response !== 0) return { cancelled: true };
  try {
    if (fs.existsSync(jobs.folder(id))) await shell.trashItem(jobs.folder(id));
    jobs.remove(id);
    log('job deleted', { id });
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('ui-prefs', () => uiPrefs());
// Where the user left each dashboard panel (renderer/dash.js), and the dashboard's current data
ipcMain.on('ui-panels', (_e, panels) => { if (panels && typeof panels === 'object') writeUi({ [panelsKey()]: panels }); });
ipcMain.handle('dash-state', () => ({ ...(dashboard?.snapshot() || {}), timers: bridge?.timers() || [], call: liveCall() }));
ipcMain.handle('dash-city', (_e, city) => {
  city = String(city || '').trim().slice(0, 80);
  writeSettings({ weatherCity: city || undefined });
  dashboard?.setCity(city);
  return city;
});
ipcMain.handle('dash-home', (_e, address) => {
  address = String(address || '').trim().slice(0, 200);
  writeSettings({ homeAddress: address || undefined });
  dashboard?.updateLeave(true);
  return address;
});
// Click for details (renderer/dash.js): what the detail cards can do directly. These only touch ARES's own state
// (timers, music, memory, files on this Mac) or open a page; anything that sends or changes something elsewhere
// (texting, calling back, drafting a reply) goes through a normal turn, so the brain's "yes" gate applies.
ipcMain.handle('dash-act', async (_e, action, arg = {}) => {
  switch (action) {
    case 'timer': return bridge?.timerAction(String(arg.label), arg.op, 300) || false;
    case 'remind': bridge?.remind(String(arg.label || 'reminder').slice(0, 60), Number(arg.seconds) || 600); return true;
    case 'music': return dashboard?.musicControl(arg.op) || false;
    case 'url': {
      try {
        const u = new URL(arg.url);
        if (u.protocol === 'https:') { await shell.openExternal(u.href); return true; }
      } catch {}
      return false;
    }
    case 'memory-forget': {
      const facts = memory.facts();
      if (!facts.includes(arg.fact)) return false;
      memory.save(facts.filter((f) => f !== arg.fact));
      log('memory forget', { removed: 1, from: 'dashboard' });
      return true;
    }
    case 'memory-edit': {
      const fact = String(arg.fact || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const facts = memory.facts();
      const i = facts.indexOf(arg.old);
      if (i < 0 || !fact) return false;
      facts[i] = fact;
      memory.save(facts);
      log('memory edit', { from: 'dashboard' });
      return fact;
    }
    case 'call-details': return calls?.details(String(arg.id)) || null;
    case 'call-transcript': {
      const file = calls?.transcriptFile(String(arg.id));
      if (file) await shell.openPath(file);
      return Boolean(file);
    }
    case 'emails': return dashboard?.refreshInbox('asked').then(() => dashboard.inbox);
    case 'fix': {
      // Status pill: one click toward fixing what's broken
      if (arg.key === 'claude') {
        require('child_process').execFile('/usr/bin/osascript', ['-e', 'tell application "Terminal"\nactivate\ndo script "claude"\nend tell']);
        return true;
      }
      const panes = { mic: 'Privacy_Microphone', speech: 'Privacy_SpeechRecognition' };
      if (panes[arg.key]) { await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[arg.key]}`); return true; }
      if (arg.key === 'voice') { shell.showItemInFolder(path.join(app.getPath('userData'), '.env')); return true; }
      if (arg.key === 'recheck') { checkIntegrations(); return true; }
      return false;
    }
  }
  return false;
});
ipcMain.handle('job-open', (_e, id, file) => {
  const target = file ? workFiles.resolveJobFile(jobs, id, file) : jobs.get(id) && jobs.folder(id);
  if (!target) return false;
  return shell.openPath(target).then((err) => !err);
});
ipcMain.handle('open-external', (_e, url) => {
  try { if (/^https?:$/.test(new URL(url).protocol)) return shell.openExternal(url).then(() => true); } catch {}
  return false;
});

// ---- Phone calls (calls.js) ----------------------------------------------------------------------
// Results of calls ARES placed, messages taken on the line, and the "while you were away" digest. Spoken on the Mac
// when the user is at it; inbound call summaries always go to the phone too (the phone is where calls matter).
const callNotes = []; // what the brain should know it just told the user (so "great, add it to my calendar" works)
function createCalls() {
  const c = new Calls({
    dir: path.join(app.getPath('userData'), 'calls'),
    log,
    cli: claude.CLI,
    contactByNumber: (n) => contacts?.byNumber(n)?.name || '',
    delivered: (ids) => relay.delivered(ids),
    phrase: (prompt) => claude.oneShot(prompt, { model: 'haiku', timeoutMs: 60_000, system: 'You are ARES, a personal assistant, reporting back briefly and naturally.' }),
  });
  const tell = (line, source = 'calls') => {
    callNotes.push(line);
    if (callNotes.length > 10) callNotes.shift();
    remember('ares', line, source);
    present();
    win.webContents.send('job-announce', { line, open: false, remembered: true });
  };
  const buttons = (num) => (num ? [{ title: 'Call back', url: `tel:${num}` }, { title: 'Text', url: `sms:${num}` }] : []);
  c.on('result', ({ call, line }) => {
    toDash({ type: 'call-done', name: call.name, line, id: call.id });
    const here = atMac();
    log('call result', { id: call.id, here });
    if (here) tell(line);
    else callNotes.push(line);
    if (!here || call.source === 'phone' || call.source === 'telegram' || readSettings().workAlwaysPhone) {
      pushToPhones({ title: `Call to ${call.name}`, body: line, tag: `call-${call.id}`,
        buttons: [{ title: 'Details', ask: `What happened on the call to ${call.name}?` }] }).catch(() => {});
    }
  });
  c.on('change', () => phone?.broadcast({ type: 'calls' }));
  c.on('live', () => toDash({ type: 'call', call: liveCall() }));
  c.on('inbound', ({ call, title, body, line, callback, pushed }) => {
    const here = atMac();
    log('call inbound', { id: call.id, urgent: call.urgent, spam: call.spam, here, pushed });
    if (!call.spam && line) toDash({ type: 'inbox', id: `call-${call.id}`, label: call.urgent ? 'URGENT CALL' : 'MESSAGE', value: title || 'Missed call', detail: line });
    if (!pushed && (!call.spam || !here)) pushToPhones({ title, body, tag: `call-${call.id}`, buttons: buttons(callback) }).catch(() => {});
    if (here && line) tell(line);
    else if (line) callNotes.push(line);
  });
  c.on('digest', ({ title, body, line, callback, pushed }) => {
    const here = atMac();
    log('call digest', { here, pushed });
    if (!pushed) pushToPhones({ title, body, tag: 'calls-digest', buttons: buttons(callback) }).catch(() => {});
    if (here) tell(line);
    else callNotes.push(line);
  });
  // Asleep: the phone line carries on alone, so give it the rest of today's availability first. Awake: catch up.
  powerMonitor.on('suspend', () => c.syncContext('suspend'));
  powerMonitor.on('resume', () => setTimeout(() => { c.catchUp('resume'); c.refreshContext('resume'); voicemail?.check('resume'); }, 8000));
  // Voicemails left on the Twilio fallback, reported like missed calls (and part of the catch-up on wake)
  voicemail = new Voicemail({ dir: path.join(app.getPath('userData'), 'calls'), log, number: () => process.env.ARES_LINE_NUMBER || c.ownNumber || '',
    transcribe: (audio, type) => transcribe(audio, type), contactByNumber: (n) => contacts?.byNumber(n)?.name || '' });
  voicemail.on('voicemail', ({ from, title, body, line, name }) => {
    toDash({ type: 'inbox', id: `vm-${Date.now()}`, label: 'VOICEMAIL', value: title, detail: body });
    pushToPhones({ title, body, tag: `vm-${from || name}`, buttons: buttons(from) }).catch(() => {});
    if (atMac()) tell(line);
    else callNotes.push(line);
  });
  return c;
}

// ---- Dashboard: the thought ticker ------------------------------------------------------------------
// What the brain is doing right now, in a few words, from the tools it reaches for.
function toolActivity(name) {
  const [, server = '', tool = name] = name.match(/^mcp__(.+?)__(.+)$/) || [];
  const writes = /^(create|update|delete|respond|send|modify|move)/.test(tool);
  if (/Calendar/.test(server)) {
    if (writes) setTimeout(() => dashboard?.refreshCalendar('changed'), 15_000); // the NEXT panel follows the change
    return writes ? 'updating your calendar…' : 'checking your calendar…';
  }
  if (/Gmail/.test(server)) return writes ? 'drafting an email…' : 'looking through your email…';
  if (/Drive/.test(server)) return 'searching your Drive…';
  if (name === 'WebSearch') return 'searching the web…';
  if (name === 'WebFetch') return 'reading a web page…';
  const own = {
    media_control: 'working the music…', set_volume: 'adjusting the volume…', open_app: 'opening an app…',
    set_timer: 'setting a timer…', list_timers: 'checking your timers…', cancel_timer: 'cancelling a timer…',
    open_url: 'opening a link…', quit_app: 'closing an app…', create_reminder: 'adding a reminder…', create_note: 'writing a note…',
    lock_screen: 'locking the screen…', battery_status: 'checking the battery…',
    remember: 'making a note…', recall_memory: 'searching my memory…', forget: 'forgetting that…', teach_phrase: 'learning that phrase…',
    start_job: 'starting a job…', list_jobs: 'checking on your jobs…', show_job: 'pulling up a job…', continue_job: 'following up on a job…',
    cancel_job: 'cancelling a job…', answer_job_approval: 'passing on your answer…', send_job_to_phone: 'sending that to your phone…',
    make_call: 'placing a call…', list_calls: 'checking your calls…', call_status: 'checking on a call…',
    find_contact: 'looking up a contact…', notify_phone: 'pinging your phone…', phone_action: 'sending that to your phone…',
  };
  return own[tool] || (server === 'ares' ? `${tool.replace(/_/g, ' ')}…` : 'working on it…');
}
claude.onTool((name) => toDash({ type: 'activity', text: toolActivity(name) }));

/** The phone call happening right now (one ARES placed), for the dashboard's CALL panel. */
function liveCall() {
  if (!calls?.live?.size) return null;
  const id = [...calls.live.keys()].pop();
  const rec = calls.calls.find((c) => c.id === id);
  return { live: true, id, name: rec?.name || 'Call', since: rec?.at || Date.now() };
}

// ---- Voice: Katherine, the backup voice, budget mode and the credit watch (voice.js) ------------------------
function createSpeech() {
  const v = new Voice({
    dir: app.getPath('userData'), log, settings: readSettings, saveSettings: writeSettings, devBuild: !app.isPackaged,
    eleven: { key: ELEVEN.key, voice: ELEVEN.voice, model: ELEVEN.model, speed: ELEVEN.speed, settings: voiceSettings },
  });
  v.on('state', () => { refreshTray(); pushVoiceStatus(); });
  // Once per outage: the status pill, the menu bar, and a short spoken note when she's next free
  v.on('down', ({ reason, note }) => {
    log('voice backup on', { reason });
    if (!win || win.isDestroyed()) return;
    if (atMac()) win.webContents.send('job-announce', { line: note, open: false });
    else notice(note);
  });
  v.on('restored', () => { log('voice backup off'); notice("Katherine's voice is back."); });
  v.on('warn', ({ level, remaining, reset }) => {
    const left = `${Math.round(remaining / 1000)}k credits left${reset ? `, reset ${new Date(reset).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}`;
    log('voice credits warning', { level, remaining });
    notice(`ElevenLabs credits ${level}% used: ${left}.`);
    pushToPhones({ title: `ElevenLabs credits ${level}% used`, body: `${left}. Budget voice is ${v.budgetMode === 'off' ? 'off' : 'covering fillers'}.`, tag: `credits-${level}` }).catch(() => {});
  });
  return v;
}

/** Status pill + the status panel's voice line in the window. */
function pushVoiceStatus() {
  if (!speech) return;
  const s = speech.status();
  toDash({ type: 'health', key: 'voice', ok: !s.backup, reason: s.backup ? `backup voice: ${s.reason}` : '' });
  const c = s.credits;
  toDash({ type: 'health', key: 'credits', ok: !(c.known && c.pct >= 0.8), reason: c.known ? `credits ${Math.round(c.pct * 100)}% used` : '' });
  toDash({ type: 'voice', line: voiceLine(s), credits: creditLine(s) });
}
function creditLine(s) {
  const c = s.credits;
  if (c.known) return `${Math.round(c.remaining / 1000)}k credits left · resets ${new Date(c.reset).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  return c.access === 'no-permission' ? `credits unknown (key needs user_read) · ARES sent ~${Math.round(c.aresSent / 1000)}k this month` : `ARES sent ~${Math.round(c.aresSent / 1000)}k credits this month`;
}
function voiceLine(s) {
  if (s.backup) return `Backup voice (${s.reason}) until ${s.retryAt ? new Date(s.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'later'}`;
  if (s.dev) return 'Backup voice: building/testing mode';
  if (s.reserve) return 'Backup voice: saving credits for phone calls';
  if (s.budgetActive) return s.budget === 'auto' ? 'Budget voice: AUTO is on (credits low)' : 'Budget voice: always on';
  return `Voice: Katherine${s.budget === 'off' ? '' : ` · budget ${s.budget}`}`;
}

/** "budget mode on/off/auto", from the Mac, the phone or Telegram. */
function budgetCommand(raw) {
  const text = raw.trim().replace(/[.!?]+$/, '').toLowerCase();
  const m = text.match(/^(?:please\s+)?(?:(?:turn|switch|put|set)\s+)?(?:the\s+)?budget(?:\s+voice)?(?:\s+mode)?(?:\s+(?:to|on to))?\s+(on|off|auto(?:matic)?|always)(?:\s+mode)?$/)
    || text.match(/^(?:please\s+)?(?:turn|switch)\s+(on|off)\s+(?:the\s+)?budget(?:\s+voice)?(?:\s+mode)?$/);
  if (!m || !speech) return null;
  const mode = m[1] === 'on' ? 'always' : m[1].startsWith('auto') ? 'auto' : m[1];
  speech.setBudget(mode);
  return mode === 'always' ? "Budget voice on, sir. Small talk in my backup voice, answers in my usual one."
    : mode === 'off' ? "Budget voice off. All Katherine, all the time."
    : "Budget voice on auto. I'll economise when the credits run low.";
}

// ---- Startup -------------------------------------------------------------------------
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  log('ARES starting', { version: app.getVersion(), packaged: app.isPackaged });

  // Tools: ARES's own MCP server (Mac controls, timers, confirmation gate), reached over a local bridge
  contacts = new Contacts(path.join(app.getPath('userData'), 'contacts.json'));
  memory = new Memory(path.join(app.getPath('userData'), 'memory.md'));
  const addFact = memory.add.bind(memory);
  memory.add = (fact) => { const saved = addFact(fact); toDash({ type: 'memory', fact: saved }); return saved; }; // the REMEMBERED flash
  dashboard = new Dashboard({ log, cli: claude.CLI, dir: path.join(app.getPath('userData'), 'dashboard'), settings: readSettings, country: app.getLocaleCountryCode() });
  dashboard.on('update', toDash);
  speech = createSpeech();
  speech.start();
  relay = new Relay({ log, firebaseFile: path.join(app.getPath('userData'), 'google-services.json') });
  calls = createCalls();
  bridge = await startBridge({
    log,
    memory,
    teachPhrase: ({ phrase, meaning }) => learnPhrase(phrase, meaning, 'corrected in conversation'),
    findContact: (name) => {
      const hits = contacts.find(name);
      log('contacts find', { hits: hits.length });
      if (!contacts.count) return { message: 'No contacts imported yet. The user can import a vCard from the ARES menu (Import Contacts…).' };
      if (!hits.length) return { message: `No contact matching "${name}".` };
      return { message: hits.map((c) => [c.name + (c.nickname ? ` (${c.nickname})` : '') + (c.org ? `, ${c.org}` : ''),
        ...c.phones.map((p) => `  phone${p.type ? ` (${p.type})` : ''}: ${p.number}`),
        ...c.emails.map((e) => `  email: ${e}`)].join('\n')).join('\n') };
    },
    onPhoneAction,
    onNotify,
    work: workControls(),
    calls,
    onTimers: (list) => toDash({ type: 'timers', timers: list }),
    onTimerDone: (label, source) => {
      log('timer done', { label, source });
      if (source === 'phone') {
        const name = label && label !== 'timer' ? `Your ${label} timer` : 'Your timer';
        return pushToPhones({ title: 'Timer done', body: `${name} is done, sir.`, tag: `timer-${label}`,
          buttons: [{ title: '+5 min', ask: `Set a 5 minute timer called ${label}` }] });
      }
      present();
      win.webContents.send('timer-done', label);
    },
  });
  const mcpConfigPath = path.join(app.getPath('userData'), 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      ares: {
        command: process.execPath,
        args: [path.join(__dirname, 'tools', 'mac.js')],
        env: { ELECTRON_RUN_AS_NODE: '1', ARES_BRIDGE: bridge.url, ARES_TOKEN: bridge.token },
      },
    },
  }), { mode: 0o600 });
  claude.init(path.join(app.getPath('userData'), 'workspace'), { mcpConfigPath, memory: () => memory.facts() }); // isolated dir: no project files or CLAUDE.md
  await startWork();

  // First run of the installed app: start at login by default (can be switched off in the menu bar).
  if (app.isPackaged && readSettings().launchAtLogin === undefined) setLaunchAtLogin(true);
  const openedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;

  voiceId = new VoiceId({
    modelPath: app.isPackaged
      ? path.join(process.resourcesPath, 'speaker-titanet-small.onnx')
      : path.join(__dirname, 'models', 'speaker-titanet-small.onnx'),
    profilePath: path.join(app.getPath('userData'), 'voiceprint.json'),
    logPath: path.join(app.getPath('userData'), 'voiceid-log.jsonl'),
    threshold: Number(process.env.ARES_VOICE_THRESHOLD) || null,
  });
  intents = new Intents({
    modelDir: app.isPackaged ? path.join(process.resourcesPath, 'intent') : path.join(__dirname, 'models', 'intent'),
    dataDir: path.join(app.getPath('userData'), 'intents'),
    log,
  });
  intents.init().then(refreshTray, (err) => log('intent unavailable', err.message)); // until then, everything is chat
  createListener();
  wallpaper = new Wallpaper({
    log, readSettings, writeSettings, appDir: __dirname, supportDir: app.getPath('userData'), prefs: uiPrefs,
    helper: app.isPackaged ? path.join(process.resourcesPath, 'ares-desktop') : path.join(__dirname, 'native', 'build', 'ares-desktop'),
  });
  wallpaper.start();
  if (!app.isPackaged && process.env.ARES_TEST_STILL) { // development: render the lock-screen still to a file, without setting it
    const { screen } = require('electron');
    for (const tint of [false, true]) {
      wallpaper.renderStill(screen.getPrimaryDisplay(), tint).then((png) => { if (png) fs.writeFileSync(`${process.env.ARES_TEST_STILL}-${tint ? 'evening' : 'day'}.png`, png); log('test still', { tint, bytes: png?.length }); });
    }
  }
  wallpaper.jobs(jobs.list());
  createDesk();
  createWindow({ show: !openedAtLogin }); // at login, wait quietly in the menu bar
  createTray();
  // First run with the wallpaper on: ask (once) about the ARES lock-screen picture
  if (wallpaper.opts.enabled && !wallpaper.opts.lockAsked && (app.isPackaged || process.env.ARES_ASK_LOCK)) setTimeout(() => wallpaper.setLockStill(true).then(refreshTray), 8000);
  win.webContents.once('did-finish-load', () => {
    listener.start(); checkIntegrations(); startRemote(); startPhone(); calls.start().catch((err) => log('calls start failed', err.message));
    voicemail.start();
    dashboard.start();
    dashboard.setVisible(win.isVisible());
    pushVoiceStatus();
  });
  globalShortcut.register(HOTKEY, toggleWindow);
  app.on('activate', () => showWindow());
});

let memorySavedOnQuit = false;
app.on('before-quit', (e) => {
  app.isQuitting = true;
  if (memorySavedOnQuit || !unsavedTurns().length) return;
  // Save this conversation to memory first (at most ~25s), then quit for real
  e.preventDefault();
  memorySavedOnQuit = true;
  log('memory save before quit');
  Promise.race([consolidateMemory('quit'), new Promise((r) => setTimeout(r, 25_000))]).finally(() => app.quit());
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  listener?.stop();
  remote?.stop();
  phone?.stop();
  intents?.dispose();
  jobs?.shutdown();
  calls?.stop();
  voicemail?.stop();
  dashboard?.stop();
  wallpaper?.stop();
  desk?.stop();
  speech?.stop();
  egress?.close();
  claude.shutdown();
});
