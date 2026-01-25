#!/usr/bin/env node
/**
 * AI Assistant Daemon v2.2
 *
 * Telegram からの指示を受け取り、Claude Code CLI で自動実行
 * Mac Mini で常駐させてスマホから操作可能にする
 *
 * v2.2 追加修正:
 * - claimTask API によるアトミックなタスク取得（競合排除）
 * - リース管理（renewLease, releaseLease）
 * - WORKER_ID によるワーカー識別
 *
 * v2.1 追加修正:
 * - API Key 必須化（fail-closed）
 * - uncaughtException 時は即 exit（LaunchDaemon に再起動委任）
 * - MAX_RETRY_DELAY（バックオフ上限）
 * - 起動時ロッククリア
 * - 出力サニタイズ（機密情報マスク）
 * - 長時間処理の進捗通知
 * - ログローテーション対応
 */

require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================
// 設定
// ============================================
const CONFIG = {
  // Cloudflare Workers Hub
  WORKERS_URL: process.env.WORKERS_URL || 'https://orchestrator-hub.masa-stage1.workers.dev',
  API_KEY: process.env.ASSISTANT_API_KEY,

  // Worker ID（クラスタ内で一意、リース管理に使用）
  WORKER_ID: process.env.WORKER_ID || `daemon_${require('os').hostname()}_${Date.now()}`,

  // 通知設定（Telegram / Discord / Slack から選択）
  NOTIFICATION_TYPE: process.env.NOTIFICATION_TYPE || 'telegram', // telegram | discord | slack

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // Discord Webhook URL（チャンネル設定 → 連携サービス → Webhook で取得）
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,

  // Slack（Webhook URL または Bot Token + Channel ID）
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID, // Bot Token 使用時は必須

  // ポーリング間隔（ミリ秒）
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 15000,

  // 作業ディレクトリ
  WORK_DIR: process.env.WORK_DIR || process.cwd(),

  // Codex CLI パス (GPT Pro)
  CODEX_CLI: process.env.CODEX_CLI || 'codex',

  // タイムアウト（ミリ秒）
  EXECUTION_TIMEOUT: parseInt(process.env.EXECUTION_TIMEOUT) || 5 * 60 * 1000, // 5分

  // 最大入力長
  MAX_INPUT_LENGTH: 4000,

  // 最大出力バッファ（バイト）
  MAX_OUTPUT_BUFFER: 1024 * 1024, // 1MB

  // Telegram 文字数制限
  TELEGRAM_MAX_LENGTH: 4000,

  // リトライ設定
  MAX_RETRIES: 3,
  RETRY_DELAY: 5000,
  MAX_RETRY_DELAY: 60000, // 最大60秒（バックオフ上限）

  // 進捗通知間隔（ミリ秒）
  PROGRESS_NOTIFY_INTERVAL: 60000, // 1分ごと

  // ログローテーション
  LOG_DIR: process.env.LOG_DIR || path.join(process.cwd(), 'logs'),
  MAX_LOG_SIZE: 10 * 1024 * 1024, // 10MB
};

// ============================================
// 機密情報パターン（マスク対象）
// ============================================
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|passwd|credential|auth)[=:\s]+["']?[\w\-\.]+["']?/gi,
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI API Key
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub Personal Access Token
  /gho_[a-zA-Z0-9]{36}/g, // GitHub OAuth Token
  /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g, // GitHub Fine-grained PAT
  /xox[baprs]-[a-zA-Z0-9\-]+/g, // Slack Token
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, // Bearer Token
  /-----BEGIN.*PRIVATE KEY-----[\s\S]*?-----END.*PRIVATE KEY-----/g,
  /[a-f0-9]{64}/g, // 64-char hex (potential secrets)
];

// ============================================
// 状態管理
// ============================================
let isProcessing = false;
let currentTaskId = null;
let currentProcess = null;
let shouldStop = false;
let consecutiveErrors = 0;
let processStartTime = null;

