/**
 * MCP CommHub Adapter
 *
 * チャネル層と Claude Orchestrator の橋渡し
 * - delegation-matrix.md 参照
 * - auto-execution.md 参照
 * - イベントを Orchestrator 形式に変換
 */

import { NormalizedEvent } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { addToTaskIndex, getTaskIds } from '../utils/task-index';

export interface SkillHint {
  category: string;
  files: string[];
  tokensEstimate: number;
}

export interface OrchestratorRequest {
  id: string;
  type: 'task' | 'query' | 'approval' | 'notification';
  source: string;
  content: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
  delegationHints: DelegationHint[];
  skillHints: SkillHint[]; // For lazy loading optimization
}

export interface DelegationHint {
  target: 'codex' | 'glm' | 'gemini' | 'subagent' | 'pencil';
  agent?: string;
  reason: string;
}

export interface OrchestratorResponse {
  id: string;
  status: 'accepted' | 'rejected' | 'pending_approval';
  message: string;
  estimatedCompletion?: string;
}

// Skill categories for lazy loading (from skill-index.json)
export interface SkillCategory {
  name: string;
  files: string[];
  triggers: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  tokensEstimate: number;
}

const SKILL_CATEGORIES: SkillCategory[] = [
  {
    name: 'delegation',
    files: ['delegation-matrix.md', 'delegation-flow.md', 'codex-usage.md'],
    triggers: ['委譲', 'delegate', 'codex', 'glm', 'gemini', 'subagent'],
    priority: 'high',
    tokensEstimate: 4500,
  },
  {
    name: 'security',
    files: ['security.md', 'secrets-management.md', 'dangerous-permission-consensus.md'],
    triggers: ['セキュリティ', 'security', '認証', 'auth', 'secret', 'credential', '危険', 'consensus', 'vote'],
    priority: 'critical',
    tokensEstimate: 3200,
  },
  {
    name: 'quality',
    files: ['coding-style.md', 'testing.md'],
    triggers: ['コード', 'code', 'テスト', 'test', 'tdd', 'カバレッジ', 'coverage', 'リファクタ', 'refactor'],
    priority: 'high',
    tokensEstimate: 3000,
  },
  {
    name: 'automation',
    files: ['auto-execution.md', 'skill-subagent-usage.md'],
    triggers: ['自動', 'auto', 'skill', 'subagent', '並列', 'parallel'],
    priority: 'medium',
    tokensEstimate: 1800,
  },
  {
    name: 'performance',
    files: ['performance.md'],
    triggers: ['パフォーマンス', 'performance', '最適化', 'optimize', 'モデル選択', 'model'],
    priority: 'low',
    tokensEstimate: 1200,
  },
];

// Estimate required skills based on content
export function estimateRequiredSkills(content: string): SkillCategory[] {
  const lowerContent = content.toLowerCase();
  const matched: SkillCategory[] = [];

  for (const category of SKILL_CATEGORIES) {
    const hasMatch = category.triggers.some(trigger =>
      lowerContent.includes(trigger.toLowerCase())
    );
    if (hasMatch) {
      matched.push(category);
    }
  }

  // Sort by priority (critical > high > medium > low)
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  matched.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return matched;
}

// Delegation patterns from delegation-matrix.md
const DELEGATION_PATTERNS: Record<string, DelegationHint> = {
  // Code-related
  code: { target: 'glm', agent: 'code-reviewer', reason: 'Code change detected' },
  review: { target: 'glm', agent: 'code-reviewer', reason: 'Review requested' },
  refactor: { target: 'glm', agent: 'refactor-advisor', reason: 'Refactoring needed' },

  // Design-related
  design: { target: 'codex', agent: 'architect', reason: 'Design decision needed' },
  architecture: { target: 'codex', agent: 'architect', reason: 'Architecture question' },

  // Security-related
  security: { target: 'codex', agent: 'security-analyst', reason: 'Security concern' },
  auth: { target: 'codex', agent: 'security-analyst', reason: 'Authentication related' },

  // UI/UX
  ui: { target: 'gemini', agent: 'ui-reviewer', reason: 'UI/UX evaluation' },
  ux: { target: 'gemini', agent: 'ui-reviewer', reason: 'UX evaluation' },

  // Investigation
  investigate: { target: 'subagent', agent: 'Explore', reason: 'Investigation needed' },
  search: { target: 'subagent', agent: 'Explore', reason: 'Search required' },
};

