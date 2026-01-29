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
import { handleAdvisorAPI } from './handlers/strategic-advisor-api';

export type { Env };

// Cockpit PWA HTML (inline for Workers) - Gemini UI/UX Design v2.0
// Linear-style high-density list with keyboard navigation (J/K/Enter)
const COCKPIT_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#121212">
  <title>FUGUE Cockpit</title>
  <style>
    :root{--bg:#121212;--surface:#1e1e1e;--border:#333;--primary:#5e6ad2;--text-high:#f3f4f6;--text-low:#9ca3af;--confidence-high:#10b981;--confidence-mid:#f59e0b;--danger:#ef4444;--safe-top:env(safe-area-inset-top);--safe-bottom:env(safe-area-inset-bottom)}
    *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
    html{font-size:14px}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text-high);min-height:100vh;padding:calc(16px + var(--safe-top)) 12px calc(80px + var(--safe-bottom)) 12px}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:4px 0}
    h1{font-size:1.25rem;font-weight:600;letter-spacing:-0.02em}
    .status{display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--text-low)}
    .status-dot{width:8px;height:8px;border-radius:50%;background:var(--danger)}
    .status-dot.connected{background:var(--confidence-high);box-shadow:0 0 6px var(--confidence-high)}
    .section{margin-bottom:20px}
    .section-title{display:flex;justify-content:space-between;align-items:center;font-size:0.7rem;color:var(--text-low);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;padding:0 4px}
    .section-badge{background:var(--primary);color:#fff;padding:1px 6px;border-radius:8px;font-size:0.65rem}
    .kbd{font-size:0.6rem;color:var(--text-low);border:1px solid var(--border);padding:1px 4px;border-radius:3px;font-family:monospace}
    .insight-list{background:var(--surface);border-radius:10px;overflow:hidden;border:1px solid var(--border)}
    .insight-item{display:flex;align-items:center;gap:10px;padding:14px 12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s;min-height:52px;outline:none}
    .insight-item:last-child{border-bottom:none}
    .insight-item:hover,.insight-item:focus{background:rgba(255,255,255,0.03)}
    .insight-item.selected{background:rgba(94,106,210,0.15);border-left:2px solid var(--primary)}
    .insight-icon{flex-shrink:0;width:20px;height:20px;display:flex;align-items:center;justify-content:center}
    .insight-icon.strategic{color:#8b5cf6}
    .insight-icon.tactical{color:#3b82f6}
    .insight-icon.reflective{color:#22c55e}
    .insight-icon.questioning{color:#f59e0b}
    .insight-content{flex:1;min-width:0}
    .insight-header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
    .insight-title{font-size:0.875rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .insight-time{font-size:0.7rem;font-family:monospace;color:var(--text-low);flex-shrink:0}
    .insight-desc{font-size:0.75rem;color:var(--text-low);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
    .insight-confidence{flex-shrink:0;display:flex;align-items:center;gap:4px}
    .confidence-value{font-size:0.75rem;font-family:monospace}
    .confidence-value.high{color:var(--confidence-high)}
    .confidence-value.mid{color:var(--confidence-mid)}
    .confidence-value.low{color:var(--danger)}
    .confidence-bar{width:3px;height:14px;background:var(--border);border-radius:2px;overflow:hidden;display:flex;flex-direction:column-reverse}
    .confidence-bar-fill{width:100%;background:var(--confidence-high);transition:height 0.3s}
    .confidence-bar-fill.mid{background:var(--confidence-mid)}
    .confidence-bar-fill.low{background:var(--danger)}
    .no-data{color:var(--text-low);text-align:center;padding:20px;font-size:0.8rem}
    .repo-list,.task-list,.daemon-list{background:var(--surface);border-radius:10px;overflow:hidden;border:1px solid var(--border)}
    .repo-item,.task-item,.daemon-item{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border)}
    .repo-item:last-child,.task-item:last-child,.daemon-item:last-child{border-bottom:none}
    .repo-name,.task-name,.daemon-name{font-size:0.875rem;font-weight:500}
    .repo-branch,.task-meta,.daemon-time{font-size:0.7rem;color:var(--text-low);margin-top:1px}
    .badge{padding:3px 8px;border-radius:4px;font-size:0.65rem;font-weight:600}
    .badge.clean{background:rgba(34,197,94,0.15);color:#22c55e}
    .badge.dirty{background:rgba(239,68,68,0.15);color:#ef4444}
    .badge.ahead{background:rgba(59,130,246,0.15);color:#3b82f6}
    .badge.pending{background:rgba(245,158,11,0.15);color:#f59e0b}
    .badge.in_progress{background:rgba(59,130,246,0.15);color:#3b82f6}
    .badge.completed{background:rgba(34,197,94,0.15);color:#22c55e}
    .daemon-dot{width:6px;height:6px;border-radius:50%;margin-right:8px}
    .daemon-dot.online{background:#22c55e}
    .daemon-dot.offline{background:#ef4444}
    .bottom-sheet{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-end;justify-content:center;pointer-events:none;opacity:0;transition:opacity 0.2s}
    .bottom-sheet.open{opacity:1;pointer-events:auto}
    .sheet-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)}
    .sheet-content{position:relative;width:100%;max-width:420px;background:var(--bg);border:1px solid var(--border);border-bottom:none;border-radius:16px 16px 0 0;max-height:85vh;display:flex;flex-direction:column;transform:translateY(100%);transition:transform 0.25s ease-out}
    .bottom-sheet.open .sheet-content{transform:translateY(0)}
    .sheet-handle{width:100%;display:flex;justify-content:center;padding:10px 0 6px}
    .sheet-handle-bar{width:36px;height:4px;background:var(--border);border-radius:2px}
    .sheet-body{flex:1;overflow-y:auto;padding:0 16px 16px}
    .sheet-tag{display:inline-block;padding:3px 8px;border-radius:4px;font-size:0.7rem;font-weight:500;background:rgba(94,106,210,0.2);color:var(--primary);margin-bottom:10px}
    .sheet-title{font-size:1.25rem;font-weight:700;margin-bottom:12px;line-height:1.3}
    .sheet-desc{font-size:0.875rem;color:var(--text-low);line-height:1.5;margin-bottom:16px}
    .sheet-code{background:#0a0a0a;border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.75rem;font-family:'SF Mono',Menlo,monospace;overflow-x:auto;color:var(--text-low);white-space:pre;margin-bottom:16px}
    .sheet-actions{position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--border);padding:12px 16px calc(12px + var(--safe-bottom));display:flex;gap:8px}
    .sheet-btn{flex:1;padding:12px;border-radius:8px;font-size:0.875rem;font-weight:600;border:none;cursor:pointer;transition:transform 0.1s,opacity 0.1s}
    .sheet-btn:active{transform:scale(0.97)}
    .sheet-btn.secondary{background:var(--surface);color:var(--text-low);border:1px solid var(--border)}
    .sheet-btn.danger{background:rgba(239,68,68,0.15);color:var(--danger);border:1px solid rgba(239,68,68,0.3)}
    .sheet-btn.primary{background:var(--primary);color:#fff}
    .bottom-bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:1px solid var(--border);padding:10px 12px calc(10px + var(--safe-bottom));display:flex;gap:8px}
    .bottom-bar-btn{flex:1;padding:10px;border-radius:8px;font-size:0.8rem;font-weight:500;border:none;cursor:pointer;background:var(--surface);color:var(--text-low);transition:background 0.15s}
    .bottom-bar-btn:active{background:var(--border)}
    .bottom-bar-btn.active{background:var(--primary);color:#fff}
    .updated{font-size:0.65rem;color:var(--text-low);text-align:center;margin-top:8px}
  </style>
</head>
<body>
  <div class="header">
    <h1>FUGUE</h1>
    <div class="status"><div id="statusDot" class="status-dot"></div><span id="statusText">Offline</span></div>
  </div>

  <div class="section">
    <div class="section-title"><span>💡 Insights</span><div style="display:flex;gap:6px;align-items:center"><span id="insightBadge" class="section-badge" style="display:none">0</span><span class="kbd">J/K</span></div></div>
    <div id="insights" class="insight-list"><div class="no-data">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-title"><span>Repositories</span></div>
    <div id="repos" class="repo-list"><div class="no-data">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-title"><span>Tasks</span><span id="taskBadge" class="section-badge" style="display:none">0</span></div>
    <div id="tasks" class="task-list"><div class="no-data">No tasks</div></div>
  </div>

  <div class="section">
    <div class="section-title"><span>Daemons</span></div>
    <div id="daemons" class="daemon-list"><div class="no-data">Loading...</div></div>
  </div>

  <div id="updated" class="updated"></div>

  <div id="sheet" class="bottom-sheet">
    <div class="sheet-backdrop" onclick="closeSheet()"></div>
    <div class="sheet-content" role="dialog" aria-modal="true">
      <div class="sheet-handle"><div class="sheet-handle-bar"></div></div>
      <div class="sheet-body" id="sheetBody"></div>
      <div class="sheet-actions" id="sheetActions"></div>
    </div>
  </div>

  <div class="bottom-bar">
    <button class="bottom-bar-btn" onclick="refresh()">↻ Refresh</button>
    <button class="bottom-bar-btn" onclick="toggleDarkMode()">◐ Mode</button>
  </div>

  <script>
    let ws=null,token=new URLSearchParams(location.search).get('token'),insights=[],selectedIdx=-1;
    function connectWS(){const u=\`\${location.protocol==='https:'?'wss:':'ws:'}/\${location.host}/api/ws\`+(token?\`?token=\${token}\`:'');ws=new WebSocket(u);ws.onopen=()=>{document.getElementById('statusDot').classList.add('connected');document.getElementById('statusText').textContent='Online'};ws.onclose=()=>{document.getElementById('statusDot').classList.remove('connected');document.getElementById('statusText').textContent='Offline';setTimeout(connectWS,5000)};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='git-status')renderRepos(m.repos)}}

    function renderInsights(data){insights=data;const c=document.getElementById('insights');const b=document.getElementById('insightBadge');b.textContent=data.length;b.style.display=data.length>0?'inline':'none';if(!data.length){c.innerHTML='<div class="no-data">No insights</div>';return}
    c.innerHTML=data.map((i,idx)=>{const conf=i.confidence||75;const confClass=conf>=80?'high':conf>=50?'mid':'low';const typeIcon={strategic:'⚡',tactical:'🎯',reflective:'💭',questioning:'❓'}[i.type]||'💡';const ago=i.createdAt?formatAgo(i.createdAt):'';
    return \`<article class="insight-item\${idx===selectedIdx?' selected':''}" tabindex="0" data-idx="\${idx}" onclick="openInsight(\${idx})" onkeydown="handleInsightKey(event,\${idx})" aria-label="\${i.title}, confidence \${conf}%">
      <div class="insight-icon \${i.type}">\${typeIcon}</div>
      <div class="insight-content"><div class="insight-header"><span class="insight-title">\${i.title}</span><span class="insight-time">\${ago}</span></div><p class="insight-desc">\${i.description||''}</p></div>
      <div class="insight-confidence" title="Confidence: \${conf}%"><span class="confidence-value \${confClass}">\${conf}%</span><div class="confidence-bar"><div class="confidence-bar-fill \${confClass}" style="height:\${conf}%"></div></div></div>
    </article>\`}).join('')}

    function handleInsightKey(e,idx){if(e.key==='Enter'||e.key===' '){e.preventDefault();openInsight(idx)}}
    document.addEventListener('keydown',e=>{if(document.getElementById('sheet').classList.contains('open')){if(e.key==='Escape')closeSheet();if(e.key==='a')handleAction('accepted');if(e.key==='x')handleAction('dismissed');if(e.key==='s')handleAction('snoozed');return}
    if(e.key==='j'||e.key==='ArrowDown'){e.preventDefault();selectedIdx=Math.min(selectedIdx+1,insights.length-1);renderInsights(insights);focusInsight()}
    if(e.key==='k'||e.key==='ArrowUp'){e.preventDefault();selectedIdx=Math.max(selectedIdx-1,0);renderInsights(insights);focusInsight()}
    if((e.key==='Enter'||e.key===' ')&&selectedIdx>=0){e.preventDefault();openInsight(selectedIdx)}
    if(e.key==='r'){e.preventDefault();refresh()}})
    function focusInsight(){const item=document.querySelector(\`.insight-item[data-idx="\${selectedIdx}"]\`);if(item)item.focus()}

    function openInsight(idx){const i=insights[idx];if(!i)return;selectedIdx=idx;renderInsights(insights);const typeLabel={strategic:'Strategic',tactical:'Tactical',reflective:'Reflective',questioning:'Questioning'}[i.type]||i.type;
    document.getElementById('sheetBody').innerHTML=\`<span class="sheet-tag">\${typeLabel}</span><h2 class="sheet-title">\${i.title}</h2><p class="sheet-desc">\${i.description||''}</p>\${i.suggestedAction?\`<div class="sheet-code">\${i.suggestedAction}</div>\`:''}\`;
    document.getElementById('sheetActions').innerHTML=\`<button class="sheet-btn secondary" onclick="handleAction('snoozed')">Snooze (S)</button><button class="sheet-btn danger" onclick="handleAction('dismissed')">Dismiss (X)</button><button class="sheet-btn primary" onclick="handleAction('accepted')">Accept (A)</button>\`;
    document.getElementById('sheet').classList.add('open')}
    function closeSheet(){document.getElementById('sheet').classList.remove('open')}
    async function handleAction(action){const i=insights[selectedIdx];if(!i)return;closeSheet();try{await fetch('/api/advisor/insights/'+i.id+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});fetchData()}catch(e){console.error(e)}}

    function renderRepos(repos){const c=document.getElementById('repos');if(!repos||!repos.length){c.innerHTML='<div class="no-data">No repositories</div>';return}c.innerHTML=repos.map(r=>{const cnt=r.uncommitted_count||r.uncommittedCount||0;const ahead=r.ahead_count||r.aheadCount||0;let status='clean',badge='Clean';if(cnt>0){status='dirty';badge=cnt+' changes'}else if(ahead>0){status='ahead';badge=ahead+' ahead'}return \`<div class="repo-item"><div><div class="repo-name">\${r.name}</div><div class="repo-branch">\${r.branch||'main'}</div></div><span class="badge \${status}">\${badge}</span></div>\`}).join('')}

    function renderTasks(tasks){const c=document.getElementById('tasks');const b=document.getElementById('taskBadge');const active=tasks.filter(t=>t.status!=='completed');b.textContent=active.length;b.style.display=active.length>0?'inline':'none';if(!tasks||!tasks.length){c.innerHTML='<div class="no-data">No tasks</div>';return}c.innerHTML=tasks.slice(0,5).map(t=>{const statusLabel={pending:'Pending',in_progress:'Running',completed:'Done'}[t.status]||t.status;return \`<div class="task-item"><div><div class="task-name">\${t.task_type||t.taskType||'Task'}</div><div class="task-meta">\${t.id?.slice(0,8)||''}</div></div><span class="badge \${t.status}">\${statusLabel}</span></div>\`}).join('')}

    function renderDaemons(daemons){const c=document.getElementById('daemons');if(!daemons||!daemons.length){c.innerHTML='<div class="no-data">No daemons</div>';return}c.innerHTML=daemons.map(d=>{const online=d.status==='healthy'||d.is_healthy;const ago=d.last_heartbeat?formatAgo(d.last_heartbeat):'Unknown';return \`<div class="daemon-item"><div style="display:flex;align-items:center"><div class="daemon-dot \${online?'online':'offline'}"></div><div><div class="daemon-name">\${d.daemon_id||d.daemonId||'Local Agent'}</div><div class="daemon-time">Last: \${ago}</div></div></div></div>\`}).join('')}

    function formatAgo(ts){const s=Math.floor((Date.now()/1000)-(typeof ts==='number'?ts:new Date(ts).getTime()/1000));if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h'}
    function toggleDarkMode(){document.body.style.filter=document.body.style.filter?'':'invert(0.9) hue-rotate(180deg)'}

    async function fetchData(){try{const opts={credentials:'include',headers:token?{Authorization:'Bearer '+token}:{}};const[rr,tr,dr,ir]=await Promise.all([fetch('/api/cockpit/repos',opts),fetch('/api/cockpit/tasks',opts),fetch('/api/daemon/health',opts),fetch('/api/advisor/insights?limit=5',opts)]);if(rr.ok){const d=await rr.json();renderRepos(d.repos||d.data||d)}if(tr.ok){const d=await tr.json();renderTasks(d.tasks||d.data||[])}if(dr.ok){const d=await dr.json();renderDaemons(d.daemons||d.data||[])}if(ir.ok){const d=await ir.json();renderInsights(d.data||[])}document.getElementById('updated').textContent='Updated: '+new Date().toLocaleTimeString('ja-JP')}catch(e){console.error(e)}}
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

    // Strategic Advisor API endpoints (for FUGUE insights) - with CORS
    if (path.startsWith('/api/advisor')) {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const response = await handleAdvisorAPI(request, env, path);

      // Add CORS headers to response
      const newResponse = new Response(response.body, response);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      return newResponse;
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
