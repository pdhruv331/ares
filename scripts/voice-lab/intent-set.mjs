// The intent test set (docs/voice-prompt.md A8): labelled routes, slots and entities, deliberate negatives, and noisy-
// transcript variants. Personal names are placeholders ({contact}, {app}, {project}) filled at run time from the
// support folder's contacts and the Mac's apps, so nobody's name is ever committed.
//
// Each case: [text, route, slots?, flags?]
//   route   what should happen: a registry route (timer.set, volume.set, app.open …), a remark (remark.stop …), a listening
//           control (listen.quiet …), or 'chat' (a question or conversation for the brain) / 'none' (not for her at all).
//   flags   neg: a deliberate negative (looks like a command, isn't one) · model: the brain model it deserves
//           (haiku | sonnet | opus) when it goes to the brain.
// Which routes today's code can answer without the brain is FAST_TODAY below; B13's registry will widen it.

export const CASES = [
  // ---- Remarks (intent.js + remarks.js: answered on the Mac today) ------------------------------------------------
  ['stop', 'remark.stop'], ['stop stop stop', 'remark.stop'], ['hold on', 'remark.stop'], ['wait a sec', 'remark.stop'],
  ['hang on hang on', 'remark.stop'], ['shush', 'remark.stop'], ['okay okay enough', 'remark.stop'], ['whoa whoa', 'remark.stop'],
  ['thanks', 'remark.thanks'], ['cheers', 'remark.thanks'], ['thank you ARES', 'remark.thanks'], ['nice one, thanks', 'remark.thanks'],
  ['brilliant, ta', 'remark.thanks'], ['got it', 'remark.thanks'], ['perfect thank you', 'remark.thanks'],
  ['say that again', 'remark.repeat'], ['what did you say', 'remark.repeat'], ['sorry, come again?', 'remark.repeat'],
  ['can you repeat that', 'remark.repeat'], ['pardon?', 'remark.repeat'],
  ['never mind', 'remark.nevermind'], ['forget it', 'remark.nevermind'], ['actually don\'t worry about it', 'remark.nevermind'],
  ['that\'s all for now', 'remark.sleep'], ['that\'ll be all', 'remark.sleep'], ['okay I\'m done, thanks', 'remark.sleep'],
  ['yeah go on', 'remark.continue'], ['mm-hm', 'remark.continue'], ['carry on', 'remark.continue'], ['right, and then?', 'remark.continue'],
  ['yes', 'remark.yes'], ['yeah do it', 'remark.yes'], ['go ahead', 'remark.yes'], ['no', 'remark.no'], ['nah, the other one', 'remark.no'],

  // ---- Listening controls (localCommand in the window today) ------------------------------------------------------
  ['go quiet', 'listen.quiet'], ['stop listening', 'listen.mute'], ['stop listening for an hour', 'listen.mute', { minutes: 60 }],
  ['mute yourself for 20 minutes', 'listen.mute', { minutes: 20 }], ['stay awake', 'listen.awake'], ['keep listening', 'listen.awake'],
  ['go to sleep', 'listen.quiet'], ['start listening', 'listen.unmute'], ['show me the comms', 'ui.comms'], ['hide', 'ui.hide'],
  ['tidy up the panels', 'ui.tidy'], ['show me my week', 'calendar.show', { view: 'week' }], ['show the month', 'calendar.show', { view: 'month' }],
  ['what\'s on the 20th', 'calendar.day', { day: 20 }], ['how\'s my Claude usage', 'readout.claude'], ['battery?', 'battery.query'],
  ['how much battery is left', 'battery.query'], ['what\'s running', 'readout.jobs'], ['show my tasks', 'tasks.show'],
  ['pin the weather', 'ui.pin', { panel: 'weather' }], ['set my weather city to Manchester', 'settings.weatherCity', { city: 'Manchester' }],

  // ---- Power and the kill switch (main.js before the brain) ------------------------------------------------------
  ['power down', 'power.down'], ['ARES, shut down', 'power.down'], ['stop everything', 'autonomy.stopAll'], ['pause all the jobs', 'autonomy.stopAll'],

  // ---- Mac actions (all go to the brain today; B13's fast-path candidates) --------------------------------------
  ['set a timer for five minutes', 'timer.set', { minutes: 5 }, { model: 'haiku' }],
  ['timer, ten minutes', 'timer.set', { minutes: 10 }, { model: 'haiku' }],
  ['set a 90 second timer', 'timer.set', { seconds: 90 }, { model: 'haiku' }],
  ['start a pasta timer for 11 minutes', 'timer.set', { minutes: 11, label: 'pasta' }, { model: 'haiku' }],
  ['cancel the timer', 'timer.cancel', {}, { model: 'haiku' }], ['how long is left on the timer', 'timer.query', {}, { model: 'haiku' }],
  ['wake me up at 7 tomorrow', 'alarm.set', { time: '07:00' }, { model: 'haiku' }],
  ['turn the volume down', 'volume.down', {}, { model: 'haiku' }], ['volume up a bit', 'volume.up', {}, { model: 'haiku' }],
  ['set the volume to 30 percent', 'volume.set', { level: 30 }, { model: 'haiku' }], ['mute the sound', 'volume.mute', {}, { model: 'haiku' }],
  ['play some music', 'media.play', {}, { model: 'haiku' }], ['pause the music', 'media.pause', {}, { model: 'haiku' }],
  ['skip this song', 'media.next', {}, { model: 'haiku' }], ['go back a track', 'media.previous', {}, { model: 'haiku' }],
  ['play Radiohead', 'media.play', { query: 'Radiohead' }, { model: 'haiku' }],
  ['open {app}', 'app.open', { app: '{app}' }, { model: 'haiku' }], ['launch {app}', 'app.open', { app: '{app}' }, { model: 'haiku' }],
  ['can you open {app} for me', 'app.open', { app: '{app}' }, { model: 'haiku' }], ['quit {app}', 'app.quit', { app: '{app}' }, { model: 'haiku' }],
  ['close Safari', 'app.quit', { app: 'Safari' }, { model: 'haiku' }], ['lock the screen', 'screen.lock', {}, { model: 'haiku' }],
  ['lock my Mac', 'screen.lock', {}, { model: 'haiku' }],
  ['what time is it', 'time.query', {}, { model: 'haiku' }], ['what\'s the date today', 'date.query', {}, { model: 'haiku' }],
  ['what day is it', 'date.query', {}, { model: 'haiku' }], ['what\'s the time in Tokyo', 'time.query', { place: 'Tokyo' }, { model: 'haiku' }],
  ['what\'s the weather like', 'weather.query', {}, { model: 'haiku' }], ['is it going to rain later', 'weather.query', {}, { model: 'haiku' }],
  ['what\'s the weather in London tomorrow', 'weather.query', { place: 'London', day: 'tomorrow' }, { model: 'haiku' }],
  ['remind me to call the dentist at 3', 'reminder.add', { text: 'call the dentist', time: '15:00' }, { model: 'haiku' }],
  ['remind me in an hour to take the washing out', 'reminder.add', { text: 'take the washing out', in: 60 }, { model: 'haiku' }],
  ['take a note: buy batteries', 'note.add', { text: 'buy batteries' }, { model: 'haiku' }],
  ['add milk to my shopping list', 'tasks.add', { text: 'milk', list: 'shopping' }, { model: 'haiku' }],
  ['what\'s 15 percent of 80', 'calc', { expr: '15% of 80' }, { model: 'haiku' }], ['convert 10 miles to kilometres', 'convert', {}, { model: 'haiku' }],
  ['how do you spell necessary', 'spell', { word: 'necessary' }, { model: 'haiku' }],
  ['turn on do not disturb', 'system.dnd', { on: true }, { model: 'haiku' }], ['turn wifi off', 'system.wifi', { on: false }, { model: 'haiku' }],
  ['take a screenshot', 'screen.shot', {}, { model: 'haiku' }], ['empty the trash', 'files.trash', {}, { model: 'sonnet' }],

  // ---- Personal data and people (the brain; entity resolution matters) --------------------------------------------
  ['call {contact}', 'contact.call', { contact: '{contact}' }, { model: 'sonnet' }],
  ['ring {contact}', 'contact.call', { contact: '{contact}' }, { model: 'sonnet' }],
  ['text {contact} I\'m running late', 'contact.text', { contact: '{contact}', message: 'I\'m running late' }, { model: 'sonnet' }],
  ['send {contact} a message saying see you at 8', 'contact.text', { contact: '{contact}', message: 'see you at 8' }, { model: 'sonnet' }],
  ['email {contact} about the invoice', 'contact.email', { contact: '{contact}', topic: 'the invoice' }, { model: 'sonnet' }],
  ['what\'s on my calendar today', 'calendar.query', { date: 'today' }, { model: 'sonnet' }],
  ['when\'s my next meeting', 'calendar.query', { next: true }, { model: 'sonnet' }],
  ['move my 3 o\'clock to 4', 'calendar.move', { from: '15:00', to: '16:00' }, { model: 'sonnet' }],
  ['any new emails', 'mail.query', {}, { model: 'sonnet' }], ['read my latest email from {contact}', 'mail.read', { contact: '{contact}' }, { model: 'sonnet' }],
  ['find the PDF I downloaded yesterday', 'files.find', { kind: 'pdf', when: 'yesterday' }, { model: 'sonnet' }],
  ['send this to my phone', 'phone.send', {}, { model: 'sonnet' }], ['what\'s my {project} project doing', 'project.status', { project: '{project}' }, { model: 'sonnet' }],
  ['how are my Claude sessions doing', 'claude.sessions', {}, { model: 'sonnet' }],

  // ---- Questions and conversation (the brain) ----------------------------------------------------------------------
  ['hey, how\'s it going', 'chat', {}, { model: 'haiku' }], ['good morning', 'chat', {}, { model: 'haiku' }],
  ['who won the match last night', 'chat', {}, { model: 'sonnet' }], ['what\'s the capital of Peru', 'chat', {}, { model: 'sonnet' }],
  ['why is the sky blue', 'chat', {}, { model: 'sonnet' }], ['what do you think of my idea about the app', 'chat', {}, { model: 'sonnet' }],
  ['tell me a joke', 'chat', {}, { model: 'haiku' }], ['I\'m knackered today', 'chat', {}, { model: 'sonnet' }],
  ['compare the M5 Pro and the M5 Max for video editing', 'chat', {}, { model: 'opus' }],
  ['help me plan a weekend in Edinburgh', 'chat', {}, { model: 'opus' }], ['draft a reply to the landlord about the boiler', 'chat', {}, { model: 'opus' }],
  ['research the best standing desks and write it up', 'job.start', {}, { model: 'opus' }],
  ['explain how a heat pump works', 'chat', {}, { model: 'opus' }],

  // ---- Deliberate negatives: command-shaped, but not the command ------------------------------------------------------
  ['what\'s a good volume for a podcast', 'chat', {}, { neg: true, model: 'sonnet' }],
  ['the timer on the oven is broken again', 'none', {}, { neg: true }],
  ['I need to call mum later', 'none', {}, { neg: true }], ['I should text Sam back', 'none', {}, { neg: true }],
  ['open source is the way to go honestly', 'none', {}, { neg: true }], ['let\'s just play it by ear', 'none', {}, { neg: true }],
  ['stop it Jake', 'none', {}, { neg: true }], ['wait for me at the door', 'none', {}, { neg: true }],
  ['thanks for nothing mate', 'none', {}, { neg: true }], ['I can\'t stop thinking about that film', 'none', {}, { neg: true }],
  ['he said never mind the rest', 'none', {}, { neg: true }], ['did you lock the car', 'none', {}, { neg: true }],
  ['the music was too loud at that gig', 'none', {}, { neg: true }], ['remind me what we were talking about', 'chat', {}, { neg: true, model: 'sonnet' }],
  ['I was reading about Ares the Greek god', 'none', {}, { neg: true }], ['Aries is my star sign', 'none', {}, { neg: true }],
  ['Harris called earlier', 'none', {}, { neg: true }], ['we flew to Paris in May', 'none', {}, { neg: true }],
  ['go to sleep you silly dog', 'none', {}, { neg: true }], ['shut up, no way!', 'none', {}, { neg: true }],
  ['yes I know, Mum', 'none', {}, { neg: true }], ['no no, put it on the left', 'none', {}, { neg: true }],
  ['how much battery does the new iPhone have', 'chat', {}, { neg: true, model: 'sonnet' }],
  ['what time does the shop close', 'chat', {}, { neg: true, model: 'sonnet' }],
  ['power down the generator first', 'none', {}, { neg: true }], ['stop everything you\'re doing and look at this', 'none', {}, { neg: true }],
];

