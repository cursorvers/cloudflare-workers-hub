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
import { verifyAccessToken, hasPermission, type UserRole } from '../utils/jwt-auth';
import { CockpitGateway, type WebSocketMessage, type OrchestratorRequest } from '../fugue/cockpit-gateway';

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

const StatusRequestSchema = z.object({
  type: z.literal('status-request'),
});

const ChatMessageSchema = z.object({
  type: z.literal('chat'),
  payload: z.object({
    message: z.string().min(1).max(10000),
    context: z.record(z.unknown()).optional(),
  }),
});

const CommandMessageSchema = z.object({
  type: z.literal('command'),
  payload: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  }),
});

// =============================================================================
// Observability Schemas
// =============================================================================

const ProviderHealthSchema = z.object({
  provider: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']),
  latency_p95_ms: z.number().optional(),
  error_rate: z.number().optional(),
  last_request_at: z.number().optional(),
});

const CostDataSchema = z.object({
  date: z.string(),
  provider: z.string(),
  call_count: z.number().int().min(0),
  total_tokens: z.number().int().min(0),
  total_cost_usd: z.number().min(0),
});

const RequestSampleSchema = z.object({
  timestamp: z.number(),
  provider: z.string(),
  agent: z.string().optional(),
  latency_ms: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cost_usd: z.number().optional(),
  status: z.enum(['success', 'error', 'timeout']).optional(),
  error_message: z.string().optional(),
});

const ObservabilitySyncSchema = z.object({
  type: z.literal('observability-sync'),
  provider_health: z.array(ProviderHealthSchema).optional(),
  costs: z.array(CostDataSchema).optional(),
  requests: z.array(RequestSampleSchema).optional(),
  budget_status: z.object({
    provider: z.string(),
    daily_spent_usd: z.number(),
    weekly_spent_usd: z.number().optional(),
    monthly_spent_usd: z.number().optional(),
  }).array().optional(),
});

