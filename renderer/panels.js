// The views drawn inside dash.js's panels (docs/panels-prompt.md, sections 2, 4, 5, 6): the expandable CALENDAR
// (DAY · WEEK · MONTH), TASKS, and the custom panel templates. Each view renders into its panel's .dp-view at FULL
// density; the panel sizes itself to the content and dash.js's flow moves the neighbours. A view is registered with
// Dash.view(name, { size, render(p, host, ctx), act(p, action, el, ctx), touched(p, ctx), open(p, opts, ctx), sig(p, ctx) }).
const PanelViews = (() => {
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DAY = 86_400_000;
  const pad2 = (n) => String(n).padStart(2, '0');
  const hm = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const startOfWeek = (ms) => { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }; // Monday
  const WD = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const settings = { collapseSec: 60 }; // (dash passes prefs.calendarCollapseSec when set)

  // Colour by kind: cyan = my day, violet = work, amber = important (needs me)
  const IMPORTANT = /\b(interview|flight|deadline|doctor|dentist|exam|hospital|visa|court|urgent|important|board|investor|pitch)\b/i;
  const WORKISH = /\b(standup|stand-up|sync|1:1|one on one|review|retro|planning|sprint|meeting|call|demo|deploy|release|focus|deep work)\b/i;
  const kindOf = (ev) => (ev.important || IMPORTANT.test(ev.title) ? 'needs' : ev.kind === 'work' || WORKISH.test(ev.title) || /work/i.test(ev.calendar || '') ? 'work' : 'day');
  const important = (ev) => kindOf(ev) === 'needs';
  const onDay = (events, day) => events.filter((e) => e.start < day + DAY && e.end > day && !(e.allDay && e.start >= day + DAY));

  // ---- CALENDAR ----------------------------------------------------------------------------------------------------------
  // One panel, three views switched by text tabs in the header. It collapses back to DAY after a while without a touch.
  const Cal = { view: 'day', sel: null, weekOff: 0, timer: null, snapTimer: null, release: null };
  const calEl = (p) => p.parts.view;

  function calHeader(view, titleText) {
    const tab = (v, label) => `<span class="cal-tab${view === v ? ' on' : ''}" data-act="view:${v}">${label}</span>`;
    return `<div class="cal-head"><span class="cal-title">${esc(titleText)}</span><span class="cal-tabs">${tab('day', 'DAY')}<i>·</i>${tab('week', 'WEEK')}<i>·</i>${tab('month', 'MONTH')}</span></div>`;
  }
  function eventRow(ev, now, i, { time = true } = {}) {
    const k = kindOf(ev);
    const live = ev.start <= now && ev.end > now;
    return `<div class="cal-ev k-${k}${live ? ' live' : ''}${ev.end <= now ? ' past' : ''}" data-act="event:${i}">
      ${time ? `<span class="cal-time">${ev.allDay ? 'ALL DAY' : hm(ev.start)}</span>` : ''}<i class="cal-bar"></i><span class="cal-name">${esc(ev.title)}</span>
      ${ev.location && !/https?:/.test(ev.location) ? `<span class="cal-where">${esc(ev.location.split(',')[0])}</span>` : ''}</div>`;
  }
  const nowLine = () => '<div class="cal-now"><i></i></div>';

  function renderDay(events, now) {
    const today = startOfDay(now);
    const list = onDay(events, today).sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.start - b.start));
    const d = new Date(now);
    let html = calHeader('day', `${WD[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}`);
    html += '<div class="cal-list">';
    if (!list.length) html += '<div class="cal-empty">nothing scheduled today</div>';
    let placedNow = false;
    list.forEach((ev, i) => {
      const upcoming = !ev.allDay && ev.start > now;
      if (upcoming && !placedNow) { html += nowLine(); placedNow = true; }
      html += eventRow(ev, now, events.indexOf(ev));
    });
    if (!placedNow && list.length) html += nowLine();
    html += '</div>';
    // The rest of the week: the remaining days with an event count each (amber if a day has something important)
    const rest = [];
    for (let t = today + DAY; t < startOfWeek(now) + 7 * DAY; t += DAY) {
      const evs = onDay(events, t);
      rest.push(`<span class="cal-rest-day${evs.some(important) ? ' hot' : ''}${evs.length ? '' : ' none'}" data-act="day:${t}"><b>${WD[(new Date(t).getDay() + 6) % 7].slice(0, 2)}</b><em>${evs.length || '·'}</em></span>`);
    }
    if (rest.length) html += `<div class="cal-rest"><span class="cal-sub">REST OF THE WEEK</span><div class="cal-rest-days">${rest.join('')}</div></div>`;
    return html;
  }

  function renderWeek(events, now) {
    const week0 = startOfWeek(now) + Cal.weekOff * 7 * DAY;
    const days = [...Array(7)].map((_, i) => week0 + i * DAY);
    const timed = days.flatMap((t) => onDay(events, t).filter((e) => !e.allDay));
    let h0 = 8, h1 = 20;
    for (const e of timed) { h0 = Math.min(h0, new Date(e.start).getHours()); h1 = Math.max(h1, Math.min(24, new Date(e.end - 1).getHours() + 1)); }
    const hours = h1 - h0, PX = 22; // px per hour
    const title = Cal.weekOff === 0 ? 'THIS WEEK' : Cal.weekOff === 1 ? 'NEXT WEEK' : Cal.weekOff === -1 ? 'LAST WEEK' : `${new Date(week0).getDate()} ${MONTHS[new Date(week0).getMonth()]}`;
    let html = calHeader('week', title);
    html += `<div class="cal-week" style="--h0:${h0};--rows:${hours};--px:${PX}px">`;
    html += '<div class="cal-hours">' + [...Array(hours + 1)].map((_, i) => `<span style="top:${i * PX}px">${pad2(h0 + i)}</span>`).join('') + '</div>';
    html += '<div class="cal-cols">';
    for (const t of days) {
      const d = new Date(t);
      const isToday = t === startOfDay(now);
      const evs = onDay(events, t);
      const allDay = evs.filter((e) => e.allDay);
      html += `<div class="cal-col${isToday ? ' today' : ''}" data-act="day:${t}"><div class="cal-colhead"><b>${WD[(d.getDay() + 6) % 7].slice(0, 2)}</b><em>${d.getDate()}</em>${allDay.length ? `<i class="cal-alld k-${kindOf(allDay[0])}" title="${esc(allDay.map((e) => e.title).join(', '))}"></i>` : ''}</div><div class="cal-grid">`;
      for (let i = 0; i < hours; i++) html += `<i class="cal-line" style="top:${i * PX}px"></i>`;
      for (const e of evs.filter((x) => !x.allDay)) {
        const top = Math.max(0, ((Math.max(e.start, t) - t) / 3_600_000 - h0) * PX), bottom = Math.min(hours * PX, ((Math.min(e.end, t + DAY) - t) / 3_600_000 - h0) * PX);
        html += `<span class="cal-block k-${kindOf(e)}${e.start <= now && e.end > now ? ' live' : ''}" style="top:${top}px;height:${Math.max(6, bottom - top)}px" data-act="event:${events.indexOf(e)}" title="${esc(e.title)}">${bottom - top >= 14 ? esc(e.title) : ''}</span>`;
      }
      if (isToday) { const y = ((now - t) / 3_600_000 - h0) * PX; if (y >= 0 && y <= hours * PX) html += `<i class="cal-nowline" style="top:${y}px"></i>`; }
      html += '</div></div>';
    }
    html += '</div></div>';
    html += `<div class="cal-foot"><span data-act="week:-1">‹ PREV</span><span data-act="week:0" class="${Cal.weekOff ? '' : 'dim'}">TODAY</span><span data-act="week:1">NEXT ›</span></div>`;
    return html;
  }

  function renderMonth(events, now) {
    const sel = Cal.sel ?? startOfDay(now);
    const base = new Date(sel); base.setDate(1);
    const month0 = base.getTime();
    const first = startOfWeek(month0);
    let html = calHeader('month', `${MONTHS[base.getMonth()]} ${base.getFullYear()}`);
    html += '<div class="cal-month"><div class="cal-wd">' + WD.map((w) => `<span>${w[0]}</span>`).join('') + '</div><div class="cal-days">';
    for (let i = 0; i < 42; i++) {
      const t = first + i * DAY;
      const d = new Date(t);
      if (i >= 35 && d.getMonth() !== base.getMonth()) break;
      const evs = onDay(events, t);
      const dots = evs.slice(0, 3).map((e) => `<i class="k-${kindOf(e)}"></i>`).join('');
      html += `<span class="cal-day${d.getMonth() !== base.getMonth() ? ' other' : ''}${t === startOfDay(now) ? ' today' : ''}${t === sel ? ' sel' : ''}" data-act="pick:${t}"><em>${d.getDate()}</em><b>${dots}</b></span>`;
    }
    html += '</div></div>';
    const list = onDay(events, sel).sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.start - b.start));
    const sd = new Date(sel);
    html += `<div class="cal-agenda"><span class="cal-sub">${sel === startOfDay(now) ? 'TODAY' : `${WD[(sd.getDay() + 6) % 7]} ${sd.getDate()} ${MONTHS[sd.getMonth()]}`}</span>`;
    html += list.length ? list.map((e) => eventRow(e, now, events.indexOf(e))).join('') : '<div class="cal-empty">nothing that day</div>';
    html += `</div><div class="cal-foot"><span data-act="month:-1">‹</span><span data-act="month:0" class="${sel === startOfDay(now) ? 'dim' : ''}">TODAY</span><span data-act="month:1">›</span></div>`;
    return html;
  }

  function armCollapse(ctx) {
    clearTimeout(Cal.timer);
    const secs = Number(settings.collapseSec) || 60;
    Cal.timer = setTimeout(() => { Cal.view = 'day'; Cal.weekOff = 0; Cal.sel = null; ctx.refresh(); Cal.release?.(); }, secs * 1000);
  }
  function switchView(p, ctx, next, patch = {}) {
    const host = calEl(p);
    Object.assign(Cal, patch);
    if (Cal.view !== next || patch.animate) {
      Cal.view = next;
      if (!ctx.reduce) host.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' }); // the content cross-fades while the box resizes
    }
    p.viewSig = null;
    ctx.refresh();
    armCollapse(ctx);
  }

  const calendar = {
    size: { w: 250, h: 150 },
    sig: (p, ctx) => `${Cal.view}|${Cal.sel}|${Cal.weekOff}|${Math.floor(ctx.now / 60_000)}|${(ctx.model.events || []).map((e) => `${e.start}${e.end}${e.title}`).join()}`,
    render(p, host, ctx) {
      const events = (ctx.model.events || []).slice().sort((a, b) => a.start - b.start);
      host.className = `dp-view cal cal-v-${Cal.view}`;
      host.innerHTML = Cal.view === 'week' ? renderWeek(events, ctx.now) : Cal.view === 'month' ? renderMonth(events, ctx.now) : renderDay(events, ctx.now);
      if (!host._wheel) { // scroll in WEEK: previous / next week (snaps back after a minute)
        host._wheel = true;
        let acc = 0;
        host.addEventListener('wheel', (e) => {
          if (Cal.view !== 'week') return;
          e.preventDefault(); e.stopPropagation();
          acc += e.deltaY + e.deltaX;
          if (Math.abs(acc) < 60) return;
          Cal.weekOff += acc > 0 ? 1 : -1; acc = 0;
          switchView(p, ctx, 'week', { animate: true });
          clearTimeout(Cal.snapTimer);
          Cal.snapTimer = setTimeout(() => { if (Cal.weekOff) { Cal.weekOff = 0; p.viewSig = null; ctx.refresh(); } }, 60_000);
        }, { passive: false });
      }
    },
    act(p, action, el, ctx) {
      const [what, arg] = action.split(':');
      const events = ctx.model.events || [];
      if (what === 'view') switchView(p, ctx, arg);
      else if (what === 'day') switchView(p, ctx, 'month', { sel: Number(arg) });
      else if (what === 'pick') switchView(p, ctx, 'month', { sel: Number(arg), animate: false });
      else if (what === 'week') { Cal.weekOff = arg === '0' ? 0 : Cal.weekOff + Number(arg); switchView(p, ctx, 'week', { animate: true }); }
      else if (what === 'month') {
        if (arg === '0') Cal.sel = null;
        else { const d = new Date(Cal.sel ?? startOfDay(ctx.now)); d.setDate(1); d.setMonth(d.getMonth() + Number(arg)); Cal.sel = d.getTime(); }
        switchView(p, ctx, 'month', { animate: true });
      } else if (what === 'event') {
        const ev = events.slice().sort((a, b) => a.start - b.start)[Number(arg)];
        if (ev) { ctx.update({ info: { type: 'event', ev } }); ctx.openCard(); }
      }
    },
    touched(p, ctx) { armCollapse(ctx); },
    /** "Show me my week", "what's on the 20th?": from voice or the brain. opts: { view, date (ms), weekOffset } */
    open(p, opts, ctx) {
      const patch = {};
      if (opts.date) patch.sel = startOfDay(opts.date);
      if (Number.isFinite(opts.weekOffset)) patch.weekOff = opts.weekOffset;
      switchView(p, ctx, opts.view || (opts.date ? 'month' : opts.weekOffset ? 'week' : 'day'), { ...patch, animate: true });
    },
    collapse(p, ctx) { switchView(p, ctx, 'day', { weekOff: 0, sel: null }); },
    state: () => ({ view: Cal.view, sel: Cal.sel, weekOff: Cal.weekOff }),
    setRelease(fn) { Cal.release = fn; },
    settings,
  };

  // ---- TASKS --------------------------------------------------------------------------------------------------------------------
  // "TASKS · <list>" with the open count; rows: a square checkbox, the title, the due label (LATE amber, TODAY, a weekday or a
  // date); late first. Ticking strikes the row through and shows "✓ <task> · UNDO" for 5 s. A dashed last line hints the voice.
  const Tk = { ticked: new Map() }; // task id -> { t, timer }
  const dueLabel = (ms, now) => {
    const today = startOfDay(now), d = startOfDay(ms);
    if (d < today) return 'LATE';
    if (d === today) return 'TODAY';
    if (d === today + DAY) return 'TMRW';
    if (d < today + 7 * DAY) return WD[(new Date(d).getDay() + 6) % 7];
    return `${new Date(d).getDate()} ${MONTHS[new Date(d).getMonth()]}`;
  };
  const tasks = {
    size: { w: 250, h: 120 },
    sig: (p, ctx) => `${JSON.stringify(ctx.model)}|${[...Tk.ticked.keys()].join()}|${Math.floor(ctx.now / 60_000)}`,
    render(p, host, ctx) {
      const m = ctx.model || {};
      const list = m.tasks || [];
      host.className = 'dp-view tasks';
      const listName = m.lists?.filter((l) => l.on).length === 1 ? m.lists.find((l) => l.on).title : m.source === 'reminders' ? 'REMINDERS' : m.source === 'google' ? 'GOOGLE' : '';
      let html = `<div class="cal-head"><span class="cal-title">TASKS${listName ? ` · ${esc(listName)}` : ''}</span><span class="tk-count">${list.length ? pad2(list.length) : ''}</span></div>`;
      if (!m.source) {
        html += '<div class="tk-setup"><div class="cal-empty">no task source yet</div><div class="tk-choices"><span class="tk-choice" data-act="setup:reminders">USE REMINDERS</span><span class="tk-choice" data-act="setup:google">CONNECT GOOGLE TASKS</span></div></div>';
      } else {
        html += '<div class="tk-list">';
        const rows = list.slice(0, 8);
        for (const t of rows) {
          const done = Tk.ticked.has(t.id);
          const late = t.due != null && startOfDay(t.due) < startOfDay(ctx.now);
          html += `<div class="tk-row${done ? ' done' : ''}${late ? ' late' : ''}" data-id="${esc(t.id)}">
            <i class="tk-box" data-act="tick:${esc(t.id)}"></i><span class="tk-title" data-act="tick:${esc(t.id)}">${esc(t.title)}</span>
            ${done ? `<span class="tk-undo" data-act="undo:${esc(t.id)}">✓ · UNDO</span>` : t.due != null ? `<span class="tk-due${late ? ' late' : ''}">${dueLabel(t.due, ctx.now)}</span>` : ''}</div>`;
        }
        if (!list.length) html += `<div class="cal-empty">${m.error ? '— ' + esc(m.error) : 'nothing on the list'}</div>`;
        if (list.length > rows.length) html += `<div class="tk-more">+ ${list.length - rows.length} MORE</div>`;
        html += '</div>';
        html += '<div class="tk-hint">"add buy milk to my tasks"</div>';
      }
      host.innerHTML = html;
    },
    act(p, action, el, ctx) {
      const [what, id] = action.split(/:(.*)/);
      if (what === 'setup') { ctx.act('tasks-setup', { source: id }); return; }
      const t = (ctx.model.tasks || []).find((x) => x.id === id);
      if (!t) return;
      if (what === 'tick' && !Tk.ticked.has(id)) {
        const row = el.closest('.tk-row');
        row?.classList.add('done');
        if (!ctx.reduce) row?.querySelector('.tk-title')?.animate([{ backgroundSize: '0% 1px' }, { backgroundSize: '100% 1px' }], { duration: 320, easing: 'ease-out' });
        // Done after 5 s unless undone: the strike-through shows at once, the API call waits for the undo window
        const timer = setTimeout(() => { Tk.ticked.delete(id); ctx.act('tasks-complete', { id }); ctx.refresh(); }, 5000);
        Tk.ticked.set(id, { t, timer });
        ctx.refresh();
      } else if (what === 'undo' && Tk.ticked.has(id)) {
        clearTimeout(Tk.ticked.get(id).timer);
        Tk.ticked.delete(id);
        ctx.refresh();
      }
    },
  };

  // Registered once Dash exists (this script loads after dash.js)
  Dash.view('calendar', calendar);
  Dash.view('tasks', tasks);
  return { calendar, tasks, kindOf, dayKey, startOfDay, startOfWeek, onDay, DAY };
})();
