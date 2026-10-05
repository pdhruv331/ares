// Autonomy for the brain (docs/autonomy-prompt.md, sections 1-4): projects, goals, routines, the kill switch. Thin
// calls over the bridge to autonomy.js in the ARES app (which holds the tiers, caps and the audit log).
const { z } = require('zod');

function register({ tool, bridge }) {
  const auto = (name, args = {}) => bridge(`/autonomy/${name}`, args);

  // ---- Projects --------------------------------------------------------------------------------------------------
  tool('start_project',
    'Start a PROJECT: a long-running Claude Code session in its own workspace (~/ARES Projects/<name>, a git repo) that builds '
    + 'something: a script, a small app, a website, a data pipeline, an automation. It plans, builds, tests, verifies against the '
    + 'definition of done and reports; checkpoints are committed; progress shows as an orb and in Work. FIRST write the brief from the '
    + 'conversation and read it back to the user in a few sentences (goal, constraints, how we\'ll know it\'s done); call this only '
    + 'after they say yes. Costs their Claude usage; one project runs at a time.',
    { title: z.string().describe('2-5 words'), goal: z.string().describe('What to build and for whom, complete and self-contained'), constraints: z.string().optional().describe('Language, libraries, style, things to avoid'), definition_of_done: z.string().describe('Checkable conditions: what must exist and work') },
    async (a) => (await auto('project/start', a)).message);

  tool('list_projects', 'The projects ARES has built or is building, with phase, tests and the last commit.', {}, async () => (await auto('project/list', {})).message);
  tool('project_status', '"How\'s the X project going?": its phase, latest test result, last commit and recent steps.', { project: z.string().describe('Its name, words from it, or "it"') },
    async (a) => (await auto('project/status', a)).message);
  tool('project_control',
    'Pause, resume or stop a project; hand it over ("open it in Claude Code": Terminal with claude --resume in its folder); open the folder; '
    + '"run it" (starts the command the project declared and gives a preview link, phone-reachable over Tailscale); stop_run; send_to_phone '
    + '(summary + a zip + the preview link).',
    { project: z.string(), action: z.enum(['pause', 'resume', 'stop', 'open_in_claude_code', 'open_folder', 'run', 'stop_run', 'send_to_phone']) },
    async (a) => (await auto('project/control', a)).message);

  // ---- Goals ----------------------------------------------------------------------------------------------------------
  tool('set_goal',
    'Give ARES a GOAL: a multi-step outcome ("prep me for Monday\'s interview", "find me a cheaper phone plan", "keep my inbox at zero '
    + 'important"). ARES plans the steps and runs them one after another as background jobs, each feeding the next, reporting progress. '
    + 'Goals persist until done or cancelled. Anything that sends, spends or deletes is left for the user.',
    { goal: z.string().describe('The outcome, in the user\'s words plus every relevant detail from the conversation and memory') },
    async (a) => (await auto('goal/set', a)).message);
  tool('list_goals', 'The user\'s goals and where each is.', {}, async () => (await auto('goal/list', {})).message);
  tool('cancel_goal', 'Cancel a goal (its running step stops).', { goal: z.string() }, async (a) => (await auto('goal/cancel', a)).message);

  // ---- Routines ----------------------------------------------------------------------------------------------------------
  tool('create_routine',
    'A ROUTINE: a task ARES runs by itself on a schedule or on an event ("every weekday at 8, brief me on my day", "every Friday, summarise '
    + 'what I worked on", "when the Mac wakes, check for important email"). Each run is a background job whose result goes to the phone. '
    + 'Only when the user asks for one, or says yes to your offer: never on your own.',
    {
      title: z.string(), task: z.string().describe('A complete brief for the worker, every time it runs'),
      every: z.string().optional().describe('"day", "weekday", "weekend", "week", a day name, "hour", or "30 minutes"'),
      at: z.string().optional().describe('Time of day, "08:00" or "6pm"'), days: z.array(z.string()).optional().describe('Day names, e.g. ["mon","wed"]'),
      on: z.enum(['unlock', 'wake']).optional().describe('Run on an event instead of a time'),
    },
    async (a) => (await auto('routine/create', a)).message);
  tool('list_routines', 'The user\'s routines: on/off, schedule, last and next run.', {}, async () => (await auto('routine/list', {})).message);
  tool('routine_control', 'Turn a routine on or off, run it now, or delete it.', { routine: z.string(), action: z.enum(['on', 'off', 'run', 'delete']) },
    async (a) => (await auto('routine/control', a)).message);

  // ---- The kill switch, status -------------------------------------------------------------------------------------------
  tool('stop_everything', 'THE KILL SWITCH: "ARES, stop everything". Pauses every job and project at once, holds goals and routines. Resume with resume_everything.', {},
    async () => (await auto('stop', {})).message);
  tool('resume_everything', 'Resume after the kill switch: everything, or one project, job or goal by name.', { what: z.string().optional() },
    async (a) => (await auto('resume', a)).message);
  tool('autonomy_status', 'What ARES is doing on her own: active projects, goals, routines, whether everything is paused, and the day\'s run allowance.', {},
    async () => (await auto('status', {})).message);
}

module.exports = { register };
