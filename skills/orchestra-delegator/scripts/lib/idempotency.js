/**
 * P2-10: Idempotency Keys
 *
 * SHA256-based deduplication with TTL cache.
 * Prevents duplicate delegate executions within a time window.
 * File-based storage with atomic writes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache', 'idempotency');
const DEFAULT_TTL_MS = 300000; // 5 minutes

/**
 * Compute idempotency key from provider + agent + task + extra context.
 * Uses null byte delimiter to prevent key collision (security-analyst review).
 * P2.5: Accepts variadic args to include file path, forte context, flags.
 * @param {string} provider
 * @param {string} agent
 * @param {...string} parts - task, file path, forte context path, flags, etc.
 * @returns {string} hex hash
 */
function computeKey(provider, agent, ...parts) {
  // Use null byte delimiter to prevent prefix collisions
  const input = [provider, agent, ...parts].join('\0');
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Check if a cached result exists and is within TTL
 * @param {string} key
 * @param {number} [ttlMs]
 * @returns {{ hit: boolean, data: Object|null, age: number }}
 */
function checkCache(key, ttlMs = DEFAULT_TTL_MS) {
  try {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(filePath)) return { hit: false, data: null, age: 0 };

    const raw = fs.readFileSync(filePath, 'utf-8');
    const cached = JSON.parse(raw);
    const age = Date.now() - (cached._cachedAt || 0);

    if (age > ttlMs) {
      // Expired - remove stale cache
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return { hit: false, data: null, age };
    }

    return { hit: true, data: cached, age };
  } catch {
    return { hit: false, data: null, age: 0 };
  }
}

/**
 * Store result in cache with timestamp
 * @param {string} key
 * @param {Object} data
 */
function storeCache(key, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    }

    const filePath = path.join(CACHE_DIR, `${key}.json`);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    const record = { ...data, _cachedAt: Date.now() };

    // Atomic write: write to tmp then rename (prevents partial reads)
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Non-blocking, fail silently
  }
}

/**
 * Purge expired entries from cache directory
 * @param {number} [ttlMs]
 */
function purgeExpired(ttlMs = DEFAULT_TTL_MS) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(CACHE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > ttlMs) {
          fs.unlinkSync(filePath);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

module.exports = { computeKey, checkCache, storeCache, purgeExpired, DEFAULT_TTL_MS };
