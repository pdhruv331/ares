// ARES's Keychain items (the Google Tasks OAuth client and refresh token), through Apple's own /usr/bin/security.
//
// Why not the calendar helper: ARES is signed without an Apple team ID, so macOS ties a Keychain item to the exact
// code hash of the program that saved it. Every rebuild changed the helper's hash and macOS asked for the login
// password again. Items saved by /usr/bin/security belong to "apple-tool:", which never changes.
//
// Secrets travel on stdin (security's interactive mode, as hex) and stdout, never argv, never a file.
// Items the helper saved earlier (account "ares") are moved over the first time they're read: one last prompt.
const { execFile } = require('child_process');
const path = require('path');

const SECURITY = '/usr/bin/security';
const ACCOUNT = 'ares-keychain';   // items saved by /usr/bin/security
const LEGACY = 'ares';             // items the calendar helper saved (tied to its code hash)
const label = (service) => `ARES ${service}`;

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(SECURITY, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr); return reject(err); }
      resolve(String(stdout));
    });
    child.stdin.end(input ?? '');
  });
}

/** True when an item exists. Reads attributes only, so it never prompts. */
const exists = (service, account) => run(['find-generic-password', '-a', account, '-s', label(service)]).then(() => true, () => false);
const read = (service, account) => run(['find-generic-password', '-a', account, '-s', label(service), '-w']).then((out) => out.replace(/\n$/, ''), () => null);

/**
 * @param {object} [o]
 * @param {string} [o.legacyHelperApp]  "ARES Calendar.app", to read items it saved before (the one-time move)
 * @param {(...a: any[]) => void} [o.log]
 */
function keychain({ legacyHelperApp, log = () => {} } = {}) {
  const legacyRead = (service) => new Promise((resolve) => {
    if (!legacyHelperApp) return resolve(null);
    const bin = path.join(legacyHelperApp, 'Contents', 'MacOS', 'ares-calendar');
    const child = execFile(bin, ['keychain', 'get', service], { timeout: 120_000 }, (err, stdout) => resolve(err ? null : String(stdout)));
    child.stdin.end();
  });

  async function set(service, secret) {
    const hex = Buffer.from(String(secret), 'utf8').toString('hex');
    const name = label(service);
    await run(['-i'], `add-generic-password -U -a ${ACCOUNT} -s "${name}" -l "${name}" -X ${hex}\n`);
    if (await read(service, ACCOUNT) !== String(secret)) throw new Error(`keychain: "${name}" did not save`);
    return true;
  }

  async function get(service) {
    const secret = await read(service, ACCOUNT);
    if (secret != null) return secret;
    if (!(await exists(service, LEGACY))) return null;
    // The one-time move: the helper reads the old item (macOS may ask once), security saves it, the old one goes
    const old = await legacyRead(service);
    if (old == null) return null;
    try {
      await set(service, old);
      await run(['delete-generic-password', '-a', LEGACY, '-s', label(service)]).catch(() => {});
      log('keychain moved', { service });
    } catch (err) { log('keychain move failed', { service, error: err.message }); }
    return old;
  }

  async function del(service) {
    const gone = await Promise.all([ACCOUNT, LEGACY].map((a) => run(['delete-generic-password', '-a', a, '-s', label(service)]).then(() => true, () => false)));
    return gone.some(Boolean);
  }

  return { get, set, delete: del };
}

module.exports = { keychain };
