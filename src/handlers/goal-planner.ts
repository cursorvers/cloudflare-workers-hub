/**
 * Goal Planner API Handler
 *
 * Transforms high-level goals into executable action plans.
 * Part of FUGUE Evolution Phase 0.5.
 *
 * Features:
 * - Goal Parser: Natural language → Structured goal
 * - Action Generator: Goal → Action list (template-based)
 * - Dependency Resolver: Action ordering
 * - Executor integration: Connects to existing delegation system
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// Goal categories and their associated metrics
type GoalCategory = 'resource' | 'quality' | 'progress' | 'automation';

interface StructuredGoal {
  id: string;
  category: GoalCategory;
  metric: string;
  threshold: number;
  operator: '>' | '<' | '=' | '>=';
  deadline?: string;
  originalText: string;
  parsedAt: string;
}

interface Action {
  id: string;
  type: 'measure' | 'decide' | 'delegate' | 'notify' | 'adjust';
  target: string;
  params: Record<string, unknown>;
  dependsOn: string[];
}

interface ActionPlan {
  goalId: string;
  goal: StructuredGoal;
  actions: Action[];
  createdAt: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
}

interface ExecutionResult {
  actionId: string;
  status: 'success' | 'failed' | 'skipped';
  output?: unknown;
  error?: string;
  executedAt: string;
}

// Goal templates with predefined action sequences
const GOAL_TEMPLATES: Record<string, { category: GoalCategory; metric: string; actions: Omit<Action, 'id'>[] }> = {
  // Resource management
  'claude_exhaustion': {
    category: 'resource',
    metric: 'claude_usage',
    actions: [
      { type: 'measure', target: '/api/usage', params: { agent: 'claude' }, dependsOn: [] },
      { type: 'decide', target: 'threshold', params: { condition: 'usage > 80', metric: 'weekly' }, dependsOn: ['a1'] },
      { type: 'adjust', target: 'delegation-matrix', params: { increaseGLM: true, decreaseClaude: true }, dependsOn: ['a2'] },
      { type: 'notify', target: 'fugue-ui', params: { priority: 'high', channel: 'agents' }, dependsOn: ['a3'] },
    ],
  },
  'codex_budget': {
    category: 'resource',
    metric: 'codex_usage',
    actions: [
      { type: 'measure', target: '/api/usage', params: { agent: 'codex' }, dependsOn: [] },
      { type: 'decide', target: 'threshold', params: { condition: 'budget > 40', metric: 'monthly' }, dependsOn: ['a1'] },
      { type: 'notify', target: 'fugue-ui', params: { priority: 'medium', channel: 'agents' }, dependsOn: ['a2'] },
    ],
  },
  // Quality improvement
  'code_review_completion': {
    category: 'quality',
    metric: 'review_completion',
    actions: [
      { type: 'measure', target: '/api/cockpit/tasks', params: { type: 'review' }, dependsOn: [] },
      { type: 'decide', target: 'threshold', params: { condition: 'completion < 90' }, dependsOn: ['a1'] },
      { type: 'delegate', target: 'glm', params: { agent: 'code-reviewer', parallel: true }, dependsOn: ['a2'] },
      { type: 'notify', target: 'fugue-ui', params: { priority: 'medium', channel: 'tasks' }, dependsOn: ['a3'] },
    ],
  },
  // Progress tracking
  'task_completion': {
    category: 'progress',
    metric: 'task_completion',
    actions: [
      { type: 'measure', target: '/api/cockpit/tasks', params: {}, dependsOn: [] },
      { type: 'decide', target: 'threshold', params: { condition: 'pending > 10' }, dependsOn: ['a1'] },
      { type: 'notify', target: 'fugue-ui', params: { priority: 'low', channel: 'tasks' }, dependsOn: ['a2'] },
    ],
  },
  // Automation
  'consensus_timeout': {
    category: 'automation',
    metric: 'consensus_success',
    actions: [
      { type: 'measure', target: '/api/advisor/insights', params: { type: 'consensus' }, dependsOn: [] },
      { type: 'decide', target: 'threshold', params: { condition: 'timeout_rate > 50' }, dependsOn: ['a1'] },
      { type: 'adjust', target: 'consensus-config', params: { reduceTimeout: true }, dependsOn: ['a2'] },
      { type: 'notify', target: 'fugue-ui', params: { priority: 'medium', channel: 'system' }, dependsOn: ['a3'] },
    ],
  },
};

// Keywords for goal classification
const GOAL_KEYWORDS: Record<string, string[]> = {
  'claude_exhaustion': ['claude', '枯渇', 'exhaustion', 'limit', 'usage', '使用量', '制限'],
  'codex_budget': ['codex', 'budget', '予算', 'cost', 'コスト', 'openai'],
  'code_review_completion': ['review', 'レビュー', 'code', 'コード', '品質', 'quality', '完了率'],
  'task_completion': ['task', 'タスク', 'progress', '進捗', 'pending', '未完了'],
  'consensus_timeout': ['consensus', '合議', 'timeout', 'タイムアウト', 'vote', '投票'],
};

/**
 * Parse natural language goal into structured format
 */
