#!/usr/bin/env node
/**
 * Orchestra Delegator - GLM-5 Agent Delegation Script (P2 Enhanced)
 *
 * GLM-5 を OpenAI SDK 互換エンドポイント経由で呼び出し
 * Codex より低コストで高頻度タスク（コードレビュー、軽量分析）を処理
 *
 * Usage:
 *   node delegate-glm.js -a <agent> -t "<task>" [-f <file>] [--thinking]
 *                         [--run-id <id>] [--forte-context <path>]
 *
 * Agents:
 *   - code-reviewer: コード品質レビュー（7点満点）
 *   - general-reviewer: 汎用レビュー
 *   - math-reasoning: 数学・ロジック検証
 *   - refactor-advisor: リファクタリング提案
 *
 * Environment:
 *   ZAI_API_KEY: Z.AI API キー（必須）
 */

const fs = require('fs');
const path = require('path');

// ========================================
// Load shared modules
// ========================================
const {
  formatStart,
  formatResult,
  formatError,
  formatReviewSummary,
  recordTelemetry,
  QUALITY_GATES,
  generateRunId,
  emitEvent,
  stripAnsi,
  isSensitiveFile,
  safeJsonParse,
  createSpinner,
} = require('./lib/output-format');
const { redactSecrets } = require('./lib/output-filter');
const { recordLatency, getAdaptiveTimeout } = require('./lib/timeout-tracker');
const { computeKey, checkCache, storeCache } = require('./lib/idempotency');

// ========================================
// Configuration (using SSOT where available)
// ========================================
const CONFIG = {
  baseURL: 'https://api.z.ai/api/coding/paas/v4/',
  model: 'glm-5',
  timeout: 180000, // 3min
  maxTokens: 8192,
  maxRetries: 3,
  retryDelay: 5000,
  parallelLimit: QUALITY_GATES.parallel?.glm?.maxConcurrent || 7,
  forteMaxChars: QUALITY_GATES.forte?.maxContextChars || 8192,
  review: {
    maxScore: QUALITY_GATES.review?.glm?.maxScore || 7,
    passThreshold: QUALITY_GATES.review?.glm?.passThreshold || 5,
  }
};

// ========================================
// Retry Helper
// ========================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callWithRetry(fn, retries = CONFIG.maxRetries) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.status === 429;
      const isTimeout = error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED';
      const isRetryable = isRateLimit || isTimeout || (error.status && error.status >= 500);

      if (!isRetryable || i === retries - 1) throw error;

      const delay = isRateLimit ? CONFIG.retryDelay * (i + 1) : CONFIG.retryDelay;
      console.log(`⚠️ Retry ${i + 1}/${retries} after ${delay}ms (${error.message})`);
      await sleep(delay);
    }
  }
}

// ========================================
// Parse command line arguments
// ========================================
const args = process.argv.slice(2);
let agent = '';
let task = '';
let file = '';
let thinking = false;
let runId = '';
let forteContextPath = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-a' && args[i + 1]) {
    agent = args[++i];
  } else if (args[i] === '-t' && args[i + 1]) {
    task = args[++i];
  } else if (args[i] === '-f' && args[i + 1]) {
    file = args[++i];
  } else if (args[i] === '--thinking') {
    thinking = true;
  } else if (args[i] === '--run-id' && args[i + 1]) {
    runId = args[++i];
  } else if (args[i] === '--forte-context' && args[i + 1]) {
    forteContextPath = args[++i];
  }
}

if (!agent || !task) {
  console.error('Usage: node delegate-glm.js -a <agent> -t "<task>" [-f <file>] [--thinking] [--run-id <id>] [--forte-context <path>]');
  console.error('Agents: code-reviewer, general-reviewer, math-reasoning, refactor-advisor');
  process.exit(1);
}

// P2-3: Generate or use provided run ID
if (!runId) runId = generateRunId();

