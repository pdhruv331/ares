// Ignition, standby and power down in the ARES window (docs/ignition-prompt.md): the glue between the main process (ignition.js,
// power.js, over window.ares.power) and the scene's controller (renderer/ignite.js, Scene.power). Runs after app.js: Voice, note,
// show and setState are the window's own (top-level consts of a classic script are shared with later scripts).
//
// - A cold start: the page began as the offline still (?power=cold); the real start-up steps fill the charge, the wake plays,
//   then the wake line is typed under the reactor and spoken. If the ignition helper is drawing the charge instead, the page
//   stays invisible until the handover and simply fades in live.
// - Holds on the core / the notch (scene.js → 'power' events) ask the main process: standby, wake, power down.
// - Standby / spin-down: the main process says the mode; the controller animates; panels and chrome hide (html.power-quiet);
//   the ghost log shows the real steps; the sounds play.
(() => {
  const root = document.documentElement;
  const P = window.Scene?.power;
  if (!P || !window.ares?.power) return;
  const ghost = Ignite.ghost(document.getElementById('ghostLog'));
  let prefs = { sounds: true, wakeLine: 'spoken' };
  let wake = null;            // { text, spoken } the wake line to show/say when the wake completes
  let helperDriven = false;   // the helper plays the charge; this page waits for the handover
  let holdSound = null;

  const quiet = (on) => root.classList.toggle('power-quiet', on);
  const modeClass = (m) => { for (const c of [...root.classList]) if (c.startsWith('power-') && !['power-quiet', 'power-wait', 'power-handover'].includes(c)) root.classList.remove(c); root.classList.add(`power-${m}`); };
  const applyPrefs = (p) => { prefs = { ...prefs, ...p }; Sounds.enabled = prefs.sounds !== false; };

  // ---- The wake line: typed by the controller, spoken here ----------------------------------------------------------------------
  async function sayWake() {
    if (!wake) return;
    const line = wake; wake = null;
    P.wakeLine = line.text; P.lineShown = 0; P.t = 0;
    note('ares', line.text);
    if (!line.spoken || document.visibilityState !== 'visible') return; // text only: quiet hours, a Focus, "shown only", or hidden at login
    window.ares.pauseListening();
    try { await Voice.speak(line.spoken); } catch {}
    setState('idle');
    window.ares.resumeListening();
  }

  // ---- Messages from the main process ---------------------------------------------------------------------------------------------
  window.ares.power.on((m) => {
    switch (m.type) {
      case 'step':
        ghost.step(m.step);
        if (!m.reverse) { P.step(m.step); if (m.step.status === 'fail') Sounds.play('nope'); }
        if (!m.reverse && m.step.status === 'ok' && P.mode === 'charging') Sounds.rate('charge-hum', 0.8 + P.charge * 0.9);
        break;
      case 'ready':
        wake = m.line || null;
        if (helperDriven && root.classList.contains('power-wait')) break; // the helper plays the wake; this page comes in live at the handover
        P.ready();
        break;
      case 'handover':
        if (!helperDriven || !root.classList.contains('power-wait')) break; // this page played the charge itself: 'online' arrives from the controller
        // the helper reached its bloom: play the wake here too (the rings spring open, the shockwave) while the page fades in
        P.set('wake', { force: true });
        root.classList.remove('power-wait'); root.classList.add('power-handover');
        setTimeout(() => { quiet(false); modeClass('online'); ghost.line('all systems nominal'); sayWake(); }, 1400);
        break;
      case 'mode':
        onMode(m);
        break;
      case 'say':
        if (m.line) { note('ares', m.line); window.ares.pauseListening(); Voice.speak(m.line).catch(() => {}); }
        break;
      case 'prefs':
        applyPrefs(m.prefs);
        break;
    }
  });
  function onMode(m) {
    const status = m.status || P.status;
    modeClass(m.mode);
    if (m.mode === 'tostandby') { P.set('tostandby', { status }); quiet(true); Sounds.play('standby-down'); ghost.line(`standby · ${m.why || 'user'}`, 2500); }
    else if (m.mode === 'standby') { if (P.mode !== 'standby') P.set('standby', { status }); else P.status = status; quiet(true); }
    else if (m.mode === 'fromstandby') { P.set('fromstandby', { status }); Sounds.play('wake-chime'); ghost.line('awake', 1500); }
    else if (m.mode === 'online') { if (P.mode !== 'online' && P.mode !== 'fromstandby' && P.mode !== 'wake') P.set('online'); quiet(false); }
    else if (m.mode === 'spindown') { P.set('spindown'); quiet(true); Sounds.play('clunk'); setTimeout(() => Sounds.play('winddown'), 250); }
    else if (m.mode === 'dormant') { if (P.mode !== 'offline' && P.mode !== 'spindown') P.set('offline', { force: true }); quiet(true); modeClass('offline'); }
    else if (m.mode === 'charging') { helperDriven = false; root.classList.remove('power-wait'); ghost.clear(); P.set('charging', { force: true }); P.charge = 0; P.readyAt = false; quiet(true); modeClass('charging'); ghost.line('igniting', 1500); } // (a wake from dormancy: this page plays the charge)
  }

  // ---- The controller's events (scene.js dispatches them each frame) -------------------------------------------------------------
  window.addEventListener('power', (e) => {
    const ev = e.detail;
    if (ev === 'wake') { Sounds.stop('charge-hum', 0.3); Sounds.play('bloom'); }
    else if (ev === 'online') { if (!helperDriven) { ghost.line('all systems nominal'); sayWake(); } quiet(false); modeClass('online'); window.ares.power.act('online', 'window'); }
    else if (ev === 'offline') { Sounds.play('thud'); ghost.line('reactor cold', 2500); }
    else if (ev === 'standby') { /* settled */ }
    else if (ev.startsWith('commit:')) {
      const kind = ev.slice(7);
      Sounds.stop('hold-rise'); Sounds.play('clunk');
      if (kind === 'standby') window.ares.power.act('standby', 'core hold');
      else if (kind === 'wakeup' || kind === 'wake') window.ares.power.act('wake', 'core hold'); // (wake: from dormancy)
      else if (kind === 'power') window.ares.power.act('powerdown', 'notch hold');
    } else if (ev.startsWith('cancel:')) Sounds.stop('hold-rise');
  });
  // The hold's rising tone and the hover tick: polled (the controller has no DOM)
  let wasHold = false, wasHover = 0;
  setInterval(() => {
    const holding = Boolean(P.hold);
    if (holding && !wasHold) Sounds.play('hold-rise');
    if (!holding && wasHold) Sounds.stop('hold-rise');
    wasHold = holding;
    const hover = (P.hover > 0.5 ? 1 : 0) + (P.notchHover > 0.5 ? 2 : 0);
    if (hover && hover !== wasHover) Sounds.play('tick');
    wasHover = hover;
    if (P.mode === 'charging' && !helperDriven && !Sounds.silent && P.shown > 0.02 && !chargeHum) { chargeHum = true; Sounds.loop('charge-hum'); }
    if (P.mode === 'breath' && chargeHum) { chargeHum = false; Sounds.stop('charge-hum', 0.2); Sounds.play('inhale'); }
  }, 80);
  let chargeHum = false;

  // ---- Start: what state are we in? ---------------------------------------------------------------------------------------------------
  window.ares.power.state().then(async (st) => {
    applyPrefs(st.prefs || {});
    Sounds.silent = await window.ares.power.act('silent').catch(() => false);
    Sounds.preload();
    if (st.mode === 'standby' || st.mode === 'tostandby') { root.classList.remove('power-wait'); P.set('standby', { force: true, status: st.status }); quiet(true); modeClass('standby'); return; }
    if (st.mode === 'dormant') { root.classList.remove('power-wait'); P.set('offline', { force: true }); quiet(true); modeClass('offline'); return; } // (a reload while dormant)
    if (st.ready && st.helper === false && P.mode === 'offline' && !st.helperAlive) {
      // a reload after the start (or a very slow page): no ceremony, straight to live
      if (!st.steps?.length) { P.set('online', { force: true }); modeClass('online'); return; }
    }
    if (P.mode !== 'offline') { root.classList.remove('power-wait', 'power-quiet'); modeClass('online'); return; } // (?power=online: a reload while she's up)
    helperDriven = Boolean(st.helper || st.helperAlive);
    modeClass('offline'); quiet(true);
    if (helperDriven) { root.classList.add('power-wait'); return; } // the helper's window shows the charge; wait for the handover
    root.classList.remove('power-wait'); // this page plays the charge itself
    for (const s of st.steps || []) { ghost.step(s); P.step(s); }
    if (st.ready) { wake = st.line || null; P.ready(); }
  }).catch(() => {});
})();