// Routes today's code answers without the brain (renderer localCommand, intent.js + remarks.js local intents, main.js
// power/kill phrases). Everything else today goes to the brain.
export const FAST_TODAY = new Set(['remark.stop', 'remark.thanks', 'remark.repeat', 'remark.nevermind', 'remark.sleep',
  'listen.quiet', 'listen.mute', 'listen.awake', 'listen.unmute', 'ui.comms', 'ui.hide', 'ui.tidy', 'ui.pin', 'calendar.show', 'calendar.day',
  'readout.claude', 'readout.jobs', 'battery.query', 'tasks.show', 'settings.weatherCity', 'power.down', 'autonomy.stopAll']);

// Noisy-transcript variants: what an ASR typically does to a command (the real ones come from the A4 recordings).
const NAME_MISHEARD = ['Aries', 'Harris', 'Paris', 'a res', 'heiress'];
const HOMOPHONES = [[/\btwo\b/i, 'to'], [/\bfor\b/i, 'four'], [/\bto\b/i, 'two'], [/\bright\b/i, 'write'], [/\bhour\b/i, 'our'],
  [/\bmusic\b/i, 'muse ick'], [/\btimer\b/i, 'time er'], [/\bminutes\b/i, 'minute'], [/\bvolume\b/i, 'volumes']];
export function noisy(text, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  out.push(text.toLowerCase().replace(/[.,!?:']/g, ''));                                   // no punctuation or case
  for (const [re, to] of HOMOPHONES) if (re.test(text)) { out.push(text.replace(re, to)); break; } // one homophone
  const words = text.split(' ');
  if (words.length > 3) out.push(words.filter((_, i) => i !== 1 + Math.floor(rnd() * (words.length - 2))).join(' ')); // a dropped word
  out.push(`um ${text}`);                                                                   // a filler in front
  out.push(`${NAME_MISHEARD[Math.floor(rnd() * NAME_MISHEARD.length)]} ${text}`);           // her name, misheard, in front
  return [...new Set(out)].filter((v) => v !== text);
}
