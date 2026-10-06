// Before scene.js: what the page's query says about the scene (the pages' CSP allows no inline script).
//   ?geo=cx,cy,r      the reactor's geometry in the page's CSS px (the lock-screen still, the ignition helper: the same spot as
//                     the live window, docs/ignition-prompt.md)
//   ?power=cold       a cold start: begin as the offline still (gold, full size) and brighten with the real start-up
//   ?power=standby    begin in standby (a renderer reload while she's standing by)
//   ?mode=wallpaper|still|saver   these pages only mirror the window's power state (replicas)
(() => {
  const q = new URLSearchParams(location.search);
  const geo = (q.get('geo') || '').split(',').map(Number);
  if (geo.length === 3 && geo.every(Number.isFinite) && geo[2] > 0) window.SCENE_GEOMETRY = { cx: geo[0], cy: geo[1], r: geo[2] };
  if (q.get('power')) window.SCENE_POWER = q.get('power');
  if (['wallpaper', 'still', 'saver'].includes(q.get('mode') || document.body?.dataset.mode)) window.SCENE_REPLICA = true; // (the ignition helper's page takes holds itself)
})();