const IncomingMessageSchema = z.discriminatedUnion('type', [
  AgentStatusSchema,
  GitStatusMessageSchema,
  TaskResultSchema,
  PongSchema,
  ObservabilitySyncSchema,
  StatusRequestSchema,
  ChatMessageSchema,
  CommandMessageSchema,
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

// =============================================================================
// Types
// =============================================================================

type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
type GitStatus = z.infer<typeof GitStatusSchema>;

interface AgentConnection {
  agentId: string;
  userId: string;      // JWT sub claim
  role: UserRole;      // JWT role claim
  connectedAt: string;
  lastPingAt?: string;
  status: 'online' | 'offline' | 'busy' | 'idle';
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Persistent State Interface (for DO eviction recovery)
// =============================================================================

interface PendingTask {
  taskId: string;
  taskType: string;
  payload: unknown;
  createdAt: number;
  retryCount: number;
}

interface CockpitState {
  pendingTasks: PendingTask[];
  lastSavedAt: number;
}

// =============================================================================
// CockpitWebSocket Durable Object
// =============================================================================

export class CockpitWebSocket extends DurableObject<Env> {
  private sessions: Map<WebSocket, AgentConnection> = new Map();
  private pendingTasks: Map<string, PendingTask> = new Map();
  private gateway: CockpitGateway = new CockpitGateway();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state from storage on initialization (critical for DO eviction recovery)
    this.ctx.blockConcurrencyWhile(async () => {
      await this.restoreSessions();
      await this.loadState();
    });

    // Set up periodic cleanup alarm (every 60 seconds)
    this.ctx.storage.setAlarm(Date.now() + 60000);
  }

  /**
   * Save persistent state to durable storage
   * Called after task queue changes to survive DO eviction
   */
  private async saveState(): Promise<void> {
    const state: CockpitState = {
      pendingTasks: Array.from(this.pendingTasks.values()),
      lastSavedAt: Date.now(),
    };
    await this.ctx.storage.put('cockpitState', state);
    safeLog.log('[CockpitWebSocket] State saved', {
      pendingTasksCount: this.pendingTasks.size
    });
  }

  /**
   * Load persistent state from durable storage
   * Called on DO initialization to recover from eviction
   */
  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<CockpitState>('cockpitState');
    if (stored) {
      this.pendingTasks = new Map(
        stored.pendingTasks.map(task => [task.taskId, task])
      );
      safeLog.log('[CockpitWebSocket] State loaded', {
        pendingTasksCount: this.pendingTasks.size,
        lastSavedAt: stored.lastSavedAt,
      });
    } else {
      this.pendingTasks = new Map();
      safeLog.log('[CockpitWebSocket] No stored state found, initialized fresh');
    }
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

    // Internal API for broadcasting alerts (from notification-hub)
    if (path === '/broadcast-alert' && request.method === 'POST') {
      return await this.handleBroadcastAlert(request);
    }

    // Get connected agents (monitoring)
    if (path === '/agents' && request.method === 'GET') {
      return await this.handleGetAgents(request);
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Handle WebSocket upgrade request with multiple authentication methods
   *
   * Supports three authentication methods (in priority order):
   * 1. Cloudflare Access (for PWA via Access-protected routes) - via X-Access-User-* headers from main router
   * 2. API Key (for Local Agent/service accounts) - via X-API-Key header or Bearer token matching QUEUE_API_KEY
   * 3. JWT token (for direct access) - via query param or Authorization header
   */
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Extract credentials from various sources
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token');
    const authHeader = request.headers.get('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const apiKeyHeader = request.headers.get('X-API-Key');
    const agentIdHeader = request.headers.get('X-Agent-Id');

    // Check for pre-verified Cloudflare Access user (from main router)
    const accessUserId = request.headers.get('X-Access-User-Id');
    const accessUserRole = request.headers.get('X-Access-User-Role');
    const accessUserEmail = request.headers.get('X-Access-User-Email');

    // Method 1: Cloudflare Access (pre-verified by main router)
    if (accessUserId && accessUserRole) {
      safeLog.log('[CockpitWebSocket] Cloudflare Access authentication', {
        userId: accessUserId,
        role: accessUserRole,
        email: accessUserEmail,
      });

      // Check WebSocket permission
      if (!hasPermission('WS', '/ws', accessUserRole as UserRole)) {
        safeLog.warn('[CockpitWebSocket] Insufficient permissions for WebSocket', {
          role: accessUserRole,
        });
        return new Response('Forbidden: Insufficient permissions', { status: 403 });
      }

      // Upgrade to WebSocket
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const sessionData = {
        userId: accessUserId,
        role: accessUserRole as UserRole,
        email: accessUserEmail,
        authMethod: 'cloudflare-access',
      };

      this.ctx.acceptWebSocket(server, [JSON.stringify(sessionData)]);

      safeLog.log('[CockpitWebSocket] WebSocket upgraded (Cloudflare Access)', {
        userId: accessUserId,
        role: accessUserRole,
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // Method 2: API Key authentication (for Local Agent)
    if (this.env.QUEUE_API_KEY && (apiKeyHeader === this.env.QUEUE_API_KEY || headerToken === this.env.QUEUE_API_KEY)) {
      safeLog.log('[CockpitWebSocket] API Key authentication for Local Agent', { agentId: agentIdHeader });

      // Upgrade to WebSocket with service account credentials
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const sessionData = {
        userId: agentIdHeader || 'local-agent',
        role: 'operator' as UserRole,
        isServiceAccount: true,
        authMethod: 'api-key',
      };

      this.ctx.acceptWebSocket(server, [JSON.stringify(sessionData)]);

      safeLog.log('[CockpitWebSocket] WebSocket upgraded (Service Account)', {
        agentId: agentIdHeader,
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // Method 3: JWT token (legacy/direct access)
    const token = queryToken || headerToken;

    if (!token) {
      safeLog.warn('[CockpitWebSocket] Missing authentication (Access, JWT, or API Key)');
      return new Response('Unauthorized: Missing token or API key', { status: 401 });
    }

    // Verify JWT token
    const payload = await verifyAccessToken(token, this.env);
    if (!payload) {
      safeLog.warn('[CockpitWebSocket] Invalid JWT token');
      return new Response('Unauthorized: Invalid token', { status: 401 });
    }

    // Check WebSocket permission (admin + operator only)
    if (!hasPermission('WS', '/ws', payload.role)) {
      safeLog.warn('[CockpitWebSocket] Insufficient permissions for WebSocket', {
        role: payload.role,
      });
      return new Response('Forbidden: Insufficient permissions', { status: 403 });
    }

    // Upgrade to WebSocket
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Store user info in session (will be set in agent-status message)
    // For now, we'll pass it via tag
    const sessionData = {
      userId: payload.sub,
      role: payload.role,
      authMethod: 'jwt',
    };

    // Accept the WebSocket connection with tags
    this.ctx.acceptWebSocket(server, [JSON.stringify(sessionData)]);

    safeLog.log('[CockpitWebSocket] WebSocket upgraded', {
      userId: payload.sub,
      role: payload.role,
    });

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
        case 'observability-sync':
          await this.handleObservabilitySync(validated);
          break;
        case 'status-request':
          await this.handleStatusRequest(ws);
          break;
        case 'chat':
          await this.handleChatMessage(ws, validated);
          break;
        case 'command':
          await this.handleCommandMessage(ws, validated);
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

    // Extract user info from WebSocket tags (set during upgrade)
    const tags = this.ctx.getTags(ws);
    let userId = 'unknown';
    let role: UserRole = 'viewer';

    if (tags.length > 0) {
      try {
        const sessionData = JSON.parse(tags[0]);
        userId = sessionData.userId;
        role = sessionData.role;
      } catch (error) {
        safeLog.warn('[CockpitWebSocket] Failed to parse session data from tags');
      }
    }

    const agent: AgentConnection = {
      agentId,
      userId,
      role,
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
      userId,
      role,
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
   * Handle status request from PWA client
   * Sends current state: tasks, repos, alerts, provider health
   */
  private async handleStatusRequest(ws: WebSocket): Promise<void> {
    if (!this.env.DB) {
      safeLog.warn('[CockpitWebSocket] DB not available for status request');
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Database not available',
      }));
      return;
    }

    try {
      // Fetch tasks (limit 20, most recent first)
      const tasksResult = await this.env.DB.prepare(`
        SELECT id, title, status, executor, created_at, updated_at, logs, result
        FROM cockpit_tasks
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      const tasks = (tasksResult.results || []).map((task: any) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        executor: task.executor,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        logs: task.logs,
        result: task.result ? JSON.parse(task.result) : null,
      }));

      // Send tasks
      ws.send(JSON.stringify({
        type: 'tasks',
        payload: tasks,
      }));

      // Fetch repos (limit 10)
      const reposResult = await this.env.DB.prepare(`
        SELECT id, name, path, branch, status, uncommitted_count, ahead_count, behind_count, last_checked, modified_files
        FROM cockpit_git_repos
        ORDER BY last_checked DESC
        LIMIT 10
      `).all();

      const repos = (reposResult.results || []).map((repo: any) => ({
        id: repo.id,
        name: repo.name,
        path: repo.path,
        branch: repo.branch,
        status: repo.status,
        uncommittedCount: repo.uncommitted_count,
        aheadCount: repo.ahead_count,
        behindCount: repo.behind_count,
        lastChecked: repo.last_checked,
        modifiedFiles: repo.modified_files ? JSON.parse(repo.modified_files) : [],
      }));

      // Send git status
      ws.send(JSON.stringify({
        type: 'git-status',
        payload: { repos },
      }));

      // Fetch alerts (unacknowledged, limit 10)
      const alertsResult = await this.env.DB.prepare(`
        SELECT id, severity, title, message, source, created_at, acknowledged
        FROM cockpit_alerts
        WHERE acknowledged = 0
        ORDER BY created_at DESC
        LIMIT 10
      `).all();

      const alerts = (alertsResult.results || []).map((alert: any) => ({
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        source: alert.source,
        createdAt: alert.created_at,
        acknowledged: alert.acknowledged === 1,
      }));

      // Send alerts one by one
      for (const alert of alerts) {
        ws.send(JSON.stringify({
          type: 'alert',
          payload: alert,
        }));
      }

      // Fetch provider health
      const healthResult = await this.env.DB.prepare(`
        SELECT provider, status, latency_p95_ms, error_rate, last_request_at
        FROM cockpit_provider_health
      `).all();

      const providerHealth = (healthResult.results || []).map((h: any) => ({
        provider: h.provider,
        status: h.status,
        latencyP95Ms: h.latency_p95_ms,
        errorRate: h.error_rate,
        lastRequestAt: h.last_request_at,
      }));

      // Send observability sync
      ws.send(JSON.stringify({
        type: 'observability-sync',
        payload: { provider_health: providerHealth },
      }));

      safeLog.log('[CockpitWebSocket] Status request handled', {
        tasksCount: tasks.length,
        reposCount: repos.length,
        alertsCount: alerts.length,
        providersCount: providerHealth.length,
      });
    } catch (error) {
      safeLog.error('[CockpitWebSocket] Status request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to fetch status',
      }));
    }
  }

  /**
   * Handle chat message from PWA client
   * Routes through CockpitGateway for FUGUE integration
   */
  private async handleChatMessage(
    ws: WebSocket,
    message: z.infer<typeof ChatMessageSchema>
  ): Promise<void> {
    // Get user info from session
    const tags = this.ctx.getTags(ws);
    let userId = 'unknown';
    let userRole = 'viewer';

    if (tags.length > 0) {
      try {
        const sessionData = JSON.parse(tags[0]);
        userId = sessionData.userId || 'unknown';
        userRole = sessionData.role || 'viewer';
      } catch {
        // Ignore parse errors
      }
    }

    // Route through CockpitGateway for FUGUE delegation
    const wsMessage: WebSocketMessage = {
      type: 'chat',
      payload: message.payload,
    };

    const { request, routingDecision } = await this.gateway.processMessage(wsMessage, userId);
    const now = Math.floor(Date.now() / 1000);

    // Check for dangerous operations requiring consensus
    if (routingDecision.requiresConsensus) {
      safeLog.warn('[CockpitWebSocket] Dangerous operation detected, requires consensus', {
        taskId: request.id,
        content: request.content.slice(0, 50),
      });
      // For now, still process but flag it (full 3-party consensus would need external calls)
    }

    // Store as a task in DB with delegation hints
    if (this.env.DB) {
      try {
        await this.env.DB.prepare(`
          INSERT INTO cockpit_tasks (
            id, title, status, executor, priority, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          request.id,
          request.content.slice(0, 100) + (request.content.length > 100 ? '...' : ''),
          'pending',
          routingDecision.agent, // Suggested agent from CockpitGateway
          routingDecision.requiresConsensus ? 'high' : 'normal',
          now,
          now,
          JSON.stringify({
            type: 'chat-instruction',
            orchestratorRequest: request,
            routingDecision,
            userRole,
          })
        ).run();

        safeLog.log('[CockpitWebSocket] Chat task created via Gateway', {
          taskId: request.id,
          userId,
          suggestedAgent: routingDecision.agent,
          confidence: routingDecision.confidence,
        });
      } catch (error) {
        safeLog.error('[CockpitWebSocket] Failed to create chat task', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Broadcast to connected agents with routing info
    const taskMessage = {
      type: 'task',
      taskId: request.id,
      taskType: 'orchestrator-request',
      payload: {
        orchestratorRequest: request,
        routingDecision,
      },
    };

    let agentCount = 0;
    for (const [agentWs, agent] of this.sessions) {
      if (agentWs !== ws && (agent.status === 'online' || agent.status === 'idle')) {
        try {
          agentWs.send(JSON.stringify(taskMessage));
          agentCount++;
        } catch {
          // Ignore send errors
        }
      }
    }

    // Send acknowledgment with routing info
    ws.send(JSON.stringify({
      type: 'ack',
      taskId: request.id,
      message: 'チャットを受信しました',
      agentCount,
      routing: {
        suggestedAgent: routingDecision.agent,
        confidence: routingDecision.confidence,
        keywords: request.delegationHints.keywords,
      },
    }));

    // Send task update to sender
    ws.send(JSON.stringify({
      type: 'task_created',
      payload: {
        id: request.id,
        title: request.content.slice(0, 100) + (request.content.length > 100 ? '...' : ''),
        status: 'pending',
        executor: routingDecision.agent,
        createdAt: now,
        updatedAt: now,
      },
    }));

    // Send chat response with routing info
    const routingInfo = routingDecision.confidence > 0.5
      ? `→ ${routingDecision.agent} (${Math.round(routingDecision.confidence * 100)}%)`
      : '';

    ws.send(JSON.stringify({
      type: 'chat-response',
      payload: {
        taskId: request.id,
        role: 'system',
        content: agentCount > 0
          ? `メッセージを受信しました。${agentCount}エージェントに転送中... ${routingInfo}`
          : `メッセージを受信しました。処理中... ${routingInfo}`,
        timestamp: now,
      },
    }));

    safeLog.log('[CockpitWebSocket] Chat message processed via Gateway', {
      taskId: request.id,
      userId,
      agentCount,
      messageLength: request.content.length,
      routing: routingDecision,
    });
  }

  /**
   * Handle command message from PWA client
   * Routes through CockpitGateway for FUGUE integration
   */
  private async handleCommandMessage(
    ws: WebSocket,
    message: z.infer<typeof CommandMessageSchema>
  ): Promise<void> {
    // Get user info from session
    const tags = this.ctx.getTags(ws);
    let userId = 'unknown';
    let userRole = 'viewer';

    if (tags.length > 0) {
      try {
        const sessionData = JSON.parse(tags[0]);
        userId = sessionData.userId || 'unknown';
        userRole = sessionData.role || 'viewer';
      } catch {
        // Ignore parse errors
      }
    }

    // Route through CockpitGateway for FUGUE delegation
    const wsMessage: WebSocketMessage = {
      type: 'command',
      payload: message.payload,
    };

    const { request, routingDecision } = await this.gateway.processMessage(wsMessage, userId);
    const now = Math.floor(Date.now() / 1000);

    // Check for dangerous operations requiring consensus
    if (routingDecision.requiresConsensus) {
      safeLog.warn('[CockpitWebSocket] Dangerous command detected, requires consensus', {
        taskId: request.id,
        command: message.payload.command,
      });
    }

    // Store as a task in DB with delegation hints
    if (this.env.DB) {
      try {
        await this.env.DB.prepare(`
          INSERT INTO cockpit_tasks (
            id, title, status, executor, priority, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          request.id,
          request.content,
          'pending',
          routingDecision.agent,
          routingDecision.requiresConsensus ? 'high' : 'normal',
          now,
          now,
          JSON.stringify({
            type: 'command',
            orchestratorRequest: request,
            routingDecision,
            userRole,
          })
        ).run();

        safeLog.log('[CockpitWebSocket] Command task created via Gateway', {
          taskId: request.id,
          command: message.payload.command,
          userId,
          suggestedAgent: routingDecision.agent,
        });
      } catch (error) {
        safeLog.error('[CockpitWebSocket] Failed to create command task', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Broadcast to connected agents with routing info
    const taskMessage = {
      type: 'task',
      taskId: request.id,
      taskType: 'orchestrator-request',
      payload: {
        orchestratorRequest: request,
        routingDecision,
      },
    };

    let agentCount = 0;
    for (const [agentWs, agent] of this.sessions) {
      if (agentWs !== ws && (agent.status === 'online' || agent.status === 'idle')) {
        try {
          agentWs.send(JSON.stringify(taskMessage));
          agentCount++;
        } catch {
          // Ignore send errors
        }
      }
    }

    // Send acknowledgment with routing info
    ws.send(JSON.stringify({
      type: 'ack',
      taskId: request.id,
      message: `コマンド ${message.payload.command} を受信しました`,
      agentCount,
      routing: {
        suggestedAgent: routingDecision.agent,
        confidence: routingDecision.confidence,
        requiresConsensus: routingDecision.requiresConsensus,
      },
    }));

    // Send task update to sender
    ws.send(JSON.stringify({
      type: 'task_created',
      payload: {
        id: request.id,
        title: request.content,
        status: 'pending',
        executor: routingDecision.agent,
        createdAt: now,
        updatedAt: now,
      },
    }));

    safeLog.log('[CockpitWebSocket] Command message processed via Gateway', {
      taskId: request.id,
      command: message.payload.command,
      userId,
      agentCount,
      routing: routingDecision,
    });
  }

  /**
   * Handle observability data sync from local agent
   */
  private async handleObservabilitySync(
    message: z.infer<typeof ObservabilitySyncSchema>
  ): Promise<void> {
    if (!this.env.DB) {
      safeLog.warn('[CockpitWebSocket] DB not available for observability sync');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Sync provider health
    if (message.provider_health) {
      for (const health of message.provider_health) {
        try {
          await this.env.DB.prepare(`
            UPDATE cockpit_provider_health
            SET status = ?, latency_p95_ms = ?, error_rate = ?,
                last_request_at = ?, updated_at = ?
            WHERE provider = ?
          `).bind(
            health.status,
            health.latency_p95_ms || null,
            health.error_rate || null,
            health.last_request_at || null,
            now,
            health.provider
          ).run();
        } catch (error) {
          safeLog.error('[CockpitWebSocket] Failed to update provider health', {
            provider: health.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Sync costs
    if (message.costs) {
      for (const cost of message.costs) {
        try {
          await this.env.DB.prepare(`
            INSERT INTO cockpit_costs (date, provider, call_count, total_tokens, total_cost_usd, synced_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, provider) DO UPDATE SET
              call_count = excluded.call_count,
              total_tokens = excluded.total_tokens,
              total_cost_usd = excluded.total_cost_usd,
              synced_at = excluded.synced_at
          `).bind(
            cost.date,
            cost.provider,
            cost.call_count,
            cost.total_tokens,
            cost.total_cost_usd,
            now
          ).run();
        } catch (error) {
          safeLog.error('[CockpitWebSocket] Failed to sync cost', {
            date: cost.date,
            provider: cost.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Sync recent requests (sample)
    if (message.requests) {
      for (const req of message.requests) {
        try {
          await this.env.DB.prepare(`
            INSERT INTO cockpit_observability_requests (
              timestamp, provider, agent, latency_ms,
              input_tokens, output_tokens, cost_usd, status, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            req.timestamp,
            req.provider,
            req.agent || null,
            req.latency_ms || null,
            req.input_tokens || null,
            req.output_tokens || null,
            req.cost_usd || null,
            req.status || null,
            req.error_message || null
          ).run();
        } catch (error) {
          safeLog.error('[CockpitWebSocket] Failed to insert request sample', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Cleanup old requests (keep last 1000)
      await this.env.DB.prepare(`
        DELETE FROM cockpit_observability_requests
        WHERE id NOT IN (
          SELECT id FROM cockpit_observability_requests
          ORDER BY timestamp DESC LIMIT 1000
        )
      `).run();
    }

    // Sync budget status
    if (message.budget_status) {
      for (const budget of message.budget_status) {
        try {
          await this.env.DB.prepare(`
            UPDATE cockpit_budget_status
            SET daily_spent_usd = ?, weekly_spent_usd = ?,
                monthly_spent_usd = ?, updated_at = ?
            WHERE provider = ?
          `).bind(
            budget.daily_spent_usd,
            budget.weekly_spent_usd || null,
            budget.monthly_spent_usd || null,
            now,
            budget.provider
          ).run();
        } catch (error) {
          safeLog.error('[CockpitWebSocket] Failed to update budget status', {
            provider: budget.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    safeLog.log('[CockpitWebSocket] Observability data synced', {
      providerHealthCount: message.provider_health?.length || 0,
      costsCount: message.costs?.length || 0,
      requestsCount: message.requests?.length || 0,
    });
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
   * Broadcast alert to all connected PWA clients
   * Called by notification-hub service to push alerts in real-time
   */
  private async handleBroadcastAlert(request: Request): Promise<Response> {
    try {
      const alert = await request.json() as {
        id: string;
        severity: string;
        title: string;
        message: string;
        source: string;
        createdAt: number;
        acknowledged: boolean;
      };

      // Validate required fields
      if (!alert.id || !alert.severity || !alert.title) {
        return new Response(JSON.stringify({ error: 'Missing required fields' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Broadcast to all connected sessions
      const alertMessage = {
        type: 'alert',
        payload: {
          id: alert.id,
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          source: alert.source,
          createdAt: alert.createdAt,
          acknowledged: alert.acknowledged,
        },
      };

      let sentCount = 0;
      for (const [ws] of this.sessions) {
        try {
          ws.send(JSON.stringify(alertMessage));
          sentCount++;
        } catch {
          // Ignore send errors for individual connections
        }
      }

      safeLog.log('[CockpitWebSocket] Alert broadcasted', {
        alertId: alert.id,
        severity: alert.severity,
        sentCount,
      });

      return new Response(JSON.stringify({
        success: true,
        sentCount,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[CockpitWebSocket] Broadcast alert failed', {
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
   * Periodic alarm to ping agents, cleanup stale connections, and persist state
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

    // Retry pending tasks to newly connected agents
    if (this.pendingTasks.size > 0 && this.sessions.size > 0) {
      const maxRetries = 3;
      for (const [taskId, task] of this.pendingTasks) {
        if (task.retryCount >= maxRetries) {
          safeLog.warn('[CockpitWebSocket] Task exceeded max retries', { taskId });
          this.pendingTasks.delete(taskId);
          continue;
        }

        // Try to send to an available agent
        for (const [ws, agent] of this.sessions) {
          if (agent.status === 'online' || agent.status === 'idle') {
            try {
              ws.send(JSON.stringify({
                type: 'task',
                taskId: task.taskId,
                taskType: task.taskType,
                payload: task.payload,
              }));
              task.retryCount++;
              safeLog.log('[CockpitWebSocket] Retried pending task', {
                taskId,
                retryCount: task.retryCount,
                agentId: agent.agentId,
              });
              break;
            } catch {
              // Continue to next agent
            }
          }
        }
      }
    }

    // Persist state periodically (safety net)
    await this.saveState();

    // Schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
}