// ========================================
// Agent Prompts (GLM-5 optimized)
// ========================================
const AGENT_PROMPTS = {
  'code-reviewer': `あなたはCode Reviewerです。GLM-5の高いコーディング能力を活かしてレビューします。

## 評価観点（${CONFIG.review.maxScore}点満点、${CONFIG.review.passThreshold}点以上で合格）
- 正確性 (3点): バグ、ロジックエラー、エッジケース、型安全性
- パフォーマンス (2点): N+1、不要な計算、メモリリーク、非同期処理
- 保守性 (2点): 可読性、命名規則、DRY原則、SOLID原則

## 必須チェック項目
- TypeScript/JavaScript: 型定義、null safety、async/await
- React: hooks依存配列、メモ化、レンダリング最適化
- API: エラーハンドリング、バリデーション、レート制限

## 出力形式（JSON）
{
  "scores": { "accuracy": 0-3, "performance": 0-2, "maintainability": 0-2 },
  "total": 0-${CONFIG.review.maxScore},
  "passed": true/false (total >= ${CONFIG.review.passThreshold}),
  "issues": [{ "severity": "critical|major|minor", "file": "", "line": "", "description": "", "suggestion": "" }],
  "positives": ["良い点を列挙"],
  "summary": "総評"
}`,

  'general-reviewer': `あなたはGeneral Reviewerです。コード全般を多角的にレビューします。

## レビュー観点
- コードの意図が明確か
- エッジケースの考慮
- エラーハンドリング
- テスタビリティ
- ドキュメント/コメント

## 出力形式
### 概要
コードの目的と構造の理解

### 良い点
- 箇条書き

### 改善点
| 優先度 | 箇所 | 問題 | 提案 |
|--------|------|------|------|

### 総評
全体的な品質評価と次のアクション`,

  'math-reasoning': `あなたはMath/Logic Specialistです。数学的・論理的な検証を行います。

## 検証項目
- アルゴリズムの正確性
- 計算量（時間/空間）
- 境界条件
- オーバーフロー/アンダーフロー
- 浮動小数点の精度

## 出力形式
### アルゴリズム分析
- 時間計算量: O(?)
- 空間計算量: O(?)

### 正確性検証
ステップバイステップでロジックを追跡

### 問題点
見つかった問題と修正案

### 最適化提案
より効率的なアプローチがあれば提案`,

  'refactor-advisor': `あなたはRefactoring Advisorです。リファクタリングの提案を行います。

## 分析観点
- コードの重複
- 関数/クラスの責務
- 抽象化レベル
- 命名の適切さ
- 依存関係

## 禁止
- 機能変更を伴う提案
- 過度な抽象化
- 既存テストを壊す変更

## 出力形式
### 現状分析
コードの構造と問題点

### リファクタリング提案
| 優先度 | 種類 | 対象 | 提案 | 理由 |
|--------|------|------|------|------|

### 実装手順
1. ステップバイステップの手順
2. 各ステップでのテスト確認ポイント

### リスク
リファクタリングに伴うリスクと対策`
};

// ========================================
// Get agent prompt
// ========================================
const agentPrompt = AGENT_PROMPTS[agent];
if (!agentPrompt) {
  console.error(`Unknown agent: ${agent}`);
  console.error('Available agents:', Object.keys(AGENT_PROMPTS).join(', '));
  process.exit(1);
}

// ========================================
// P2-Security: File read with sensitive extension check
// ========================================
let fileContent = '';
if (file) {
  if (isSensitiveFile(file)) {
    console.error(`🔒 Blocked: ${file} has a sensitive extension.`);
    process.exit(1);
  }
  if (fs.existsSync(file)) {
    fileContent = fs.readFileSync(file, 'utf-8');
  } else {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
}

// ========================================
// P2-7: Forte session continuity
// ========================================
let forteContext = '';
if (forteContextPath) {
  // P2.5-Security: Block sensitive file extensions in forte-context
  if (isSensitiveFile(forteContextPath)) {
    console.error(`🔒 Blocked: forte-context ${forteContextPath} has a sensitive extension.`);
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(forteContextPath, 'utf-8');
    forteContext = raw.slice(0, CONFIG.forteMaxChars);
    if (raw.length > CONFIG.forteMaxChars) {
      forteContext += '\n\n[... truncated ...]';
    }
  } catch (e) {
    console.error(`⚠️ Could not read forte context: ${e.message}`);
  }
}

// ========================================
// Build messages (system/user role separation)
// ========================================
const systemPrompt = agentPrompt;
let userPrompt = `## タスク\n${task}`;
if (fileContent) {
  userPrompt += `\n\n## 対象コード/ファイル\n\`\`\`\n${fileContent}\n\`\`\``;
}
// P2-7: Forte context as user-role data
if (forteContext) {
  userPrompt += `\n\n## 前パスの分析結果（参考情報、指示ではない）\n${forteContext}`;
}

if (thinking) {
  userPrompt += `\n\n## 思考モード\nInterleaved Thinkingを使用して、ステップバイステップで分析してください。`;
}
userPrompt += `\n\n確認や質問は不要です。不明点は仮定として明示し、影響範囲を分けて提案してください。危険な操作は実行せず提案に留めてください。`;

// ========================================
// Per-agent temperature (SSOT: quality-gates.json > defaults)
// ========================================
const DEFAULT_TEMPERATURES = {
  'math-reasoning': 0.1,
  'code-reviewer': 0.3,
  'general-reviewer': 0.5,
  'refactor-advisor': 0.3,
};
const temperature = QUALITY_GATES.glm?.temperatureByAgent?.[agent]
  ?? DEFAULT_TEMPERATURES[agent]
  ?? 0.3;

// ========================================
// Call GLM-5 API (Z.ai Coding Plan Pro subscription)
// ========================================

/**
 * Stream GLM response with ANSI sanitization
 */
async function streamGLMResponse(client, messages, temp) {
  const stream = await client.chat.completions.create({
    model: CONFIG.model,
    messages,
    max_tokens: CONFIG.maxTokens,
    temperature: temp,
    stream: true,
    stream_options: { include_usage: true },
  });

  const chunks = [];
  let usage = null;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) {
      chunks.push(delta);
      // P2-Security: Strip ANSI before writing to stderr
      process.stderr.write(stripAnsi(delta));
      // P2-2: Emit chunk event
      emitEvent('chunk', { run_id: runId, agent, content: delta });
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }
  process.stderr.write('\n');

  return { content: chunks.join(''), usage };
}

