import type { Env } from '../types';

function isTruthy(value: string | undefined): boolean {
  const v = (value || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export function getDeployTarget(env: Env): string {
  return (env.DEPLOY_TARGET || 'hub').toLowerCase();
}

export function isCanaryWriteEnabled(env: Env): boolean {
  return isTruthy(env.CANARY_WRITE_ENABLED);
}

export function maybeBlockCanaryWrite(request: Request, env: Env): Response | null {
  if (getDeployTarget(env) !== 'canary') return null;
  if (isCanaryWriteEnabled(env)) return null;

  const method = request.method;
  const isWriteMethod = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (!isWriteMethod) return null;

  // Minimal CORS: reflect Origin so browser callers can see the error body.
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }

  return new Response(JSON.stringify({
    error: 'Forbidden',
    message: 'Canary write methods are disabled by default.',
    hint: 'Set CANARY_WRITE_ENABLED=true to allow write methods on canary.',
  }), { status: 403, headers });
}

