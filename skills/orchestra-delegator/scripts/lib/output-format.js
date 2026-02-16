/**
 * Orchestra Delegator - Standardized Output Format (P2 Enhanced)
 *
 * Unified event model, correlation IDs, ANSI sanitization,
 * progress indicators, and safe JSON parsing.
 *
 * Usage:
 *   const { formatResult, formatError, formatStart, recordTelemetry,
 *           generateRunId, emitEvent, bus, stripAnsi, createSpinner,
 *           safeJsonParse } = require('./lib/output-format');
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ========================================
// P2-2: Unified Event Bus
// ========================================
const bus = new EventEmitter();
bus.setMaxListeners(20); // Prevent warning in parallel execution

/**
 * Emit a typed event on the shared bus
 * @param {'start'|'progress'|'chunk'|'end'|'error'} type
 * @param {Object} data - Must include run_id
 */
function emitEvent(type, data) {
  bus.emit(type, { ...data, timestamp: Date.now() });
}

// ========================================
// P2-3: Correlation ID
// ========================================

/**
 * Generate a unique run ID for correlation
 * @returns {string} UUID v4
 */
function generateRunId() {
  return crypto.randomUUID();
}

// ========================================
// P2-Security: ANSI Strip (critical fix from security-analyst)
// ========================================

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\x1B(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\][^\x1B]*\x1B\\)/g;

/**
 * Strip ANSI escape sequences and control characters from text.
 * Prevents terminal escape injection from model outputs.
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(ANSI_RE, '');
}

// ========================================
// P2-8: Progress Spinner
// ========================================

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

/**
 * Create a stderr spinner for long-running operations.
 * Only displays in TTY environments.
 * @param {string} label
 * @returns {{ stop: Function }}
 */
function createSpinner(label) {
  const isTTY = process.stderr.isTTY;
  if (!isTTY) return { stop() {} };

  let frame = 0;
  const startMs = Date.now();
  const interval = setInterval(() => {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    process.stderr.write(`\r${SPINNER_FRAMES[frame++ % 4]} ${label} (${elapsed}s)`);
  }, 100);

  return {
    stop() {
      clearInterval(interval);
      process.stderr.write('\r\x1b[K'); // Clear spinner line
    },
  };
}

// ========================================
// P2-9/Security: Safe JSON Parse
// ========================================

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_JSON_SIZE = 1024 * 1024; // 1MB

/**
 * Parse JSON safely with prototype pollution protection and size limit.
 * @param {string} text - Raw text potentially containing JSON
 * @returns {{ data: Object|null, raw: string }}
 */
