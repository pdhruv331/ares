// ARES's long-term memory: a plain Markdown file of facts about the user, kept only on this Mac
// (~/Library/Application Support/ARES/memory.md, readable by you alone). You can open and edit it freely.
// Facts are added as they come up (the remember tool) and the whole file is tidied at the end of each
// conversation: new durable facts merged in, duplicates removed, outdated ones updated.
const fs = require('fs');

const HEADER = '# What ARES remembers about you\n\n' +
  '<!-- One fact per line, starting with "- ". Edit freely: ARES reads this at the start of every conversation. -->\n\n';
const MAX_FACTS = 150;

class Memory {
  constructor(file) {
    this.file = file;
    if (!fs.existsSync(file)) this.save([]);
  }

  /** The facts, one per line (always read from disk, so your own edits count). */
  facts() {
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n')
        .filter((l) => /^\s*[-*]\s+\S/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
    } catch { return []; }
  }

  get count() { return this.facts().length; }

  save(facts) {
    const unique = [...new Map(facts.map((f) => [f.toLowerCase(), f.trim()])).values()].filter(Boolean).slice(-MAX_FACTS);
    fs.writeFileSync(this.file, HEADER + unique.map((f) => `- ${f}`).join('\n') + (unique.length ? '\n' : ''), { mode: 0o600 });
    return unique.length;
  }

  add(fact) {
    fact = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!fact) throw new Error('nothing to remember');
    this.save([...this.facts(), fact]);
    return fact;
  }

  /** Remove every fact that mentions all the words of `about`. Returns what was removed. */
  forget(about) {
    const words = String(about || '').toLowerCase().match(/[a-z0-9']+/g) || [];
    if (!words.length) return [];
    const facts = this.facts();
    const gone = facts.filter((f) => words.every((w) => f.toLowerCase().includes(w)));
    if (gone.length) this.save(facts.filter((f) => !gone.includes(f)));
    return gone;
  }

  clear() {
    try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch {}
    this.save([]);
  }

  /** Replace everything with a consolidated list (keeps the previous file as memory.md.bak). */
  replace(facts) {
    try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch {}
    return this.save(facts);
  }
}

/** The instruction for the end-of-conversation tidy-up (run as a separate, tool-less Claude call). */
function consolidationPrompt(facts, transcript) {
  return `You maintain the long-term memory of ARES, a personal voice assistant, about its one user.

CURRENT MEMORY (one fact per line):
${facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(empty)'}

CONVERSATION THAT JUST ENDED:
${transcript}

Write the updated memory. Rules:
- Add durable facts worth knowing in future conversations: the user's name, people in their life and who they are, preferences, routines, work, projects, plans and upcoming dates (with the actual date), how they like ARES to behave.
- Skip small talk, one-off requests (weather, timers, music), anything already done, and anything sensitive like passwords, codes, card or account numbers.
- Update facts that changed (replace the old one), merge duplicates, drop facts that are clearly out of date (past one-off plans).
- If the user asked ARES to forget something, leave it out.
- Keep each fact to one short sentence in the third person ("The user's sister is Priya."). At most 100 facts.
- Keep every existing fact that is still true, word for word.

Reply with only the full updated list, one fact per line starting with "- ", and nothing else. If there is nothing to remember at all, reply with exactly: NONE`;
}

module.exports = { Memory, consolidationPrompt };
