// Copies the Work panel's rendering libraries out of node_modules into renderer/vendor/, so the app loads
// them locally (no CDN) and the packaged app doesn't need these dev packages. Run: node scripts/vendor.mjs
// (build-app.sh runs it too).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });
const nm = (p) => path.join(root, 'node_modules', p);

const copies = {
  'marked.umd.js': 'marked/lib/marked.umd.js',
  'purify.min.js': 'dompurify/dist/purify.min.js',
  'chart.umd.min.js': 'chart.js/dist/chart.umd.min.js',
  'mermaid.min.js': 'mermaid/dist/mermaid.min.js',
  'hljs-dark.css': 'highlight.js/styles/github-dark.css',
};
for (const [to, from] of Object.entries(copies)) fs.copyFileSync(nm(from), path.join(out, to));

// highlight.js ships CommonJS only: bundle its common languages into one browser script (window.hljs)
await build({
  stdin: { contents: "window.hljs = require('highlight.js/lib/common');", resolveDir: root },
  bundle: true, minify: true, format: 'iife', outfile: path.join(out, 'highlight.min.js'), logLevel: 'warning',
});
console.log('vendored:', fs.readdirSync(out).join(', '));
