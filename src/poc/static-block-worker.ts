import type { Env } from '../types';

// Satisfy wrangler.toml Durable Object bindings when using this alternate entrypoint.
export { TaskCoordinator } from '../durable-objects/task-coordinator';
export { CockpitWebSocket } from '../durable-objects/cockpit-websocket';
export { SystemEvents } from '../durable-objects/system-events';

class StaticBlockThisSmoke {
  static value = 0;
  static {
    // If Workers/miniflare mishandles `this` here, this assignment will throw.
    this.value = 42;
  }
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    if (env.ENVIRONMENT !== 'development') {
      return new Response('Not found', { status: 404 });
    }
    return Response.json({
      ok: true,
      value: StaticBlockThisSmoke.value,
    });
  },
};

