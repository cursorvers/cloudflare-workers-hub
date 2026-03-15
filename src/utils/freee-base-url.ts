import type { Env } from '../types';

export const DEFAULT_FREEE_BASE_URL = 'https://api.freee.co.jp/api/1';

function isProductionLike(env: Env): boolean {
  const deployTarget = (env.DEPLOY_TARGET || '').toLowerCase();
  const environment = (env.ENVIRONMENT || '').toLowerCase();
  if (deployTarget === 'hub' || environment === 'production') {
    return true;
  }
  if (!deployTarget && environment !== 'development') {
    return true;
  }
  return false;
}

function validateOverride(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('FREEE_BASE_URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('FREEE_BASE_URL must use https');
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('FREEE_BASE_URL must not include credentials, query params, or fragments');
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (normalizedPath !== '/api/1') {
    throw new Error('FREEE_BASE_URL path must be /api/1');
  }

  return `${parsed.origin}/api/1`;
}

export function resolveFreeeBaseUrl(env: Env): string {
  if (isProductionLike(env)) {
    return DEFAULT_FREEE_BASE_URL;
  }

  const override = env.FREEE_BASE_URL?.trim();
  if (!override) {
    return DEFAULT_FREEE_BASE_URL;
  }

  return validateOverride(override);
}
