// The wallpaper is a second view of this ARES: everything the window's scene is told (her state, voice level and
// spectrum, the wake pulse, the amber "needs you" tint) is passed on to the main process, which forwards it to the
// wallpaper windows. Levels are sent at most ~30 times a second, the spectrum thinned to 40 values.
(() => {
  const send = (msg) => window.ares.scene(msg);
  const wrap = (name, fn) => { const orig = HUD[name].bind(HUD); HUD[name] = (...args) => { orig(...args); fn(...args); }; };
  let spectrum = null, lastLevel = 0, pending = null;
  wrap('setState', (state) => send({ type: 'state', state }));
  wrap('pulse', (strength = 1) => send({ type: 'pulse', strength }));
  wrap('attention', (on) => send({ type: 'attention', on: Boolean(on) }));
  wrap('offline', (on) => send({ type: 'offline', on: Boolean(on) }));
  wrap('setSpectrum', (arr) => { spectrum = arr; });
  wrap('setLevel', (v) => {
    const now = performance.now();
    const msg = () => ({ type: 'level', v, spectrum: spectrum ? Array.from({ length: 40 }, (_, i) => Math.round(spectrum[Math.floor(i * spectrum.length / 40)] * 100) / 100) : null });
    clearTimeout(pending);
    if (now - lastLevel >= 33) { lastLevel = now; send(msg()); }
    else pending = setTimeout(() => { lastLevel = performance.now(); send(msg()); }, 33); // the last value (e.g. 0) always arrives
  });
})();