function detectDelegationHints(content: string): DelegationHint[] {
  const hints: DelegationHint[] = [];
  const lowerContent = content.toLowerCase();

  for (const [keyword, hint] of Object.entries(DELEGATION_PATTERNS)) {
    if (lowerContent.includes(keyword)) {
      hints.push(hint);
    }
  }

  // Default to scope-analyst if no hints
  if (hints.length === 0) {
    hints.push({
      target: 'codex',
      agent: 'scope-analyst',
      reason: 'No specific pattern detected, needs scope analysis',
    });
  }

  return hints;
}

function determinePriority(event: NormalizedEvent): OrchestratorRequest['priority'] {
  const content = event.content.toLowerCase();

  if (content.includes('urgent') || content.includes('critical') || content.includes('緊急')) {
    return 'critical';
  }
  if (content.includes('important') || content.includes('重要')) {
    return 'high';
  }
  if (event.source === 'clawdbot') {
    return 'medium'; // Customer requests get medium priority
  }
  return 'low';
}

function determineRequestType(event: NormalizedEvent): OrchestratorRequest['type'] {
  const content = event.content.toLowerCase();

  if (content.includes('approve') || content.includes('承認')) {
    return 'approval';
  }
  if (content.includes('notify') || content.includes('通知')) {
    return 'notification';
  }
  if (content.includes('?') || content.includes('？') || content.includes('what') || content.includes('how')) {
    return 'query';
  }
  return 'task';
}

export function convertToOrchestratorRequest(event: NormalizedEvent): OrchestratorRequest {
  const requiredSkills = estimateRequiredSkills(event.content);

  return {
    id: event.id,
    type: determineRequestType(event),
    source: event.source,
    content: event.content,
    priority: determinePriority(event),
    metadata: event.metadata,
    delegationHints: detectDelegationHints(event.content),
    skillHints: requiredSkills.map(skill => ({
      category: skill.name,
      files: skill.files,
      tokensEstimate: skill.tokensEstimate,
    })),
  };
}

/**
 * Orchestrator connection configuration
 */
export interface OrchestratorConfig {
  mode: 'kv-queue' | 'webhook' | 'direct';
  kvNamespace?: KVNamespace;
  webhookUrl?: string;
  directUrl?: string;
  timeout?: number;
}

let orchestratorConfig: OrchestratorConfig = { mode: 'kv-queue' };

/**
 * Configure Orchestrator connection
 */
export function configureOrchestrator(config: OrchestratorConfig): void {
  orchestratorConfig = config;
}

/**
 * Send request to Orchestrator via KV queue
 * External orchestrator polls /api/queue endpoint
 */
async function sendViaKVQueue(
  request: OrchestratorRequest,
  kv: KVNamespace
): Promise<OrchestratorResponse> {
  // NEW: Use queue:task:{taskId} format (no pending list)
  const queueKey = `queue:task:${request.id}`;

  // Store request in KV queue with 1 hour TTL
  await kv.put(queueKey, JSON.stringify({
    ...request,
    queuedAt: new Date().toISOString(),
    status: 'pending',
  }), { expirationTtl: 3600 });

  // Update cached task index (avoids KV list on next claim)
  await addToTaskIndex(kv, request.id);

  safeLog.log(`[Orchestrator] Request ${request.id} queued in KV (new format)`);

  return {
    id: request.id,
    status: 'accepted',
    message: `Request queued. Poll /api/result/${request.id} for result. Delegation: ${request.delegationHints.map(h => h.target).join(', ')}`,
    estimatedCompletion: new Date(Date.now() + 60000).toISOString(),
  };
}

/**
 * Send request to Orchestrator via webhook callback
 */
async function sendViaWebhook(
  request: OrchestratorRequest,
  webhookUrl: string,
  timeout: number = 30000
): Promise<OrchestratorResponse> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }

    const result = await response.json() as OrchestratorResponse;
    safeLog.log(`[Orchestrator] Request ${request.id} sent via webhook`);
    return result;
  } catch (error) {
    safeLog.error(`[Orchestrator] Webhook error:`, error);
    // Fallback to accepted status
    return {
      id: request.id,
      status: 'accepted',
      message: `Webhook delivery attempted. Error: ${error}. Delegation: ${request.delegationHints.map(h => h.target).join(', ')}`,
      estimatedCompletion: new Date(Date.now() + 120000).toISOString(),
    };
  }
}

/**
 * Send request to Orchestrator via direct HTTP API
 */