// ============================================
// ログローテーション対応ロガー
// ============================================
class Logger {
  constructor(logDir, maxSize) {
    this.logDir = logDir;
    this.maxSize = maxSize;
    this.logFile = path.join(logDir, 'daemon.log');

    // ログディレクトリ作成
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  rotate() {
    try {
      if (!fs.existsSync(this.logFile)) return;

      const stats = fs.statSync(this.logFile);
      if (stats.size >= this.maxSize) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rotatedFile = path.join(this.logDir, `daemon-${timestamp}.log`);
        fs.renameSync(this.logFile, rotatedFile);

        // 古いログを削除（5世代保持）
        const logs = fs.readdirSync(this.logDir)
          .filter(f => f.startsWith('daemon-') && f.endsWith('.log'))
          .sort()
          .reverse();
        logs.slice(5).forEach(f => {
          fs.unlinkSync(path.join(this.logDir, f));
        });
      }
    } catch (e) {
      console.error('[Logger] Rotation error:', e.message);
    }
  }

  write(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const sanitizedData = { ...data };

    // 機密情報をマスク
    if (sanitizedData.apiKey) sanitizedData.apiKey = '***';
    if (sanitizedData.token) sanitizedData.token = '***';

    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message} ${
      Object.keys(sanitizedData).length ? JSON.stringify(sanitizedData) : ''
    }\n`;

    // コンソール出力
    console[level === 'error' ? 'error' : 'log'](logLine.trim());

    // ファイル出力
    try {
      this.rotate();
      fs.appendFileSync(this.logFile, logLine);
    } catch (e) {
      // ファイル出力失敗は無視
    }
  }

  log(message, data) { this.write('info', message, data); }
  warn(message, data) { this.write('warn', message, data); }
  error(message, data) { this.write('error', message, data); }
}

const logger = new Logger(CONFIG.LOG_DIR, CONFIG.MAX_LOG_SIZE);

// ============================================
// セキュリティ: 入力サニタイズ
// ============================================
function sanitizeInput(input) {
  if (!input || typeof input !== 'string') {
    return '';
  }

  // 長さ制限
  let sanitized = input.substring(0, CONFIG.MAX_INPUT_LENGTH);

  // 危険なシェルメタ文字を除去/エスケープ
  sanitized = sanitized
    .replace(/[\x00-\x1f]/g, '') // 制御文字除去
    .replace(/\\/g, '\\\\')      // バックスラッシュエスケープ
    .trim();

  return sanitized;
}

// ============================================
// セキュリティ: 出力サニタイズ（機密情報マスク）
// ============================================
function sanitizeOutput(output) {
  if (!output || typeof output !== 'string') {
    return '';
  }

  let sanitized = output;

  // 機密情報パターンをマスク
  SECRET_PATTERNS.forEach(pattern => {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  });

  return sanitized;
}

// ============================================
// ユーティリティ: メッセージ truncate
// ============================================
function truncateMessage(text, limit = CONFIG.TELEGRAM_MAX_LENGTH) {
  if (!text) return '(空)';
  if (text.length <= limit) return text;

  // 先頭と末尾を表示（エラー原因が末尾にあることが多い）
  const headSize = Math.floor(limit * 0.4);
  const tailSize = Math.floor(limit * 0.4);
  const head = text.substring(0, headSize);
  const tail = text.substring(text.length - tailSize);

  return `${head}\n\n_...省略 (${text.length}文字中)..._\n\n${tail}`;
}

// ============================================
// 通知システム（Telegram / Discord / Slack 対応）
// ============================================

// Markdown → プレーンテキスト変換（Discord/Slack用）
function markdownToPlain(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // Bold
    .replace(/\*(.+?)\*/g, '$1')       // Italic
    .replace(/`{3}[\s\S]*?`{3}/g, m => m.replace(/`{3}\n?/g, ''))  // Code block
    .replace(/`(.+?)`/g, '$1')         // Inline code
    .replace(/_(.+?)_/g, '$1');        // Italic underscore
}

// 統合通知関数
async function sendNotification(text, retries = CONFIG.MAX_RETRIES) {
  const type = CONFIG.NOTIFICATION_TYPE;

  if (type === 'discord') {
    return sendDiscord(text, retries);
  } else if (type === 'slack') {
    return sendSlack(text, retries);
  } else {
    return sendTelegram(text, {}, retries);
  }
}

