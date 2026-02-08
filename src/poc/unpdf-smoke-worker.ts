import type { Env } from '../types';
import { extractPdfText } from '../services/pdf-text-extractor';
import { createMinimalHelloWorldPdf } from './pdf-fixtures';

// Satisfy wrangler.toml Durable Object bindings when using this alternate entrypoint.
export { TaskCoordinator } from '../durable-objects/task-coordinator';
export { CockpitWebSocket } from '../durable-objects/cockpit-websocket';
export { SystemEvents } from '../durable-objects/system-events';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/__poc/unpdf') {
      return new Response('Not found', { status: 404 });
    }

    // Safety: never expose this endpoint outside dev.
    if (env.ENVIRONMENT !== 'development') {
      return new Response('Not found', { status: 404 });
    }

    try {
      const start = Date.now();
      const result = await extractPdfText(createMinimalHelloWorldPdf(), {
        maxBytes: 1024 * 1024,
        maxPages: 5,
      });
      const elapsedMs = Date.now() - start;

      return Response.json({
        ok: true,
        elapsedMs,
        totalPages: result.totalPages,
        byteLength: result.byteLength,
        textPreview: result.text.slice(0, 200),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      return Response.json(
        {
          ok: false,
          error: message,
          stack: stack ? stack.split('\n').slice(0, 5).join('\n') : undefined,
        },
        { status: 500 }
      );
    }
  },
};
