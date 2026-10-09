const $ = (id) => document.getElementById(id);
const input = $('input');
const micBtn = $('micBtn');

// ---- State ----------------------------------------------------------------
let state = 'idle';
let awakeMode = false; // "stay awake" or desk mode: no wake word needed
let deskOn = false;     // desk mode is what's keeping her listening (desk.js)
let deskWhy = '';       // why desk mode is off right now (idle, on a call, locked…)
function setState(s) {
  state = s;
  HUD.setState(s);
  window.Stars?.setState(s);
  Surface.state(s);
  Dash.state(s);
  $('stateText').textContent = { idle: deskOn ? 'DESK MODE' : awakeMode ? 'ALWAYS LISTENING' : 'ONLINE', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'SPEAKING' }[s];
}

// Delivery cues like [dryly] are for the voice, not the screen (also hides a half-streamed "[dry")
const forDisplay = (text) => text.replace(/\[[a-z ]+\]\s*/gi, '').replace(/\[[^\]]*$/, '').trim();

// The conversation is shown as subtitles (renderer/comms.js) and kept in COMMS, today's history on every device.
// Turns the brain answers reach COMMS from the main process; lines only the window knows about are noted here.
const note = (who, text) => window.ares.comms.note(who, forDisplay(text));
/** A line she shows without saying it: up as a subtitle long enough to read, and kept in COMMS. */
const show = (text) => window.ares.comms.note('ares', forDisplay(text), { notice: true });