// Telegram API
async function sendTelegram(text, options = {}, retries = CONFIG.MAX_RETRIES) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    logger.log('[Telegram] Not configured, skipping');
    return null;
  }

  const sanitizedText = sanitizeOutput(text);
  const truncatedText = truncateMessage(sanitizedText);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: truncatedText,
          parse_mode: 'Markdown',
          ...options,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const result = await response.json();
      if (!result.ok) {
        logger.error('[Telegram] API Error', { description: result.description });
        if (attempt < retries) {
          const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
          await sleep(delay);
          continue;
        }
      }
      return result;
    } catch (error) {
      logger.error('[Telegram] Send failed', { attempt, error: error.message });
      if (attempt < retries) {
        const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
        await sleep(delay);
      }
    }
  }
  return null;
}

// Discord Webhook
async function sendDiscord(text, retries = CONFIG.MAX_RETRIES) {
  if (!CONFIG.DISCORD_WEBHOOK_URL) {
    logger.log('[Discord] Not configured, skipping');
    return null;
  }

  const sanitizedText = sanitizeOutput(text);
  const truncatedText = truncateMessage(sanitizedText, 2000); // Discord limit

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(CONFIG.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: truncatedText,
          username: 'AI Assistant',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.error('[Discord] API Error', { status: response.status });
        if (attempt < retries) {
          const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
          await sleep(delay);
          continue;
        }
      }
      return { ok: true };
    } catch (error) {
      logger.error('[Discord] Send failed', { attempt, error: error.message });
      if (attempt < retries) {
        const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
        await sleep(delay);
      }
    }
  }
  return null;
}

// Slack（Webhook URL または Bot Token 対応）
async function sendSlack(text, retries = CONFIG.MAX_RETRIES) {
  const hasWebhook = !!CONFIG.SLACK_WEBHOOK_URL;
  const hasBotToken = CONFIG.SLACK_BOT_TOKEN && CONFIG.SLACK_CHANNEL_ID;

  if (!hasWebhook && !hasBotToken) {
    logger.log('[Slack] Not configured, skipping');
    return null;
  }

  const sanitizedText = sanitizeOutput(text);
  const plainText = markdownToPlain(sanitizedText);
  const truncatedText = truncateMessage(plainText, 3000);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let url, headers, body;

      if (hasBotToken) {
        // Bot Token 経由（chat.postMessage API）
        url = 'https://slack.com/api/chat.postMessage';
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
        };
        body = JSON.stringify({
          channel: CONFIG.SLACK_CHANNEL_ID,
          text: truncatedText,
          username: 'AI Assistant',
          icon_emoji: ':robot_face:',
        });
      } else {
        // Webhook URL 経由
        url = CONFIG.SLACK_WEBHOOK_URL;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
          text: truncatedText,
          username: 'AI Assistant',
          icon_emoji: ':robot_face:',
        });
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (hasBotToken) {
        const result = await response.json();
        if (!result.ok) {
          logger.error('[Slack] API Error', { error: result.error });
          if (attempt < retries) {
            const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
            await sleep(delay);
            continue;
          }
        }
        return result;
      } else {
        if (!response.ok) {
          logger.error('[Slack] Webhook Error', { status: response.status });
          if (attempt < retries) {
            const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
            await sleep(delay);
            continue;
          }
        }
        return { ok: true };
      }
    } catch (error) {
      logger.error('[Slack] Send failed', { attempt, error: error.message });
      if (attempt < retries) {
        const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
        await sleep(delay);
      }
    }
  }
  return null;
}

