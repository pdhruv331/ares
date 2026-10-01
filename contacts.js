// ARES's address book: contacts imported from a vCard export (e.g. Google Contacts → Export → vCard),
// kept only on this Mac (~/Library/Application Support/ARES/contacts.json, readable by you alone).
const fs = require('fs');

/** Parse a .vcf file into [{ name, nickname, org, phones: [{type, number}], emails: [...] }]. */
function parseVcf(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); // continuation lines
  const cards = [];
  let card = null;
  for (const raw of unfolded.split('\n')) {
    const line = raw.trim();
    if (/^BEGIN:VCARD$/i.test(line)) { card = { name: '', nickname: '', org: '', phones: [], emails: [] }; continue; }
    if (/^END:VCARD$/i.test(line)) { if (card && (card.name || card.phones.length || card.emails.length)) cards.push(card); card = null; continue; }
    if (!card) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon).replace(/^item\d+\./i, '');
    const value = line.slice(colon + 1).replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').trim();
    const [prop, ...params] = head.split(';');
    const types = params.join(';').toLowerCase().match(/(cell|mobile|home|work|main|iphone|other)/g) || [];
    switch (prop.toUpperCase()) {
      case 'FN': card.name = value; break;
      case 'N': if (!card.name) card.name = value.split(';').slice(0, 2).reverse().filter(Boolean).join(' '); break;
      case 'NICKNAME': card.nickname = value; break;
      case 'ORG': card.org = value.replace(/;+$/, '').replace(/;/g, ', '); break;
      case 'TEL': if (value) card.phones.push({ type: types[0] || '', number: value }); break;
      case 'EMAIL': if (value) card.emails.push(value); break;
    }
  }
  return cards;
}

class Contacts {
  constructor(file) {
    this.file = file;
    try { this.list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.list = []; }
  }

  get count() { return this.list.length; }

  importVcf(path) {
    const cards = parseVcf(fs.readFileSync(path, 'utf8'));
    if (!cards.length) throw new Error('no contacts found in that file');
    this.list = cards;
    fs.writeFileSync(this.file, JSON.stringify(cards), { mode: 0o600 });
    return cards.length;
  }

  /** The contact with this phone number (last 10 digits match), or null. */
  byNumber(number) {
    const tail = (n) => String(n || '').replace(/\D/g, '').slice(-10);
    const want = tail(number);
    if (want.length < 7) return null;
    return this.list.find((c) => c.phones.some((p) => tail(p.number) === want)) || null;
  }

  /** Best matches for a name, nickname, relationship word or company (e.g. "mum", "sam", "landlord"). */
  find(query, limit = 5) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const words = q.split(/\s+/);
    const scored = this.list.map((c) => {
      const hay = `${c.name} ${c.nickname} ${c.org}`.toLowerCase();
      let score = 0;
      if (c.name.toLowerCase() === q || c.nickname.toLowerCase() === q) score += 10;
      if (hay.includes(q)) score += 5;
      for (const w of words) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay)) score += 2;
      return [score, c];
    }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(([, c]) => c);
  }
}

module.exports = { Contacts, parseVcf };
