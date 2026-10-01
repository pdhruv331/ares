// Worker Bash, confined. Every command a work-mode worker runs is wrapped in macOS's Seatbelt sandbox
// (sandbox-exec): no network, no reading the user's home folder except the job's own folder and the worker
// runtime, and no writing anywhere but the job folder (plus /tmp, which LibreOffice needs for its pipes).
// On top of that, only a short list of plain commands runs without asking; anything else waits for a yes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const realDir = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** Write the job's Seatbelt profile (outside its folder) and return its path. */
function writeProfile(file, { jobDir, runtime }) {
  const home = realDir(os.homedir());
  const job = realDir(jobDir);
  const rt = realDir(runtime);
  const claudeTmp = `/private/tmp/claude-${process.getuid?.() ?? 501}`;
  const profile = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(deny file-read* (subpath ${q(home)}) (subpath "/Volumes") (subpath "/Users/Shared") (subpath ${q(claudeTmp)}))
(allow file-read* (literal ${q(home)}) (subpath ${q(job)}) (subpath ${q(rt)}) (subpath ${q(`${claudeTmp}/bundled-skills`)}))
(allow file-read-metadata)
(deny file-write* (subpath "/"))
(allow file-write* (subpath ${q(job)}) (subpath "/private/tmp") (regex #"^/dev/(null|tty|fd/|dtracehelper)"))
(deny file-write* (subpath ${q(claudeTmp)}))
`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, profile, { mode: 0o600 });
  return file;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** The command, as it will really run: inside the sandbox, with temp files kept in the job folder. */
function wrap(command, { profile, jobDir }) {
  const tmp = path.join(jobDir, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  return `/usr/bin/sandbox-exec -f ${shq(profile)} /bin/zsh -c ${shq(`export TMPDIR=${shq(tmp)}; ${command}`)}`;
}

// Plain commands that only read, convert or organise files. Inside the sandbox they can't reach anything
// but the job folder anyway; this list just decides what runs without asking.
const PLAIN = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'pwd', 'cd', 'echo', 'printf', 'true', 'test', '[',
  'grep', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'jq', 'diff', 'date', 'basename', 'dirname', 'mkdir', 'touch', 'cp', 'mv',
  'zip', 'unzip', 'soffice', 'markitdown', 'pdftoppm', 'pdftotext', 'pdfinfo', 'pdfimages', 'qpdf', 'sips']);
const SCRIPTED = new Set(['python3', 'python', 'node']);

/** Split a command line into its simple commands, or null if it uses shell features we won't pre-approve. */
function segments(cmd) {
  if (/`|\$\(|<\(|>\(/.test(cmd)) return null; // command substitution: ask
  const out = [];
  let words = [];
  let word = null; // null: between words
  let quote = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endSeg = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') word += cmd[++i] ?? '';
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    if (c === '\\') { word = (word ?? '') + (cmd[++i] ?? ''); continue; }
    if (c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) { word = (word ?? '') + c; continue; } // 2>&1, &>
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && cmd[i + 1] !== '&' && cmd[i - 1] !== '&' && cmd[i - 1] !== '>') return null; // background jobs
      endSeg();
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word = (word ?? '') + c;
  }
  if (quote) return null;
  endSeg();
  return out;
}

/**
 * 'allow' when every part of the command is a plain command, or python3/node running a script file that
 * lives in the job folder or the worker runtime (the skills' own scripts). Otherwise 'ask'.
 * @param {(p: string) => boolean} okScript  is this script path inside the job folder or the runtime?
 */
function classify(command, okScript) {
  const segs = segments(String(command || ''));
  if (!segs || !segs.length) return 'ask';
  for (let words of segs) {
    while (words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words = words.slice(1); // FOO=bar cmd
    const prog = path.basename(words[0] || '');
    if (!prog) continue;
    if (prog === 'rm' || (prog === 'find' && words.some((w) => /^-(delete|exec|execdir|ok)$/.test(w)))) return 'ask'; // deleting: ask
    if (PLAIN.has(prog) || prog === 'find') continue;
    if (SCRIPTED.has(prog) || /\/venv\/bin\/python3?$/.test(words[0])) {
      const rest = words.slice(1).filter((w) => !/^-[uBW]/.test(w)); // harmless interpreter flags
      if (rest[0] === '-m' && /^(markitdown|json\.tool|zipfile)$/.test(rest[1] || '')) continue;
      if (rest[0] && !rest[0].startsWith('-') && /\.(py|js|mjs|cjs)$/.test(rest[0]) && okScript(rest[0])) continue;
      return 'ask';
    }
    return 'ask';
  }
  return 'allow';
}

/** Where Claude Code unpacks its built-in skills (dataviz and friends): readable by workers. */
const bundledSkills = () => `/private/tmp/claude-${process.getuid?.() ?? 501}/bundled-skills`;

module.exports = { bundledSkills, writeProfile, wrap, classify, segments };
