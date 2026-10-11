// "Ideas" starters (docs/phone-ui-prompt.md §8, from Meta Muse's Ideas library): two or three chips under the phone's reactor,
// chosen from what's relevant right now (the time, the calendar, recent jobs) and from things the owner repeats (the same
// seen-table autonomy.js uses for routine suggestions). Few and accurate, never a catalogue; a learned shortcut is offered once
// a day. No model call: rules over real data.

const hourOf = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * @param {object} o  { events: [{title, start, end, allDay, location}], jobs: [job], seen: {key: [{day, hour}]}, offered: {key: day},
 *                      job: a job id the receipt is for (optional), now: Date }
 * @returns {{label: string, ask: string, kind: string}[]}  at most three
 */
function ideas({ events = [], jobs = [], seen = {}, offered = {}, job = null, now = new Date() } = {}) {
  const out = [];
  const t = now.getTime();
  const hour = now.getHours() + now.getMinutes() / 60;
  const add = (label, ask, kind) => { if (out.length < 3 && !out.some((o) => o.ask === ask)) out.push({ label, ask, kind }); };

  // A receipt: what to do next with THIS job
  if (job) {
    const j = jobs.find((x) => x.id === job);
    if (j) {
      if (j.status === 'done') { add('Send it to my Mac', `Open the "${j.title}" job on my Mac.`, 'job'); add('Summarise it', `Give me the key points of the "${j.title}" job in three lines.`, 'job'); add('Turn it into a routine', `Could the "${j.title}" job become a routine? Suggest a schedule.`, 'job'); }
      else if (j.status === 'failed') { add('Try again', `Retry the "${j.title}" job.`, 'job'); add('What went wrong?', `What went wrong with the "${j.title}" job, in one sentence?`, 'job'); }
      else if (j.status === 'approval') add('Why is it asking?', `Why does the "${j.title}" job need my OK, in one sentence?`, 'job');
      else { add('How far along?', `How far along is the "${j.title}" job?`, 'job'); add('Stop it', `Stop the "${j.title}" job.`, 'job'); }
    }
    return out;
  }

  // The next event: prep before it, a summary after it
  const next = events.filter((e) => !e.allDay && e.start > t - 10 * 60_000).sort((a, b) => a.start - b.start)[0];
  if (next) {
    const mins = Math.round((next.start - t) / 60_000);
    if (mins <= 120 && mins > -10) add(`Prep me for ${next.title.slice(0, 22)}`, `Prepare me for "${next.title}" at ${hourOf(next.start)}: what it's about, who's there, anything I should have ready.`, 'calendar');
    else if (mins <= 8 * 60) add(`What's at ${hourOf(next.start)}?`, `What do I need to know for "${next.title}" at ${hourOf(next.start)}?`, 'calendar');
  }
  // The morning: a brief; the evening: tomorrow
  if (hour >= 5 && hour < 11) add("Brief me on today", 'Brief me on today: my calendar, anything waiting on me, and what the jobs did overnight.', 'time');
  else if (hour >= 18 && hour < 23) add("What's on tomorrow?", "What's on my calendar tomorrow, and is there anything I should prepare tonight?", 'time');

  // Jobs: one finished and unseen, or one waiting
  const waiting = jobs.find((j) => j.status === 'approval');
  if (waiting) add(`OK the ${waiting.title.slice(0, 18)} job?`, `What is the "${waiting.title}" job asking me to approve, in one sentence?`, 'job');
  const fresh = jobs.filter((j) => j.status === 'done' && !j.seen).sort((a, b) => (b.finished || 0) - (a.finished || 0))[0];
  if (fresh) add(`What did ${fresh.title.slice(0, 18)} find?`, `Give me the key points of the "${fresh.title}" job in three lines.`, 'job');

  // A learned shortcut: something asked on 3+ days around this hour, offered once a day
  const today = now.toISOString().slice(0, 10);
  for (const [key, list] of Object.entries(seen)) {
    if (out.length >= 3) break;
    if (!Array.isArray(list) || list.length < 3 || offered[key] === today) continue;
    const near = list.filter((e) => Math.abs(e.hour - hour) <= 1).length;
    if (near >= 2) { add(key.charAt(0).toUpperCase() + key.slice(1) + '…', key, 'learned'); offered[key] = today; }
  }
  return out;
}

module.exports = { ideas };
