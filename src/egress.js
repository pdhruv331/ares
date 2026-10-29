// Work mode's web door for worker browsers (Playwright): a tiny HTTP/HTTPS proxy on 127.0.0.1 that only
// connects to the public internet. Loopback, private LAN, link-local, Tailscale (CGNAT) and other special
// addresses are refused after DNS resolution, so neither a URL nor a redirect nor a DNS trick can reach
// the ARES bridge, the phone server or anything else on this Mac or network.
const http = require('http');
const net = require('net');
const dns = require('dns').promises;

/** Is this IP address somewhere a worker must never reach? */
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)   // CGNAT, including Tailscale
      || (a === 169 && b === 254)             // link-local
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

/** Resolve a host to a public address, or throw. */
async function publicAddress(host) {
  host = host.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.ts\.net$/i.test(host)) throw new Error('blocked host');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('blocked address');
  return addrs[0].address;
}

/** Is this URL fine for a worker to fetch or browse? (http/https to a public host) */
async function isPublicUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    await publicAddress(u.hostname);
    return true;
  } catch { return false; }
}

function startEgress({ log = () => {} } = {}) {
  const deny = (res, why) => { res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`Blocked by ARES: ${why}`); };
  const server = http.createServer(async (req, res) => {
    // Plain http:// requests arrive with an absolute URL
    let u;
    try { u = new URL(req.url); } catch { return deny(res, 'bad request'); }
    if (u.protocol !== 'http:') return deny(res, 'only http and https');
    let ip;
    try { ip = await publicAddress(u.hostname); } catch (err) { log('egress block', { host: u.hostname }); return deny(res, err.message); }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const up = http.request({ host: ip, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers, servername: u.hostname }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', async (req, socket, head) => {
    const [host, port = '443'] = req.url.split(/:(?=\d+$)/);
    let ip;
    try { ip = await publicAddress(host); } catch (err) {
      log('egress block', { host });
      return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
    const up = net.connect(Number(port), ip, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  })));
}

module.exports = { startEgress, isPublicUrl, isPrivate };