// ---- Voice output -------------------------------------------------------------
// Replies are spoken sentence by sentence: each sentence's audio is requested from ElevenLabs the
// moment Claude finishes writing it and played while it streams in, so ARES starts talking about
// half a second after her first sentence instead of after the whole reply. macOS voice without a key.
const Voice = (() => {
  const zero = () => { HUD.setLevel(0); HUD.setSpectrum(new Float32Array(HUD.BARS)); };
  let ttsOn = false;
  window.ares.ttsAvailable().then((on) => { ttsOn = on; });

  // One analyser for everything ARES says, so the HUD follows her real voice
  let audioCtx, analyser, raf = null;
  function ensureAudio() {
    audioCtx ??= new AudioContext();
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      analyser.connect(audioCtx.destination);
    }
  }
  function startMeter() {
    if (raf) return;
    ensureAudio();
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const out = new Float32Array(HUD.BARS);
    const half = HUD.BARS / 2;
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const v = bins[Math.floor((i / half) * bins.length * 0.4)] / 255;
        out[i] = out[HUD.BARS - 1 - i] = v;
        sum += v;
      }
      HUD.setSpectrum(out);
      HUD.setLevel(Math.min(1, (sum / half) * 2));
      raf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stopMeter() { cancelAnimationFrame(raf); raf = null; zero(); }

  // Start fetching a sentence's audio immediately; it's played later, in order.
  function fetchClip(text) {
    const clip = { chunks: [], done: false, error: null, onUpdate: null };
    clip.id = window.ares.ttsStream(
      text,
      (chunk) => { clip.chunks.push(chunk); clip.onUpdate?.(); },
      (err) => { clip.done = true; clip.error = err; clip.onUpdate?.(); },
    );
    return clip;
  }

  // Play a clip's raw PCM (24kHz, 16-bit mono) as chunks arrive, scheduling each one gaplessly
  // after the last. Resolves with an error or null once the final chunk has finished playing.
  const RATE = 24000;
  const live = new Set(); // stop() for each clip playing in the window
  const stopAll = () => [...live].forEach((stop) => stop());
  function playClip(clip, line = null) {
    return new Promise((resolve) => {
      ensureAudio();
      let at = 0;              // audio-clock time where the next chunk should start
      let fed = 0;
      // Subtitle timing from the clip itself: when its audio really started, any stalls waiting for chunks, and
      // where her voice starts and ends inside it (leading/trailing silence), in samples
      let t0 = null, gaps = 0, samples = 0, firstLoud = -1, lastLoud = -1;
      if (line) line.clock = () => {
        if (t0 === null) return null;
        const start = firstLoud < 0 ? 0 : firstLoud / RATE;
        const heard = lastLoud < 0 ? 0 : lastLoud / RATE;
        return { t: audioCtx.currentTime - t0 - gaps, start, end: clip.done ? heard : Math.max(heard, start + line.text.length / 15.5) };
      };
      let carry = null;        // odd trailing byte from the previous chunk
      let last = null;
      let finished = false;
      const sources = new Set();
      const done = (stopped = false) => {
        if (finished) return;
        finished = true;
        clip.onUpdate = null;
        live.delete(stop);
        if (clip.id) window.ares.ttsWindowDone(clip.id, stopped);
        resolve(stopped ? null : clip.error);
      };
      // Barge-in: cut this clip off mid-word
      const stop = () => { clip.onUpdate = null; sources.forEach((s) => { try { s.stop(); } catch {} }); done(true); };
      live.add(stop);
      const pump = () => {
        while (fed < clip.chunks.length) {
          let bytes = clip.chunks[fed++];
          if (carry) { const b = new Uint8Array(carry.length + bytes.length); b.set(carry); b.set(bytes, carry.length); bytes = b; carry = null; }
          if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.slice(0, -1); }
          if (!bytes.length) continue;
          const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
          const buf = audioCtx.createBuffer(1, pcm.length, RATE);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) {
            ch[i] = pcm[i] / 32768;
            if (pcm[i] > 650 || pcm[i] < -650) { if (firstLoud < 0) firstLoud = samples + i; lastLoud = samples + i; }
          }
          samples += pcm.length;
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(analyser);
          const soonest = audioCtx.currentTime + 0.03;
          if (t0 === null) t0 = Math.max(at, soonest);
          else if (at < soonest) gaps += soonest - at; // ran dry waiting for audio: the words wait too
          at = Math.max(at, soonest);
          if (turnStart) {
            window.ares.log('timing first-sound', { ms: Math.round(performance.now() - turnStart + (at - audioCtx.currentTime) * 1000) });
            window.ares.latency('firstAudio', Date.now() + (at - audioCtx.currentTime) * 1000);
            turnStart = 0;
          }
          src.start(at);
          sources.add(src);
          src.addEventListener('ended', () => sources.delete(src));
          at += buf.duration;
          last = src;
        }
        if (clip.done) {
          if (!last) return done();
          last.onended = () => done();
        }
      };
      clip.onUpdate = pump;
      pump();
    });
  }

  // Last resort (the main process's voices all failed): the best British FEMALE macOS voice, Premium/Enhanced
  // first. Never Daniel. Can't be analysed, so it fakes a talking envelope.
  let sysVoice = null;
  const NAMES = ['Serena', 'Kate', 'Stephanie', 'Martha', 'Flo', 'Shelley', 'Sandy'];
  const pick = () => {
    const tier = (v) => (/Premium/.test(v.name) ? 0 : /Enhanced/.test(v.name) ? 1 : 2);
    const rank = (v) => NAMES.findIndex((n) => v.name.startsWith(n));
    const gb = speechSynthesis.getVoices().filter((v) => /^en[-_]GB$/i.test(v.lang) && rank(v) >= 0);
    sysVoice = gb.sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b))[0] || null;
  };
  speechSynthesis.onvoiceschanged = pick;
  pick();

  function speakSystem(text, line = null) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(forDisplay(text));
      u.onboundary = (e) => { if (e.name !== 'sentence') line?.at(e.charIndex); };
      if (sysVoice) u.voice = sysVoice;
      u.lang = 'en-GB';
      u.rate = 1.05;
      let frame;
      const animate = (t) => {
        const env = 0.35 + 0.35 * Math.abs(Math.sin(t / 90)) * (0.6 + 0.4 * Math.sin(t / 37));
        HUD.setLevel(env);
        HUD.setSpectrum(Float32Array.from({ length: HUD.BARS }, (_, i) => env * (0.4 + 0.6 * Math.abs(Math.sin(t / 110 + i * 0.35)))));
        frame = requestAnimationFrame(animate);
      };
      u.onstart = () => { frame = requestAnimationFrame(animate); line?.estimate(14, 0); if (turnStart) { window.ares.latency('firstAudio', Date.now(), { ttsEngine: 'system' }); turnStart = 0; } };
      u.onend = u.onerror = () => { cancelAnimationFrame(frame); zero(); line?.finish(); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  let warned = false;
  const warn = (err) => {
    console.error('TTS failed', err);
    Dash.health('voice', false, /401|403|unauthori|invalid/i.test(String(err)) ? 'ElevenLabs key rejected' : 'voice unavailable');
    if (!warned) { warned = true; show(`Voice module error (${err}). Falling back to the Mac's own voice.`); }
  };
  /** A spoken reply: say() sentences as they're ready; done() resolves when she's finished talking;
   *  cancel() stops the rest (barge-in). */
  function session() {
    let chain = Promise.resolve();
    let failed = false;
    let cancelled = false;
    let inSources = false; // web answers end with a "Sources:" list: shown on screen, never read aloud
    const native = nativeVoice; // through the listener: echo-cancelled, so she can be interrupted
    const say = (text) => {
      if (inSources || cancelled) return;
      const cut = text.search(/(^|\n)\s*Sources?:/i);
      if (cut >= 0) { inSources = true; text = text.slice(0, cut); }
      text = text.replace(/\(?https?:\/\/\S+\)?/g, '').trim(); // never read out web addresses
      if (!/[a-z0-9]/i.test(forDisplay(text))) return;
      window.ares.latency('firstSentence', Date.now(), { firstSentenceChars: text.length }); // (only the first one counts)
      const line = Comms.sentence(text); // its subtitle, lit word by word as she says it
      if (native && ttsOn && !failed) {
        const playing = window.ares.ttsPlay(text); // fetch now; the listener plays clips strictly in order
        chain = chain.then(async () => {
          if (cancelled) return;
          setState('speaking');
          line.start();
          line.estimate(15.5, 0.3); // the listener plays it: no clip timing here, so by speech rate
          const r = await playing;
          if (r.ok) return line.finish();
          if (r.stopped || cancelled) return;
          if (r.native === false) { // listener can't play right now (e.g. muted): play it here
            const clip = fetchClip(text);
            startMeter();
            const err = await playClip(clip, line);
            if (!err) return line.finish();
            failed = true;
            warn(err);
          } else {
            failed = true;
            warn(r.error);
          }
          await speakSystem(text, line);
        });
        return;
      }
      const clip = ttsOn && !failed ? fetchClip(text) : null; // request now, in parallel with playback
      chain = chain.then(async () => {
        if (cancelled) return; // talked over: drop the sentences still queued
        setState('speaking');
        line.start();
        if (clip && !failed) {
          startMeter();
          const err = await playClip(clip, line);
          if (!err) return line.finish();
          failed = true;
          warn(err);
        }
        if (!cancelled) await speakSystem(text, line);
      });
    };
    return {
      say,
      // Her line fades a couple of seconds after she finishes; talked over, it stops where her voice stopped
      done: () => chain.then(() => { stopMeter(); if (!cancelled) Comms.end(); }),
      cancel: () => { cancelled = true; Comms.cut(); stopAll(); speechSynthesis.cancel(); },
    };
  }

  /** Splits streaming text into sentences as they complete. */
  function splitter(onSentence) {
    let consumed = 0;
    let latest = '';
    let timer = null;
    const flush = (end) => {
      if (latest.slice(consumed, end).trim().length < 6) return false; // keep tiny fragments ("Ah.") with the next one
      onSentence(latest.slice(consumed, end));
      consumed = end;
      return true;
    };
    return {
      feed(sofar) {
        latest = sofar;
        clearTimeout(timer);
        const re = /[.!?…]+["')\]]*\s+/g;
        re.lastIndex = consumed;
        let m;
        while ((m = re.exec(sofar))) flush(m.index + m[0].length);
        // A sentence ending right at the edge of what's streamed so far ("Tokyo, sir.") would otherwise
        // wait for the next chunk to arrive with its space. If nothing more comes quickly, speak it now.
        if (/[.!?…]["')\]]*$/.test(sofar)) timer = setTimeout(() => flush(latest.length), 120);
      },
      finish(full) {
        clearTimeout(timer);
        if (full.length > consumed) onSentence(full.slice(consumed));
        consumed = full.length;
      },
    };
  }

  function speak(text) {
    const s = session();
    splitter(s.say).finish(text);
    return s.done();
  }

  return { speak, session, splitter, ready: () => ttsOn };
})();

// ---- Local voice commands (handled instantly, no AI round-trip) --------------
function parseMinutes(text) {
  const m = text.match(/\bfor\s+(half an?|an?|one|\d+)\s*(minute|min|hour|hr)s?\b/i);
  if (!m) return null;
  const n = /half/i.test(m[1]) ? 0.5 : /^(an?|one)$/i.test(m[1]) ? 1 : Number(m[1]);
  return /^h/i.test(m[2]) ? n * 60 : n;
}
const spokenDuration = (min) => (min >= 60 ? `${min / 60 === 1 ? 'an hour' : `${min / 60} hours`}` : `${min} minutes`);

function localCommand(raw) {
  // "Aries, stay awake" / "can you stay awake": the wake word (as heard) and polite openers don't change the command
  const text = raw.trim().replace(/[.!?]+$/, '')
    .replace(/^((hey|ok(ay)?)\s+)?(ares|aries|ayres|arias)\b[,.!]?\s*/i, '')
    .replace(/^(can|could|would|will) you\s+/i, '');
  // The readout callouts open by voice too ("how's my Claude usage?", "battery?", "what's running?", "how's the Mac?")
  const callout = /\b(claude|usage limit|rate limit)\b/i.test(text) && /\b(usage|limit|used|left|how much|how's|hows|how is|status)\b/i.test(text) ? 'claude'
    : /\bbattery\b/i.test(text) && /\b(how|what|status|level|left|charge|low)\b/i.test(text) ? 'battery'
    : /^(what's|whats|what is) (running|working|in progress|the work)\b|^(how are|hows|how's) (the|my) jobs\b|^(show|open) (the )?jobs( readout| callout)?$/i.test(text) ? 'jobs'
    : /^(how's|hows|how is) (the|my) (mac|host|machine|laptop)\b|^(show|open) (the )?host( readout| callout)?$/i.test(text) ? 'host' : null;
  if (callout && window.Callouts) {
    return { reply: '', after: () => { Callouts.open(callout); window.ares.resumeListening(); } };
  }
  if (/^(please\s+)?(stay awake|keep listening|stay with me|conversation mode|always listen(ing)?( mode)?)\b/i.test(text)) {
    return {
      reply: voiceIdOn
        ? "[warmly] I'm all ears, sir. No need to say my name. Tell me to go to sleep when you're done."
        : "I'm all ears, sir. Fair warning: without Voice ID I'll answer anyone in the room. Tell me to go to sleep when you're done.",
      after: () => { window.ares.setAwake(true); window.ares.resumeListening(); },
    };
  }
  if (/^(please\s+)?(go (back )?to sleep|go quiet|be quiet|quiet mode|sleep( now)?|stand ?by|that'?s all|that will be all|you can rest|stop staying awake)\b/i.test(text)) {
    return {
      reply: awakeMode ? "Very good, sir. I'll wait for my name." : "[dryly] I'm already resting, sir. Just say my name.",
      after: () => { window.ares.setAwake(false); window.ares.resumeListening(); },
    };
  }
  if (/^(please\s+)?(stop listening|mute( yourself| the mic(rophone)?)?|stop eavesdropping|don't listen)\b/i.test(text)) {
    const minutes = parseMinutes(text);
    return {
      reply: minutes
        ? `[dryly] Very well, sir. I'll stop listening for ${spokenDuration(minutes)}.`
        : "Understood, sir. I'll stop listening. Press Option Space when you need me.",
      after: () => window.ares.mute(minutes),
    };
  }
  if (/^(please\s+)?(start listening|unmute|listen again|wake up)\b/i.test(text)) {
    return { reply: "I'm listening again, sir. Just say Hey ARES.", after: () => window.ares.unmute() };
  }
  if (/^(please\s+)?(hide|go away|dismiss|minimi[sz]e)( yourself| the window)?$/i.test(text)) {
    return { reply: '', after: () => { window.ares.resumeListening(); window.ares.hide(); } };
  }
  if (/^(please\s+)?((show|open|pull up)( me)?( the| your)? (comms?|coms|comes|calms)|what did you( just)? say|what was that you said)\b/i.test(text)) {
    return { reply: '', after: () => { Comms.open(); window.ares.resumeListening(); } };
  }
  if (/^(please\s+)?(hide|close)( the| your)? (comms?|coms|comes|calms)\b/i.test(text)) {
    return { reply: '', after: () => { Comms.close(); window.ares.resumeListening(); } };
  }
  if (/^(please\s+)?(tidy up|tidy( up)? (the |your )?(panels|screen|dashboard)|clean up (the |your )?(panels|screen|dashboard)|reset (the )?panels)$/i.test(text)) {
    return { reply: '', after: () => { Dash.tidy(); window.ares.resumeListening(); } };
  }
  // The calendar panel: "show me my week", "show the month", "what's on the 20th?", "what about next week?", "collapse it"
  if (/^(?:please\s+)?(?:show|open|pull up)(?: me)?(?: my| the)? (?:week|weekly view|week view|calendar week)\b/i.test(text)) {
    return { reply: '', after: () => { Dash.open('calendar', { view: 'week' }); window.ares.resumeListening(); } };
  }
  if (/^(?:please\s+)?(?:what(?:'s| is| about)|how(?:'s| is)|show(?: me)?)(?: my| the)? next week\b/i.test(text)) {
    return { reply: '', after: () => { Dash.open('calendar', { view: 'week', weekOffset: 1 }); window.ares.resumeListening(); } };
  }
  if (/^(?:please\s+)?(?:show|open|pull up)(?: me)?(?: my| the)? (?:month|monthly view|month view|calendar month)\b/i.test(text)) {
    return { reply: '', after: () => { Dash.open('calendar', { view: 'month' }); window.ares.resumeListening(); } };
  }
  if (/^(?:please\s+)?(?:show|open|pull up)(?: me)?(?: my| the)? (?:calendar|day|today'?s? (?:calendar|schedule|events))\b/i.test(text)) {
    return { reply: '', after: () => { Dash.open('calendar', { view: 'day' }); window.ares.resumeListening(); } };
  }
  const nth = text.match(/^(?:please\s+)?what(?:'s| is| do i have)(?: on| for)?(?: the)? (\d{1,2})(?:st|nd|rd|th)?(?: of ([a-z]+))?\??$/i);
  if (nth) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const m = nth[2] ? months.findIndex((x) => nth[2].toLowerCase().startsWith(x)) : -1;
    if (m >= 0) d.setMonth(m);
    d.setDate(Number(nth[1]));
    if (m < 0 && d.getTime() < Date.now() - 86_400_000) d.setMonth(d.getMonth() + 1); // "the 2nd" on the 20th means next month
    const date = d.getTime();
    const evs = (Dash.events || []).filter((e) => e.start < date + 86_400_000 && e.end > date).sort((a, b) => a.start - b.start);
    const when = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    const fmt = (e) => (e.allDay ? e.title : `${e.title} at ${new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    const reply = !evs.length ? `Nothing on ${when}, sir.` : evs.length === 1 ? `On ${when}: ${fmt(evs[0])}.` : `${evs.length} things on ${when}: ${evs.map(fmt).join(', ')}.`;
    return { reply, after: () => { Dash.open('calendar', { view: 'month', date }); window.ares.resumeListening(); } };
  }
  if (/^(?:please\s+)?(?:refresh|reload|sync|update)(?: my| the)? (?:tasks?|to-?do(?: list)?|task list|reminders)$/i.test(text)) {
    return { reply: 'Refreshing your tasks, sir.', after: () => { window.ares.dash.act('tasks-refresh', {}); Dash.open('tasks'); window.ares.resumeListening(); } };
  }
  if (/^(?:please\s+)?(?:refresh|reload|sync|update)(?: my| the)? calendar$/i.test(text)) {
    return { reply: 'Refreshing your calendar, sir.', after: () => { window.ares.dash.act('calendar-refresh', {}); window.ares.resumeListening(); } };
  }
  if (/^(?:please\s+)?(?:show|open|pull up)(?: me)?(?: my| the)? (?:tasks?|to-?do(?: list)?|task list|reminders)(?: panel)?$/i.test(text)) {
    return { reply: '', after: () => { Dash.open('tasks'); window.ares.resumeListening(); } };
  }
  if (/^(?:please\s+)?(?:collapse|shrink|fold)(?: it| that| the calendar| the panel)?$/i.test(text)) {
    return { reply: '', after: () => { Dash.collapseView('calendar'); window.ares.resumeListening(); } };
  }
  const preview = (Dash.custom || []).find((c) => c.preview);
  if (preview && /^(?:please\s+)?(?:yes,? )?(?:keep (?:it|that|this|the panel)(?: and pin(?: it)?)?|keep and pin(?: it)?|pin it and keep it)\.?$/i.test(text)) {
    const pin = /pin/i.test(text);
    return { reply: pin ? 'Kept and pinned, sir.' : 'Kept, sir.', after: () => { window.ares.dash.act('panels-keep', { id: preview.id, pin }).then(() => { if (pin) Dash.pin(`custom:${preview.id}`, true); }); window.ares.resumeListening(); } };
  }
  if (preview && /^(?:please\s+)?(?:no,? )?(?:discard|drop|forget|bin|scrap)(?: it| that| this| the panel| the preview)?\.?$/i.test(text)) {
    return { reply: 'Discarded, sir.', after: () => { window.ares.dash.act('panels-discard', { id: preview.id }); window.ares.resumeListening(); } };
  }
  let pin = text.match(/^(?:please\s+)?(pin|unpin) (?:my |the )?(.+?)(?: panel)?$/i);
  if (pin) {
    const on = pin[1].toLowerCase() === 'pin';
    const ok = Dash.pin(pin[2], on);
    return { reply: ok ? `${on ? 'Pinned' : 'Unpinned'}, sir.` : on ? `I don't have a ${pin[2]} panel up to pin, sir.` : `The ${pin[2]} panel isn't pinned, sir.`, after: () => window.ares.resumeListening() };
  }
  let place = text.match(/^(?:please\s+)?(?:set|change) (?:my |the )?weather (?:city|location) to (.+)$/i);
  if (place) {
    const city = place[1].trim();
    return { reply: `Weather now follows ${city}, sir.`, after: () => { window.ares.dash.setCity(city); window.ares.resumeListening(); } };
  }
  place = text.match(/^(?:please\s+)?(?:set my home (?:address|location) to|my home address is) (.+)$/i);
  if (place) {
    const home = place[1].trim();
    return { reply: "Noted, sir. Leave-by times will start from there.", after: () => { window.ares.dash.setHome(home); window.ares.resumeListening(); } };
  }
  if (/\b(learn|train|enrol+|register|set ?up|setup|retrain|create|make)\b.*\b(my voice|voice ?(id|print|profile|recognition))\b/i.test(text)) {
    return { reply: '', after: () => runEnrollment() };
  }
  if (/^(please\s+)?(turn off|disable|switch off) (the )?voice (id|lock|verification|recognition)\b/i.test(text)) {
    return { reply: "Voice ID is off, sir. I'll answer to anyone for now.", after: () => setVoiceId(false) };
  }
  if (/^(please\s+)?(turn on|enable|switch on) (the )?voice (id|lock|verification|recognition)\b/i.test(text)) {
    return { reply: "Voice ID is back on. Strangers will be politely turned away.", after: () => setVoiceId(true) };
  }
  return null;
}

// ---- Short remarks: the semantic intent layer (intent.js + remarks.js, in the main process) says what they're
// doing. Clear ones are answered without the brain ("cheers", "say that again"); anything short and less clear
// goes to the brain with what she was just saying, the same on the Mac, the phone and Telegram.

// ---- Conversation loop ----------------------------------------------------
let turnStart = 0;
const AWAKE_NOTE = '(ARES note: always-listening mode, this was overheard without your name. If it is not addressed to you ' +
  '(for example the user talking to someone else, on a call, or thinking aloud), reply with exactly (ignore) and nothing else.)\n\n';
const isIgnore = (t) => /^\s*\(ignore\)?/i.test(t);

let activeTurn = null;
let interruptedNote = ''; // set when the user talks over her, passed to Claude with their next request
async function handle(text, { voice = false, addressed = true, intent = null } = {}) {
  turnStart = performance.now();
  const handleAt = Date.now(); // (also this turn's identity in the latency log)
  window.ares.latency('handle', handleAt);
  const turn = activeTurn = { barged: false, speech: null };
  // Echo-cancelled playback: keep listening so the user can simply talk over her. Otherwise pause.
  if (bargeable && Voice.ready()) window.ares.speakingMode(true); else window.ares.pauseListening();
  window.ares.replyStart();
  const cutIn = interruptedNote; // (not `note`: that would hide note() below)
  interruptedNote = '';
  Comms.user(text);

  // Settings-type commands first ("stay awake", "mute for an hour"), then what a short remark means:
  // cutting her off with "hold up" or "okay thanks" just means stop, "cheers" gets a quick "any time".
  const command = localCommand(text) || Work.command(text) || (Drop.pending ? await Drop.consume(text, { voice }) : null);
  const plan = command ? { notes: '' }
    : await window.ares.planRemark(text, { intent, afterBarge: Boolean(cutIn), addressed }).catch(() => ({ notes: '' }));
  window.ares.latency('plan', Date.now(), { local: Boolean(command || plan.quick) });
  const quick = plan.quick && { ...plan.quick, after: plan.quick.action === 'sleep' ? () => { window.ares.setAwake(false); window.ares.resumeListening(); } : null };
  const local = command || quick;
  if (command) { note('user', text); if (command.reply) note('ares', command.reply); } // brain and quick turns are kept by the main process
  const speech = turn.speech = Voice.session();
  const sentences = Voice.splitter(speech.say);
  let ignored = false;
  let said = ''; // the reply, for desk mode's follow-up judgement
  if (!local) {
    setState('thinking');
    let streamed = '';
    // Overheard (no wake word): hold back until we know she isn't choosing to stay out of it.
    const gate = (t) => addressed || (t.trim().length >= 9 && !isIgnore(t));
    const reply = await Brain.respond(cutIn + plan.notes + Work.contextNote() + (addressed ? '' : AWAKE_NOTE) + text, (sofar) => {
      streamed = sofar;
      if (!gate(sofar)) return;
      sentences.feed(sofar);
    });
    ignored = !addressed && isIgnore(reply);
    if (ignored) Comms.userFade();
    else if (!turn.barged) {
      if (!streamed && reply) { note('user', text); note('ares', reply); } // answered without the brain (offline, error, "forget")
      sentences.finish(streamed || reply);
      said = streamed || reply;
    }
  } else if (local.reply) {
    sentences.finish(local.reply);
    said = local.reply;
  }
  await speech.done();
  window.ares.latency('end', 0, { handleAt, end: turn.barged ? 'barged' : ignored ? 'ignored by the brain' : 'done' });
  // For desk mode: when she last finished, and whether she asked something (a short answer is then for her)
  if (!ignored) window.ares.replyDone(/\?\s*$/.test(forDisplay(said)));
  if (turn.barged) return; // the listener is already capturing what the user is saying
  setState('idle');

  if (local) return local.after ? local.after() : window.ares.resumeListening();
  // After a spoken exchange, keep listening briefly for a follow-up without needing "Hey ARES"
  // (always-listening mode already hears everything).
  if (voice && !listening.muted && !awakeMode) window.ares.listen(5000);
  else window.ares.resumeListening();
}

$('inputForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  handle(text);
});

// ---- Voice input: native "Hey ARES" listener -------------------------------
const listening = { muted: false, ready: false };
const PLACEHOLDER = input.placeholder;
const wakeItem = document.querySelector('[data-key="wake"]');

function chime() {
  try {
    const ctx = new AudioContext();
    [660, 990].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
    setTimeout(() => ctx.close(), 800);
  } catch {}
}

function renderListening() {
  wakeItem.classList.remove('online', 'pending');
  if (listening.ready) wakeItem.classList.add(listening.muted ? 'pending' : 'online');
  wakeItem.lastChild.textContent = listening.muted ? 'Wake word · muted' : deskOn ? 'Desk mode · no wake word' : awakeMode ? 'Always listening' : 'Wake word · Hey ARES';
  // The status bar's ear: how she's listening right now
  const ear = $('ear');
  ear.textContent = listening.muted ? 'MUTED' : deskOn ? 'DESK MODE' : awakeMode ? 'LISTENING' : 'WAKE WORD';
  ear.title = listening.muted ? 'Not listening' : deskOn ? 'Listening without the wake word while you\'re at the Mac (only your voice, only when you talk to her)'
    : awakeMode ? 'Always listening (say "go to sleep" to stop)' : `Say "Hey ARES"${deskWhy ? ` · desk mode: ${deskWhy}` : ''}`;
  ear.className = `ear ${listening.muted ? 'muted' : deskOn || awakeMode ? 'open' : ''}`;
  if (state === 'idle') setState('idle');
  micBtn.title = listening.muted ? 'Muted: click to listen' : 'Click to talk (or say "Hey ARES")';
}

function stopCapturing() {
  micBtn.classList.remove('live');
  input.placeholder = PLACEHOLDER;
  HUD.setLevel(0);
  HUD.setSpectrum(new Float32Array(HUD.BARS));
}

let warnedListener = false;
window.ares.onListener((evt) => {
  switch (evt.type) {
    case 'ready':
      listening.ready = true;
      renderListening();
      refreshNativeVoice();
      break;
    case 'outlevel': {
      if (state !== 'speaking') break;
      const v = evt.v;
      HUD.setLevel(v);
      HUD.setSpectrum(Float32Array.from({ length: HUD.BARS }, (_, i) => v * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.37 + performance.now() / 90)))));
      break;
    }
    case 'error':
      if (evt.code === 'speech-denied' || evt.code === 'mic-denied') Dash.health('mic', false, evt.code === 'mic-denied' ? 'microphone access off' : 'speech recognition off');
      if (warnedListener) break;
      warnedListener = true;
      show({
        'speech-denied': 'I need Speech Recognition permission to hear you, sir: System Settings, Privacy and Security, Speech Recognition.',
        'mic-denied': 'I need microphone access to hear you, sir: System Settings, Privacy and Security, Microphone.',
      }[evt.code] || `My hearing module reported a problem: ${evt.message}.`);
      break;
    case 'wake':
      chime();
      HUD.pulse();
    // fall through
    case 'listening':
      setState('listening');
      micBtn.classList.add('live');
      input.placeholder = 'Listening…';
      break;
    case 'partial':
      setState('listening');
      micBtn.classList.add('live');
      Comms.user(evt.text, { live: true });
      break;
    case 'level': {
      const v = evt.v;
      HUD.setLevel(v);
      HUD.setSpectrum(Float32Array.from({ length: HUD.BARS }, (_, i) => v * (0.3 + 0.7 * Math.abs(Math.sin(i * 0.45 + performance.now() / 120)))));
      break;
    }
    case 'command':
      stopCapturing();
      if (evt.authorized === false) refuse(evt.text);
      else handle(evt.text, { voice: true, addressed: evt.addressed !== false, intent: evt.intent });
      break;
    case 'timeout':
    case 'ignored': // heard without the wake word, and not for her (main.js): nothing more is coming for it
      stopCapturing();
      Comms.userFade();
      if (state === 'listening') setState('idle');
      break;
    case 'awake':
      awakeMode = evt.on;
      if ('desk' in evt) { // (the listener's own echo of "awake on" doesn't say why; main.js's does)
        deskOn = Boolean(evt.desk?.active) && !evt.manual;
        deskWhy = evt.desk && !evt.desk.active ? evt.desk.reason : '';
      }
      renderListening();
      if (state === 'idle') setState('idle');
      // Stopped listening without the wake word (desk mode off, idle, "go quiet"): a capture it started is over
      if (!evt.on && state === 'listening') { stopCapturing(); Comms.userFade(); setState('idle'); }
      if (!evt.on && evt.reason === 'idle') show("It's been quiet for a while, so I've gone back to waiting for my name.");
      break;
    case 'muted':
    case 'unmuted':
      listening.muted = evt.type === 'muted';
      awakeMode = Boolean(evt.awake);
      refreshNativeVoice();
      if (listening.muted) stopCapturing();
      renderListening();
      break;
  }
});

micBtn.addEventListener('click', () => window.ares.listen(6000, true)); // clicking = you're here: trusted

// ---- Barge-in: the user talked over her ------------------------------------------
let nativeVoice = false; // her voice plays through the (echo-cancelled) listener
let bargeable = false;   // echo cancellation is on, so she can be talked over (whichever way her voice plays)
const refreshNativeVoice = () => Promise.all([window.ares.nativePlayback(), window.ares.bargeCapable()])
  .then(([on, barge]) => { nativeVoice = on; bargeable = barge; });
window.ares.onBarge(({ heard }) => {
  const turn = activeTurn;
  if (!turn || turn.barged) return;
  turn.barged = true;
  turn.speech?.cancel();
  interruptedNote = `(ARES note: the user talked over you and you stopped mid-reply${heard ? `; they heard you say: "${heard.slice(-300)}"` : ' before you had said anything'}. Respond to what they say now.)\n\n`;
  setState('listening');
  micBtn.classList.add('live');
  input.placeholder = 'Listening…';
});

/** A raised palm while she speaks (renderer/hands.js): she stops, silently, and waits; nothing is captured. */
function stopSilently(how) {
  const turn = activeTurn;
  window.ares.hands.act('stop'); // her voice, wherever it's playing, and the brain's reply
  if (!turn || turn.barged) return;
  turn.barged = true;
  turn.speech?.cancel();
  interruptedNote = `(ARES note: the user stopped you mid-reply with ${how}; you said nothing more. Carry on only if asked.)\n\n`;
  setState('idle');
  window.ares.speakingMode(false);
  window.ares.resumeListening();
}
const App = { get state() { return state; }, stopSilently };

// ---- Voice ID: only the owner's voice gets through ------------------------------
const voiceIdItem = document.querySelector('[data-key="voiceid"]');
let voiceIdOn = false;
function renderVoiceId(s) {
  voiceIdOn = s.enabled;
  voiceIdItem.classList.remove('online', 'pending');
  voiceIdItem.classList.add(s.enabled ? 'online' : 'pending');
  voiceIdItem.lastChild.textContent = !s.enrolled ? 'Voice ID · not set up' : s.enabled ? 'Voice ID · owner only' : 'Voice ID · off';
}
const refreshVoiceId = () => window.ares.voiceId.status().then((s) => { renderVoiceId(s); return s; });
window.ares.voiceId.onChanged(renderVoiceId);
async function setVoiceId(on) {
  const s = await window.ares.voiceId.status();
  if (on && !s.enrolled) return runEnrollment();
  renderVoiceId(await window.ares.voiceId.enable(on));
  window.ares.resumeListening();
}

const REFUSALS = [
  "[dryly] I'm afraid you're not authorised to access me. Nice try, though.",
  "Access denied. You're not on the list, and I don't do guest passes.",
  "[amused] Voice not recognised. I've been told not to talk to strangers.",
  "I'm sorry, I only take instructions from my principal. You'll have to find your own assistant.",
  "[dryly] Unauthorised voice detected. I'll pretend I didn't hear that.",
];
async function refuse(text) {
  window.ares.pauseListening();
  Comms.user(text, { stranger: true });
  note('stranger', text);
  const line = REFUSALS[Math.floor(Math.random() * REFUSALS.length)];
  note('ares', line);
  await Voice.speak(line);
  setState('idle');
  window.ares.resumeListening(); // no follow-up window for strangers
}

const ENROLL_PHRASES = [
  "Hey ARES, what's on my calendar for tomorrow morning?",
  'Remind me to call the bank at four o\'clock this afternoon.',
  'ARES, read me the latest messages from the team.',
  'The quick brown fox jumps over the lazy dog, twice.',
  "What's the weather going to be like this weekend?",
  'Turn on focus mode and hold my notifications for an hour.',
];
let enrolling = false;
async function runEnrollment() {
  if (enrolling) return;
  enrolling = true;
  window.ares.pauseListening();
  await window.ares.voiceId.start();
  const intro = "Right then, sir. Let's teach me your voice. When each line appears, read it aloud in your normal speaking voice.";
  note('ares', intro);
  await Voice.speak(intro);

  let good = 0;
  for (const [i, phrase] of ENROLL_PHRASES.entries()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      Comms.notice(`(${i + 1}/${ENROLL_PHRASES.length}) Please say: “${phrase}”`, 30_000); // up until it's read
      setState('listening');
      micBtn.classList.add('live');
      chime();
      const r = await window.ares.voiceId.record();
      stopCapturing();
      Comms.userFade();
      setState('idle');
      if (r.ok) { good++; break; }
      Comms.notice(r.reason === 'no-speech' ? "I didn't hear anything. Let's try that one again." : 'That was a touch short. Once more, please.');
    }
  }

  const result = await window.ares.voiceId.finish();
  const outro = result.ok
    ? "Done. Your voiceprint is saved on this Mac, and from now on I'll only take instructions from you, sir."
    : "I couldn't get enough clear samples, sir. Say learn my voice whenever you'd like to try again.";
  note('ares', outro);
  window.ares.pauseListening();
  await Voice.speak(outro);
  setState('idle');
  await refreshVoiceId();
  enrolling = false;
  window.ares.resumeListening();
}
window.ares.voiceId.onEnrollRequest(() => runEnrollment());

// Integrations panel: real connection status (online / needs sign-in / off)
const GOOGLE = { calendar: 'Calendar', gmail: 'Gmail', drive: 'Drive' };
function renderIntegrations(status) {
  if (!status) return;
  // Calendar, Gmail and Drive share one "Google" row: on when all are connected, amber if only some are
  const google = Object.keys(GOOGLE).map((k) => status[k]);
  status = { ...status, google: google.every((s) => s === 'online') ? 'online' : google.some((s) => s !== 'off') ? 'pending' : 'off' };
  for (const [key, state] of Object.entries(status)) {
    const li = document.querySelector(`[data-key="${key}"]`);
    if (!li) continue;
    li.classList.remove('online', 'pending');
    if (state !== 'off') li.classList.add(state);
    li.title = { online: 'Connected', pending: 'Needs sign-in: run claude, then /mcp', off: 'Not connected' }[state];
  }
  // Hover the Google row to see each service
  document.querySelector('[data-key="google"]').title = Object.entries(GOOGLE)
    .map(([k, name]) => `${name}: ${{ online: 'connected', pending: 'needs sign-in', off: 'not connected' }[status[k]]}`).join('\n');
}
window.ares.onIntegrations(renderIntegrations);
window.ares.integrations().then(renderIntegrations);

// Conversations from the phone and Telegram reach COMMS from the main process (marked by source)
window.ares.onRemotePairing(({ bot, code }) => show(
  `To reach me from your phone, open Telegram, find @${bot}, and send this code: ${code}`));

// Timers set by voice ("set a ten minute timer for the pasta")
window.ares.onTimerDone(async (label) => {
  const line = label && label !== 'timer' ? `Sir, your ${label} timer is done.` : 'Sir, your timer is done.';
  window.ares.pauseListening();
  chime();
  note('ares', line);
  await Voice.speak(line);
  setState('idle');
  window.ares.resumeListening();
});
// Work mode: a job finished or needs a yes, and the user is at the Mac. Wait for her to be free, then say it.
let announcing = Promise.resolve();
window.ares.work.onAnnounce((a) => {
  announcing = announcing.then(async () => {
    for (let waited = 0; state !== 'idle' && waited < 60_000; waited += 400) await new Promise((r) => setTimeout(r, 400));
    if (a.open) Work.open(a.id);
    window.ares.pauseListening();
    chime();
    if (!a.remembered) note('ares', a.line);
    await Voice.speak(a.line);
    setState('idle');
    window.ares.resumeListening();
  });
});

// A detail card's action that sends or changes something ("text them I'm late", "draft a reply"): handled as if
// the user had typed it, so the brain's usual confirmation ("yes") applies before anything goes out.
window.addEventListener('ares-ask', (e) => { if (e.detail) handle(e.detail); });

// Something to say that didn't come from a turn (a job started from dropped files with a button)
window.addEventListener('ares-say', (e) => {
  announcing = announcing.then(async () => {
    if (state !== 'idle') return show(e.detail);
    note('ares', e.detail);
    window.ares.pauseListening();
    await Voice.speak(e.detail);
    setState('idle');
    window.ares.resumeListening();
  });
});

refreshVoiceId().then((s) => {
  if (!s.enrolled) setTimeout(() => show('Tip: say “ARES, learn my voice” so I only answer to you.'), 2500);
});

refreshNativeVoice();
window.ares.listenerState().then((s) => {
  listening.muted = s.muted;
  awakeMode = Boolean(s.awake);
  deskOn = Boolean(s.desk?.active) && !s.manual;
  deskWhy = s.desk && !s.desk.active ? s.desk.reason : '';
  if (!s.available) wakeItem.lastChild.textContent = 'Wake word · not installed';
  renderListening();
});

// ---- Chrome: clock, stats, window controls ---------------------------------
function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], { hour12: false });
  $('date').textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

async function refreshStats() {
  const s = await window.ares.systemStats();
  $('host').textContent = `${s.user}@${s.host}`;
  $('cpuBar').style.width = `${s.cpu * 100}%`;
  $('cpuVal').textContent = `${Math.round(s.cpu * 100)}%`;
  $('memBar').style.width = `${s.memUsed * 100}%`;
  $('memVal').textContent = `${Math.round(s.memUsed * 100)}%`;
  const hrs = Math.floor(s.uptime / 3600);
  $('uptime').textContent = `${Math.floor(hrs / 24)}d ${hrs % 24}h ${Math.floor((s.uptime % 3600) / 60)}m`;
}
// Stats live in the status list (click the status pill): only fetched while it's open
setInterval(() => { if (!$('statusPanel').hidden) refreshStats(); }, 3000);
window.addEventListener('status-open', refreshStats);
refreshStats();

let pinned = false;
$('pinBtn').addEventListener('click', () => {
  pinned = !pinned;
  window.ares.pin(pinned);
  $('pinBtn').classList.toggle('active', pinned);
});
$('hideBtn').addEventListener('click', () => window.ares.hide());
$('fullBtn').addEventListener('click', () => window.ares.toggleFullscreen());
let fullscreen = false;
window.ares.onFullscreen((on) => {
  fullscreen = on;
  document.body.classList.toggle('fullscreen', on);
  $('fullBtn').classList.toggle('active', on);
});
window.ares.onSummoned(() => input.focus());
// The corner orb (orb.js): a question from its menu or a drop ("What's on my screen?", "Explain this…") takes the usual
// path, spoken with the caption; a click on it while she speaks stops her silently, like a raised palm.
window.ares.orb.onAsk((text) => { if (typeof text === 'string' && text.trim()) handle(text.trim(), { voice: false, addressed: true }); });
window.ares.orb.onStop(() => stopSilently('the orb'));
// Esc leaves fullscreen first, then hides
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (Dash.closeCard()) return; // an open detail card folds back first
  if (Work.isOpen) return Work.back();
  if (fullscreen) window.ares.toggleFullscreen();
  else window.ares.hide();
});

// Integration status (voice + brain are next up)
window.ares.brainAvailable().then((on) => { document.querySelector('[data-key="brain"]').classList.add(on ? 'online' : 'pending'); if (!on) HUD.offline?.(true); });
// The look (◉ menu: Reactor / Brain), applied as soon as it's known and whenever it changes
const applyLook = (p) => { if (p?.look && window.Scene) Scene.setLook(p.look); };
window.ares.uiPrefs().then(applyLook);
window.ares.onUiPrefs(applyLook);
window.ares.ttsAvailable().then((on) => document.querySelector('[data-key="voice"]').classList.add(on ? 'online' : 'pending'));

// ---- Boot -----------------------------------------------------------------
// The greeting is the wake line at the end of the charge-to-wake (renderer/power.js, docs/ignition-prompt.md §4).
