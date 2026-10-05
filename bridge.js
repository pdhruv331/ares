// Localhost bridge between ARES's tool server (tools/mac.js, run by Claude Code) and the app:
// timers she can announce, and the confirmation gate for actions. Bound to 127.0.0.1 and
// protected by a random per-launch token.
const http = require('http');
const crypto = require('crypto');

// Tools whose name starts with one of these verbs only read; they never need confirmation.
const READ_VERBS = /^(get|list|search|read|find|fetch|suggest|query|view|download|check)_/i;
// Drafts don't go anywhere until sent, so creating one is safe too.
const SAFE_WRITES = /^(create_draft|draft_)/i;
// What counts as the user saying "yes" (must be how their latest message starts).
const AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|sure|go ahead|do it|send it|book it|delete it|move it|confirm(ed)?|please do|ok(ay)?|absolutely|correct|that'?s right|affirmative|go for it)\b/i;

function startBridge({ onTimerDone, onTimers = () => {}, onPhoneAction, onNotify, findContact, memory, teachPhrase, work, calls, claudeUsage, claude = () => null, control = null, log }) {
  const token = crypto.randomBytes(24).toString('hex');
  const timers = new Map(); // label -> { handle, endsAt }
  let lastUserText = '';
  let source = 'mac'; // where the current request came from: mac | phone | telegram
  let verified = false; // the current request is known to be the owner's (Voice ID, keyboard or a paired device)
  let turn = 0;
  let approvedTurn = -1;
  let callTurn = -1; // one "yes" places one call

  const describe = (ms) => {
    const s = Math.round(ms / 1000);
    return s >= 3600 ? `${Math.round(s / 360) / 10} hours` : s >= 60 ? `${Math.round(s / 6) / 10} minutes` : `${s} seconds`;
  };

  // The dashboard's TIMER panels
  // (A paused timer keeps `left` ms and no handle; `started` is when it was first set.)
  const timerList = () => [...timers].map(([label, t]) => ({ label, endsAt: t.endsAt, total: t.total, started: t.started, paused: Boolean(t.paused), left: t.paused ? t.left : t.endsAt - Date.now() }));
  const timersChanged = () => { try { onTimers(timerList()); } catch {} };
  const arm = (label, t, ms) => {
    t.endsAt = Date.now() + ms;
    t.handle = setTimeout(() => { timers.delete(label); timersChanged(); onTimerDone(label, t.from); }, ms);
  };
  /** From the dashboard's TIMER details: pause, resume, add time, cancel. */
  function timerAction(label, action, seconds = 300) {
    const t = timers.get(label);
    if (!t) return false;
    if (action === 'cancel') { clearTimeout(t.handle); timers.delete(label); }
    else if (action === 'pause' && !t.paused) { clearTimeout(t.handle); t.left = Math.max(0, t.endsAt - Date.now()); t.paused = true; }
    else if (action === 'resume' && t.paused) { t.paused = false; arm(label, t, t.left); }
    else if (action === 'add') {
      t.total += seconds * 1000;
      if (t.paused) t.left += seconds * 1000;
      else { clearTimeout(t.handle); arm(label, t, t.endsAt - Date.now() + seconds * 1000); }
    } else return false;
    timersChanged();
    return true;
  }

  const ctl = () => { const c = claude(); if (!c) throw new Error('Claude session control is still starting up'); return c; };
  const ownerOnly = { message: "Refused: that needs the owner, and this request wasn't verified (Voice ID is off, or the voice didn't match). Tell the user briefly: they can type it, use push-to-talk, or turn Voice ID on." };
  const longPoll = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ wait: true }), 60_000))]);

  const routes = {
    '/timer': ({ seconds, label }) => {
      label = (label || 'timer').trim();
      clearTimeout(timers.get(label)?.handle);
      const ms = seconds * 1000;
      const t = { total: ms, started: Date.now(), from: source }; // a timer set from the phone rings on the phone
      arm(label, t, ms);
      timers.set(label, t);
      timersChanged();
      return { message: `Timer "${label}" set for ${describe(ms)}.` };
    },
    // The user's Claude Code sessions (claude-control.js)
    '/claude/sessions': (args) => claude()?.status(args) ?? { message: 'Claude session control is still starting up.' },
    // Writing to a session, starting one or handing one over: only for the verified owner
    '/claude/reply': (args) => (verified ? ctl().reply({ ...args, source }) : ownerOnly),
    '/claude/start': (args) => (verified ? ctl().start({ ...args, aresRepo: Boolean(args.aresRepo) && /\b(ares|my ai)\b/i.test(lastUserText), source }) : ownerOnly),
    '/claude/phone': (args) => (verified ? ctl().toPhone(args) : ownerOnly),
    '/claude/open': (args) => ctl().open(args),
    '/claude/stop': (args) => ctl().stop(args),
    '/claude-usage': () => ({ message: claudeUsage ? claudeUsage() : 'Claude usage tracking is not available.' }),
    '/timers': () => ({
      message: timers.size
        ? [...timers].map(([l, t]) => `${l}: ${describe(t.paused ? t.left : t.endsAt - Date.now())} left${t.paused ? ' (paused)' : ''}`).join('; ')
        : 'No timers running.',
    }),
    '/timer/cancel': ({ label }) => {
      const names = label ? [label] : [...timers.keys()];
      let n = 0;
      for (const l of names) if (timers.has(l)) { clearTimeout(timers.get(l).handle); timers.delete(l); n++; }
      if (n) timersChanged();
      return { message: n ? `Cancelled ${n} timer${n > 1 ? 's' : ''}.` : 'No matching timer.' };
    },
    '/phone-action': (args) => onPhoneAction(args, source),
    '/contacts/find': ({ name }) => findContact(name),
    '/notify': (args) => onNotify(args),
    '/memory/remember': ({ fact }) => { memory.add(fact); log('memory remember'); return { message: 'Saved to memory.' }; },
    '/memory/recall': () => {
      const facts = memory.facts();
      return { message: facts.length ? facts.map((f) => `- ${f}`).join('\n') : 'Your memory is empty.' };
    },
    '/memory/forget': ({ about }) => {
      const gone = memory.forget(about);
      log('memory forget', { removed: gone.length });
      return { message: gone.length ? `Forgot: ${gone.join(' | ')}` : `Nothing in memory matched "${about}".` };
    },
    '/intent/teach': (args) => teachPhrase(args),
    // Work mode (jobs.js): the brain's job controls, and the gate every worker's tool calls go through
    '/work/start': (args) => work.start(args, { source, verified }),
    '/work/list': () => work.list(),
    '/work/cancel': (args) => work.cancel(args),
    '/work/show': (args) => work.show(args, { source }),
    '/work/send-phone': (args) => work.sendToPhone(args),
    '/work/continue': (args) => work.continue(args, { source, verified }),
    '/work/answer': (args) => work.answer(args, { yes: AFFIRMATIVE.test(lastUserText) }),
    // Answers can take a while (the user has to say yes): long-poll in slices, so no HTTP timeout cuts in
    '/work/approve': ({ job, tool, input }) => longPoll(work.gate(job, tool, input)),
    '/work/wait': ({ job }) => longPoll(work.decision(job)),
    // Phone calls (calls.js). mcp__ares tools skip the approve gate, so placing a call checks the yes itself.
    '/calls/make': (args) => {
      if (!calls?.ready) return { message: "The phone line isn't set up yet (ELEVENLABS_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID in the ARES .env)." };
      if (!verified) return { message: "Not placed: I couldn't confirm it's the owner speaking. Ask them to type it or use push-to-talk." };
      if (!AFFIRMATIVE.test(lastUserText) || callTurn === turn) {
        log('gate hold', { tool: 'make_call' });
        return { message: 'Not confirmed yet. In one short sentence tell the user who you\'ll call (name and number), what you\'ll say or ask, and when ' +
          '(now, or the time), and ask them to confirm. Only call after they say yes.' };
      }
      callTurn = turn;
      log('gate allow', { tool: 'make_call', said: lastUserText.slice(0, 40) });
      return calls.make({ ...args, source }).then((message) => ({ message }), (err) => { callTurn = -1; return { message: `Call not placed: ${err.message}.` }; });
    },
    '/calls/list': (args) => ({ message: calls ? calls.list(args) : 'No phone line.' }),
    '/calls/status': (args) => ({ message: calls ? calls.status(args) : 'No phone line.' }),
    '/calls/cancel': ({ call }) => ({ message: calls.cancelScheduled(call) }),
    '/calls/message': (args) => ({ message: calls.addMessage(args) }),
    '/calls/unmessage': (args) => ({ message: calls.removeMessage(args) }),
    '/approve': ({ tool }) => {
      const action = String(tool).split('__').pop();
      if (READ_VERBS.test(action) || SAFE_WRITES.test(action)) return { allow: true };
      return confirm(tool);
    },
  };

  /** Tier 3: the user's latest words have to be a clear yes (one yes covers the actions in that turn). */
  function confirm(what) {
    if (approvedTurn === turn || AFFIRMATIVE.test(lastUserText)) {
      approvedTurn = turn;
      log('gate allow', { what: String(what).slice(0, 60), said: lastUserText.slice(0, 40) });
      return { allow: true, said: lastUserText.slice(0, 80) };
    }
    log('gate hold', { what: String(what).slice(0, 60) });
    return {
      allow: false,
      message: "Not confirmed yet. Tell the user in one short sentence exactly what you're about to do " +
        '(who, what, when) and ask them to confirm. Only do it after they say yes.',
    };
  }
  // Full Mac control (control.js): /control/<route>, with who's asking and the yes-gate
  const controlRoute = (name) => (args) => control.handle(name, args, { source, verified, turn, confirm: (what) => confirm(what) });

  const server = http.createServer((req, res) => {
    const isControl = control && req.url.startsWith('/control/');
    if (req.headers.authorization !== `Bearer ${token}` || req.method !== 'POST' || (!routes[req.url] && !isControl)) {
      res.writeHead(404).end();
      return;
    }
    const handler = isControl ? controlRoute(req.url.slice('/control/'.length)) : routes[req.url];
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      Promise.resolve()
        .then(() => handler(JSON.parse(body || '{}')))
        .then((out) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out)))
        .catch((err) => res.writeHead(400).end(JSON.stringify({ error: err.message })));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      token,
      /** Record what the user just said, so a following "yes" can approve an action. */
      userSaid(text, from = 'mac', isOwner = false) { lastUserText = text; source = from; verified = isOwner; turn++; },
      /** The conversation turn now (control.js holds UI automation for the turn a "stop" landed in). */
      turn: () => turn,
      timers: timerList,
      timerAction,
      /** A reminder from the dashboard ("remind me later"): an ordinary timer she announces on the Mac. */
      remind(label, seconds) {
        clearTimeout(timers.get(label)?.handle);
        const t = { total: Math.max(5, seconds) * 1000, started: Date.now(), from: 'mac' }; // clicked at the Mac: rings here
        arm(label, t, t.total);
        timers.set(label, t);
        timersChanged();
      },
    }));
  });
}

module.exports = { startBridge };
