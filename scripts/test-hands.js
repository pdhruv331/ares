#!/usr/bin/env node
// Gesture engine tests (hands.js), no camera needed: synthetic clips (scripts/hands-synth.js) and any recorded
// clips in <support>/hands/clips/*.json (record from the ◉ menu's Hand Gestures › Record a Test Clip…, dev only).
// Every positive clip must produce its action; no negative clip may produce anything. Prints the false-trigger rate.
//   node scripts/test-hands.js [-v] [clips-dir]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { replay } = require('../hands');
const { CLIPS } = require('./hands-synth');

const verbose = process.argv.includes('-v');
const dirArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const clipsDir = dirArg || path.join(os.homedir(), 'Library', 'Application Support', 'ARES', 'hands', 'clips');

// What each positive clip must produce (and what it must not)
const EXPECT = {
  engage: { has: [(a) => a.type === 'state' && a.state === 'engaged'] },
  palmStop: { has: [(a) => a.type === 'palm'] },
  quickPinch: { has: [(a) => a.type === 'up' && a.click], not: [(a) => a.type === 'move'] },
  grabThrow: { has: [(a) => a.type === 'down', (a) => a.type === 'move', (a) => a.type === 'up' && !a.click] },
  dragSlow: { has: [(a) => a.type === 'down', (a) => a.type === 'move', (a) => a.type === 'up' && !a.click] },
  swipeLeft: { has: [(a) => a.type === 'swipe' && a.dir === 'left'], not: [(a) => a.type === 'swipe' && a.dir !== 'left'], once: 'swipe' },
  swipeRight: { has: [(a) => a.type === 'swipe' && a.dir === 'right'], not: [(a) => a.type === 'swipe' && a.dir !== 'right'], once: 'swipe' },
  swipeUp: { has: [(a) => a.type === 'swipe' && a.dir === 'up'], not: [(a) => a.type === 'swipe' && a.dir !== 'up'], once: 'swipe' },
  swipeDown: { has: [(a) => a.type === 'swipe' && a.dir === 'down'], not: [(a) => a.type === 'swipe' && a.dir !== 'down'], once: 'swipe' },
  scroll: { has: [(a) => a.type === 'scroll' && a.dy > 0], not: [(a) => a.type === 'swipe'] },
  zoomIn: { has: [(a) => a.type === 'zoom' && a.phase === 'end' && a.scale > 1.4], not: [(a) => a.type === 'down'] },
  zoomOut: { has: [(a) => a.type === 'zoom' && a.phase === 'end' && a.scale < 0.75], not: [(a) => a.type === 'down'] },
};
const NEGATIVE = ['typing', 'typingOpenLow', 'restingHands', 'scratchFace', 'chinOnHand', 'waveAtSomeone', 'heldPeaceSign', 'stretching',
  'engagedThenPeace', 'engagedThenTyping', 'engagedScratch'];
// Things that count as "something fired" in a negative clip (a cursor moving, or camera/state bookkeeping, don't)
const FIRES = (a) => ['down', 'up', 'swipe', 'scroll', 'palm'].includes(a.type) || (a.type === 'zoom' && a.phase === 'start') || (a.type === 'state' && a.state === 'engaged');
// Engaged negatives may be engaged (that's the setup) but nothing else
const ENGAGED_OK = new Set(['engagedThenPeace', 'engagedThenTyping', 'engagedScratch']);

let pass = 0, fail = 0, negTotal = 0, negFired = 0;
const summarise = (actions) => actions.filter((a) => a.type !== 'cursor' && a.type !== 'move' && !(a.type === 'zoom' && a.phase === 'update'))
  .map((a) => `${a.type}${a.state ? `:${a.state}` : ''}${a.dir ? `:${a.dir}` : ''}${a.click ? ':click' : ''}${a.phase ? `:${a.phase}${a.phase === 'end' ? `×${a.scale}` : ''}` : ''}@${a.ts}`).join(' ');

function check(name, clip, expect, negative) {
  const actions = replay(clip, {}, { onTarget: () => Boolean(clip.onTarget ?? false) });
  if (negative) {
    negTotal++;
    const fired = actions.filter((a) => FIRES(a) && !(ENGAGED_OK.has(name) && a.type === 'state'));
    if (fired.length) { negFired++; fail++; console.log(`✗ ${name}: fired ${summarise(fired)}`); }
    else { pass++; if (verbose) console.log(`✓ ${name}: quiet (${summarise(actions) || 'nothing'})`); }
    return;
  }
  const missing = (expect.has || []).filter((fn) => !actions.some(fn));
  const bad = (expect.not || []).filter((fn) => actions.some(fn));
  const extra = expect.once ? actions.filter((a) => a.type === expect.once).length > 1 : false;
  if (missing.length || bad.length || extra) { fail++; console.log(`✗ ${name}: ${missing.length ? 'missing expected action' : bad.length ? 'forbidden action' : 'fired more than once'}\n    ${summarise(actions)}`); }
  else { pass++; if (verbose) console.log(`✓ ${name}: ${summarise(actions)}`); }
}

console.log('— synthetic clips');
for (const [name, make] of Object.entries(CLIPS)) check(name, make(), EXPECT[name], NEGATIVE.includes(name));

// Recorded clips: <name>.json with { kind: 'positive'|'negative', expect: '<action type>', frames, aspect }
if (fs.existsSync(clipsDir)) {
  const files = fs.readdirSync(clipsDir).filter((f) => f.endsWith('.json'));
  if (files.length) console.log(`— recorded clips in ${clipsDir}`);
  for (const f of files) {
    try {
      const clip = JSON.parse(fs.readFileSync(path.join(clipsDir, f), 'utf8'));
      const name = f.replace(/\.json$/, '');
      if (clip.kind === 'negative') check(name, clip, null, true);
      else {
        const want = clip.expect || name.replace(/[-_ ]?\d+$/, '');
        const fn = EXPECT[want] || { has: [(a) => a.type === want || (a.type === 'swipe' && `swipe${a.dir[0].toUpperCase()}${a.dir.slice(1)}` === want)] };
        check(name, clip, fn, false);
      }
    } catch (err) { fail++; console.log(`✗ ${f}: ${err.message}`); }
  }
}

console.log(`\n${pass} passed, ${fail} failed · false triggers: ${negFired}/${negTotal} negative clips (${negTotal ? Math.round((negFired / negTotal) * 100) : 0}%)`);
process.exit(fail ? 1 : 0);
