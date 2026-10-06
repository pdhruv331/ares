// The ignition helper's page glue (native/ignition.html, in "ARES Ignition.app"): the same scene and controller as the ARES window
// (renderer/scene.js + renderer/ignite.js), driven by the Swift side through Ignition.rx({...}) and answering through
// window.webkit.messageHandlers.ares. Pointer: the Swift side polls the pointer (the window is click-through outside the circle) and
// relays moves, downs and ups; holds and hovers are the controller's. Sounds: NSSound in the helper (the window's names).
(() => {
  const P = window.Scene?.power;
  const post = (m) => { try { window.webkit.messageHandlers.ares.postMessage(m); } catch {} };
  if (!P) { post({ type: 'log', text: 'no scene' }); return; }
  const ghost = Ignite.ghost(document.getElementById('ghostLog'));
  const sound = (name, stop = false) => post({ type: 'sound', name, stop });
  const clipTo = (g) => { // only the reactor's disc and the title band are painted (the still shows through everywhere else)
    const lay = Ignite.layout(g.cx, g.cy, g.r, 1), b = lay.band.offline, R = g.r * 1.12;
    const circle = `M ${g.cx - R} ${g.cy} a ${R} ${R} 0 1 0 ${R * 2} 0 a ${R} ${R} 0 1 0 ${-R * 2} 0`;
    const rect = `M ${b.x} ${b.y} h ${b.w} v ${b.h} h ${-b.w} z`;
    document.documentElement.style.setProperty('--clip', `path('${circle} ${rect}')`);
  };
  const g = window.SCENE_GEOMETRY || Scene.geometry(); // (from the query: the canvas has no size until the first frame)
  clipTo(g);
  P.set('offline', { force: true });
  P.S = 1;
  P.clipR = 1.12; // only the disc is painted: the drain and the glow stay inside it
  let wasHold = false, wasHover = 0, hum = false;
  setInterval(() => {
    const holding = Boolean(P.hold);
    if (holding && !wasHold) sound('hold-rise');
    if (!holding && wasHold) sound('hold-rise', true);
    wasHold = holding;
    const hover = P.hover > 0.5 ? 1 : 0;
    if (hover && hover !== wasHover) sound('tick');
    wasHover = hover;
    if (P.mode === 'charging' && P.shown > 0.02 && !hum) { hum = true; sound('charge-hum'); }
    if (P.mode === 'breath' && hum) { hum = false; sound('charge-hum', true); sound('inhale'); }
  }, 80);
  window.addEventListener('power', (e) => {
    const ev = e.detail;
    if (ev === 'commit:wake') { sound('clunk'); post({ type: 'ignite' }); }
    else if (ev === 'wake') { sound('bloom'); post({ type: 'wake' }); document.body.classList.add('awake', 'out'); } // the live desktop fades in under this as it fades out
    else if (ev === 'online') { /* (gone by now) */ }
    else if (ev.startsWith('cancel:')) sound('hold-rise', true);
  });
  window.Ignition = {
    rx(m) {
      switch (m.type) {
        case 'pointer':
          if (!m.inside) { P.pointer('up', 0, 0, Scene.geometry()); P.wantHover = 0; break; }
          P.pointer('move', m.x, m.y, Scene.geometry());
          break;
        case 'down': P.pointer('down', m.x, m.y, Scene.geometry()); break;
        case 'up': P.pointer('up', m.x, m.y, Scene.geometry()); break;
        case 'ignite': // the hold committed (here or by ⌥Space / a Dock launch): the charge begins and waits for real steps
          if (P.mode === 'offline') { P.set('charging'); P.charge = 0; ghost.line('igniting', 1800); }
          break;
        case 'hello':
          for (const s of m.steps || []) { ghost.step(s); P.step(s); }
          if (m.ready) P.ready();
          break;
        case 'step': ghost.step(m); P.step(m); if (m.status === 'fail') sound('nope'); break;
        case 'ready': P.ready(); break;
        case 'failed': P.set('offline', { force: true }); ghost.line('ARES did not start', 4000); sound('nope'); break;
        case 'handover': document.body.classList.add('out'); break;
      }
    },
  };
  post({ type: 'ready' });
})();
