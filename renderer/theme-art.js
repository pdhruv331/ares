// ARES OS theme: the Finder icons (docs/ares-theme-prompt.md), drawn once in a hidden window and saved as PNGs by
// theme-icons.js. Holographic outlines in ARES cyan, a faint glass fill with scan lines, EDITH corner brackets.
(() => {
  const S = 512;
  const CYAN = '62,230,255';
  const VARIANTS = ['folder', 'document', 'image', 'pdf', 'code', 'archive', 'data', 'generic'];

  function canvas() {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    return [c, c.getContext('2d')];
  }

  const glow = (ctx, blur = 22, a = 0.9) => { ctx.shadowColor = `rgba(${CYAN},${a})`; ctx.shadowBlur = blur; };
  const noGlow = (ctx) => { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Glass: a faint cyan gradient and scan lines, inside the current path. */
  function glass(ctx, top, bottom, strength = 1) {
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, `rgba(${CYAN},${0.2 * strength})`);
    g.addColorStop(0.55, `rgba(8,30,44,${0.55 * strength})`);
    g.addColorStop(1, `rgba(${CYAN},${0.08 * strength})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = `rgba(${CYAN},0.07)`;
    for (let y = top; y < bottom; y += 9) ctx.fillRect(0, y, S, 2);
    ctx.restore();
  }

  function outline(ctx, width = 7) {
    ctx.save();
    glow(ctx, 26);
    ctx.strokeStyle = `rgba(${CYAN},0.95)`;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.stroke();
    noGlow(ctx);
    ctx.strokeStyle = 'rgba(230,252,255,0.55)';
    ctx.lineWidth = Math.max(1.5, width / 3.5);
    ctx.stroke();
    ctx.restore();
  }

  /** EDITH corner brackets around the icon. */
  function brackets(ctx, x0 = 26, y0 = 26, x1 = S - 26, y1 = S - 26, len = 64) {
    ctx.save();
    glow(ctx, 16, 0.8);
    ctx.strokeStyle = `rgba(${CYAN},0.85)`;
    ctx.lineWidth = 7;
    ctx.lineCap = 'square';
    for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(x, y + dy * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dx * len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The ARES mark: a ring with a bright core. */
  function mark(ctx, x, y, r) {
    ctx.save();
    glow(ctx, 18);
    ctx.strokeStyle = `rgba(${CYAN},0.9)`;
    ctx.lineWidth = r * 0.16;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#effcff';
    ctx.beginPath(); ctx.arc(x, y, r * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function text(ctx, s, x, y, size, spacing = 0.12) {
    ctx.save();
    glow(ctx, 14);
    ctx.fillStyle = '#effcff';
    ctx.font = `700 ${size}px "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${Math.round(size * spacing)}px`;
    ctx.fillText(s, x, y);
    ctx.restore();
  }

  function folder() {
    const [c, ctx] = canvas();
    // Back plate with the tab
    ctx.beginPath();
    ctx.moveTo(70, 150);
    ctx.lineTo(70, 128); ctx.arcTo(70, 108, 90, 108, 20);
    ctx.lineTo(200, 108); ctx.lineTo(232, 140); ctx.lineTo(422, 140); ctx.arcTo(442, 140, 442, 160, 20);
    ctx.lineTo(442, 400); ctx.arcTo(442, 420, 422, 420, 20);
    ctx.lineTo(90, 420); ctx.arcTo(70, 420, 70, 400, 20);
    ctx.closePath();
    glass(ctx, 108, 420, 0.7);
    outline(ctx, 6);
    // Front flap
    roundRect(ctx, 70, 186, 372, 234, 20);
    glass(ctx, 186, 420, 1.1);
    outline(ctx, 7);
    mark(ctx, S / 2, 304, 34);
    brackets(ctx);
    return c;
  }

  const GLYPH = {
    document(ctx) { ctx.save(); glow(ctx, 10); ctx.fillStyle = `rgba(${CYAN},0.85)`; for (let i = 0; i < 5; i++) ctx.fillRect(176, 214 + i * 34, i === 4 ? 100 : 160, 9); ctx.restore(); },
    image(ctx) {
      ctx.save(); glow(ctx, 14); ctx.strokeStyle = `rgba(${CYAN},0.95)`; ctx.lineWidth = 9; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(168, 368); ctx.lineTo(228, 284); ctx.lineTo(268, 330); ctx.lineTo(300, 296); ctx.lineTo(348, 368); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.arc(312, 222, 22, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    },
    pdf(ctx) { text(ctx, 'PDF', S / 2, 290, 76); },
    code(ctx) { text(ctx, '</>', S / 2, 290, 88, 0.02); },
    data(ctx) { text(ctx, '{ }', S / 2, 290, 96, 0.02); },
    archive(ctx) {
      ctx.save(); glow(ctx, 10); ctx.fillStyle = `rgba(${CYAN},0.9)`;
      for (let i = 0; i < 6; i++) ctx.fillRect(i % 2 ? 256 : 232, 120 + i * 30, 24, 16);
      roundRect(ctx, 226, 304, 60, 70, 10); ctx.strokeStyle = `rgba(${CYAN},0.95)`; ctx.lineWidth = 8; ctx.stroke(); ctx.restore();
    },
    generic(ctx) { mark(ctx, S / 2, 290, 46); },
  };

  function document_(kind) {
    const [c, ctx] = canvas();
    const x0 = 120, y0 = 66, x1 = 392, y1 = 446, fold = 78;
    ctx.beginPath();
    ctx.moveTo(x0 + 18, y0); ctx.lineTo(x1 - fold, y0); ctx.lineTo(x1, y0 + fold); ctx.lineTo(x1, y1 - 18);
    ctx.arcTo(x1, y1, x1 - 18, y1, 18); ctx.lineTo(x0 + 18, y1); ctx.arcTo(x0, y1, x0, y1 - 18, 18); ctx.lineTo(x0, y0 + 18); ctx.arcTo(x0, y0, x0 + 18, y0, 18);
    ctx.closePath();
    glass(ctx, y0, y1, 1);
    outline(ctx, 7);
    // The folded corner
    ctx.beginPath(); ctx.moveTo(x1 - fold, y0); ctx.lineTo(x1 - fold, y0 + fold - 12); ctx.arcTo(x1 - fold, y0 + fold, x1 - fold + 12, y0 + fold, 12); ctx.lineTo(x1, y0 + fold);
    outline(ctx, 5);
    GLYPH[kind](ctx);
    brackets(ctx);
    return c;
  }

  const out = {};
  for (const v of VARIANTS) out[v] = (v === 'folder' ? folder() : document_(v)).toDataURL('image/png');
  window.theme.send('theme-art-done', out);
})();
