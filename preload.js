const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ares', {
  systemStats: () => ipcRenderer.invoke('system-stats'),
  ttsAvailable: () => ipcRenderer.invoke('tts-available'),
  // Streams one utterance: onChunk(Uint8Array) per audio chunk, then onEnd(errorOrNull)
  ttsStream: (text, onChunk, onEnd) => {
    const id = Math.random().toString(36).slice(2);
    const chunk = (_e, cid, data) => { if (cid === id) onChunk(data); };
    const end = (_e, cid, err) => {
      if (cid !== id) return;
      ipcRenderer.removeListener('tts-chunk', chunk);
      ipcRenderer.removeListener('tts-end', end);
      onEnd(err);
    };
    ipcRenderer.on('tts-chunk', chunk);
    ipcRenderer.on('tts-end', end);
    ipcRenderer.send('tts-stream', id, text, false);
    return id;
  },
  ttsWindowDone: (id, stopped) => ipcRenderer.send('tts-window-done', id, stopped),
  // Native playback through the listener (echo-cancelled, interruptible). Resolves when she has
  // finished saying it: { ok }, { stopped } when cut off, or { error }. native:false => play it here instead.
  ttsPlay: (text) => new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      ipcRenderer.removeListener('tts-played', played);
      ipcRenderer.removeListener('tts-end', ended);
      ipcRenderer.removeListener('tts-native-off', off);
      resolve(r);
    };
    const played = (_e, cid, why) => { if (cid === id) done(why ? { stopped: true } : { ok: true }); };
    const ended = (_e, cid, err) => { if (cid === id && err) done(err === 'cancelled' ? { stopped: true } : { error: err }); };
    const off = (_e, cid) => { if (cid === id) done({ native: false }); };
    ipcRenderer.on('tts-played', played);
    ipcRenderer.on('tts-end', ended);
    ipcRenderer.on('tts-native-off', off);
    ipcRenderer.send('tts-stream', id, text, true);
  }),
  nativePlayback: () => ipcRenderer.invoke('native-playback'),
  bargeCapable: () => ipcRenderer.invoke('barge-capable'),
  replyStart: () => ipcRenderer.send('reply-start'),
  replyDone: (asked) => ipcRenderer.send('reply-done', asked),
  speakingMode: (on) => ipcRenderer.send('listener-speaking', on),
  onBarge: (fn) => ipcRenderer.on('barge', (_e, info) => fn(info)),
  brainAvailable: () => ipcRenderer.invoke('brain-available'),
  planRemark: (text, opts) => ipcRenderer.invoke('remark-plan', text, opts),
  ask: async (text, onDelta) => {
    const listener = (_e, delta) => onDelta(delta);
    ipcRenderer.on('brain-delta', listener);
    try { return await ipcRenderer.invoke('brain-ask', text); }
    finally { ipcRenderer.removeListener('brain-delta', listener); }
  },
  resetBrain: () => ipcRenderer.send('brain-reset'),
  listenerState: () => ipcRenderer.invoke('listener-state'),
  mute: (minutes) => ipcRenderer.send('listener-mute', minutes ?? null),
  unmute: () => ipcRenderer.send('listener-unmute'),
  listen: (ms, trusted = false) => ipcRenderer.send('listener-listen', ms ?? 6000, trusted),
  voiceId: {
    status: () => ipcRenderer.invoke('voiceid-status'),
    start: () => ipcRenderer.invoke('voiceid-start'),
    record: () => ipcRenderer.invoke('voiceid-record'),
    finish: () => ipcRenderer.invoke('voiceid-finish'),
    cancel: () => ipcRenderer.invoke('voiceid-cancel'),
    enable: (on) => ipcRenderer.invoke('voiceid-enable', on),
    onEnrollRequest: (fn) => ipcRenderer.on('voiceid-enroll', fn),
    onChanged: (fn) => ipcRenderer.on('voiceid-changed', (_e, s) => fn(s)),
  },
  setAwake: (on) => ipcRenderer.send('listener-awake', on),
  pauseListening: () => ipcRenderer.send('listener-pause'),
  resumeListening: () => ipcRenderer.send('listener-resume'),
  onListener: (fn) => ipcRenderer.on('listener-event', (_e, evt) => fn(evt)),
  log: (...parts) => ipcRenderer.send('log', ...parts),
  scene: (msg) => ipcRenderer.send('scene', msg), // to the wallpaper (renderer/scene-link.js)
  // The ARES theme (theme.js): the status pill for its menu bar, and the views its bar, dock and notifications open
  theme: {
    status: (s) => ipcRenderer.send('theme-status', s),
    onOpen: (fn) => ipcRenderer.on('theme-open', (_e, view) => fn(view)),
  },
  // Where this window lives (surface.js): the live desktop, lifted above the apps, or a window
  surface: {
    state: () => ipcRenderer.invoke('surface-state'),
    on: (fn) => ipcRenderer.on('surface', (_e, s) => fn(s)),
    onMode: (fn) => ipcRenderer.on('surface-mode', (_e, m) => fn(m)),
    onIcons: (fn) => ipcRenderer.on('desk-icons', (_e, list) => fn(list)),
    hits: (h) => ipcRenderer.send('surface-hits', h),
    test: (what) => ipcRenderer.send('test-surface', what), // development builds only
    testHear: (evt) => ipcRenderer.send('test-hear', evt),
    testDesk: (patch) => ipcRenderer.invoke('test-desk', patch),
  },
  // Hand gestures (vision.js → hands.js → renderer/hands.js)
  hands: {
    onActions: (fn) => ipcRenderer.on('hands-actions', (_e, list) => fn(list)),
    onState: (fn) => ipcRenderer.on('hands-state', (_e, s) => fn(s)),
    state: () => ipcRenderer.invoke('hands-state'),
    act: (what) => ipcRenderer.send('hands-act', what), // summon | hide | stop
    replay: (clip, opts) => ipcRenderer.invoke('test-hands', clip, opts || {}), // development builds only
  },
  hide: () => ipcRenderer.send('window-hide'),
  pin: (pinned) => ipcRenderer.send('window-pin', pinned),
  toggleFullscreen: () => ipcRenderer.send('window-fullscreen'),
  onSummoned: (fn) => ipcRenderer.on('summoned', fn),
  // The corner orb (orb.js): a question asked from it, a click that stops her, the portal reveal (renderer/surface.js)
  orb: {
    onAsk: (fn) => ipcRenderer.on('orb-ask', (_e, text) => fn(text)),
    onStop: (fn) => ipcRenderer.on('orb-stop', () => fn()),
    onPortal: (fn) => ipcRenderer.on('portal', (_e, p) => fn(p)),
    test: (what, arg) => ipcRenderer.invoke('test-orb', what, arg), // development builds only
  },
  integrations: () => ipcRenderer.invoke('integrations'),
  onIntegrations: (fn) => ipcRenderer.on('integrations', (_e, s) => fn(s)),
  // COMMS: today's conversation on every device (history + live lines), and window-only lines to add to it
  comms: {
    history: () => ipcRenderer.invoke('comms-history'),
    on: (fn) => ipcRenderer.on('comms', (_e, m) => fn(m)),
    note: (who, text, extra) => ipcRenderer.send('comms-note', who, text, extra || {}),
  },
  onRemotePairing: (fn) => ipcRenderer.on('remote-pairing', (_e, info) => fn(info)),
  onTimerDone: (fn) => ipcRenderer.on('timer-done', (_e, label) => fn(label)),
  uiPrefs: () => ipcRenderer.invoke('ui-prefs'),
  // The reactor's readout callouts (renderer/callouts.js ↔ readouts.js): live values, the fuller card, tier-2 actions
  readouts: {
    get: () => ipcRenderer.invoke('readouts'),
    detail: () => ipcRenderer.invoke('readouts-detail'),
    act: (name) => ipcRenderer.invoke('readouts-act', name),
    on: (fn) => ipcRenderer.on('readouts', (_e, d) => fn(d)),
  },
  onUiPrefs: (fn) => ipcRenderer.on('ui-prefs', (_e, p) => fn(p)),
  // Ignition / standby / power down (renderer/power.js ↔ ignition.js, power.js)
  power: {
    state: () => ipcRenderer.invoke('power-state'),
    act: (what, why) => ipcRenderer.invoke('power-act', what, why),
    on: (fn) => ipcRenderer.on('power', (_e, m) => fn(m)),
  },
  onFullscreen: (fn) => ipcRenderer.on('fullscreen-changed', (_e, on) => fn(on)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // The dashboard (renderer/dash.js): live data, panel positions, weather city and home address
  dash: {
    state: () => ipcRenderer.invoke('dash-state'),
    on: (fn) => ipcRenderer.on('dash', (_e, msg) => fn(msg)),
    savePanels: (panels) => ipcRenderer.send('ui-panels', panels),
    setCity: (city) => ipcRenderer.invoke('dash-city', city),
    setHome: (address) => ipcRenderer.invoke('dash-home', address),
    act: (action, arg) => ipcRenderer.invoke('dash-act', action, arg),
  },
  // Work mode: background jobs
  work: {
    list: () => ipcRenderer.invoke('jobs-list'),
    detail: (id) => ipcRenderer.invoke('job-detail', id),
    cancel: (id) => ipcRenderer.invoke('job-cancel', id),
    answer: (id, yes) => ipcRenderer.invoke('job-answer', id, yes),
    seen: (id) => ipcRenderer.invoke('job-seen', id),
    dismiss: (id) => ipcRenderer.invoke('job-dismiss', id),
    delete: (id) => ipcRenderer.invoke('job-delete', id),
    version: (id, n) => ipcRenderer.invoke('job-version', id, n),
    gallery: () => ipcRenderer.invoke('jobs-gallery'),
    search: (q) => ipcRenderer.invoke('jobs-search', q),
    withFiles: (o) => ipcRenderer.invoke('job-with-files', o),
    filePath: (file) => webUtils.getPathForFile(file),
    onShow: (fn) => ipcRenderer.on('job-show', (_e, id) => fn(id)),
    onRemoved: (fn) => ipcRenderer.on('job-removed', (_e, id) => fn(id)),
    open: (id, file) => ipcRenderer.invoke('job-open', id, file),
    preview: (id, file) => ipcRenderer.invoke('job-preview', id, file),
    savePdf: (id) => ipcRenderer.invoke('job-save-pdf', id),
    continue: (id, text) => ipcRenderer.invoke('job-continue', id, text),
    sendToPhone: (id) => ipcRenderer.invoke('job-send-phone', id),
    printReady: () => ipcRenderer.send('print-ready'),
    onChange: (fn) => ipcRenderer.on('job-change', (_e, job) => fn(job)),
    onEvent: (fn) => ipcRenderer.on('job-event', (_e, id, evt) => fn(id, evt)),
    onAnnounce: (fn) => ipcRenderer.on('job-announce', (_e, a) => fn(a)),
    pause: (id) => ipcRenderer.invoke('job-pause', id),
    resume: (id) => ipcRenderer.invoke('job-resume', id),
  },
  // Autonomy (autonomy.js): projects, goals, routines, the kill switch; and the audit log
  autonomy: {
    state: () => ipcRenderer.invoke('autonomy-state'),
    act: (name, args) => ipcRenderer.invoke('autonomy-act', name, args),
    onChange: (fn) => ipcRenderer.on('autonomy-change', (_e, v) => fn(v)),
    audit: (n) => ipcRenderer.invoke('audit-recent', n),
  },
});
