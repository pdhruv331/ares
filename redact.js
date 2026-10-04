// Strip secrets out of text that leaves its file (session summaries, notifications to the phone).
// Errs on the side of hiding: a redacted word costs nothing, a leaked key costs a lot.
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, '[key]'],          // Anthropic, OpenAI, ElevenLabs (sk_…) below
  [/\bsk_[A-Za-z0-9]{16,}/g, '[key]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[aws key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[github token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[slack token]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[google key]'],
  [/\b(?:AC|SK)[0-9a-f]{32}\b/g, '[twilio id]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]'],      // JWTs
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [token]'],
  [/\b(https?:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1[credentials]@'],                      // user:pass@host
  // KEY=value, "token": "value", password: value …
  [/\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|AUTH)[A-Z0-9_]*\s*[=:]\s*["']?)(?!\[)[^\s"',}]{6,}/gi, '$1[redacted]'],
  [/(["'](?:api[_-]?key|token|secret|password|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']\s*:\s*["'])[^"']{6,}/gi, '$1[redacted]'],
];

function redact(text) {
  let s = String(text ?? '');
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}

module.exports = { redact };
