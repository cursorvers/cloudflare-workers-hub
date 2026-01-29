/**
 * Cloudflare Workers Hub
 *
 * Orchestrator 拡張の統合入口
 * - Webhook 受信・正規化
 * - Workers AI による軽量応答
 * - Claude Orchestrator への転送
 */

import { Env } from './types';
import { CommHubAdapter } from './adapters/commhub';
import { performStartupCheck } from './utils/secrets-validator';
import { safeLog } from './utils/log-sanitizer';
import { authenticateWithAccess, mapAccessUserToInternal } from './utils/cloudflare-access';

// Durable Objects
export { TaskCoordinator } from './durable-objects/task-coordinator';
export { CockpitWebSocket } from './durable-objects/cockpit-websocket';

// Handlers
import { ensureServiceRoleMappings } from './handlers/initialization';
import { initGenericWebhook } from './handlers/generic-webhook';
import { handleWebhook } from './handlers/webhook-router';
import { handleWhatsAppWebhook } from './handlers/channels/whatsapp';
import { handleQueueAPI } from './handlers/queue';
import { handleHealthCheck, handleMetrics } from './handlers/health';
import { handleMemoryAPI } from './handlers/memory-api';
import { handleCronAPI } from './handlers/cron-api';
import { handleAdminAPI } from './handlers/admin-api';
import { handleDaemonAPI } from './handlers/daemon-api';
import { handleLimitlessAPI } from './handlers/limitless-api';
import { handleLimitlessWebhook } from './handlers/limitless-webhook';
import { handleScheduled } from './handlers/scheduled';
import { handleCockpitAPI } from './handlers/cockpit-api';

export type { Env };

