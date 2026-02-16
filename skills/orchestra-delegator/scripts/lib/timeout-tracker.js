/**
 * P2-4: Adaptive Timeout Tracker
 *
 * Records execution latencies and computes P95-based adaptive timeouts.
 * Data stored in append-only JSONL (no secrets, only timing metrics).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.claude', 'cache', 'timeout-tracker');
const MAX_RECORDS = 100; // Keep last N records per provider:agent
const MARGIN_FACTOR = 0.3; // P95 + 30% margin

// Defaults from quality-gates.json (loaded lazily)
let _qualityGates = null;
function getGates() {
  if (_qualityGates) return _qualityGates;
  try {
    _qualityGates = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', 'rules', 'quality-gates.json'), 'utf-8')
    );
  } catch {
    _qualityGates = {};
  }
  return _qualityGates;
}

/**
 * Record a latency measurement
 * @param {string} provider - 'codex' | 'glm' | 'gemini'
 * @param {string} agent
 * @param {number} latencyMs
 */
function recordLatency(provider, agent, latencyMs) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    }

    const key = `${provider}-${agent}`;
    const filePath = path.join(DATA_DIR, `${key}.jsonl`);

    // Append-only write (timing data only, no secrets)
    const record = JSON.stringify({ t: Date.now(), ms: Math.round(latencyMs) });
    fs.appendFileSync(filePath, record + '\n');

    // Rotate if too large (keep last MAX_RECORDS)
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    if (lines.length > MAX_RECORDS * 2) {
      const trimmed = lines.slice(-MAX_RECORDS).join('\n') + '\n';
      fs.writeFileSync(filePath, trimmed);
    }
  } catch {
    // Non-blocking, fail silently
  }
}

/**
 * Get adaptive timeout based on historical P95
 * @param {string} provider
 * @param {string} agent
 * @returns {number} timeout in milliseconds
 */
function getAdaptiveTimeout(provider, agent) {
  const gates = getGates();
  const config = gates.adaptiveTimeout || {};
  const defaultTimeout = gates[provider]?.timeout || config.default || 180000;
  const minTimeout = config.min || 30000;
  const maxTimeout = config.max || 600000;

  try {
    const key = `${provider}-${agent}`;
    const filePath = path.join(DATA_DIR, `${key}.jsonl`);

    if (!fs.existsSync(filePath)) return defaultTimeout;

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    const latencies = [];
    for (const line of lines) {
      try {
        const { ms } = JSON.parse(line);
        if (typeof ms === 'number' && ms > 0) latencies.push(ms);
      } catch {
        // Skip malformed lines
      }
    }

    // Need minimum 10 data points for meaningful P95
    if (latencies.length < 10) return defaultTimeout;

    // Sort ascending for percentile calculation
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95Index = Math.ceil(0.95 * sorted.length) - 1;
    const p95 = sorted[p95Index];
    const adaptive = Math.round(p95 * (1 + MARGIN_FACTOR));

    // Clamp to min/max bounds
    return Math.min(Math.max(adaptive, minTimeout), maxTimeout);
  } catch {
    return defaultTimeout;
  }
}

module.exports = { recordLatency, getAdaptiveTimeout };
