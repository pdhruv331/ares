// One frame governor for every animation loop (starfield, halo, 3D brain, dashboard effects): nothing draws while
// the window is hidden, frames are capped at 60 fps, and at 30 fps on battery.
const Perf = (() => {
  let fps = 60;
  navigator.getBattery?.().then((b) => {
    const update = () => { fps = b.charging ? 60 : 30; };
    b.addEventListener('chargingchange', update);
    update();
  }).catch(() => {});
  return {
    get fps() { return fps; },
    /** A per-loop gate: call gate(now) at the top of a requestAnimationFrame callback; false = skip this frame. */
    gate() {
      let last = 0;
      return (now) => {
        if (document.hidden) return false;
        if (now - last < 1000 / fps - 2) return false;
        last = now;
        return true;
      };
    },
  };
})();
