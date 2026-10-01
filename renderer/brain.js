// ARES's brain, renderer side. Uses Claude via Claude Code (in the main process) when it's installed,
// otherwise a handful of local canned replies.
// Contract: Brain.respond(text, onPartial) -> Promise<string>, where the string may contain
// ElevenLabs v3 delivery cues like [dryly]. onPartial receives the reply so far as it streams.
const Brain = (() => {
  const greet = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };

  const rules = [
    [/^(hi|hello|hey|yo)\b|ares\??$/i, () => `${greet()}, sir. All systems are online.`],
    [/\btime\b/i, () => `It's ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`],
    [/\b(date|day|today)\b/i, () => `Today is ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}.`],
    [/\b(status|systems?|diagnostic)/i, async () => {
      const s = await window.ares.systemStats();
      return `Running on ${s.host}. CPU load ${Math.round(s.cpu * 100)} percent, memory ${Math.round(s.memUsed * 100)} percent. All nominal.`;
    }],
    [/\b(thank|thanks)\b/i, () => 'Always a pleasure, sir.'],
  ];

  async function local(text) {
    await new Promise((r) => setTimeout(r, 400));
    for (const [re, fn] of rules) if (re.test(text)) return fn(text);
    return "My reasoning core isn't connected, sir. Install Claude Code and sign in, then restart me.";
  }

  async function respond(text, onPartial = () => {}) {
    if (/^(forget|reset|clear)\b.*\b(conversation|chat|memory|that)\b/i.test(text)) {
      window.ares.resetBrain();
      return '[dryly] Consider it forgotten, sir. Clean slate.';
    }
    if (!(await window.ares.brainAvailable())) return local(text);

    let sofar = '';
    const res = await window.ares.ask(text, (delta) => { sofar += delta; onPartial(sofar); });
    if (!res.ok) return `Apologies, sir: ${res.error}.`;
    return res.text;
  }

  return { respond };
})();
