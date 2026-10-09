// The desk session's lines and blocks (docs/voice-prompt.md A2–A5), shared by record-session.mjs (you read them) and
// fake-session.mjs (Kokoro reads them, to test the scoring before a real session). Personal names come from this Mac.
import fs from 'fs';
import os from 'os';
import path from 'path';

const SUPPORT = path.join(os.homedir(), 'Library/Application Support/ARES');
// ---- The lines ---------------------------------------------------------------------------------------------------
// Personal names come from this Mac (contacts, apps, ARES projects) and stay in the local labels file only.
function locals() {
  let contacts = [];
  try {
    contacts = JSON.parse(fs.readFileSync(path.join(SUPPORT, 'contacts.json'), 'utf8'))
      .map((c) => (c.nickname || c.name || '').trim()).filter((n) => /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(n));
  } catch {}
  const apps = fs.readdirSync('/Applications').filter((a) => a.endsWith('.app')).map((a) => a.replace(/\.app$/, '')).filter((a) => /^[A-Za-z][A-Za-z ]{2,15}$/.test(a));
  let projects = [];
  try { projects = fs.readdirSync(path.join(os.homedir(), 'ARES Projects')).filter((p) => !p.startsWith('.')).map((p) => p.replace(/[-_]/g, ' ')); } catch {}
  const pick = (list, n, d) => { const out = []; for (let i = 0; i < n; i++) out.push(list.length ? list[(i * 7919 + 13) % list.length] : d[i % d.length]); return out; };
  return { contacts: pick(contacts, 12, ['Sam', 'Priya', 'Tom']), apps: pick(apps, 8, ['Notes', 'Safari', 'Music']), projects: pick(projects, 3, ['weather app']) };
}
export const L = locals();

export const WAKE = [
  'Hey ARES, what time is it?', 'Hey ARES, set a timer for five minutes.', 'Hey ARES, what\'s the weather like?', 'Hey ARES, pause the music.',
  'Hey ARES, how are my jobs doing?', 'Hey ARES, open {app0}.', 'Hey ARES, remind me to call {c0} at six.', 'Hey ARES.',
  'Hey ARES, are you there?', 'Hey ARES, turn the volume down.', 'ARES, what\'s next on my calendar?', 'ARES, stop.',
];
export const COMMANDS = [
  'What\'s on my calendar tomorrow morning?', 'Text {c1} that I\'ll be ten minutes late.', 'Call {c2}.', 'Open {app1} and {app2}.',
  'Quit {app3}.', 'Set a timer for twenty-five minutes.', 'Remind me to take the bins out at eight tonight.', 'What\'s the weather in Manchester this weekend?',
  'Play something relaxing.', 'Skip this track.', 'Turn the volume up to sixty percent.', 'Lock the screen.', 'How much battery have I got left?',
  'Send the last screenshot to my phone.', 'Find the PDF I downloaded yesterday.', 'Read me my latest email from {c3}.', 'Email {c4} about Friday\'s meeting.',
  'What\'s my {p0} project doing?', 'Start a new project for a habit tracker app.', 'Stop everything.', 'Go quiet.', 'Stay awake.',
  'How\'s my Claude usage looking?', 'Show me my week.', 'What\'s on the twentieth?', 'Add oat milk to my shopping list.',
  'Take a note: ask the landlord about the boiler.', 'Convert eighty kilos to pounds.', 'How do you spell rhythm?', 'What\'s fifteen percent of two hundred and forty?',
  'Turn on do not disturb for an hour.', 'Mute yourself for twenty minutes.', 'Who is {c5}?', 'When did I last talk to {c6}?',
  'Summarise my unread emails.', 'What did Dhruv say about the launcher yesterday?', 'Tell ARES to forget my old address.', 'Never mind.',
  'Say that again.', 'Thanks, that\'s all.', 'Explain how a heat pump works, briefly.', 'Is it going to rain before five?',
  'Move my three o\'clock to four.', 'Cancel the timer.', 'Open the Downloads folder.', 'What\'s the time in Tokyo?',
  'Text {c7} happy birthday.', 'Search the web for the best standing desks.', 'Put the reactor look back on.', 'Power down.',
];
export const PAUSES = [ // say these the way you'd think out loud: pause where the dots are
  'Remind me to... um... call {c8} tomorrow at... nine.', 'Can you find the... the file I was working on for {p0}... yesterday afternoon.',
  'What\'s the... hmm... weather going to be like on Saturday?', 'Send {c9} a message saying... I\'ll be there around... half seven.',
  'Set a timer for... let\'s say... twelve minutes.', 'Open {app4} and then... actually also {app5}.', 'I want to plan... a weekend in... Edinburgh, maybe.',
  'Tell me about... the history of... the London Underground.', 'Add to my list... eggs, bread... and coffee.', 'How long would it take to... drive to... Bristol from here?',
  'What was the name of that... the restaurant {c10} recommended?', 'Move my... meeting with {c11}... to Thursday.', 'Turn the volume... down a bit.',
  'So... what\'s on today?', 'And then... remind me about it at four.',
];
export const fillIn = (t) => t.replace(/\{c(\d+)\}/g, (_, i) => L.contacts[i % L.contacts.length]).replace(/\{app(\d+)\}/g, (_, i) => L.apps[i % L.apps.length])
  .replace(/\{p(\d+)\}/g, (_, i) => L.projects[i % L.projects.length]);

// Each block: where you sit, what's going on in the room, and the lines
export const BLOCKS = {
  wake: { title: 'Wake word, at the desk (about half a metre)', distance: 0.5, condition: 'quiet', lines: WAKE },
  commands: { title: 'Commands, at the desk', distance: 0.5, condition: 'quiet', lines: COMMANDS },
  pauses: { title: 'Thinking out loud: pause where the dots are, the way you would', distance: 0.5, condition: 'quiet', lines: PAUSES },
  lean: { title: 'Wake word, leaning back (about 1 metre)', distance: 1, condition: 'quiet', lines: WAKE },
  far: { title: 'Across the room (about 3 metres): wake word, then a few commands', distance: 3, condition: 'quiet', lines: [...WAKE, ...COMMANDS.slice(0, 15)] },
  music: { title: 'At the desk with music playing at your normal level (start it yourself now)', distance: 0.5, condition: 'music', lines: [...WAKE, ...COMMANDS.slice(15, 30)] },
  tv: { title: 'At the desk with a TV show or YouTube talking in the background (start it yourself now)', distance: 0.5, condition: 'tv', lines: [...WAKE, ...COMMANDS.slice(30, 40)] },
  speaking: { title: 'While ARES is talking (the backup voice plays through the speakers): cut in with the wake word', distance: 0.5, condition: 'speaking', lines: WAKE, voice: true },
  // Other people's voices: a podcast or TV through the speakers, you silent. Only features (speaker embeddings, wake scores)
  // are kept from it: score-session.mjs deletes the audio once they're extracted.
  others: { title: 'Other voices: start a podcast or a TV show with people talking, then stay quiet for 3 minutes', distance: 0.5, condition: 'others', timed: 180, featuresOnly: true, lines: [] },
};
