/**
 * CORS Origin Utilities
 *
 * Single source of truth for allowed CORS origins.
 * Used by index.ts for advisor, cockpit, and notification API routes.
 */

/**
 * Static allowed origins for CORS.
 * Shared across advisor, cockpit, and notification routes.
 */
const STATIC_ORIGINS: readonly string[] = [
  'https://orchestrator-hub.masa-stage1.workers.dev',
  'https://orchestrator-hub-production.masa-stage1.workers.dev',
  'https://orchestrator-hub-canary.masa-stage1.workers.dev',
  'https://cockpit-pwa.vercel.app',
  'https://fugue-system-ui.vercel.app',
  'http://localhost:3000',
  'http://localhost:8787',
] as const;

/**
 * Build the full list of allowed origins including the current worker origin.
 */
export function getAllowedCorsOrigins(workerOrigin: string): readonly string[] {
  return [workerOrigin, ...STATIC_ORIGINS];
}

/**
 * Build standard CORS headers for a given request origin.
 * Returns the matched origin or falls back to the worker origin.
 */
export function buildCorsHeaders(
  requestOrigin: string,
  workerOrigin: string,
  extraMethods?: string,
  extraHeaders?: string,
): Record<string, string> {
  const allowedOrigins = getAllowedCorsOrigins(workerOrigin);
  const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : workerOrigin;

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': extraMethods ?? 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': extraHeaders ?? 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * Check if a request origin is in the allowed list.
 */
export function isOriginAllowed(requestOrigin: string, workerOrigin: string): boolean {
  return getAllowedCorsOrigins(workerOrigin).includes(requestOrigin);
}