// Typing indicator（Telegram のみ）
async function sendTypingAction() {
  if (CONFIG.NOTIFICATION_TYPE !== 'telegram') return;
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendChatAction`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        action: 'typing',
      }),
    });
  } catch {
    // Ignore
  }
}

// ============================================
// KV Queue API（リトライ付き）
// ============================================
async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES) {
  const headers = { ...options.headers };
  if (CONFIG.API_KEY) {
    headers['X-API-Key'] = CONFIG.API_KEY;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 401) {
          logger.error('[Queue] Unauthorized - check API_KEY');
          return null;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      consecutiveErrors = 0;
      return await response.json();
    } catch (error) {
      logger.error('[Queue] Fetch failed', { attempt, url, error: error.message });
      consecutiveErrors++;

      if (attempt < retries) {
        const delay = Math.min(CONFIG.RETRY_DELAY * attempt, CONFIG.MAX_RETRY_DELAY);
        await sleep(delay);
      }
    }
  }
  return null;
}

// ============================================
// タスクキュー API（claimTask ベース）
// ============================================

/**
 * タスクをアトミックに取得（claim）
 * 成功時: { success: true, taskId, task, lease }
 * 失敗時: { success: false, message: "No tasks available" }
 */
async function claimTask() {
  const leaseDurationSec = Math.floor(CONFIG.EXECUTION_TIMEOUT / 1000) + 60; // 実行タイムアウト + バッファ60秒
  return await fetchWithRetry(
    `${CONFIG.WORKERS_URL}/api/queue/claim`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: CONFIG.WORKER_ID,
        leaseDurationSec,
      }),
    }
  );
}

/**
 * リースを延長（長時間タスク用）
 */
async function renewLease(taskId) {
  return await fetchWithRetry(
    `${CONFIG.WORKERS_URL}/api/queue/${taskId}/renew`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: CONFIG.WORKER_ID,
        extendSec: 300, // 5分延長
      }),
    }
  );
}

/**
 * リースを解放（失敗時、他のワーカーが再処理可能に）
 */
async function releaseLease(taskId, reason) {
  return await fetchWithRetry(
    `${CONFIG.WORKERS_URL}/api/queue/${taskId}/release`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: CONFIG.WORKER_ID,
        reason,
      }),
    },
    1 // リトライなし（失敗しても他ワーカーがリース期限切れで取得可能）
  );
}

// 後方互換用（必要に応じて削除可能）
async function fetchPendingTasks() {
  const data = await fetchWithRetry(`${CONFIG.WORKERS_URL}/api/queue`);
  return data?.pending || [];
}

async function fetchTask(taskId) {
  return await fetchWithRetry(`${CONFIG.WORKERS_URL}/api/queue/${taskId}`);
}

async function markTaskProcessing(taskId) {
  await fetchWithRetry(
    `${CONFIG.WORKERS_URL}/api/queue/${taskId}/status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    },
    1 // リトライなし
  );
}