// Cockpit PWA HTML (inline for Workers)
const COCKPIT_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <title>FUGUE Cockpit</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); color: #f8fafc; min-height: 100vh; padding: 16px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding: 8px 0; }
    h1 { font-size: 24px; font-weight: 600; color: #fff; }
    .status { display: flex; align-items: center; gap: 8px; font-size: 14px; background: rgba(255,255,255,0.1); padding: 6px 12px; border-radius: 20px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 8px #ef4444; }
    .status-dot.connected { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
    .card { background: rgba(255,255,255,0.95); border: none; border-radius: 16px; padding: 20px; margin-bottom: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); color: #1e293b; }
    .card-title { font-size: 13px; color: #64748b; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    .card-badge { background: #3b82f6; color: white; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
    .repo { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #e2e8f0; }
    .repo:last-child { border-bottom: none; }
    .repo-name { font-weight: 600; color: #0f172a; font-size: 15px; }
    .repo-branch { font-size: 12px; color: #64748b; margin-top: 2px; }
    .repo-status { padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; }
    .repo-status.clean { background: #dcfce7; color: #166534; }
    .repo-status.dirty { background: #fee2e2; color: #dc2626; }
    .repo-status.ahead { background: #dbeafe; color: #1d4ed8; }
    .task { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
    .task:last-child { border-bottom: none; }
    .task-name { font-weight: 500; color: #0f172a; font-size: 14px; }
    .task-meta { font-size: 11px; color: #64748b; margin-top: 2px; }
    .task-status { padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .task-status.pending { background: #fef3c7; color: #92400e; }
    .task-status.in_progress { background: #dbeafe; color: #1d4ed8; }
    .task-status.completed { background: #dcfce7; color: #166534; }
    .daemon { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
    .daemon-dot { width: 8px; height: 8px; border-radius: 50%; }
    .daemon-dot.online { background: #22c55e; }
    .daemon-dot.offline { background: #ef4444; }
    .daemon-info { flex: 1; }
    .daemon-name { font-weight: 500; color: #0f172a; font-size: 14px; }
    .daemon-time { font-size: 11px; color: #64748b; }
    .no-data { color: #94a3b8; text-align: center; padding: 24px; font-size: 14px; }
    .btn { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; border: none; padding: 14px 24px; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; width: 100%; box-shadow: 0 4px 12px rgba(37,99,235,0.3); transition: transform 0.2s, box-shadow 0.2s; }
    .btn:active { transform: scale(0.98); }
    .updated { font-size: 11px; color: rgba(255,255,255,0.6); text-align: center; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>FUGUE Cockpit</h1>
    <div class="status"><div id="statusDot" class="status-dot"></div><span id="statusText">切断</span></div>
  </div>
  <div class="card"><div class="card-title"><span>GIT リポジトリ</span></div><div id="repos"><div class="no-data">読み込み中...</div></div></div>
  <div class="card"><div class="card-title"><span>タスク</span><span id="taskBadge" class="card-badge" style="display:none">0</span></div><div id="tasks"><div class="no-data">タスクなし</div></div></div>
  <div class="card"><div class="card-title"><span>DAEMON 状態</span></div><div id="daemons"><div class="no-data">読み込み中...</div></div></div>
  <div class="card"><div class="card-title"><span>アラート</span></div><div id="alerts"><div class="no-data">アラートなし</div></div></div>
  <button class="btn" onclick="refresh()">更新</button>
  <div id="updated" class="updated"></div>
  <script>
    let ws=null,token=new URLSearchParams(location.search).get('token');
    function connectWS(){const u=\`\${location.protocol==='https:'?'wss:':'ws:'}/\${location.host}/api/ws\`+(token?\`?token=\${token}\`:'');ws=new WebSocket(u);ws.onopen=()=>{document.getElementById('statusDot').classList.add('connected');document.getElementById('statusText').textContent='接続中'};ws.onclose=()=>{document.getElementById('statusDot').classList.remove('connected');document.getElementById('statusText').textContent='切断';setTimeout(connectWS,5000)};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='git-status')renderRepos(m.repos)}}
    function renderRepos(repos){const c=document.getElementById('repos');if(!repos||!repos.length){c.innerHTML='<div class="no-data">リポジトリなし</div>';return}c.innerHTML=repos.map(r=>{const cnt=r.uncommitted_count||r.uncommittedCount||0;const ahead=r.ahead_count||r.aheadCount||0;const behind=r.behind_count||r.behindCount||0;let status=r.status||'clean';let badge='';if(cnt>0){badge=cnt+' 変更';status='dirty';}else if(ahead>0){badge=ahead+' ahead';status='ahead';}else if(behind>0){badge=behind+' behind';status='behind';}else{badge='Clean';status='clean';}return \`<div class="repo"><div><div class="repo-name">\${r.name}</div><div class="repo-branch">\${r.branch||'main'}</div></div><div class="repo-status \${status}">\${badge}</div></div>\`}).join('')}
    function renderTasks(tasks){const c=document.getElementById('tasks');const b=document.getElementById('taskBadge');const active=tasks.filter(t=>t.status!=='completed');b.textContent=active.length;b.style.display=active.length>0?'inline':'none';if(!tasks||!tasks.length){c.innerHTML='<div class="no-data">タスクなし</div>';return}c.innerHTML=tasks.slice(0,5).map(t=>\`<div class="task"><div><div class="task-name">\${t.task_type||t.taskType||'Task'}</div><div class="task-meta">\${t.id?.slice(0,8)||''}</div></div><div class="task-status \${t.status}">\${t.status==='pending'?'待機':t.status==='in_progress'?'実行中':'完了'}</div></div>\`).join('')}
    function renderDaemons(daemons){const c=document.getElementById('daemons');if(!daemons||!daemons.length){c.innerHTML='<div class="no-data">Daemon なし</div>';return}c.innerHTML=daemons.map(d=>{const online=d.status==='healthy'||d.is_healthy;const ago=d.last_heartbeat?formatAgo(d.last_heartbeat):'不明';return \`<div class="daemon"><div class="daemon-dot \${online?'online':'offline'}"></div><div class="daemon-info"><div class="daemon-name">\${d.daemon_id||d.daemonId||'Local Agent'}</div><div class="daemon-time">最終: \${ago}</div></div></div>\`}).join('')}
    function formatAgo(ts){const s=Math.floor((Date.now()/1000)-(typeof ts==='number'?ts:new Date(ts).getTime()/1000));if(s<60)return s+'秒前';if(s<3600)return Math.floor(s/60)+'分前';return Math.floor(s/3600)+'時間前';}
    async function fetchData(){try{const opts={credentials:'include',headers:token?{Authorization:'Bearer '+token}:{}};const[rr,tr,dr,ar]=await Promise.all([fetch('/api/cockpit/repos',opts),fetch('/api/cockpit/tasks',opts),fetch('/api/daemon/health',opts),fetch('/api/cockpit/alerts',opts)]);if(rr.ok){const d=await rr.json();renderRepos(d.repos||d.data||d)}if(tr.ok){const d=await tr.json();renderTasks(d.tasks||d.data||[])}if(dr.ok){const d=await dr.json();renderDaemons(d.daemons||d.data||[])}if(ar.ok){const d=await ar.json();const c=document.getElementById('alerts');c.innerHTML=(!d.alerts&&!d.data)||(d.alerts||d.data).length===0?'<div class="no-data">アラートなし</div>':(d.alerts||d.data).map(a=>\`<div style="background:#7f1d1d;border:1px solid #991b1b;padding:12px;border-radius:8px;margin-bottom:8px;color:#fecaca"><div style="font-weight:500">\${a.message}</div></div>\`).join('')}document.getElementById('updated').textContent='更新: '+new Date().toLocaleTimeString('ja-JP');}catch(e){console.error(e)}}
    function refresh(){fetchData()}
    connectWS();fetchData();setInterval(fetchData,30000);
  </script>
</body>
</html>`;

// Cache version for schema changes (update when KV schema changes)
const CACHE_VERSION = 'v1';

// Initialize CommHub Adapter (KV will be set on first request)
const commHub = new CommHubAdapter();

// Initialize generic webhook handler with shared dependencies
initGenericWebhook(commHub, CACHE_VERSION);

// Startup check flags (Cloudflare Workers are stateless, so check on first request)
let startupCheckDone = false;
let commHubInitialized = false;
let serviceRoleMappingsInitialized = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Perform startup secrets validation once
    if (!startupCheckDone) {
      performStartupCheck(env);
      startupCheckDone = true;
    }

    // Initialize CommHub with KV for queue-based orchestration
    if (!commHubInitialized && env.CACHE) {
      commHub.setKV(env.CACHE);
      commHubInitialized = true;
    }

    // Initialize service role KV mappings (idempotent, runs once per isolate)
    if (!serviceRoleMappingsInitialized) {
      try {
        await ensureServiceRoleMappings(env);
      } catch (e) {
        safeLog.error('[Init] Service role mapping failed', { error: String(e) });
      }
      serviceRoleMappingsInitialized = true;
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check endpoint
    if (path === '/health' || path === '/') {
      return handleHealthCheck(request, env);
    }

    // Metrics endpoint
    if (path === '/metrics') {
      return handleMetrics(request, env);
    }

    // Cockpit PWA (static HTML)
    if (path === '/cockpit' || path === '/cockpit/') {
      const html = COCKPIT_HTML;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Queue API endpoints (for AI Assistant Daemon)
    if (path.startsWith('/api/queue') || path.startsWith('/api/result')) {
      try {
        return await handleQueueAPI(request, env, path);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : undefined;
        safeLog.error('[Queue] Unhandled error:', { message: msg, stack });
        return new Response(JSON.stringify({ error: 'Internal error' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Memory API endpoints (for persistent conversation history)
    if (path.startsWith('/api/memory')) {
      return handleMemoryAPI(request, env, path);
    }

    // Cron API endpoints (for scheduled task management)
    if (path.startsWith('/api/cron')) {
      return handleCronAPI(request, env, path);
    }

    // Admin API endpoints (for API key management)
    if (path.startsWith('/api/admin')) {
      return handleAdminAPI(request, env, path);
    }

    // Daemon Health API endpoints (for monitoring active daemons)
    if (path.startsWith('/api/daemon')) {
      return handleDaemonAPI(request, env, path);
    }

    // Limitless API endpoints (for Pendant voice recording sync)
    if (path.startsWith('/api/limitless')) {
      // Webhook endpoint for iOS Shortcuts
      if (path === '/api/limitless/webhook-sync' && request.method === 'POST') {
        return handleLimitlessWebhook(request, env);
      }
      // Other Limitless API endpoints
      return handleLimitlessAPI(request, env, path);
    }

    // Cockpit API endpoints (for FUGUE monitoring) - with CORS
    if (path.startsWith('/api/cockpit')) {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const response = await handleCockpitAPI(request, env, path);

      // Add CORS headers to response
      const newResponse = new Response(response.body, response);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      return newResponse;
    }

    // WebSocket upgrade for Cockpit (upgrade to DO)
    if (path === '/api/ws' && request.headers.get('Upgrade') === 'websocket') {
      if (!env.COCKPIT_WS) {
        return new Response('WebSocket not available', { status: 503 });
      }

      // Try Cloudflare Access authentication first
      const accessResult = await authenticateWithAccess(request, env);
      let authHeaders: Record<string, string> = {};

      safeLog.log('[WebSocket] Access auth attempt', {
        verified: accessResult.verified,
        email: accessResult.email,
        error: accessResult.error,
        hasCookie: request.headers.get('Cookie')?.includes('CF_Authorization') || false,
      });

      if (accessResult.verified && accessResult.email) {
        // Map Access user to internal user for RBAC
        const internalUser = await mapAccessUserToInternal(accessResult.email, env);
        if (internalUser) {
          // Pass user info via custom headers to DO
          authHeaders = {
            'X-Access-User-Id': internalUser.userId,
            'X-Access-User-Role': internalUser.role,
            'X-Access-User-Email': accessResult.email,
          };
          safeLog.log('[WebSocket] Access auth passed', {
            email: accessResult.email,
            role: internalUser.role,
          });
        }
      }

      const doId = env.COCKPIT_WS.idFromName('cockpit');
      const doStub = env.COCKPIT_WS.get(doId);

      // Forward request to DO with auth headers
      return doStub.fetch(new Request(`http://do/ws${url.search}`, {
        headers: new Headers([
          ...Array.from(request.headers.entries()),
          ...Object.entries(authHeaders),
        ]),
      }));
    }

    // Webhook endpoints
    if (path.startsWith('/webhook/')) {
      // Allow GET for WhatsApp webhook verification
      if (request.method === 'GET' && path.includes('/whatsapp')) {
        return handleWhatsAppWebhook(request, env);
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      return handleWebhook(request, env, ctx);
    }

    // 404 for unknown paths
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduled(controller, env, ctx);
  },
};
