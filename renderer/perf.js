// One frame governor for every animation loop (starfield, halo, 3D brain, dashboard effects): nothing draws while
// the window is hidden, frames are capped at 60 fps, and at 30 fps on battery.
// A page that paces itself (the wallpaper, the screen saver) sets a policy instead: () => fps, where 0 = hold the frame.
const Perf = (() => {
  let fps = 60;
  let battery = false;
  let policy = null;
  navigator.getBattery?.().then((b) => {
    const update = () => { battery = !b.charging; fps = battery ? 30 : 60; };
    b.addEventListener('chargingchange', update);
    update();
  }).catch(() => {});
  return {
    get fps() { return (policy && policy()) ?? fps; },
    get battery() { return battery; },
    setPolicy(fn) { policy = fn; },
    /** A per-loop gate: call gate(now) at the top of a requestAnimationFrame callback; false = skip this frame. */
    gate() {
      let last = 0;
      return (now) => {
        if (document.hidden && !window.SCENE_STILL) return false; // (the still renders in a window never shown)
        let cap = (policy && policy()) ?? fps; // a policy may return undefined: the normal rules
        const pc = window.Scene?.power?.fps;   // ignition / standby (renderer/ignite.js): 60 through a transition, a trickle at rest
        if (cap && pc) cap = pc;
        if (!cap || now - last < 1000 / cap - 2) return false;
        last = now;
        return true;
      };
    },
  };
})();
// Render quality for the shared scene: the pixel ratio every canvas uses. The wallpaper drops it to 1 on battery;
// set window.SCENE_DPR and dispatch 'scene-quality' to apply.
const sceneDpr = (max = 2) => window.SCENE_DPR ?? Math.min(window.devicePixelRatio || 1, max);