function parseGoal(goalText: string): StructuredGoal | null {
  const lowered = goalText.toLowerCase();

  // Find matching template by keywords
  let matchedTemplate: string | null = null;
  let maxMatches = 0;

  for (const [templateKey, keywords] of Object.entries(GOAL_KEYWORDS)) {
    const matches = keywords.filter(kw => lowered.includes(kw.toLowerCase())).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      matchedTemplate = templateKey;
    }
  }

  if (!matchedTemplate || maxMatches === 0) {
    return null;
  }

  const template = GOAL_TEMPLATES[matchedTemplate];

  // Extract threshold from text (e.g., "80%", "90%")
  const thresholdMatch = goalText.match(/(\d+)%?/);
  const threshold = thresholdMatch ? parseInt(thresholdMatch[1], 10) : 80;

  return {
    id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: template.category,
    metric: template.metric,
    threshold,
    operator: template.category === 'resource' ? '>' : '<',
    originalText: goalText,
    parsedAt: new Date().toISOString(),
  };
}

/**
 * Generate action plan from structured goal
 */
function generateActionPlan(goal: StructuredGoal): ActionPlan {
  // Find template by metric
  const templateKey = Object.keys(GOAL_TEMPLATES).find(
    key => GOAL_TEMPLATES[key].metric === goal.metric
  );

  if (!templateKey) {
    // Default action plan if no template matches
    return {
      goalId: goal.id,
      goal,
      actions: [
        { id: 'a1', type: 'notify', target: 'fugue-ui', params: { message: 'Unknown goal type' }, dependsOn: [] },
      ],
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
  }

  const template = GOAL_TEMPLATES[templateKey];
  const actions = template.actions.map((action, idx) => ({
    ...action,
    id: `a${idx + 1}`,
    // Update dependsOn references
    dependsOn: action.dependsOn.map(dep => dep),
  }));

  return {
    goalId: goal.id,
    goal,
    actions,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
}

/**
 * Execute a single action (placeholder for now)
 */
async function executeAction(
  action: Action,
  env: Env,
  results: Map<string, ExecutionResult>
): Promise<ExecutionResult> {
  // Check dependencies
  for (const depId of action.dependsOn) {
    const depResult = results.get(depId);
    if (!depResult || depResult.status !== 'success') {
      return {
        actionId: action.id,
        status: 'skipped',
        error: `Dependency ${depId} not satisfied`,
        executedAt: new Date().toISOString(),
      };
    }
  }

  try {
    let output: unknown = null;

    switch (action.type) {
      case 'measure':
        // Fetch data from target endpoint
        if (action.target.startsWith('/api/') && env.CACHE) {
          // For now, just log the measurement intent
          safeLog.log('[Goal Planner] Measure action', { target: action.target, params: action.params });
          output = { measured: true, target: action.target };
        }
        break;

      case 'decide':
        // Evaluate condition (simplified)
        safeLog.log('[Goal Planner] Decide action', { condition: action.params.condition });
        output = { decided: true, condition: action.params.condition };
        break;

      case 'delegate':
        // Log delegation intent (actual delegation via existing scripts)
        safeLog.log('[Goal Planner] Delegate action', { target: action.target, params: action.params });
        output = { delegated: true, target: action.target };
        break;

      case 'adjust':
        // Log adjustment intent
        safeLog.log('[Goal Planner] Adjust action', { target: action.target, params: action.params });
        output = { adjusted: true, target: action.target };
        break;

      case 'notify':
        // Log notification (actual notification via FUGUE UI or WebSocket)
        safeLog.log('[Goal Planner] Notify action', { target: action.target, params: action.params });
        output = { notified: true, channel: action.params.channel };
        break;
    }

    return {
      actionId: action.id,
      status: 'success',
      output,
      executedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      actionId: action.id,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
      executedAt: new Date().toISOString(),
    };
  }
}

/**
 * Execute all actions in an action plan
 */
async function executePlan(plan: ActionPlan, env: Env): Promise<ExecutionResult[]> {
  const results = new Map<string, ExecutionResult>();
  const executionOrder: string[] = [];

  // Topological sort for execution order
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(actionId: string) {
    if (visited.has(actionId)) return;
    if (visiting.has(actionId)) throw new Error(`Circular dependency at ${actionId}`);

    visiting.add(actionId);
    const action = plan.actions.find(a => a.id === actionId);
    if (action) {
      for (const dep of action.dependsOn) {
        visit(dep);
      }
    }
    visiting.delete(actionId);
    visited.add(actionId);
    executionOrder.push(actionId);
  }

  for (const action of plan.actions) {
    visit(action.id);
  }

  // Execute in order
  for (const actionId of executionOrder) {
    const action = plan.actions.find(a => a.id === actionId);
    if (action) {
      const result = await executeAction(action, env, results);
      results.set(actionId, result);
    }
  }

  return Array.from(results.values());
}

// KV keys
const GOALS_KEY = 'goal_planner_goals';
const PLANS_KEY = 'goal_planner_plans';

/**
 * Handle GET /api/goals - List goals and plans
 */
async function handleListGoals(env: Env): Promise<Response> {
  const goals: StructuredGoal[] = [];
  const plans: ActionPlan[] = [];

  if (env.CACHE) {
    try {
      const goalsData = await env.CACHE.get(GOALS_KEY);
      if (goalsData) {
        goals.push(...JSON.parse(goalsData));
      }

      const plansData = await env.CACHE.get(PLANS_KEY);
      if (plansData) {
        plans.push(...JSON.parse(plansData));
      }
    } catch (e) {
      safeLog.error('[Goal Planner] Failed to read KV', { error: String(e) });
    }
  }

  return new Response(JSON.stringify({
    goals: goals.slice(-10), // Last 10 goals
    plans: plans.slice(-10), // Last 10 plans
    templates: Object.keys(GOAL_TEMPLATES),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle POST /api/goals - Create new goal and action plan
 */
async function handleCreateGoal(request: Request, env: Env): Promise<Response> {
  let body: { goal: string; execute?: boolean };

  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.goal || typeof body.goal !== 'string') {
    return new Response(JSON.stringify({ error: 'goal field required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse goal
  const structuredGoal = parseGoal(body.goal);
  if (!structuredGoal) {
    return new Response(JSON.stringify({
      error: 'Could not parse goal',
      suggestion: 'Try using keywords like: claude, review, task, consensus',
      availableTemplates: Object.keys(GOAL_TEMPLATES),
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Generate action plan
  const plan = generateActionPlan(structuredGoal);

  // Store in KV
  if (env.CACHE) {
    try {
      // Store goal
      const goalsData = await env.CACHE.get(GOALS_KEY);
      const goals: StructuredGoal[] = goalsData ? JSON.parse(goalsData) : [];
      goals.push(structuredGoal);
      await env.CACHE.put(GOALS_KEY, JSON.stringify(goals.slice(-100)));

      // Store plan
      const plansData = await env.CACHE.get(PLANS_KEY);
      const plans: ActionPlan[] = plansData ? JSON.parse(plansData) : [];
      plans.push(plan);
      await env.CACHE.put(PLANS_KEY, JSON.stringify(plans.slice(-100)));
    } catch (e) {
      safeLog.error('[Goal Planner] Failed to store in KV', { error: String(e) });
    }
  }

  // Execute if requested
  let executionResults: ExecutionResult[] | null = null;
  if (body.execute) {
    executionResults = await executePlan(plan, env);
    plan.status = executionResults.every(r => r.status === 'success') ? 'completed' : 'failed';
  }

  safeLog.log('[Goal Planner] Created goal and plan', {
    goalId: structuredGoal.id,
    category: structuredGoal.category,
    actionsCount: plan.actions.length,
    executed: !!body.execute,
  });

  return new Response(JSON.stringify({
    goal: structuredGoal,
    plan,
    executionResults,
  }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle POST /api/goals/:id/execute - Execute an existing plan
 */
async function handleExecutePlan(env: Env, planId: string): Promise<Response> {
  if (!env.CACHE) {
    return new Response(JSON.stringify({ error: 'Cache not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const plansData = await env.CACHE.get(PLANS_KEY);
  if (!plansData) {
    return new Response(JSON.stringify({ error: 'No plans found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const plans: ActionPlan[] = JSON.parse(plansData);
  const plan = plans.find(p => p.goalId === planId);

  if (!plan) {
    return new Response(JSON.stringify({ error: 'Plan not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const results = await executePlan(plan, env);
  plan.status = results.every(r => r.status === 'success') ? 'completed' : 'failed';

  // Update plan in KV
  await env.CACHE.put(PLANS_KEY, JSON.stringify(plans));

  return new Response(JSON.stringify({
    plan,
    results,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Main handler for /api/goals endpoints
 */
export async function handleGoalPlannerAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Route handling
  const pathParts = path.replace('/api/goals', '').split('/').filter(Boolean);

  // GET /api/goals - List goals and plans
  if (request.method === 'GET' && pathParts.length === 0) {
    const response = await handleListGoals(env);
    return addCorsHeaders(response, corsHeaders);
  }

  // POST /api/goals - Create new goal
  if (request.method === 'POST' && pathParts.length === 0) {
    const response = await handleCreateGoal(request, env);
    return addCorsHeaders(response, corsHeaders);
  }

  // POST /api/goals/:id/execute - Execute plan
  if (request.method === 'POST' && pathParts.length === 2 && pathParts[1] === 'execute') {
    const response = await handleExecutePlan(env, pathParts[0]);
    return addCorsHeaders(response, corsHeaders);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function addCorsHeaders(response: Response, corsHeaders: Record<string, string>): Response {
  const newResponse = new Response(response.body, response);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });
  return newResponse;
}
