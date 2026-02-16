/**
 * Output DLP Filter - Secret Detection and Redaction
 *
 * Scans delegate output for potential secrets and masks them
 * before display or persistence. Non-blocking, fail-safe.
 */

const SECRET_PATTERNS = [
  { name: 'AWS_KEY', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { name: 'OPENAI_KEY', pattern: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'GITHUB_TOKEN', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: 'BEARER_TOKEN', pattern: /Bearer\s+[a-zA-Z0-9_\-.]{20,}/g },
  { name: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'CONN_STRING', pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]{10,}/gi },
  { name: 'API_KEY_ASSIGN', pattern: /(?:api[_-]?key|api_secret|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi },
  { name: 'SECRET_ASSIGN', pattern: /(?:secret|password|passwd|token)\s*[:=]\s*['"]([^\s'"]{8,})['"]?/gi },
];

/**
 * Redact potential secrets from text
 * @param {string} text - Input text to scan
 * @returns {{ text: string, redacted: number }}
 */
function redactSecrets(text) {
  if (!text || typeof text !== 'string') return { text: text || '', redacted: 0 };

  let redacted = 0;
  let result = text;

  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = result.match(pattern);
    if (matches) {
      redacted += matches.length;
      result = result.replace(pattern, `[REDACTED:${name}]`);
    }
  }

  return { text: result, redacted };
}

module.exports = { redactSecrets, SECRET_PATTERNS };
