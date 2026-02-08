import type { Env } from '../types';
import { extractPdfText } from '../services/pdf-text-extractor';

// Satisfy wrangler.toml Durable Object bindings when using this alternate entrypoint.
export { TaskCoordinator } from '../durable-objects/task-coordinator';
export { CockpitWebSocket } from '../durable-objects/cockpit-websocket';
export { SystemEvents } from '../durable-objects/system-events';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Safety: never expose this endpoint outside dev.
    if (env.ENVIRONMENT !== 'development') {
      return new Response('Not found', { status: 404 });
    }

    if (url.pathname !== '/__poc/extract-pdf-text') {
      return new Response('Not found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/pdf')) {
      return Response.json(
        { ok: false, error: 'Content-Type must be application/pdf' },
        { status: 415 }
      );
    }

    try {
      const start = Date.now();
      const buf = await request.arrayBuffer();
      const result = await extractPdfText(buf, {
        maxBytes: 10 * 1024 * 1024,
        maxPages: 50,
      });
      const elapsedMs = Date.now() - start;

      const text = result.text;
      return Response.json({
        ok: true,
        elapsedMs,
        totalPages: result.totalPages,
        byteLength: result.byteLength,
        textLength: text.length,
        textPreview: text.slice(0, 2000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      return Response.json(
        {
          ok: false,
          error: message,
          stack: stack ? stack.split('\n').slice(0, 8).join('\n') : undefined,
        },
        { status: 500 }
      );
    }
  },
};

