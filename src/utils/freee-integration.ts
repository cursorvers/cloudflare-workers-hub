import type { Env } from '../types';

function isTruthy(value: string | undefined): boolean {
  const v = (value || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * freee integration is enabled by default for backward-compatibility.
 * Set `FREEE_INTEGRATION_ENABLED=false` to force-disable it (e.g. on canary).
 */
export function isFreeeIntegrationEnabled(env: Env): boolean {
  if (env.FREEE_INTEGRATION_ENABLED === undefined) return true;
  return isTruthy(env.FREEE_INTEGRATION_ENABLED);
}

