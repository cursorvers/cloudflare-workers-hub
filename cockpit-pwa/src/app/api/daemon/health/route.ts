import { NextResponse } from 'next/server';
import { z } from 'zod';

const ORCHESTRATOR_HEALTH_URL =
  'https://orchestrator-hub.masa-stage1.workers.dev/api/daemon/health';
const TIMEOUT_MS = 10_000;

const DaemonStateSchema = z.object({
  daemonId: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()),
  lastHeartbeat: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  tasksProcessed: z.number(),
  currentTask: z.string().optional(),
});

const HealthResponseSchema = z.object({
  activeDaemons: z.array(DaemonStateSchema),
  stale: z.array(DaemonStateSchema),
  totalActive: z.number(),
});

export const revalidate = 30;

export async function GET() {
  const apiKey = process.env.ORCHESTRATOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Missing ORCHESTRATOR_API_KEY' },
      { status: 500 }
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ORCHESTRATOR_HEALTH_URL, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      next: { revalidate: 30 },
    });

    if (!response.ok) {
      const status = response.status >= 500 ? 503 : 500;
      return NextResponse.json(
        { error: 'Upstream request failed' },
        { status }
      );
    }

    const payload = await response.json();
    const parsed = HealthResponseSchema.safeParse(payload);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid upstream response' },
        { status: 500 }
      );
    }

    return NextResponse.json(parsed.data, { status: 200 });
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'));
    return NextResponse.json(
      { error: isTimeout ? 'Upstream timeout' : 'Upstream fetch failed' },
      { status: 503 }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
