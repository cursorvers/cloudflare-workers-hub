/**
 * CockpitWebSocket Durable Object
 *
 * Manages real-time WebSocket connections between Local Agent (Mac) and Workers Hub.
 * Provides bidirectional communication for task execution, git status monitoring,
 * and system alerts.
 *
 * ## Architecture
 * - Each Local Agent connects via WebSocket (upgrades from HTTP)
 * - DO stores agent connection state in durable storage
 * - Messages validated with Zod schemas
 * - Authentication via API key on upgrade request
 *
 * ## Message Protocol
 * ### Incoming (from agent):
 * - agent-status: { type, agentId, status, capabilities }
 * - git-status: { type, repos: GitStatus[] }
 * - task-result: { type, taskId, result, status }
 * - pong: { type }
 *
 * ### Outgoing (to agent):
 * - task: { type, taskId, taskType, payload }
 * - ping: { type }
 * - status-request: { type }
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { z } from 'zod';

// =============================================================================
// Message Schemas (Zod validation)
// =============================================================================

const AgentStatusSchema = z.object({
  type: z.literal('agent-status'),
  agentId: z.string().min(1),
  status: z.enum(['online', 'offline', 'busy', 'idle']),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const GitStatusSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  branch: z.string().optional(),
  status: z.enum(['clean', 'dirty', 'ahead', 'behind', 'diverged']).optional(),
  uncommittedCount: z.number().int().min(0).optional(),
  aheadCount: z.number().int().min(0).optional(),
  behindCount: z.number().int().min(0).optional(),
  modifiedFiles: z.array(z.string()).optional(),
});

const GitStatusMessageSchema = z.object({
  type: z.literal('git-status'),
  repos: z.array(GitStatusSchema),
});

const TaskResultSchema = z.object({
  type: z.literal('task-result'),
  taskId: z.string().min(1),
  result: z.unknown(),
  status: z.enum(['completed', 'failed']),
  logs: z.string().optional(),
});

const PongSchema = z.object({
  type: z.literal('pong'),
  timestamp: z.number().optional(),
});

const IncomingMessageSchema = z.discriminatedUnion('type', [
  AgentStatusSchema,
  GitStatusMessageSchema,
  TaskResultSchema,
  PongSchema,
]);

// Outgoing message types (sent to agent)
const TaskMessageSchema = z.object({
  type: z.literal('task'),
  taskId: z.string(),
  taskType: z.string(),
  payload: z.unknown(),
});

const PingMessageSchema = z.object({
  type: z.literal('ping'),
  timestamp: z.number(),
});

const StatusRequestSchema = z.object({
  type: z.literal('status-request'),
});

// =============================================================================
// Types
// =============================================================================

type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
type GitStatus = z.infer<typeof GitStatusSchema>;

interface AgentConnection {
  agentId: string;
  connectedAt: string;
  lastPingAt?: string;
  status: 'online' | 'offline' | 'busy' | 'idle';
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

// =============================================================================
// CockpitWebSocket Durable Object
// =============================================================================

export class CockpitWebSocket extends DurableObject<Env> {
  private sessions: Map<WebSocket, AgentConnection> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore sessions from storage on initialization
    this.ctx.blockConcurrencyWhile(async () => {
      await this.restoreSessions();
    });

    // Set up periodic cleanup alarm (every 60 seconds)
    this.ctx.storage.setAlarm(Date.now() + 60000);
  }

  /**
   * Restore sessions from durable storage
   */
  private async restoreSessions(): Promise<void> {
    const stored = await this.ctx.storage.list<AgentConnection>({ prefix: 'agent:' });
    safeLog.log('[CockpitWebSocket] Restored sessions', { count: stored.size });
  }

  /**
   * Handle HTTP requests (WebSocket upgrade or internal API)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade request
    if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return await this.handleWebSocketUpgrade(request);
    }

    // Internal API for broadcasting tasks
    if (path === '/broadcast-task' && request.method === 'POST') {
      return await this.handleBroadcastTask(request);
    }

    // Get connected agents (monitoring)
    if (path === '/agents' && request.method === 'GET') {
      return await this.handleGetAgents(request);
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Handle WebSocket upgrade request with authentication
   */
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Verify API key
    const apiKey = this.env.QUEUE_API_KEY || this.env.ASSISTANT_API_KEY;
    if (apiKey) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== apiKey) {
        safeLog.warn('[CockpitWebSocket] Unauthorized upgrade attempt');
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // Upgrade to WebSocket
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    this.ctx.acceptWebSocket(server);

    safeLog.log('[CockpitWebSocket] WebSocket upgraded');

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      // Parse message
      if (typeof message !== 'string') {
        safeLog.warn('[CockpitWebSocket] Received non-string message');
        return;
      }

      const parsed = JSON.parse(message);
      const validated = IncomingMessageSchema.parse(parsed);

      // Route message by type
      switch (validated.type) {
        case 'agent-status':
          await this.handleAgentStatus(ws, validated);
          break;
        case 'git-status':
          await this.handleGitStatus(validated);
          break;
        case 'task-result':
          await this.handleTaskResult(validated);
          break;
        case 'pong':
          await this.handlePong(ws);
          break;
        default:
          safeLog.warn('[CockpitWebSocket] Unknown message type', { type: (validated as any).type });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        safeLog.error('[CockpitWebSocket] Message validation failed', {
          errors: error.errors,
        });
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
          details: error.errors,
        }));
      } else {
        safeLog.error('[CockpitWebSocket] Message handling error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const agent = this.sessions.get(ws);
    if (agent) {
      safeLog.log('[CockpitWebSocket] Agent disconnected', {
        agentId: agent.agentId,
        code,
        reason,
        wasClean,
      });

      // Update status to offline
      const key = `agent:${agent.agentId}`;
      await this.ctx.storage.put(key, {
        ...agent,
        status: 'offline',
      });

      this.sessions.delete(ws);
    }
  }

  /**
   * Handle WebSocket error
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const agent = this.sessions.get(ws);
    safeLog.error('[CockpitWebSocket] WebSocket error', {
      agentId: agent?.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Handle agent status update
   */
  private async handleAgentStatus(
    ws: WebSocket,
    message: z.infer<typeof AgentStatusSchema>
  ): Promise<void> {
    const { agentId, status, capabilities, metadata } = message;

    const agent: AgentConnection = {
      agentId,
      connectedAt: new Date().toISOString(),
      status,
      capabilities,
      metadata,
    };

    // Store in memory
    this.sessions.set(ws, agent);

    // Persist to storage
    const key = `agent:${agentId}`;
    await this.ctx.storage.put(key, agent);

    safeLog.log('[CockpitWebSocket] Agent status updated', {
      agentId,
      status,
      capabilities,
    });

    // Acknowledge
    ws.send(JSON.stringify({
      type: 'ack',
      message: 'Status updated',
    }));
  }

  /**
   * Handle git status update from agent
   */
  private async handleGitStatus(message: z.infer<typeof GitStatusMessageSchema>): Promise<void> {
    const { repos } = message;

    if (!this.env.DB) {
      safeLog.warn('[CockpitWebSocket] DB not available for git status update');
      return;
    }

    // Update cockpit_git_repos table
    for (const repo of repos) {
      try {
        await this.env.DB.prepare(`
          INSERT INTO cockpit_git_repos (
            id, path, name, branch, status,
            uncommitted_count, ahead_count, behind_count,
            last_checked, modified_files
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            branch = excluded.branch,
            status = excluded.status,
            uncommitted_count = excluded.uncommitted_count,
            ahead_count = excluded.ahead_count,
            behind_count = excluded.behind_count,
            last_checked = excluded.last_checked,
            modified_files = excluded.modified_files
        `).bind(
          repo.id,
          repo.path,
          repo.name,
          repo.branch || null,
          repo.status || null,
          repo.uncommittedCount || 0,
          repo.aheadCount || 0,
          repo.behindCount || 0,
          Math.floor(Date.now() / 1000),
          repo.modifiedFiles ? JSON.stringify(repo.modifiedFiles) : null
        ).run();

        safeLog.log('[CockpitWebSocket] Git repo updated', { repoId: repo.id, path: repo.path });
      } catch (error) {
        safeLog.error('[CockpitWebSocket] Failed to update git repo', {
          repoId: repo.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle task result from agent
   */
  private async handleTaskResult(message: z.infer<typeof TaskResultSchema>): Promise<void> {
    const { taskId, result, status, logs } = message;

    if (!this.env.DB) {
      safeLog.warn('[CockpitWebSocket] DB not available for task result');
      return;
    }

    try {
      await this.env.DB.prepare(`
        UPDATE cockpit_tasks
        SET status = ?, result = ?, logs = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        status,
        JSON.stringify(result),
        logs || null,
        Math.floor(Date.now() / 1000),
        taskId
      ).run();

      safeLog.log('[CockpitWebSocket] Task result updated', { taskId, status });
    } catch (error) {
      safeLog.error('[CockpitWebSocket] Failed to update task result', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle pong response
   */
  private async handlePong(ws: WebSocket): Promise<void> {
    const agent = this.sessions.get(ws);
    if (agent) {
      agent.lastPingAt = new Date().toISOString();
      const key = `agent:${agent.agentId}`;
      await this.ctx.storage.put(key, agent);
    }
  }

  /**
   * Broadcast task to all connected agents (or specific agent)
   */
  private async handleBroadcastTask(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const task = TaskMessageSchema.parse(body);

      let sentCount = 0;
      for (const [ws, agent] of this.sessions) {
        if (agent.status === 'online' || agent.status === 'idle') {
          ws.send(JSON.stringify(task));
          sentCount++;
        }
      }

      safeLog.log('[CockpitWebSocket] Task broadcasted', {
        taskId: task.taskId,
        sentCount,
      });

      return new Response(JSON.stringify({
        success: true,
        sentCount,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[CockpitWebSocket] Broadcast task failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Get connected agents (monitoring)
   */
  private async handleGetAgents(request: Request): Promise<Response> {
    const agents: AgentConnection[] = [];
    for (const agent of this.sessions.values()) {
      agents.push(agent);
    }

    return new Response(JSON.stringify({
      agents,
      count: agents.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Periodic alarm to ping agents and cleanup stale connections
   */
  async alarm(): Promise<void> {
    safeLog.log('[CockpitWebSocket] Alarm triggered, pinging agents');

    const now = Date.now();
    const staleThresholdMs = 120 * 1000; // 2 minutes

    for (const [ws, agent] of this.sessions) {
      // Send ping
      try {
        ws.send(JSON.stringify({
          type: 'ping',
          timestamp: now,
        }));
      } catch (error) {
        safeLog.warn('[CockpitWebSocket] Failed to send ping', {
          agentId: agent.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Check for stale connections
      if (agent.lastPingAt) {
        const lastPingTime = new Date(agent.lastPingAt).getTime();
        if (now - lastPingTime > staleThresholdMs) {
          safeLog.warn('[CockpitWebSocket] Stale connection detected', {
            agentId: agent.agentId,
            lastPingAt: agent.lastPingAt,
          });
          ws.close(1000, 'Stale connection');
        }
      }
    }

    // Schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
}