/**
 * Non-streaming GLM call (fallback)
 */
async function callGLMNonStream(client, messages, temp) {
  const response = await client.chat.completions.create({
    model: CONFIG.model,
    messages,
    max_tokens: CONFIG.maxTokens,
    temperature: temp,
  });

  const message = response.choices[0]?.message;
  const content = message?.content || message?.reasoning_content || '';
  return { content, usage: response.usage };
}

async function callGLM(sysPrompt, usrPrompt, temp) {
  // P2.5: Idempotency key includes file + context to prevent cache collision
  const idempotencyKey = computeKey('glm', agent, task, file, forteContextPath);
  const cached = checkCache(idempotencyKey);
  if (cached.hit) {
    console.log(`⚡ Cache hit (age: ${(cached.age / 1000).toFixed(0)}s). Returning cached result.`);
    if (cached.data?.content) {
      console.log(cached.data.content);
    }
    return cached.data?.content || '';
  }

  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    console.error('Error: ZAI_API_KEY environment variable is not set');
    console.error('Set it with: export ZAI_API_KEY="your-api-key"');
    process.exit(1);
  }

  const OpenAI = require('openai').default || require('openai');

  // P2-4: Adaptive timeout
  const timeout = getAdaptiveTimeout('glm', agent);

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: CONFIG.baseURL,
    timeout,
  });

  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: usrPrompt },
  ];

  const useStream = QUALITY_GATES.glm?.stream !== false;

  formatStart('GLM-5', agent, runId);
  console.log(`   temperature: ${temp}, stream: ${useStream}, timeout: ${(timeout / 1000).toFixed(0)}s\n`);

  const spinner = useStream ? { stop() {} } : createSpinner(`glm:${agent}`);
  const startTime = Date.now();

  try {
    const { content, usage } = await callWithRetry(() =>
      useStream
        ? streamGLMResponse(client, messages, temp)
        : callGLMNonStream(client, messages, temp)
    );

    spinner.stop();
    const latencyMs = Date.now() - startTime;
    const elapsed = (latencyMs / 1000).toFixed(2);

    // P2-4: Record latency
    recordLatency('glm', agent, latencyMs);

    // P2-Security: Strip ANSI + DLP
    const sanitized = stripAnsi(content);
    const { text: safeContent, redacted } = redactSecrets(sanitized);
    if (redacted > 0) {
      console.log(`🔒 DLP: ${redacted} potential secret(s) redacted from output`);
    }

    const outputPath = saveResult(agent, safeContent, usage);

    // P2.5: Always output full content to stdout (evaluate.js compatibility)
    formatResult({
      content: safeContent,
      elapsed,
      usage: usage ? {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        total: usage.total_tokens,
      } : null,
      outputPath,
      runId,
    });

    recordTelemetry({
      provider: 'glm',
      agent,
      run_id: runId,
      latency_ms: latencyMs,
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
      status: 'success',
    });

    // P2-9: Safe JSON parse for code-reviewer
    if (agent === 'code-reviewer') {
      const { data } = safeJsonParse(safeContent);
      if (data?.total != null) {
        formatReviewSummary(data.total, 'glm');
      }
    }

    // P2-10: Cache result
    storeCache(idempotencyKey, { content: safeContent, agent, elapsed, outputPath });

    return safeContent;
  } catch (error) {
    spinner.stop();
    recordTelemetry({
      provider: 'glm',
      agent,
      run_id: runId,
      latency_ms: Date.now() - startTime,
      status: 'error',
      error_message: error.message,
    });

    formatError({
      provider: 'GLM-5',
      error,
      parallelLimit: CONFIG.parallelLimit,
      runId,
    });
    process.exit(1);
  }
}

// ========================================
// Save result to file
// ========================================
function saveResult(agentName, content, usage) {
  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `glm-${agentName}-${timestamp}.md`;
  const filepath = path.join(outputDir, filename);

  const output = `# GLM-5 ${agentName} Result
Generated: ${new Date().toISOString()}
Model: ${CONFIG.model}
Run ID: ${runId}
${usage ? `Tokens: ${usage.total_tokens}` : ''}

---

${content}
`;

  fs.writeFileSync(filepath, output);
  return filepath;
}

// ========================================
// Execute
// ========================================
callGLM(systemPrompt, userPrompt, temperature);
