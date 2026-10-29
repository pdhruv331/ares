// Result cards (docs/phone-ui-prompt.md §6): the brain attaches a card spec to an answer (the show_card tool) and the phone
// draws it with its own views. A fixed catalogue, validated here before anything leaves: kind + a few fields + up to three
// follow-up actions. Unknown kinds become a text card; unknown fields are dropped. The same spec could feed the Mac
// window later (phone first).
const KINDS = ['summary', 'list', 'event', 'place', 'file', 'image', 'progress', 'approval', 'text'];
const FIELDS = ['when', 'where', 'address', 'hours', 'phone', 'name', 'size', 'mime', 'url', 'job', 'what', 'icon'];
const SAFE_URL = /^(https?:\/\/|tel:|sms:|smsto:|mailto:|\/api\/files\/|\/api\/jobs\/)/i;

const str = (v, n) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
const words = (t) => str(t, 400).split(' ').filter(Boolean);

/** A clean card, or null if there's nothing worth showing. `error` names the first problem (for the tool's answer). */
function validateCard(spec = {}) {
  if (!spec || typeof spec !== 'object') return { error: 'the card must be an object' };
  const out = { kind: KINDS.includes(String(spec.kind).toLowerCase()) ? String(spec.kind).toLowerCase() : 'text' };
  const title = words(spec.title);
  if (title.length > 12) return { error: 'the title must be 12 words or fewer' };
  out.title = title.join(' ');
  if (spec.text) out.text = str(spec.text, 600);
  if (Array.isArray(spec.lines)) out.lines = spec.lines.slice(0, 3).map((l) => str(l, 140)).filter(Boolean);
  if (Array.isArray(spec.items)) {
    out.items = spec.items.slice(0, 6).map((it) => (typeof it === 'object' && it
      ? { text: str(it.text, 120), sub: str(it.sub, 80), url: SAFE_URL.test(str(it.url, 1000)) ? str(it.url, 1000) : '' }
      : { text: str(it, 120) })).filter((it) => it.text);
  }
  for (const k of FIELDS) if (spec[k] != null && spec[k] !== '') out[k] = str(spec[k], k === 'url' ? 1000 : 300);
  if (out.url && !SAFE_URL.test(out.url)) return { error: 'url must be http(s), tel:, sms:, mailto:, or a /api/files or /api/jobs path on the Mac' };
  if (Array.isArray(spec.actions)) {
    if (spec.actions.length > 3) return { error: 'at most three actions' };
    out.actions = [];
    for (const a of spec.actions) {
      if (!a || typeof a !== 'object') continue;
      const label = str(a.label, 24);
      if (!label) continue;
      const act = { label };
      if (a.url) { if (!SAFE_URL.test(str(a.url, 1000))) return { error: `action "${label}": url not allowed` }; act.url = str(a.url, 1000); }
      if (a.ask) act.ask = str(a.ask, 300);
      if (a.share) act.share = str(a.share, 2000);
      if (a.api) { if (!/^\/api\/jobs\/[\w-]{1,40}\/(answer|cancel|send-to-mac|seen|dismiss|undo)$/.test(String(a.api))) return { error: `action "${label}": api not allowed` }; act.api = String(a.api); if (a.body && typeof a.body === 'object') act.body = a.body; }
      if (!act.url && !act.ask && !act.share && !act.api) return { error: `action "${label}" needs a url, ask, share or api` };
      out.actions.push(act);
    }
  }
  const body = out.text || out.lines?.length || out.items?.length || out.when || out.address || out.name || out.url || out.job;
  if (!out.title && !body) return { error: 'the card is empty' };
  return { card: out };
}

/** The tool's description of the catalogue, for the brain. */
const CATALOGUE = 'Kinds: summary (title + up to 3 lines), list (items: text, sub, url), event (title, when, where, url), ' +
  'place (title, address, hours, phone, url), file (name, size, mime, url: a /api/files/<id> link from send_to_phone), ' +
  'image (url on the Mac), progress (job: id), approval (job: id). Title ≤ 12 words. Up to 3 actions {label, url | ask | share | api}: ' +
  'url opens on the phone (http(s), tel:, sms:, mailto:), ask sends that text to you as a follow-up, share opens the phone\'s share sheet with it.';

module.exports = { validateCard, KINDS, CATALOGUE };
