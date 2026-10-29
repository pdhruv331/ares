#!/usr/bin/env node
// Phone UI v3 (docs/phone-ui-prompt.md), the Mac side without Claude: the card catalogue's validation, the outgoing check's
// routing and local rules (a fake one-shot), the ideas starters, and the job approval's edit / undo window with a fake worker.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateCard } = require('../src/cards');
const { isOutgoing, check } = require('../src/sentinel');
const { ideas } = require('../src/ideas');

let n = 0;
const ok = (name) => { n++; console.log(`  ok ${name}`); };

// ---- Cards ------------------------------------------------------------------------------------------------------
{
  const good = validateCard({ kind: 'event', title: 'Dentist tomorrow', when: 'Tue 10:30', where: 'High St', actions: [{ label: 'Directions', url: 'https://maps.google.com/?q=High+St' }, { label: 'Remind me', ask: 'remind me an hour before the dentist' }] });
  assert(good.card && good.card.kind === 'event' && good.card.actions.length === 2, 'event card validates');
  assert(validateCard({ kind: 'weird', title: 'x', text: 'y' }).card.kind === 'text', 'unknown kind → text');
  assert(validateCard({ kind: 'summary', title: 'one two three four five six seven eight nine ten eleven twelve thirteen' }).error, 'title cap');
  assert(validateCard({ kind: 'summary', title: 'x', actions: [{ label: 'a', url: 'javascript:alert(1)' }] }).error, 'bad url refused');
  assert(validateCard({ kind: 'summary', title: 'x', actions: [{ label: 'a', api: '/api/power/standby' }] }).error, 'api outside jobs refused');
  assert(validateCard({ kind: 'list', title: 't', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).card.items.length === 6, 'items capped at 6');
  assert(validateCard({ kind: 'summary' }).error === 'the card is empty', 'empty card refused');
  ok('cards: catalogue validation');
}

// ---- Sentinel ---------------------------------------------------------------------------------------------------
{
  assert(isOutgoing('mcp__gmail__send_message', {}), 'send_message is outgoing');
  assert(!isOutgoing('mcp__ares__send_to_phone', {}), 'send_to_phone is internal');
  assert(!isOutgoing('mcp__ares__phone_action', { kind: 'text' }), 'phone_action composes, does not send');
  assert(!isOutgoing('Read', {}) && !isOutgoing('WebSearch', {}), 'reads are not outgoing');
  assert(isOutgoing('Bash', { command: 'git push origin main' }), 'git push is outgoing');
  assert(!isOutgoing('Bash', { command: 'npm test' }), 'npm test is not');
  ok('sentinel: what counts as outgoing');
}
(async () => {
  const calls = [];
  const fake = async (prompt) => { calls.push(prompt); return prompt.includes('bob@evil.example') ? '{"ok": false, "reason": "recipient not in contacts"}' : '{"ok": true, "reason": "matches the request"}'; };
  const contacts = { list: [{ name: 'Sam', emails: ['sam@example.com'], phones: [] }], byNumber: () => null, find: (q) => (q.includes('sam') ? [{ name: 'Sam' }] : []) };
  let v = await check({ request: 'email sam the notes', tool: 'mcp__gmail__send_message', input: { to: 'sam@example.com', body: 'notes' }, contacts }, fake);
  assert(v.ok === true && calls[0].includes('in contacts (Sam)'), 'known recipient passes, contacts consulted');
  v = await check({ request: 'email sam the notes', tool: 'mcp__gmail__send_message', input: { to: 'bob@evil.example', body: 'notes' }, contacts }, fake);
  assert(v.ok === false && /recipient/.test(v.reason), 'unknown recipient fails');
  v = await check({ request: 'send it', tool: 'mcp__gmail__send_message', input: { to: 'sam@example.com', body: 'key: sk-abcdefghijklmnop1234' }, contacts }, fake);
  assert(v.ok === false && /key/.test(v.reason) && calls.length === 2, 'a secret fails locally, no model call');
  v = await check({ request: 'x', tool: 'mcp__gmail__send_message', input: {} }, async () => { throw new Error('down'); });
  assert(v.ok === null, 'checker down → no verdict, never a false pass');
  ok('sentinel: verdicts');

  // ---- Ideas ------------------------------------------------------------------------------------------------------
  {
    const now = new Date(); now.setHours(8, 30, 0, 0);
    const events = [{ title: 'Standup', start: now.getTime() + 40 * 60_000, end: now.getTime() + 70 * 60_000, allDay: false }];
    const jobs = [{ id: 'j1', title: 'Flight options', status: 'done', seen: false, finished: now.getTime() }, { id: 'j2', title: 'Invoice', status: 'approval' }];
    const list = ideas({ events, jobs, seen: {}, offered: {}, now });
    assert(list.length === 3 && list[0].kind === 'calendar' && /Standup/.test(list[0].ask), 'the next meeting comes first');
    assert(list.some((i) => i.kind === 'time') && list.every((i) => i.ask.length > 0), 'a morning brief, every chip asks something');
    const offered = {};
    const learned = ideas({ events: [], jobs: [], seen: { 'check the weather in leeds': [{ day: 'a', hour: 8.4 }, { day: 'b', hour: 8.6 }, { day: 'c', hour: 8.2 }] }, offered, now });
    assert(learned.some((i) => i.kind === 'learned') && Object.keys(offered).length === 1, 'a repeated request becomes a chip, offered once');
    assert(!ideas({ events: [], jobs: [], seen: { 'check the weather in leeds': [{ day: 'a', hour: 8.4 }, { day: 'b', hour: 8.6 }, { day: 'c', hour: 8.2 }] }, offered, now }).some((i) => i.kind === 'learned'), 'not twice the same day');
    const receipt = ideas({ events: [], jobs, job: 'j1', now });
    assert(receipt.length === 3 && receipt.every((i) => i.kind === 'job'), 'a receipt gets job follow-ups');
    ok('ideas: starters');
  }

  // ---- Approvals: edit, the undo window, the sentinel verdict on the request -------------------------------------
  {
    const { Jobs } = require('../src/jobs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-ui-'));
    const jobs = new Jobs({ dir, cli: '/bin/false', tools: () => [], runtime: dir });
    const audit = []; jobs.audit = { record: (e) => audit.push(e) };
    const job = jobs.start({ title: 'Send the notes', task: 'email sam the notes', size: 'small', source: 'phone' });
    jobs.sentinel = async () => ({ ok: false, reason: 'recipient not in contacts', at: Date.now(), what: 'send' });
    // EDIT: the worker is told the change and to ask again
    let p = jobs.ask(job, 'mcp__gmail__send_message', { to: 'bob@evil.example' });
    await new Promise((r) => setTimeout(r, 20));
    assert(job.status === 'approval' && job.approval.check && job.approval.check.ok === false, 'the verdict joined the request');
    assert(jobs.answer(job.id, false, undefined, { edit: 'send it to sam instead', from: 'phone' }) === true);
    let d = await p;
    assert(d.allow === false && /sam instead/.test(d.message) && /ask again/.test(d.message), 'edit → a change for the worker');
    // A yes from the phone is held; undo withdraws it
    p = jobs.ask(job, 'mcp__gmail__send_message', { to: 'sam@example.com' });
    assert(jobs.answer(job.id, true, undefined, { from: 'phone' }) === true);
    assert(job.undo && job.undo.until > Date.now() && job.status === 'running', 'undo window open');
    assert(jobs.undo(job.id).ok === true);
    d = await p;
    assert(d.allow === false && /withdrew/.test(d.message) && !job.undo, 'undone → denied');
    assert(jobs.undo(job.id).error, 'nothing to undo twice');
    // A yes from the Mac runs at once
    p = jobs.ask(job, 'mcp__gmail__send_message', { to: 'sam@example.com' });
    jobs.answer(job.id, true);
    d = await p;
    assert(d.allow === true && !job.undo, 'the Mac\'s own yes has no window');
    const r = jobs.receipt(job.id);
    assert(r.events.some((e) => e.kind === 'check-failed') && r.checks.length >= 1 && audit.some((a) => /outgoing check/.test(a.what)), 'the receipt carries steps, checks and the audit saw it');
    jobs.shutdown();
    ok('approvals: edit, undo, verdicts, receipt');
  }
  console.log(`${n} groups passed`);
  process.exit(0); // (the Jobs module keeps timers; nothing else to wait for)
})().catch((err) => { console.error(err); process.exit(1); });