function safeJsonParse(text) {
  if (!text || typeof text !== 'string') return { data: null, raw: text || '' };

  // Try fenced JSON block first
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  let jsonText = fencedMatch ? fencedMatch[1].trim() : null;

  // Fallback to brace-bounded
  if (!jsonText) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonText = text.slice(firstBrace, lastBrace + 1);
    }
  }

  if (!jsonText) return { data: null, raw: text };
  if (jsonText.length > MAX_JSON_SIZE) return { data: null, raw: text };

  try {
    const parsed = JSON.parse(jsonText, (key, value) => {
      if (DANGEROUS_KEYS.has(key)) return undefined;
      return value;
    });
    return { data: parsed, raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

// ========================================
// P2-Security: Sensitive file extension check
// ========================================
const SENSITIVE_EXTENSIONS = new Set([
  '.env', '.pem', '.key', '.p12', '.pfx', '.jks',
  '.credentials', '.secret', '.token',
]);

/**
 * Check if a file path has a sensitive extension
 * @param {string} filePath
 * @returns {boolean}
 */
function isSensitiveFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  return SENSITIVE_EXTENSIONS.has(ext) || SENSITIVE_EXTENSIONS.has(`.${base}`) || base.startsWith('.env');
}

// ========================================
// Telemetry Integration
// ========================================
let telemetryModule = null;

/**
 * Load telemetry module lazily
 */
function getTelemetryModule() {
  if (telemetryModule !== null) return telemetryModule;

  const telemetryPath = path.join(os.homedir(), '.claude', 'skills', 'ai-observability', 'lib', 'telemetry.js');

  try {
    if (fs.existsSync(telemetryPath)) {
      telemetryModule = require(telemetryPath);
    } else {
      telemetryModule = false; // Mark as not available
    }
  } catch (e) {
    telemetryModule = false;
  }

  return telemetryModule;
}

/**
 * Record telemetry data (non-blocking)
 */
function recordTelemetry(data) {
  const telemetry = getTelemetryModule();
  if (!telemetry) return;

  // Fire and forget - don't block the main operation
  telemetry.recordRequest(data).catch(() => {
    // Silent failure
  });
}

// ========================================
// Load Quality Gates for thresholds
// ========================================
function loadQualityGates() {
  // Try repo-local copy first (for GHA runners), then home directory
  const candidates = [
    path.join(__dirname, 'quality-gates.json'),
    path.join(os.homedir(), '.claude', 'rules', 'quality-gates.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      }
    } catch (e) {
      // Silent fallback
    }
  }
  return { review: { glm: { maxScore: 7, passThreshold: 5 } } };
}

const QUALITY_GATES = loadQualityGates();

// ========================================
// Formatting Functions
// ========================================

/**
 * @param {string} provider - GLM, Codex, Gemini
 * @param {string} agent
 * @param {string} [runId] - Correlation ID
 */
function formatStart(provider, agent, runId) {
  const idStr = runId ? ` [${runId.slice(0, 8)}]` : '';
  console.log(`\n🤖 Delegating to ${provider} (${agent})${idStr}...\n`);
  if (runId) emitEvent('start', { run_id: runId, provider, agent });
}

/**
 * @param {Object} options
 * @param {string} options.content
 * @param {number} options.elapsed
 * @param {Object} options.usage
 * @param {string} options.outputPath
 * @param {string} [options.runId]
 */
function formatResult({ content, elapsed, usage, outputPath, runId }) {
  console.log(content);
  console.log(`\n---`);
  console.log(`⏱️ 処理時間: ${elapsed}s`);

  if (usage) {
    console.log(`📊 トークン: input=${usage.prompt_tokens || usage.input}, output=${usage.completion_tokens || usage.output}, total=${usage.total_tokens || usage.total}`);
  }

  if (outputPath) {
    console.log(`💾 結果保存: ${outputPath}`);
  }

  if (runId) emitEvent('end', { run_id: runId, elapsed, usage, outputPath });
}

/**
 * @param {Object} options
 * @param {string} options.provider
 * @param {Error} options.error
 * @param {number} options.parallelLimit
 * @param {string} [options.runId]
 */
function formatError({ provider, error, parallelLimit, runId }) {
  console.error(`❌ Error calling ${provider}: ${error.message}`);

  const isRateLimit = error.status === 429;
  if (isRateLimit && parallelLimit) {
    console.error(`💡 Rate limit exceeded. Try reducing parallel requests (max ${parallelLimit}).`);
  }

  if (error.response?.data) {
    console.error('Response:', JSON.stringify(error.response.data, null, 2));
  }

  if (runId) emitEvent('error', { run_id: runId, provider, error: error.message });
}

/**
 * @param {number} score
 * @param {string} type - 'glm', 'codex', 'combined'
 */
function formatReviewSummary(score, type = 'glm') {
  const gates = QUALITY_GATES.review?.[type] || QUALITY_GATES.review?.glm;
  const maxScore = gates?.maxScore || 7;
  const passThreshold = gates?.passThreshold || 5;
  const passed = score >= passThreshold;

  const emoji = passed ? '✅' : '⚠️';
  const status = passed ? 'PASSED' : 'NEEDS WORK';

  console.log(`\n${emoji} Review: ${score}/${maxScore} - ${status}`);
  return passed;
}

/**
 * @param {Object} data
 */
function formatJSON(data) {
  console.log(JSON.stringify(data, null, 2));
}

// ========================================
// Exports
// ========================================
module.exports = {
  // Existing
  formatStart,
  formatResult,
  formatError,
  formatReviewSummary,
  formatJSON,
  recordTelemetry,
  QUALITY_GATES,
  // P2: Event model + correlation
  bus,
  emitEvent,
  generateRunId,
  // P2: Security
  stripAnsi,
  isSensitiveFile,
  safeJsonParse,
  // P2: Progress
  createSpinner,
};