async function reportResult(taskId, result) {
  await fetchWithRetry(
    `${CONFIG.WORKERS_URL}/api/result/${taskId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    }
  );
}

// ============================================
// Memory API（会話履歴の保存・取得）
// ============================================
async function getConversationContext(userId, channel) {
  const url = new URL(`${CONFIG.WORKERS_URL}/api/memory/context/${userId}`);
  if (channel) url.searchParams.set('channel', channel);
  url.searchParams.set('maxTokens', '2000');

  const data = await fetchWithRetry(url.toString());
  return data?.context || '';
}

async function saveConversation(message) {
  return await fetchWithRetry(
    `${CONFIG.WORKERS_URL}/api/memory/save`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }
  );
}

// ============================================
// Claude Code CLI 実行（セキュリティ強化版）
// ============================================
function executeCodex(prompt) {
  return new Promise((resolve, reject) => {
    const sanitizedPrompt = sanitizeInput(prompt);

    if (!sanitizedPrompt) {
      reject(new Error('Empty or invalid prompt'));
      return;
    }

    const startTime = Date.now();
    processStartTime = startTime;
    let output = '';
    let errorOutput = '';
    let outputSize = 0;
    let killed = false;

    logger.log('[Codex] Executing', { promptLength: sanitizedPrompt.length });

    // spawn で直接実行（シェル経由ではない）
    const proc = spawn(CONFIG.CODEX_CLI, ['exec', sanitizedPrompt], {
      cwd: CONFIG.WORK_DIR,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // コマンドインジェクション対策
    });

    currentProcess = proc;

    // 出力バッファ管理
    proc.stdout.on('data', (data) => {
      outputSize += data.length;
      if (outputSize <= CONFIG.MAX_OUTPUT_BUFFER) {
        output += data.toString();
      } else if (!killed) {
        logger.warn('[Codex] Output buffer exceeded, truncating');
      }
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString().substring(0, 10000);
    });

    proc.on('close', (code, signal) => {
      currentProcess = null;
      processStartTime = null;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        logger.warn('[Codex] Process killed', { signal, elapsed });
        resolve({
          success: false,
          output: output.trim(),
          error: `Process terminated: ${signal}`,
          elapsed,
        });
        return;
      }

      logger.log('[Codex] Finished', { code, elapsed });

      resolve({
        success: code === 0,
        output: output.trim(),
        error: code !== 0 ? (errorOutput.trim() || `Exit code: ${code}`) : undefined,
        elapsed,
      });
    });

    proc.on('error', (error) => {
      currentProcess = null;
      processStartTime = null;
      logger.error('[Codex] Process error', { error: error.message });

      if (error.code === 'ENOENT') {
        reject(new Error(`Codex CLI not found: ${CONFIG.CODEX_CLI}`));
      } else {
        reject(error);
      }
    });

    // タイムアウト
    const timeoutId = setTimeout(() => {
      if (currentProcess) {
        killed = true;
        logger.warn('[Codex] Execution timeout, killing process');
        proc.kill('SIGTERM');

        // SIGTERM で終了しない場合は SIGKILL
        setTimeout(() => {
          if (currentProcess) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      }
    }, CONFIG.EXECUTION_TIMEOUT);

    proc.on('close', () => clearTimeout(timeoutId));
  });
}

// ============================================
// タスク処理（同時実行制御付き、claimTask ベース）
// ============================================
async function processTask(claimResult) {
  // 同時実行ロック
  if (isProcessing) {
    logger.log('[Task] Already processing, skipping');
    return;
  }

  const { taskId, task } = claimResult;
  if (!task) {
    logger.log('[Task] No task in claim result', { taskId });
    return;
  }

  isProcessing = true;
  currentTaskId = taskId;

  // リース更新インターバル（2分ごとに5分延長）
  const leaseRenewalInterval = setInterval(async () => {
    if (currentTaskId === taskId) {
      const renewResult = await renewLease(taskId);
      if (renewResult?.success) {
        logger.log('[Lease] Renewed', { taskId, newExpiry: renewResult.lease?.expiresAt });
      } else {
        logger.warn('[Lease] Renewal failed', { taskId, message: renewResult?.message });
      }
    }
  }, 2 * 60 * 1000); // 2分ごと

  try {
    const content = task.content || '';
    // タスクメタデータからユーザー情報を取得（Slackは'user'、他は'userId'を使用）
    const userId = task.metadata?.userId || task.metadata?.user || task.userId || 'unknown';
    const channel = task.metadata?.channel || task.channel || 'default';
    const source = task.source || task.metadata?.source || 'slack';

    logger.log('[Task] Processing', { taskId, contentLength: content.length, userId, channel, workerId: CONFIG.WORKER_ID });

    // ユーザーメッセージを永続メモリに保存
    await saveConversation({
      id: `msg_user_${Date.now()}`,
      user_id: userId,
      channel: channel,
      source: source,
      role: 'user',
      content: content,
      metadata: { taskId },
    });

    // 会話コンテキストを取得
    const conversationContext = await getConversationContext(userId, channel);
    logger.log('[Memory] Context loaded', { contextLength: conversationContext.length });

    // プロンプトにコンテキストを注入
    let enhancedPrompt = content;
    if (conversationContext) {
      enhancedPrompt = `${conversationContext}\n\n---\n\n現在の質問: ${content}`;
    }

    // 通知
    const preview = sanitizeInput(content).substring(0, 100);
    await sendNotification(`🔄 *タスク開始*\n\n\`${preview}...\``);

    // 定期的に typing アクションを送信
    const typingInterval = setInterval(sendTypingAction, 4000);

    // 長時間処理の進捗通知（リース更新も行う）
    const progressInterval = setInterval(async () => {
      if (processStartTime && currentProcess) {
        const elapsed = Math.floor((Date.now() - processStartTime) / 1000);
        await sendNotification(`⏳ *処理継続中* (${elapsed}秒経過)\n\nタイムアウトまで残り ${Math.floor((CONFIG.EXECUTION_TIMEOUT / 1000) - elapsed)}秒`);
      }
    }, CONFIG.PROGRESS_NOTIFY_INTERVAL);

    try {
      // コンテキスト注入済みプロンプトでCodex実行
      const result = await executeCodex(enhancedPrompt);

      clearInterval(typingInterval);
      clearInterval(progressInterval);

      // 出力をサニタイズ
      const sanitizedOutput = sanitizeOutput(result.output || '(出力なし)');
      const outputPreview = truncateMessage(sanitizedOutput, 500);

      // アシスタントの応答を永続メモリに保存
      await saveConversation({
        id: `msg_assistant_${Date.now()}`,
        user_id: userId,
        channel: channel,
        source: source,
        role: 'assistant',
        content: result.output || '',
        metadata: { taskId, success: result.success, elapsed: result.elapsed },
      });

      if (result.success) {
        await sendNotification(
          `✅ *完了* (${result.elapsed}秒)\n\n` +
          `\`\`\`\n${outputPreview}\n\`\`\``
        );
      } else {
        const sanitizedError = sanitizeOutput(result.error || '');
        await sendNotification(
          `❌ *エラー* (${result.elapsed}秒)\n\n` +
          `\`\`\`\n${truncateMessage(sanitizedError || outputPreview, 500)}\n\`\`\``
        );
      }

      await reportResult(taskId, {
        id: taskId,
        status: result.success ? 'completed' : 'failed',
        output: sanitizeOutput(result.output?.substring(0, 10000)),
        error: sanitizeOutput(result.error),
        elapsed: result.elapsed,
      });

    } catch (execError) {
      clearInterval(typingInterval);
      clearInterval(progressInterval);

      // エラーメッセージもサニタイズ（機密情報漏洩防止）
      const sanitizedError = sanitizeOutput(execError.message);
      logger.error('[Task] Execution error', { taskId, error: sanitizedError });

      await sendNotification(`❌ *実行エラー*\n\n\`${sanitizedError}\``);

      // 実行エラー時はリースを解放（他ワーカーが再処理可能に）
      await releaseLease(taskId, `Execution error: ${sanitizedError}`);

      await reportResult(taskId, {
        id: taskId,
        status: 'failed',
        error: sanitizedError,
      });
    }

  } finally {
    clearInterval(leaseRenewalInterval);
    isProcessing = false;
    currentTaskId = null;
  }
}

