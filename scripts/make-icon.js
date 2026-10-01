// Renders the ARES arc-reactor app icon to assets/icon.png (run with: electron scripts/make-icon.js)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<html><body style="margin:0;background:transparent"><canvas id="c" width="1024" height="1024"></canvas><script>
const c = document.getElementById('c').getContext('2d');
const C = 512, cyan = (a) => 'rgba(62,230,255,' + a + ')';
// macOS-style rounded square
const r = 230, pad = 100, s = 1024 - pad * 2;
c.beginPath(); c.roundRect(pad, pad, s, s, r);
const bg = c.createRadialGradient(C, C, 40, C, C, 520);
bg.addColorStop(0, '#0b2130'); bg.addColorStop(1, '#03080d');
c.fillStyle = bg; c.fill();
c.lineWidth = 3; c.strokeStyle = cyan(0.35); c.stroke();
c.save(); c.clip();
const ring = (rad, w, a) => { c.beginPath(); c.arc(C, C, rad, 0, Math.PI * 2); c.lineWidth = w; c.strokeStyle = cyan(a); c.stroke(); };
ring(330, 4, 0.35);
for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2, l = i % 10 ? 14 : 30; c.beginPath(); c.moveTo(C + Math.cos(a) * 322, C + Math.sin(a) * 322); c.lineTo(C + Math.cos(a) * (322 - l), C + Math.sin(a) * (322 - l)); c.lineWidth = i % 10 ? 3 : 5; c.strokeStyle = cyan(0.55); c.stroke(); }
c.setLineDash([46, 22]); ring(262, 16, 0.3); c.setLineDash([]);
for (let i = 0; i < 10; i++) { const a0 = i / 10 * Math.PI * 2 + 0.05, a1 = a0 + Math.PI * 2 / 10 - 0.1;
  c.beginPath(); c.arc(C, C, 215, a0, a1); c.arc(C, C, 140, a1, a0, true); c.closePath();
  c.fillStyle = cyan(0.2); c.fill(); c.lineWidth = 4; c.strokeStyle = cyan(0.9); c.stroke(); }
const g = c.createRadialGradient(C, C, 0, C, C, 190);
g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, cyan(0.95)); g.addColorStop(0.6, cyan(0.3)); g.addColorStop(1, cyan(0));
c.fillStyle = g; c.beginPath(); c.arc(C, C, 190, 0, Math.PI * 2); c.fill();
ring(92, 6, 1);
c.restore();
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.exit(0);
});