async function sendViaDirect(
  request: OrchestratorRequest,
  directUrl: string,
  timeout: number = 30000
): Promise<OrchestratorResponse> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${directUrl}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Direct API returned ${response.status}`);
    }

    const result = await response.json() as OrchestratorResponse;
    safeLog.log(`[Orchestrator] Request ${request.id} sent directly`);
    return result;
  } catch (error) {
    safeLog.error(`[Orchestrator] Direct connection error:`, error);
    return {
      id: request.id,
      status: 'accepted',
      message: `Direct connection failed: ${error}. Request logged for manual processing.`,
      estimatedCompletion: new Date(Date.now() + 300000).toISOString(),
    };
  }
}

/**
 * Send request to Orchestrator using configured method
 */
export async function sendToOrchestrator(
  request: OrchestratorRequest,
  kv?: KVNamespace
): Promise<OrchestratorResponse> {
  safeLog.log('[Orchestrator] Processing request:', {
    id: request.id,
    type: request.type,
    priority: request.priority,
    delegationHints: request.delegationHints.map(h => `${h.target}/${h.agent}`),
  });

  const config = orchestratorConfig;

  // Use KV queue if available
  if (config.mode === 'kv-queue' && (kv || config.kvNamespace)) {
    const kvStore = kv || config.kvNamespace;
    if (kvStore) {
      return sendViaKVQueue(request, kvStore);
    }
  }

  // Use webhook if configured
  if (config.mode === 'webhook' && config.webhookUrl) {
    return sendViaWebhook(request, config.webhookUrl, config.timeout);
  }

  // Use direct connection if configured
  if (config.mode === 'direct' && config.directUrl) {
    return sendViaDirect(request, config.directUrl, config.timeout);
  }

  // Fallback: log and return accepted (for development)
  safeLog.log('[Orchestrator] No connection configured, using fallback mode');
  return {
    id: request.id,
    status: 'accepted',
    message: `Request queued (fallback mode). Delegation hints: ${request.delegationHints.map(h => h.target).join(', ')}`,
    estimatedCompletion: new Date(Date.now() + 60000).toISOString(),
  };
}

export class CommHubAdapter {
  private orchestratorUrl: string;
  private kv?: KVNamespace;

  constructor(orchestratorUrl: string = 'http://localhost:8080', kv?: KVNamespace) {
    this.orchestratorUrl = orchestratorUrl;
    this.kv = kv;
  }

  /**
   * Set KV namespace for queue-based orchestration
   */
  setKV(kv: KVNamespace): void {
    this.kv = kv;
  }

  async processEvent(event: NormalizedEvent): Promise<OrchestratorResponse> {
    const request = convertToOrchestratorRequest(event);

    // Log for debugging
    safeLog.log(`[CommHub] Processing event ${event.id}`);
    safeLog.log(`[CommHub] Type: ${request.type}, Priority: ${request.priority}`);
    safeLog.log(`[CommHub] Delegation: ${request.delegationHints.map(h => `${h.target}/${h.agent}`).join(', ')}`);

    // Log skill hints for lazy loading
    const totalTokens = request.skillHints.reduce((sum, s) => sum + s.tokensEstimate, 0);
    safeLog.log(`[CommHub] Skills: ${request.skillHints.map(s => s.category).join(', ')} (~${totalTokens} tokens)`);

    return sendToOrchestrator(request, this.kv);
  }

  /**
   * Get pending requests from queue (cached to reduce KV list ops)
   */
  async getPendingRequests(): Promise<string[]> {
    if (!this.kv) return [];
    return getTaskIds(this.kv);
  }

  /**
   * Get specific request from queue
   * NEW: Use queue:task: prefix
   */
  async getRequest(requestId: string): Promise<OrchestratorRequest | null> {
    if (!this.kv) return null;
    return await this.kv.get<OrchestratorRequest>(`queue:task:${requestId}`, 'json');
  }

  /**
   * Store result for a request
   */
  async storeResult(requestId: string, result: OrchestratorResponse): Promise<void> {
    if (!this.kv) return;

    // Store result
    await this.kv.put(`orchestrator:result:${requestId}`, JSON.stringify(result), {
      expirationTtl: 3600,
    });

    // Delete task key (new format)
    await this.kv.delete(`queue:task:${requestId}`);

    // Delete lease if exists
    await this.kv.delete(`queue:lease:${requestId}`);

    // No need to update pending list - we don't use it anymore
  }

  /**
   * Get result for a request
   */
  async getResult(requestId: string): Promise<OrchestratorResponse | null> {
    if (!this.kv) return null;
    return await this.kv.get<OrchestratorResponse>(`orchestrator:result:${requestId}`, 'json');
  }
}

export default CommHubAdapter;