// ============================================
// ユーティリティ
// ============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// メインループ（claimTask ベース）
// ============================================
async function pollLoop() {
  logger.log('[Daemon] Poll loop started', {
    workersUrl: CONFIG.WORKERS_URL,
    workDir: CONFIG.WORK_DIR,
    pollInterval: CONFIG.POLL_INTERVAL,
    workerId: CONFIG.WORKER_ID,
  });

  await sendNotification('🤖 *AI Assistant v2.2 起動*\n\nタスクを待機中...');

  while (!shouldStop) {
    try {
      if (!isProcessing) {
        // claimTask でアトミックにタスクを取得（競合なし）
        const claimResult = await claimTask();

        if (claimResult?.success && claimResult.taskId) {
          logger.log('[Daemon] Claimed task', {
            taskId: claimResult.taskId,
            leaseExpiry: claimResult.lease?.expiresAt,
          });
          await processTask(claimResult);
        }
        // claimResult.success === false は「タスクなし」なのでログ不要
      }

      // 連続エラーが多い場合はバックオフ（上限付き）
      if (consecutiveErrors > 5) {
        logger.warn('[Daemon] Too many consecutive errors, backing off');
        const backoffDelay = Math.min(CONFIG.POLL_INTERVAL * 2, CONFIG.MAX_RETRY_DELAY);
        await sleep(backoffDelay);
        consecutiveErrors = 0;
      }

    } catch (error) {
      logger.error('[Daemon] Poll error', { error: error.message });
    }

    await sleep(CONFIG.POLL_INTERVAL);
  }

  logger.log('[Daemon] Stopped');
}

// ============================================
// ハートビート（5分ごと）
// ============================================
async function heartbeat() {
  const interval = 5 * 60 * 1000;

  while (!shouldStop) {
    await sleep(interval);

    if (!shouldStop) {
      const status = isProcessing ? `処理中: ${currentTaskId}` : '待機中';
      logger.log(`[Heartbeat] ${status}`);
    }
  }
}

