import type { CSRFCheck } from './types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function freezeCheck(result: CSRFCheck): CSRFCheck {
  return Object.freeze({ ...result });
}

function pass(reason: string): CSRFCheck {
  return freezeCheck({ valid: true, reason });
}

function fail(reason: string): CSRFCheck {
  return freezeCheck({ valid: false, reason });
}

function extractOriginFromReferer(referer: string | null): string | null {
  if (!referer) return null;

  try {
    const url = new URL(referer);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function validateCSRF(
  method: string,
  originHeader: string | null,
  refererHeader: string | null,
  allowedOrigins: readonly string[],
): CSRFCheck {
  const normalizedMethod = method.toUpperCase();

  if (SAFE_METHODS.has(normalizedMethod)) {
    return pass('safe method; CSRF check skipped');
  }

  const origin = originHeader?.trim() ?? '';
  if (origin.length > 0) {
    if (allowedOrigins.includes(origin)) {
      return pass('origin allowed');
    }
    return fail('origin not allowed');
  }

  const refererOrigin = extractOriginFromReferer(refererHeader);
  if (refererOrigin) {
    if (allowedOrigins.includes(refererOrigin)) {
      return pass('referer origin allowed');
    }
    return fail('referer origin not allowed');
  }

  return fail('missing origin and referer for state-changing method');
}
