import { describe, it, expect } from 'vitest';
import { maybeBlockCanaryWrite } from './canary-write-gate';

describe('maybeBlockCanaryWrite', () => {
  it('returns 403 Response for write methods on canary when disabled', async () => {
    const req = new Request('https://example.com/api/cockpit/tasks', {
      method: 'POST',
      headers: { Origin: 'https://fugue-system-ui.vercel.app', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    const env: any = { DEPLOY_TARGET: 'canary', CANARY_WRITE_ENABLED: 'false' };
    const res = maybeBlockCanaryWrite(req, env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body).toMatchObject({ error: 'Forbidden' });
  });

  it('returns null for GET on canary when disabled', () => {
    const req = new Request('https://example.com/health', { method: 'GET' });
    const env: any = { DEPLOY_TARGET: 'canary', CANARY_WRITE_ENABLED: 'false' };
    expect(maybeBlockCanaryWrite(req, env)).toBeNull();
  });

  it('returns null for write methods on hub', () => {
    const req = new Request('https://example.com/api/cockpit/tasks', { method: 'POST' });
    const env: any = { DEPLOY_TARGET: 'hub', CANARY_WRITE_ENABLED: 'false' };
    expect(maybeBlockCanaryWrite(req, env)).toBeNull();
  });
});