// ============================================
// Graceful Shutdown
// ============================================
async function gracefulShutdown(signal) {
  logger.log(`[Daemon] Received ${signal}, shutting down...`);
  shouldStop = true;

  // 実行中のプロセスを終了
  if (currentProcess) {
    logger.log('[Daemon] Killing current process');
    currentProcess.kill('SIGTERM');

    // 5秒待っても終了しなければ強制終了
    await sleep(5000);
    if (currentProcess) {
      currentProcess.kill('SIGKILL');
    }
  }

  await sendNotification('🛑 *AI Assistant 停止*');

  // 少し待ってから終了（Telegram 送信完了を待つ）
  await sleep(1000);
  process.exit(0);
}

// ============================================
// シグナルハンドラ
// ============================================
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ============================================
// エラーハンドラ（即 exit → LaunchDaemon が再起動）
// ============================================
process.on('uncaughtException', (error) => {
  logger.error('[Fatal] Uncaught exception - exiting for clean restart', {
    error: error.message,
    stack: error.stack,
  });

  // 即座に終了（LaunchDaemon が再起動する）
  // 状態不整合を避けるため、通知は送らない
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('[Fatal] Unhandled rejection - exiting for clean restart', {
    reason: String(reason),
  });

  // 即座に終了
  process.exit(1);
});

// ============================================
// 環境変数バリデーション（強化版）
// ============================================
function validateConfig() {
  const errors = [];
  const warnings = [];

  // 必須: WORKERS_URL
  if (!CONFIG.WORKERS_URL) {
    errors.push('WORKERS_URL is required');
  }

  // 必須: API_KEY（fail-closed）
  if (!CONFIG.API_KEY) {
    errors.push('ASSISTANT_API_KEY is required (fail-closed security)');
  }

  // 通知設定の検証
  const notifType = CONFIG.NOTIFICATION_TYPE;
  if (notifType === 'telegram') {
    if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
      warnings.push('Telegram not configured - notifications disabled');
    }
  } else if (notifType === 'discord') {
    if (!CONFIG.DISCORD_WEBHOOK_URL) {
      warnings.push('DISCORD_WEBHOOK_URL not set - notifications disabled');
    }
  } else if (notifType === 'slack') {
    const hasWebhook = !!CONFIG.SLACK_WEBHOOK_URL;
    const hasBotToken = CONFIG.SLACK_BOT_TOKEN && CONFIG.SLACK_CHANNEL_ID;
    if (!hasWebhook && !hasBotToken) {
      warnings.push('Slack not configured - need SLACK_WEBHOOK_URL or (SLACK_BOT_TOKEN + SLACK_CHANNEL_ID)');
    } else if (hasBotToken) {
      logger.log('[Config] Using Slack Bot Token');
    } else {
      logger.log('[Config] Using Slack Webhook');
    }
  } else {
    warnings.push(`Unknown NOTIFICATION_TYPE: ${notifType}`);
  }
  logger.log(`[Config] Notification type: ${notifType}`);

  // エラーがあれば終了
  if (errors.length > 0) {
    errors.forEach(e => logger.error(`[Config] ${e}`));
    console.error('\n❌ Configuration errors. Please check your .env file.\n');
    process.exit(1);
  }

  // 警告を出力
  warnings.forEach(w => logger.warn(`[Config] ${w}`));
}

// ============================================
// 起動時ロッククリア
// ============================================
function clearStartupLocks() {
  // メモリ上のロックをクリア（再起動後のスティッキーロック対策）
  isProcessing = false;
  currentTaskId = null;
  currentProcess = null;
  processStartTime = null;
  consecutiveErrors = 0;
  shouldStop = false;

  logger.log('[Startup] Locks cleared');
}

// ============================================
// エントリーポイント
// ============================================
async function main() {
  console.log('========================================');
  console.log('  AI Assistant Daemon v2.2');
  console.log('  ClaimTask API + Lease Management');
  console.log('========================================');

  // 起動時ロッククリア
  clearStartupLocks();

  // 設定バリデーション（API Key 必須）
  validateConfig();

  await Promise.all([
    pollLoop(),
    heartbeat(),
  ]);
}

main().catch(error => {
  logger.error('[Fatal]', { error: error.message });
  process.exit(1);
});
