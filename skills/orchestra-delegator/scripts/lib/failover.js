/**
 * P2-5: Failover Module
 *
 * Codex -> GLM automatic failover with agent mapping.
 * Prevents circular failover with visited set.
 */

const path = require('path');

const MAX_FAILOVER = 1; // Single failover attempt (no chains)

// Agent mapping: Codex agent -> GLM equivalent
const FAILOVER_MAP = {
  'code-reviewer': { provider: 'glm', agent: 'code-reviewer' },
  'architect': { provider: 'glm', agent: 'general-reviewer' },
  'security-analyst': { provider: 'glm', agent: 'code-reviewer' },
  'scope-analyst': { provider: 'glm', agent: 'general-reviewer' },
  'plan-reviewer': { provider: 'glm', agent: 'general-reviewer' },
};

/**
 * Check if an error is retryable via failover
 * @param {Error|Object} error
 * @returns {boolean}
 */
function isFailoverEligible(error) {
  if (!error) return false;
  // Network/timeout errors
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') return true;
  if (error.timedOut) return true;
  // Process errors (spawn failure, non-zero exit)
  if (error.code === 'ENOENT' || error.code === 'EACCES') return true;
  // HTTP 5xx or rate limit
  if (error.status >= 500 || error.status === 429) return true;
  // Non-zero exit code from child process
  if (typeof error.exitCode === 'number' && error.exitCode !== 0) return true;
  return false;
}

/**
 * Get failover target for a given provider:agent
 * @param {string} provider
 * @param {string} agent
 * @returns {{ provider: string, agent: string }|null}
 */
function getFailoverTarget(provider, agent) {
  // Only Codex -> GLM failover supported
  if (provider !== 'codex') return null;
  return FAILOVER_MAP[agent] || null;
}

/**
 * Execute with failover support
 * @param {Function} primaryFn - async () => result
 * @param {Object} context - { provider, agent, runId }
 * @param {Function} fallbackFactory - (target) => async () => result
 * @returns {Promise<{ result: any, failedOver: boolean, failoverTarget: Object|null }>}
 */
async function tryWithFailover(primaryFn, context, fallbackFactory) {
  const { provider, agent } = context;

  try {
    const result = await primaryFn();
    return { result, failedOver: false, failoverTarget: null };
  } catch (error) {
    const target = getFailoverTarget(provider, agent);

    if (!target || !isFailoverEligible(error)) {
      throw error;
    }

    console.log(`⚡ Failover: ${provider}:${agent} -> ${target.provider}:${target.agent} (${error.message || error.code})`);

    const fallbackFn = fallbackFactory(target);
    const result = await fallbackFn();
    return { result, failedOver: true, failoverTarget: target };
  }
}

module.exports = {
  FAILOVER_MAP,
  MAX_FAILOVER,
  isFailoverEligible,
  getFailoverTarget,
  tryWithFailover,
};
