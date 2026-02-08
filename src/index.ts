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
import { getDeployTarget, isCanaryWriteEnabled, maybeBlockCanaryWrite } from './utils/canary-write-gate';
import { authenticateWithAccess, mapAccessUserToInternal } from './utils/cloudflare-access';
import { isFreeeIntegrationEnabled } from './utils/freee-integration';

// Durable Objects
export { TaskCoordinator } from './durable-objects/task-coordinator';
export { CockpitWebSocket } from './durable-objects/cockpit-websocket';
export { SystemEvents } from './durable-objects/system-events';
export { RateLimiter } from './durable-objects/rate-limiter';

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
import { handleUsageAPI } from './handlers/usage-api';
import { handleGoalPlannerAPI } from './handlers/goal-planner';
import { handlePushQueueBatch } from './handlers/push-queue-consumer';
import { handleReceiptUpload } from './handlers/receipt-upload';
import { handleReceiptSearch } from './handlers/receipt-search';
import { handleReceiptSourcesAPI } from './handlers/receipt-sources-api';
import { handleDLQAPI } from './handlers/dlq-api';

export type { Env };

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

// Cockpit PWA HTML (inline for Workers) - Gemini UI/UX Design v3.0
// Phase 3: Swipe gestures, ARIA, Dynamic Type, Coach marks
const COCKPIT_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#121212">
  <meta name="description" content="FUGUE Strategic Advisor - AI-powered development insights">
  <title>FUGUE Cockpit</title>
  <style>
    :root{--bg:#121212;--surface:#1e1e1e;--border:#333;--primary:#5e6ad2;--text-high:#f3f4f6;--text-low:#9ca3af;--confidence-high:#10b981;--confidence-mid:#f59e0b;--danger:#ef4444;--accept:#22c55e;--safe-top:env(safe-area-inset-top);--safe-bottom:env(safe-area-inset-bottom);--base-font:clamp(0.875rem,2.5vw,1rem)}
    *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
    html{font-size:var(--base-font);-webkit-text-size-adjust:100%}
    @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text-high);min-height:100vh;min-height:100dvh;padding:calc(1rem + var(--safe-top)) 0.75rem calc(5rem + var(--safe-bottom)) 0.75rem}
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
    .insight-item{position:relative;display:flex;align-items:center;gap:0.625rem;padding:0.875rem 0.75rem;border-bottom:1px solid var(--border);cursor:pointer;transition:transform 0.15s,background 0.15s;min-height:3.25rem;outline:none;touch-action:pan-y;overflow:hidden}
    .insight-item:last-child{border-bottom:none}
    .insight-item:hover,.insight-item:focus-visible{background:rgba(255,255,255,0.03)}
    .insight-item:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}
    .insight-item.selected{background:rgba(94,106,210,0.15);border-left:2px solid var(--primary)}
    .insight-item.swiping-right{background:linear-gradient(90deg,rgba(34,197,94,0.2) 0%,transparent 50%)}
    .insight-item.swiping-left{background:linear-gradient(270deg,rgba(239,68,68,0.2) 0%,transparent 50%)}
    .swipe-hint{position:absolute;top:50%;transform:translateY(-50%);font-size:1.25rem;opacity:0;transition:opacity 0.15s}
    .swipe-hint.left{right:0.75rem}
    .swipe-hint.right{left:0.75rem}
    .insight-item.swiping-right .swipe-hint.right,.insight-item.swiping-left .swipe-hint.left{opacity:1}
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
    .badge.backlog{background:rgba(156,163,175,0.15);color:#9ca3af}
    .badge.pending{background:rgba(245,158,11,0.15);color:#f59e0b}
    .badge.in_progress{background:rgba(59,130,246,0.15);color:#3b82f6}
    .badge.review{background:rgba(139,92,246,0.15);color:#8b5cf6}
    .badge.completed{background:rgba(34,197,94,0.15);color:#22c55e}
    .badge.low{background:rgba(156,163,175,0.15);color:#9ca3af}
    .badge.medium{background:rgba(59,130,246,0.15);color:#3b82f6}
    .badge.high{background:rgba(245,158,11,0.15);color:#f59e0b}
    .badge.urgent{background:rgba(239,68,68,0.15);color:#ef4444}
    .daemon-dot{width:6px;height:6px;border-radius:50%;margin-right:8px}
    .kanban{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:8px}
    @media(max-width:768px){.kanban{grid-template-columns:repeat(4,minmax(140px,1fr));min-width:600px}}
    .kanban-col{background:var(--surface);border-radius:8px;border:1px solid var(--border);min-height:120px}
    .kanban-header{padding:8px 10px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
    .kanban-title{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.03em}
    .kanban-count{background:var(--border);color:var(--text-low);padding:1px 6px;border-radius:8px;font-size:0.6rem}
    .kanban-cards{padding:6px;min-height:60px}
    .kanban-card{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;cursor:pointer;transition:transform 0.1s,box-shadow 0.1s}
    .kanban-card:hover{transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,0.3)}
    .kanban-card:last-child{margin-bottom:0}
    .kanban-card-title{font-size:0.75rem;font-weight:500;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .kanban-card-meta{display:flex;justify-content:space-between;align-items:center;font-size:0.6rem;color:var(--text-low)}
    .kanban-card-executor{display:flex;align-items:center;gap:3px}
    .kanban-empty{color:var(--text-low);font-size:0.7rem;text-align:center;padding:16px 8px}
    .view-toggle{display:flex;gap:4px}
    .view-btn{background:none;border:1px solid var(--border);color:var(--text-low);padding:2px 8px;border-radius:4px;font-size:0.65rem;cursor:pointer}
    .view-btn.active{background:var(--primary);border-color:var(--primary);color:#fff}
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
    <div style="display:flex;align-items:center;gap:8px">
      <button id="pushNotifBtn" onclick="requestPushPermission()" style="display:none;background:var(--primary);color:#fff;border:none;padding:4px 8px;border-radius:4px;font-size:0.65rem;cursor:pointer" title="Enable push notifications">🔔 Enable Push</button>
      <div class="status"><div id="statusDot" class="status-dot"></div><span id="statusText">Offline</span></div>
    </div>
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
    <div class="section-title">
      <span>Tasks</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span id="taskBadge" class="section-badge" style="display:none">0</span>
        <div class="view-toggle">
          <button class="view-btn" id="listViewBtn" onclick="setTaskView('list')">List</button>
          <button class="view-btn active" id="kanbanViewBtn" onclick="setTaskView('kanban')">Board</button>
        </div>
        <button class="view-btn" onclick="openNewTaskSheet()" style="background:var(--primary);border-color:var(--primary);color:#fff">+ New</button>
      </div>
    </div>
    <div id="tasksListView" class="task-list" style="display:none"><div class="no-data">No tasks</div></div>
    <div id="tasksKanbanView" style="overflow-x:auto">
      <div class="kanban">
        <div class="kanban-col"><div class="kanban-header"><span class="kanban-title">📋 Backlog</span><span id="backlogCount" class="kanban-count">0</span></div><div id="backlogCards" class="kanban-cards"><div class="kanban-empty">Drop tasks here</div></div></div>
        <div class="kanban-col"><div class="kanban-header"><span class="kanban-title">🔄 In Progress</span><span id="inProgressCount" class="kanban-count">0</span></div><div id="inProgressCards" class="kanban-cards"><div class="kanban-empty">No tasks</div></div></div>
        <div class="kanban-col"><div class="kanban-header"><span class="kanban-title">👀 Review</span><span id="reviewCount" class="kanban-count">0</span></div><div id="reviewCards" class="kanban-cards"><div class="kanban-empty">No tasks</div></div></div>
        <div class="kanban-col"><div class="kanban-header"><span class="kanban-title">✅ Done</span><span id="doneCount" class="kanban-count">0</span></div><div id="doneCards" class="kanban-cards"><div class="kanban-empty">No tasks</div></div></div>
      </div>
    </div>
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
    // XSS prevention: escape HTML entities
    function escapeHtml(str){if(!str)return '';return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
    function connectWS(){const u=\`\${location.protocol==='https:'?'wss:':'ws:'}/\${location.host}/api/ws\`+(token?\`?token=\${token}\`:'');ws=new WebSocket(u);ws.onopen=()=>{document.getElementById('statusDot').classList.add('connected');document.getElementById('statusText').textContent='Online'};ws.onclose=()=>{document.getElementById('statusDot').classList.remove('connected');document.getElementById('statusText').textContent='Offline';setTimeout(connectWS,5000)};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='git-status')renderRepos(m.repos)}}

    function renderInsights(data){insights=data;const c=document.getElementById('insights');const b=document.getElementById('insightBadge');b.textContent=data.length;b.style.display=data.length>0?'inline':'none';if(!data.length){c.innerHTML='<div class="no-data">No insights</div>';return}
    c.innerHTML=data.map((i,idx)=>{const conf=i.confidence||75;const confClass=conf>=80?'high':conf>=50?'mid':'low';const typeIcon={strategic:'⚡',tactical:'🎯',reflective:'💭',questioning:'❓'}[i.type]||'💡';const ago=i.createdAt?formatAgo(i.createdAt):'';
    return \`<article class="insight-item\${idx===selectedIdx?' selected':''}" tabindex="0" data-idx="\${idx}" onclick="openInsight(\${idx})" onkeydown="handleInsightKey(event,\${idx})" aria-label="\${escapeHtml(i.title)}, confidence \${conf}%">
      <span class="swipe-hint right" aria-hidden="true">✓</span>
      <div class="insight-icon \${escapeHtml(i.type)}">\${typeIcon}</div>
      <div class="insight-content"><div class="insight-header"><span class="insight-title">\${escapeHtml(i.title)}</span><span class="insight-time">\${ago}</span></div><p class="insight-desc">\${escapeHtml(i.description)||''}</p></div>
      <div class="insight-confidence" title="Confidence: \${conf}%"><span class="confidence-value \${confClass}">\${conf}%</span><div class="confidence-bar"><div class="confidence-bar-fill \${confClass}" style="height:\${conf}%"></div></div></div>
      <span class="swipe-hint left" aria-hidden="true">✗</span>
    </article>\`}).join('');initSwipeGestures()}

    function handleInsightKey(e,idx){if(e.key==='Enter'||e.key===' '){e.preventDefault();openInsight(idx)}}
    document.addEventListener('keydown',e=>{if(document.getElementById('sheet').classList.contains('open')){if(e.key==='Escape')closeSheet();if(e.key==='a')handleAction('accepted');if(e.key==='x')handleAction('dismissed');if(e.key==='s')handleAction('snoozed');return}
    if(e.key==='j'||e.key==='ArrowDown'){e.preventDefault();selectedIdx=Math.min(selectedIdx+1,insights.length-1);renderInsights(insights);focusInsight()}
    if(e.key==='k'||e.key==='ArrowUp'){e.preventDefault();selectedIdx=Math.max(selectedIdx-1,0);renderInsights(insights);focusInsight()}
    if((e.key==='Enter'||e.key===' ')&&selectedIdx>=0){e.preventDefault();openInsight(selectedIdx)}
    if(e.key==='r'){e.preventDefault();refresh()}})
    function focusInsight(){const item=document.querySelector(\`.insight-item[data-idx="\${selectedIdx}"]\`);if(item)item.focus()}

    function openInsight(idx){const i=insights[idx];if(!i)return;selectedIdx=idx;renderInsights(insights);const typeLabel={strategic:'Strategic',tactical:'Tactical',reflective:'Reflective',questioning:'Questioning'}[i.type]||escapeHtml(i.type);
    document.getElementById('sheetBody').innerHTML=\`<span class="sheet-tag">\${escapeHtml(typeLabel)}</span><h2 class="sheet-title">\${escapeHtml(i.title)}</h2><p class="sheet-desc">\${escapeHtml(i.description)||''}</p>\${i.suggestedAction?\`<div class="sheet-code">\${escapeHtml(i.suggestedAction)}</div>\`:''}\`;
    document.getElementById('sheetActions').innerHTML=\`<button class="sheet-btn secondary" onclick="handleAction('snoozed')">Snooze (S)</button><button class="sheet-btn danger" onclick="handleAction('dismissed')">Dismiss (X)</button><button class="sheet-btn primary" onclick="handleAction('accepted')">Accept (A)</button>\`;
    document.getElementById('sheet').classList.add('open')}
    function closeSheet(){document.getElementById('sheet').classList.remove('open')}
    async function handleAction(action){const i=insights[selectedIdx];if(!i)return;closeSheet();try{await fetch('/api/advisor/insights/'+i.id+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});fetchData()}catch(e){console.error(e)}}

    function renderRepos(repos){const c=document.getElementById('repos');if(!repos||!repos.length){c.innerHTML='<div class="no-data">No repositories</div>';return}c.innerHTML=repos.map(r=>{const cnt=r.uncommitted_count||r.uncommittedCount||0;const ahead=r.ahead_count||r.aheadCount||0;let status='clean',badge='Clean';if(cnt>0){status='dirty';badge=cnt+' changes'}else if(ahead>0){status='ahead';badge=ahead+' ahead'}return \`<div class="repo-item"><div><div class="repo-name">\${escapeHtml(r.name)}</div><div class="repo-branch">\${escapeHtml(r.branch||'main')}</div></div><span class="badge \${status}">\${badge}</span></div>\`}).join('')}

    let allTasks=[],currentTaskView='kanban';
    function setTaskView(view){currentTaskView=view;document.getElementById('listViewBtn').classList.toggle('active',view==='list');document.getElementById('kanbanViewBtn').classList.toggle('active',view==='kanban');document.getElementById('tasksListView').style.display=view==='list'?'block':'none';document.getElementById('tasksKanbanView').style.display=view==='kanban'?'block':'none';renderTasks(allTasks)}
    function renderTasks(tasks){allTasks=tasks||[];const b=document.getElementById('taskBadge');const active=allTasks.filter(t=>t.status!=='completed');b.textContent=active.length;b.style.display=active.length>0?'inline':'none';if(currentTaskView==='list'){renderTasksList(allTasks)}else{renderKanban(allTasks)}}
    function renderTasksList(tasks){const c=document.getElementById('tasksListView');if(!tasks||!tasks.length){c.innerHTML='<div class="no-data">No tasks</div>';return}c.innerHTML=tasks.slice(0,10).map(t=>{const statusLabel={backlog:'Backlog',pending:'Pending',in_progress:'Running',review:'Review',completed:'Done'}[t.status]||escapeHtml(t.status);return \`<div class="task-item" onclick="openTaskDetail('\${escapeHtml(t.id)}')" style="cursor:pointer"><div><div class="task-name">\${escapeHtml(t.title||'Task')}</div><div class="task-meta">\${escapeHtml(t.executor||'')} · \${escapeHtml(t.id?.slice(0,8)||'')}</div></div><span class="badge \${escapeHtml(t.status)}">\${statusLabel}</span></div>\`}).join('')}
    function renderKanban(tasks){const cols={backlog:[],in_progress:[],review:[],completed:[]};(tasks||[]).forEach(t=>{const s=t.status==='pending'?'backlog':t.status;if(cols[s])cols[s].push(t)});
    ['backlog','in_progress','review','completed'].forEach((col,i)=>{const cards=cols[col]||[];const container=document.getElementById(['backlogCards','inProgressCards','reviewCards','doneCards'][i]);const countEl=document.getElementById(['backlogCount','inProgressCount','reviewCount','doneCount'][i]);countEl.textContent=cards.length;if(!cards.length){container.innerHTML='<div class="kanban-empty">No tasks</div>';return}
    container.innerHTML=cards.map(t=>{const execIcon={claude:'🤖','claude-code':'🤖',codex:'⚡',glm:'🧠',subagent:'👥',gemini:'💎'}[t.executor]||'📝';const prioClass=t.priority||'medium';return \`<div class="kanban-card" onclick="openTaskDetail('\${escapeHtml(t.id)}')" draggable="true" data-task-id="\${escapeHtml(t.id)}"><div class="kanban-card-title">\${escapeHtml(t.title)}</div><div class="kanban-card-meta"><span class="kanban-card-executor">\${execIcon} \${escapeHtml(t.executor||'')}</span><span class="badge \${prioClass}" style="padding:1px 4px;font-size:0.55rem">\${escapeHtml(t.priority||'med')}</span></div></div>\`}).join('')})}
    async function openTaskDetail(taskId){const opts={credentials:'include',headers:token?{Authorization:'Bearer '+token}:{}};try{const r=await fetch('/api/cockpit/tasks/'+taskId,opts);if(!r.ok)return;const d=await r.json();const t=d.task;const statusOpts=['backlog','in_progress','review','completed'].map(s=>\`<option value="\${s}" \${t.status===s?'selected':''}>\${{backlog:'📋 Backlog',in_progress:'🔄 In Progress',review:'👀 Review',completed:'✅ Done'}[s]}</option>\`).join('');const prioOpts=['low','medium','high','urgent'].map(p=>\`<option value="\${p}" \${t.priority===p?'selected':''}>\${{low:'Low',medium:'Medium',high:'High',urgent:'Urgent'}[p]}</option>\`).join('');
    document.getElementById('sheetBody').innerHTML=\`<span class="sheet-tag">\${escapeHtml(t.executor||'Unassigned')}</span><h2 class="sheet-title">\${escapeHtml(t.title)}</h2><p class="sheet-desc">\${escapeHtml(t.description)||'No description'}</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px"><label style="font-size:0.7rem;color:var(--text-low)">Status<select id="taskStatus" style="width:100%;margin-top:4px;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text-high);font-size:0.8rem">\${statusOpts}</select></label><label style="font-size:0.7rem;color:var(--text-low)">Priority<select id="taskPriority" style="width:100%;margin-top:4px;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text-high);font-size:0.8rem">\${prioOpts}</select></label></div>\`;
    document.getElementById('sheetActions').innerHTML=\`<button class="sheet-btn danger" onclick="deleteTask('\${escapeHtml(t.id)}')">Delete</button><button class="sheet-btn primary" onclick="updateTask('\${escapeHtml(t.id)}')">Save</button>\`;
    document.getElementById('sheet').classList.add('open')}catch(e){console.error(e)}}
    async function updateTask(taskId){const status=document.getElementById('taskStatus').value;const priority=document.getElementById('taskPriority').value;const opts={method:'PUT',credentials:'include',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({status,priority})};try{await fetch('/api/cockpit/tasks/'+taskId,opts);closeSheet();fetchData()}catch(e){console.error(e)}}
    async function deleteTask(taskId){if(!confirm('Delete this task?'))return;const opts={method:'DELETE',credentials:'include',headers:token?{Authorization:'Bearer '+token}:{}};try{await fetch('/api/cockpit/tasks/'+taskId,opts);closeSheet();fetchData()}catch(e){console.error(e)}}
    function openNewTaskSheet(){document.getElementById('sheetBody').innerHTML=\`<h2 class="sheet-title">New Task</h2><div style="display:flex;flex-direction:column;gap:12px"><label style="font-size:0.7rem;color:var(--text-low)">Title<input id="newTaskTitle" type="text" placeholder="Task title..." style="width:100%;margin-top:4px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text-high);font-size:0.875rem"></label><label style="font-size:0.7rem;color:var(--text-low)">Description<textarea id="newTaskDesc" placeholder="Optional description..." style="width:100%;margin-top:4px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text-high);font-size:0.8rem;min-height:60px;resize:vertical"></textarea></label><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><label style="font-size:0.7rem;color:var(--text-low)">Executor<select id="newTaskExecutor" style="width:100%;margin-top:4px;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text-high);font-size:0.8rem"><option value="">Unassigned</option><option value="claude-code">🤖 Claude Code</option><option value="codex">⚡ Codex</option><option value="glm">🧠 GLM</option><option value="subagent">👥 Subagent</option><option value="gemini">💎 Gemini</option></select></label><label style="font-size:0.7rem;color:var(--text-low)">Priority<select id="newTaskPriority" style="width:100%;margin-top:4px;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text-high);font-size:0.8rem"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></label></div></div>\`;
    document.getElementById('sheetActions').innerHTML=\`<button class="sheet-btn secondary" onclick="closeSheet()">Cancel</button><button class="sheet-btn primary" onclick="createTask()">Create</button>\`;document.getElementById('sheet').classList.add('open');setTimeout(()=>document.getElementById('newTaskTitle').focus(),100)}
    async function createTask(){const title=document.getElementById('newTaskTitle').value.trim();if(!title){alert('Title is required');return}const body={title,description:document.getElementById('newTaskDesc').value.trim()||undefined,executor:document.getElementById('newTaskExecutor').value||undefined,priority:document.getElementById('newTaskPriority').value,status:'backlog'};const opts={method:'POST',credentials:'include',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)};try{await fetch('/api/cockpit/tasks',opts);closeSheet();fetchData()}catch(e){console.error(e)}}

    function renderDaemons(daemons){const c=document.getElementById('daemons');if(!daemons||!daemons.length){c.innerHTML='<div class="no-data">No daemons</div>';return}c.innerHTML=daemons.map(d=>{const online=d.status==='healthy'||d.is_healthy;const ago=d.last_heartbeat?formatAgo(d.last_heartbeat):'Unknown';return \`<div class="daemon-item"><div style="display:flex;align-items:center"><div class="daemon-dot \${online?'online':'offline'}"></div><div><div class="daemon-name">\${escapeHtml(d.daemon_id||d.daemonId||'Local Agent')}</div><div class="daemon-time">Last: \${ago}</div></div></div></div>\`}).join('')}

    function formatAgo(ts){const s=Math.floor((Date.now()/1000)-(typeof ts==='number'?ts:new Date(ts).getTime()/1000));if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h'}
    function toggleDarkMode(){document.body.style.filter=document.body.style.filter?'':'invert(0.9) hue-rotate(180deg)'}

    // Phase 3: Swipe gesture support (vanilla JS, no Hammer.js)
    const SWIPE_THRESHOLD=80,SWIPE_VELOCITY=0.3;
    function initSwipeGestures(){document.querySelectorAll('.insight-item').forEach((el,idx)=>{let startX=0,startY=0,currentX=0,isDragging=false,startTime=0;
    el.addEventListener('touchstart',e=>{if(e.touches.length!==1)return;startX=e.touches[0].clientX;startY=e.touches[0].clientY;currentX=startX;isDragging=true;startTime=Date.now();el.style.transition='none'},{passive:true});
    el.addEventListener('touchmove',e=>{if(!isDragging)return;const dx=e.touches[0].clientX-startX,dy=e.touches[0].clientY-startY;if(Math.abs(dy)>Math.abs(dx)*1.5){isDragging=false;resetSwipe(el);return}currentX=e.touches[0].clientX;const clampedDx=Math.max(-100,Math.min(100,dx));el.style.transform=\`translateX(\${clampedDx}px)\`;el.classList.toggle('swiping-right',dx>30);el.classList.toggle('swiping-left',dx<-30)},{passive:true});
    el.addEventListener('touchend',e=>{if(!isDragging){resetSwipe(el);return}const dx=currentX-startX,dt=(Date.now()-startTime)/1000,v=Math.abs(dx)/dt/1000;if(Math.abs(dx)>SWIPE_THRESHOLD||v>SWIPE_VELOCITY){if(dx>0){selectedIdx=idx;handleAction('accepted')}else{selectedIdx=idx;handleAction('dismissed')}}resetSwipe(el);isDragging=false},{passive:true});
    el.addEventListener('touchcancel',()=>{resetSwipe(el);isDragging=false},{passive:true})})}
    function resetSwipe(el){el.style.transition='transform 0.2s';el.style.transform='';el.classList.remove('swiping-right','swiping-left')}

    // Phase 3: Coach marks for first-time users
    function showCoachMark(){if(localStorage.getItem('fugue_coach_seen'))return;if(!insights.length)return;const cm=document.createElement('div');cm.id='coachMark';cm.innerHTML=\`<div style="position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.7);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:300px">
        <div style="font-size:2rem;margin-bottom:12px">👆</div>
        <h3 style="font-size:1rem;margin-bottom:8px">Swipe Gestures</h3>
        <p style="font-size:0.875rem;color:var(--text-low);margin-bottom:16px;line-height:1.5">Swipe right to <span style="color:var(--accept)">Accept</span>, left to <span style="color:var(--danger)">Dismiss</span>. Or use keyboard: <span class="kbd">J</span>/<span class="kbd">K</span> to navigate, <span class="kbd">Enter</span> for details.</p>
        <button onclick="dismissCoachMark()" style="background:var(--primary);color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:0.875rem;cursor:pointer">Got it</button>
      </div></div>\`;document.body.appendChild(cm)}
    function dismissCoachMark(){localStorage.setItem('fugue_coach_seen','1');const cm=document.getElementById('coachMark');if(cm)cm.remove()}

    async function fetchData(){try{const opts={credentials:'include',headers:token?{Authorization:'Bearer '+token}:{}};const[rr,tr,dr,ir]=await Promise.all([fetch('/api/cockpit/repos',opts),fetch('/api/cockpit/tasks',opts),fetch('/api/daemon/health',opts),fetch('/api/advisor/insights?limit=5',opts)]);if(rr.ok){const d=await rr.json();renderRepos(d.repos||d.data||d)}if(tr.ok){const d=await tr.json();renderTasks(d.tasks||d.data||[])}if(dr.ok){const d=await dr.json();renderDaemons(d.daemons||d.data||[])}if(ir.ok){const d=await ir.json();renderInsights(d.data||[]);showCoachMark()}document.getElementById('updated').textContent='Updated: '+new Date().toLocaleTimeString('ja-JP')}catch(e){console.error(e)}}
    function refresh(){fetchData()}

    // PWA Push Notifications initialization
    async function initPushNotifications(){if(!('serviceWorker' in navigator)||!('PushManager' in window)){console.log('[Push] Not supported');return}try{const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});console.log('[Push] SW registered:',reg.scope);await navigator.serviceWorker.ready;const permission=Notification.permission;const btn=document.getElementById('pushNotifBtn');if(permission==='granted'){await subscribeToPush(reg)}else if(permission==='default'){if(btn)btn.style.display='inline-block'}else{console.log('[Push] Permission denied')}}catch(e){console.error('[Push] Init failed:',e)}}

    async function subscribeToPush(reg){try{let sub=await reg.pushManager.getSubscription();if(!sub){const keyRes=await fetch('/api/cockpit/vapid-public-key');if(!keyRes.ok){console.error('[Push] Failed to get VAPID key');return}const{publicKey}=await keyRes.json();const appServerKey=urlBase64ToUint8Array(publicKey);sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:appServerKey});console.log('[Push] New subscription created')}const subData={endpoint:sub.endpoint,keys:{p256dh:sub.toJSON().keys.p256dh,auth:sub.toJSON().keys.auth}};const saveRes=await fetch('/api/cockpit/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(subData)});if(saveRes.ok){console.log('[Push] Subscription saved')}else{console.error('[Push] Failed to save subscription')}}catch(e){console.error('[Push] Subscribe failed:',e)}}

    function urlBase64ToUint8Array(base64){const padding='='.repeat((4-(base64.length%4))%4);const b64=(base64+padding).replace(/-/g,'+').replace(/_/g,'/');const raw=window.atob(b64);const arr=new Uint8Array(raw.length);for(let i=0;i<raw.length;++i){arr[i]=raw.charCodeAt(i)}return arr}

    async function requestPushPermission(){if(!('Notification' in window)){alert('Notifications not supported');return}const permission=await Notification.requestPermission();const btn=document.getElementById('pushNotifBtn');if(permission==='granted'){const reg=await navigator.serviceWorker.ready;await subscribeToPush(reg);if(btn)btn.style.display='none';alert('Push notifications enabled!')}else{alert('Permission denied')}}

    connectWS();fetchData();setInterval(fetchData,30000);initPushNotifications();
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
		  const url = new URL(request.url);
		  const workerOrigin = url.origin;
		  const path = url.pathname;
	
		  const deployTarget = getDeployTarget(env);
		  const canaryWriteEnabled = isCanaryWriteEnabled(env);
		  const blocked = maybeBlockCanaryWrite(request, env);
		  if (blocked) return blocked;

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
    if (env.DB) {
      commHub.setDB(env.DB);
    }

    // Initialize service role KV mappings (idempotent, runs once per isolate)
    if (!serviceRoleMappingsInitialized) {
	    // If canary is in read-only mode, skip any initialization that could write to D1/KV.
	    if (!(deployTarget === 'canary' && !canaryWriteEnabled)) {
	      try {
	        await ensureServiceRoleMappings(env);
	      } catch (e) {
	        safeLog.error('[Init] Service role mapping failed', { error: String(e) });
	      }
	    }
      serviceRoleMappingsInitialized = true;
	    }

    // Health check endpoint
    if (path === '/health') {
      return handleHealthCheck(request, env);
    }

    // Root redirect to Cockpit PWA
    if (path === '/') {
      return Response.redirect(`${url.origin}/cockpit`, 302);
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

    // Service Worker (for PWA Push Notifications)
    if (path === '/sw.js') {
      // Inline Service Worker code (Cloudflare Workers compatible)
      const swCode = `
// Service Worker for PWA Push Notifications (Phase 2)
const SW_VERSION = '1.0.0';
const CACHE_NAME = 'cockpit-pwa-' + SW_VERSION;

self.addEventListener('install', (event) => {
  console.log('[SW ' + SW_VERSION + '] Installing...');
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log('[SW ' + SW_VERSION + '] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  console.log('[SW] Push received');
  let notificationData = {
    title: 'Cockpit Alert',
    body: 'New notification',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: 'cockpit-alert',
    requireInteraction: false,
  };

  if (event.data) {
    try {
      const text = event.data.text();
      if (!text || text.trim().length === 0) {
        console.warn('[SW] Push data is empty, using default notification');
      } else {
        const payload = JSON.parse(text);
        console.log('[SW] Push payload:', payload);
        notificationData = {
          title: payload.title || notificationData.title,
          body: payload.message || payload.body || notificationData.body,
          icon: payload.icon || notificationData.icon,
          badge: payload.badge || notificationData.badge,
          tag: payload.id || payload.tag || notificationData.tag,
          data: {
            id: payload.id,
            severity: payload.severity,
            source: payload.source,
            actionUrl: payload.actionUrl,
            timestamp: payload.createdAt || Date.now(),
          },
          requireInteraction: payload.severity === 'critical' || payload.severity === 'error',
        };
        if (payload.actionUrl) {
          notificationData.actions = [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' },
          ];
        }
      }
    } catch (error) {
      console.error('[SW] Failed to parse push payload:', error);
      console.log('[SW] Using default notification data');
    }
  }

  event.waitUntil(
    self.registration.showNotification(notificationData.title, notificationData)
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.tag);
  event.notification.close();

  const notificationData = event.notification.data || {};
  const actionUrl = notificationData.actionUrl;

  if (event.action === 'dismiss') {
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/cockpit') && 'focus' in client) {
          return client.focus().then((focusedClient) => {
            if (actionUrl && focusedClient.navigate) {
              return focusedClient.navigate(actionUrl);
            }
            return focusedClient;
          });
        }
      }
      if (clients.openWindow) {
        const targetUrl = actionUrl || '/cockpit';
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: SW_VERSION });
  }
});

console.log('[SW ' + SW_VERSION + '] Service Worker loaded');
      `.trim();

      return new Response(swCode, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Service-Worker-Allowed': '/',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }

    // Queue API endpoints (for AI Assistant Daemon)
    if (path.startsWith('/api/queue') || path.startsWith('/api/result')) {
      try {
        return await handleQueueAPI(request, env, path);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : undefined;
        const apiKey = request.headers.get('X-API-Key') || request.headers.get('x-api-key') || 'missing';
        safeLog.error('[Queue] Unhandled error:', {
          message: msg,
          stack,
          path,
          method: request.method,
          hasXApiKey: request.headers.has('X-API-Key'),
          hasLowercaseApiKey: request.headers.has('x-api-key'),
          apiKeyPrefix: apiKey !== 'missing' ? apiKey.substring(0, 8) : 'missing',
        });
        return new Response(JSON.stringify({ error: 'Internal error' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Memory API endpoints (for persistent conversation history)
    if (path.startsWith('/api/memory')) {
      return handleMemoryAPI(request, env, path);
    }

      // freee OAuth (manual start): redirects to freee authorize page.
      if (path === '/api/freee/auth') {
        if (!isFreeeIntegrationEnabled(env)) {
          return new Response('Not Found', { status: 404 });
        }

        if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !env.FREEE_ENCRYPTION_KEY) {
          safeLog.error('[freee OAuth] Missing required env vars (auth start)', {
            hasClientId: !!env.FREEE_CLIENT_ID,
            hasClientSecret: !!env.FREEE_CLIENT_SECRET,
            hasEncryptionKey: !!env.FREEE_ENCRYPTION_KEY,
          });
          return new Response('Server not configured', { status: 500 });
        }

        const origin = new URL(request.url).origin;
        const redirectUri = env.FREEE_REDIRECT_URI || `${origin}/api/freee/callback`;
        const state = crypto.randomUUID();

        const authUrl = new URL('https://accounts.secure.freee.co.jp/public_api/authorize');
        authUrl.search = new URLSearchParams({
          response_type: 'code',
          client_id: env.FREEE_CLIENT_ID,
          redirect_uri: redirectUri,
          // freee requires explicit scopes for API access. Keep it broad enough for receipts + deal automation.
          scope: 'read write',
          state,
        }).toString();

        const headers = new Headers({ Location: authUrl.toString() });
        headers.set(
          'Set-Cookie',
          `freee_oauth_state=${encodeURIComponent(state)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
        );
        return new Response(null, { status: 302, headers });
      }

	    // freee OAuth Callback endpoint
	    if (path === '/api/freee/callback') {
        if (!isFreeeIntegrationEnabled(env)) {
          return new Response('Not Found', { status: 404 });
        }

	      const code = url.searchParams.get('code');
	      if (!code) {
	        return new Response('Missing authorization code', { status: 400 });
	      }

        // If the flow started via /api/freee/auth, validate state cookie (best-effort).
        const state = url.searchParams.get('state');
        const cookieState = parseCookies(request.headers.get('Cookie')).freee_oauth_state;
        if (cookieState && state && cookieState !== state) {
          safeLog.error('[freee OAuth] State mismatch', {
            cookieStatePrefix: cookieState.substring(0, 8),
            statePrefix: state.substring(0, 8),
          });
          return new Response('Invalid OAuth state', { status: 400 });
        }

	      if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !env.FREEE_ENCRYPTION_KEY) {
	        safeLog.error('[freee OAuth] Missing required env vars', {
	          hasClientId: !!env.FREEE_CLIENT_ID,
	          hasClientSecret: !!env.FREEE_CLIENT_SECRET,
	          hasEncryptionKey: !!env.FREEE_ENCRYPTION_KEY,
	        });
	        return new Response('Server not configured', { status: 500 });
	      }
	      if (!env.DB && !env.KV) {
	        safeLog.error('[freee OAuth] Neither DB nor KV configured');
	        return new Response('Server not configured', { status: 500 });
	      }
	 
	      try {
	        // Prefer configured redirect URI (stable across script/env hostnames).
	        // Fallback to same-origin callback for development/staging.
	        const redirectUri = env.FREEE_REDIRECT_URI || `${new URL(request.url).origin}/api/freee/callback`;

	        // Primary: send client_id/client_secret in the form body (common OAuth pattern).
	        // Fallback: some OAuth servers require client authentication via HTTP Basic and
	        // may reject (or mis-handle) duplicated credentials in both header + body.
	        const paramsWithClientSecret = new URLSearchParams({
	          grant_type: 'authorization_code',
	          client_id: env.FREEE_CLIENT_ID,
	          client_secret: env.FREEE_CLIENT_SECRET,
	          code: code,
	          redirect_uri: redirectUri,
	        });

        safeLog.log('[freee OAuth] Exchanging code', {
          redirectUri,
          codePrefix: code.substring(0, 10),
          clientIdPrefix: env.FREEE_CLIENT_ID?.substring(0, 6),
        });

        const tokenUrl = 'https://accounts.secure.freee.co.jp/public_api/token';
        const basicAuth = btoa(`${env.FREEE_CLIENT_ID}:${env.FREEE_CLIENT_SECRET}`);

        // Exchange code for tokens. Some OAuth servers require client auth via Basic;
        // we try without and then retry with Basic to reduce misconfiguration/debug time.
        const tryExchange = async (useBasic: boolean): Promise<Response> => {
          const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
          if (useBasic) headers.Authorization = `Basic ${basicAuth}`;
          const body = useBasic
            ? new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
              })
            : paramsWithClientSecret;
          return fetch(tokenUrl, { method: 'POST', headers, body });
        };

        let tokenResponse = await tryExchange(false);
        let fallback: { attempted: boolean; status?: number; body?: string } = { attempted: false };

        if (!tokenResponse.ok) {
          const primaryError = await tokenResponse.text();
          safeLog.error('[freee OAuth] Token exchange failed (primary)', {
            status: tokenResponse.status,
            error: primaryError,
            redirectUri,
            envRedirectUri: env.FREEE_REDIRECT_URI,
          });

          fallback.attempted = true;
          const tokenResponse2 = await tryExchange(true);
          if (tokenResponse2.ok) {
            tokenResponse = tokenResponse2;
          } else {
            const fallbackError = await tokenResponse2.text();
            fallback.status = tokenResponse2.status;
            fallback.body = fallbackError;
            safeLog.error('[freee OAuth] Token exchange failed (basic auth fallback)', {
              status: tokenResponse2.status,
              error: fallbackError,
              redirectUri,
              envRedirectUri: env.FREEE_REDIRECT_URI,
            });

            // Include non-secret diagnostics to reduce guesswork when debugging invalid_grant.
            const hint =
              primaryError.includes('invalid_grant') || fallbackError.includes('invalid_grant')
                ? 'Hint: authorization codes are short-lived and one-time-use. Restart from /api/freee/auth (do not refresh /callback). Also verify FREEE_CLIENT_SECRET and that FREEE_REDIRECT_URI exactly matches the redirect URI registered in freee.'
                : 'Hint: verify freee app settings and Worker secrets.';

            return new Response(
              [
                `Token exchange failed (primary): ${primaryError}`,
                `Token exchange failed (basic auth): ${fallbackError}`,
                '',
                `redirect_uri_used: ${redirectUri}`,
                `env.FREEE_REDIRECT_URI: ${env.FREEE_REDIRECT_URI || '(unset)'}`,
                hint,
              ].join('\n'),
              { status: 400 }
            );
          }
        }

        const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; expires_in: number };

        // Optionally resolve company_id from freee API so the Worker can operate without
        // requiring FREEE_COMPANY_ID as a secret (we persist this to D1 when possible).
        let companyId: string | null = null;
        try {
          const companiesRes = await fetch('https://api.freee.co.jp/api/1/companies', {
            method: 'GET',
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          if (companiesRes.ok) {
            const companiesPayload = await companiesRes.json() as { companies?: Array<{ id: number }> };
            const companies = Array.isArray(companiesPayload.companies) ? companiesPayload.companies : [];
            if (companies.length > 0) {
              companyId = String(companies[0].id);
              if (companies.length > 1) {
                safeLog.warn('[freee OAuth] Multiple companies returned; defaulting to first', { count: companies.length });
              }
            }
          } else {
            safeLog.warn('[freee OAuth] Failed to fetch companies (continuing)', { status: companiesRes.status });
          }
        } catch (e) {
          safeLog.warn('[freee OAuth] Error fetching companies (continuing)', { error: String(e) });
        }

	        // Encrypt refresh token with AES-GCM
	        const encoder = new TextEncoder();
	        const keyData = encoder.encode(env.FREEE_ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
	        const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']);
	        const iv = crypto.getRandomValues(new Uint8Array(12));
	        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoder.encode(tokens.refresh_token));
	        const combined = new Uint8Array(iv.length + encrypted.byteLength);
	        combined.set(iv, 0);
	        combined.set(new Uint8Array(encrypted), iv.length);
	        const encryptedRefreshToken = btoa(String.fromCharCode(...combined));

	        // Store tokens in D1 (preferred). Fallback to KV if migrations are not applied yet.
          const expiresAtMs = Date.now() + (tokens.expires_in - 60) * 1000;
          if (env.DB) {
            try {
              await env.DB.prepare(
                `INSERT INTO external_oauth_tokens (provider, encrypted_refresh_token, access_token, access_token_expires_at_ms, updated_at, company_id)
                 VALUES ('freee', ?, ?, ?, strftime('%s','now'), ?)
                 ON CONFLICT(provider) DO UPDATE SET
                   encrypted_refresh_token=excluded.encrypted_refresh_token,
                   access_token=excluded.access_token,
                   access_token_expires_at_ms=excluded.access_token_expires_at_ms,
                   company_id=COALESCE(external_oauth_tokens.company_id, excluded.company_id),
                   updated_at=strftime('%s','now')`
              ).bind(encryptedRefreshToken, tokens.access_token, expiresAtMs, companyId).run();
            } catch (error) {
              safeLog.error('[freee OAuth] Failed to persist tokens to D1 (falling back to KV)', { error: String(error) });
              // kv-optimizer:ignore-next
              await env.KV?.put('freee:refresh_token', encryptedRefreshToken);
              // kv-optimizer:ignore-next
              await env.KV?.put('freee:access_token', tokens.access_token, { expirationTtl: tokens.expires_in - 60 });
              // kv-optimizer:ignore-next
              await env.KV?.put('freee:access_token_expiry', expiresAtMs.toString(), { expirationTtl: tokens.expires_in - 60 });
            }
          } else {
            // kv-optimizer:ignore-next
            await env.KV?.put('freee:refresh_token', encryptedRefreshToken);
            // kv-optimizer:ignore-next
            await env.KV?.put('freee:access_token', tokens.access_token, { expirationTtl: tokens.expires_in - 60 });
            // kv-optimizer:ignore-next
            await env.KV?.put('freee:access_token_expiry', expiresAtMs.toString(), { expirationTtl: tokens.expires_in - 60 });
          }

        safeLog.log('[freee OAuth] Tokens stored successfully');

        return new Response(`
          <!DOCTYPE html>
          <html><head><title>freee OAuth Success</title></head>
          <body style="font-family:system-ui;text-align:center;padding:40px">
            <h1>✅ freee認証成功</h1>
            <p>アクセストークンとリフレッシュトークンが保存されました。</p>
            <p>このウィンドウを閉じて大丈夫です。</p>
          </body></html>
        `, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            // Clear state cookie after success (best-effort).
            'Set-Cookie': 'freee_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
          },
        });
      } catch (error) {
        safeLog.error('[freee OAuth] Error', { error: String(error) });
        return new Response(`OAuth error: ${error}`, { status: 500 });
      }
    }

    // Manual Gmail polling trigger (admin only)
    if (path === '/api/receipts/poll' && request.method === 'POST') {
      const { verifyAPIKey } = await import('./utils/api-auth');
      if (!verifyAPIKey(request, env, 'admin')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const { handleGmailReceiptPolling } = await import('./handlers/receipt-gmail-poller');
      try {
        await handleGmailReceiptPolling(env);
        return new Response(JSON.stringify({ success: true, message: 'Gmail polling completed' }), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Retry failed receipts - fetch from R2 and upload to freee (admin only)
    if (path === '/api/receipts/retry' && request.method === 'POST') {
      const { verifyAPIKey } = await import('./utils/api-auth');
      if (!verifyAPIKey(request, env, 'admin')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const { createFreeeClient } = await import('./services/freee-client');
      const bucket = env.RECEIPTS || env.R2;
      if (!bucket) {
        return new Response(JSON.stringify({ error: 'R2 bucket not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      const freeeClient = createFreeeClient(env);
      const failed = await env.DB!.prepare(
        `SELECT id, r2_object_key, file_hash FROM receipts WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50`
      ).all();
      const results: Array<{id: string, status: string, freeeId?: string, error?: string}> = [];
      for (const row of failed.results) {
        try {
          const obj = await bucket.get(row.r2_object_key as string);
          if (!obj) { results.push({ id: row.id as string, status: 'skipped', error: 'R2 object not found' }); continue; }
          const blob = await obj.blob();
          const fileName = (row.r2_object_key as string).split('/').pop() || 'receipt.pdf';
          const freeeResult = await freeeClient.uploadReceipt(blob, fileName, `retry:${row.file_hash}`);
          await env.DB!.prepare(
            `UPDATE receipts SET status = 'completed', freee_receipt_id = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
          ).bind(String(freeeResult.receipt?.id || ''), row.id).run();
          results.push({ id: row.id as string, status: 'completed', freeeId: String(freeeResult.receipt?.id || '') });
        } catch (error) {
          results.push({ id: row.id as string, status: 'failed', error: String(error) });
        }
      }
      return new Response(JSON.stringify({ success: true, retried: results.length, results }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Receipt Upload API endpoint (freee integration)
    if (path === '/api/receipts/upload' && request.method === 'POST') {
      return handleReceiptUpload(request, env);
    }

    // Receipt Search API endpoint (Electronic Bookkeeping Law compliant)
    if (path === '/api/receipts/search' && request.method === 'GET') {
      return handleReceiptSearch(request, env);
    }

    // Receipt Sources API (web receipt scraper orchestration)
    if (path.startsWith('/api/receipts/sources')) {
      return handleReceiptSourcesAPI(request, env, path);
    }

    // Dead Letter Queue API (Failed receipt processing management)
    if (path.startsWith('/api/receipts/dlq')) {
      return handleDLQAPI(request, env, path);
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

    // AI Usage API endpoints (for FUGUE agent usage monitoring)
    if (path.startsWith('/api/usage')) {
      return handleUsageAPI(request, env, path);
    }

    // Goal Planner API endpoints (FUGUE Evolution Phase 0.5)
    if (path.startsWith('/api/goals')) {
      return handleGoalPlannerAPI(request, env, path);
    }

    // Limitless API endpoints (for Pendant voice recording sync)
    if (path.startsWith('/api/limitless')) {
      // Webhook endpoint for iOS Shortcuts
      if (path === '/api/limitless/webhook-sync' && request.method === 'POST') {
        return handleLimitlessWebhook(request, env);
      }
      // Phase 1: Highlight trigger endpoint (iOS Shortcut timestamp mark)
      // Accept both GET and POST (iOS Shortcut compatibility)
      if (path === '/api/limitless/highlight-trigger' && (request.method === 'GET' || request.method === 'POST')) {
        const { handleHighlightTrigger } = await import('./handlers/limitless-highlight');
        return handleHighlightTrigger(request, env);
      }
      // Other Limitless API endpoints
      return handleLimitlessAPI(request, env, path);
    }

    // Strategic Advisor API endpoints (for FUGUE insights) - with CORS
	    if (path.startsWith('/api/advisor')) {
	      // CSRF protection: restrict CORS to same origin or trusted domains
	      const origin = request.headers.get('Origin') || '';
	      const allowedOrigins = [
	        workerOrigin,
	        'https://orchestrator-hub.masa-stage1.workers.dev',
	        'https://orchestrator-hub-production.masa-stage1.workers.dev',
	        'https://orchestrator-hub-canary.masa-stage1.workers.dev',
	        'https://cockpit-pwa.vercel.app',
	        'http://localhost:3000',
	        'http://localhost:8787',
	      ];
      const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
      const corsHeaders = {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true',
      };

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // CSRF protection: Reject cross-origin POST requests without valid origin
      if (request.method === 'POST' && origin && !allowedOrigins.includes(origin)) {
        safeLog.warn('[Advisor API] CSRF: rejected cross-origin POST', { origin });
        return new Response(JSON.stringify({ error: 'Forbidden: Invalid origin' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
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
	      // CSRF protection: restrict CORS to same origin or trusted domains
	      const origin = request.headers.get('Origin') || '';
	      const allowedOrigins = [
	        workerOrigin,
	        'https://orchestrator-hub.masa-stage1.workers.dev',
	        'https://orchestrator-hub-production.masa-stage1.workers.dev',
	        'https://orchestrator-hub-canary.masa-stage1.workers.dev',
	        'https://cockpit-pwa.vercel.app',
	        'https://fugue-system-ui.vercel.app',
	        'http://localhost:3000',
	        'http://localhost:8787',
      ];
      const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
      const corsHeaders = {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true',
      };

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // CSRF protection: Reject cross-origin POST requests without valid origin
      if (request.method === 'POST' && origin && !allowedOrigins.includes(origin)) {
        safeLog.warn('[Cockpit API] CSRF: rejected cross-origin POST', { origin });
        return new Response(JSON.stringify({ error: 'Forbidden: Invalid origin' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
      }

      const response = await handleCockpitAPI(request, env, path);

      // Add CORS headers to response
      const newResponse = new Response(response.body, response);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      return newResponse;
    }

    // Notification System API (SystemEvents DO) - for device-independent notifications
	    if (path.startsWith('/api/notifications')) {
      if (!env.SYSTEM_EVENTS) {
        return new Response(JSON.stringify({ error: 'Notification system not available' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }

	      // CORS support for PWA
	      const origin = request.headers.get('Origin') || '';
	      const allowedOrigins = [
	        workerOrigin,
	        'https://orchestrator-hub.masa-stage1.workers.dev',
	        'https://orchestrator-hub-production.masa-stage1.workers.dev',
	        'https://orchestrator-hub-canary.masa-stage1.workers.dev',
	        'https://cockpit-pwa.vercel.app',
	        'https://fugue-system-ui.vercel.app',
	        'http://localhost:3000',
	        'http://localhost:8787',
	      ];
      const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
      const corsHeaders = {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-API-Key',
        'Access-Control-Allow-Credentials': 'true',
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Authentication: Cloudflare Access or API Key
      const accessResult = await authenticateWithAccess(request, env);
      const apiKeyHeader = request.headers.get('X-API-Key');
      const tokenParam = url.searchParams.get('token');
      const isApiKeyAuth = env.QUEUE_API_KEY && (apiKeyHeader === env.QUEUE_API_KEY || tokenParam === env.QUEUE_API_KEY);

      if (!accessResult.verified && !isApiKeyAuth) {
        safeLog.log('[Notifications API] Auth failed', {
          accessVerified: accessResult.verified,
          hasApiKey: !!apiKeyHeader,
          hasToken: !!tokenParam,
        });
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: 'Cloudflare Access or API key required',
        }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const doId = env.SYSTEM_EVENTS.idFromName('notifications');
      const doStub = env.SYSTEM_EVENTS.get(doId);

      // Map API paths to DO endpoints
      const subPath = path.replace('/api/notifications', '') || '/state';
      const response = await doStub.fetch(new Request(`http://do${subPath}`, request));

      // Add CORS headers
      const newResponse = new Response(response.body, response);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      return newResponse;
    }

    // WebSocket upgrade for Notifications (SystemEvents DO)
    if (path === '/api/notifications/ws' && request.headers.get('Upgrade') === 'websocket') {
      if (!env.SYSTEM_EVENTS) {
        return new Response('Notification WebSocket not available', { status: 503 });
      }

      // Authentication: Cloudflare Access or API Key (via query param for WebSocket)
      const accessResult = await authenticateWithAccess(request, env);
      const tokenParam = url.searchParams.get('token');
      const isApiKeyAuth = env.QUEUE_API_KEY && tokenParam === env.QUEUE_API_KEY;

      if (!accessResult.verified && !isApiKeyAuth) {
        safeLog.log('[Notifications WS] Auth failed', {
          accessVerified: accessResult.verified,
          hasToken: !!tokenParam,
        });
        return new Response('Unauthorized: Cloudflare Access or API key required', { status: 401 });
      }

      const deviceId = url.searchParams.get('deviceId') || `device-${Date.now()}`;
      const doId = env.SYSTEM_EVENTS.idFromName('notifications');
      const doStub = env.SYSTEM_EVENTS.get(doId);

      return doStub.fetch(new Request(`http://do/ws?deviceId=${deviceId}`, request));
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

      // Check for token-based auth as fallback (for PWA)
      const tokenParam = url.searchParams.get('token');
      const apiKeyHeader = request.headers.get('X-API-Key');
      let isTokenAuth = false;

      // Support both query param and X-API-Key header
      if (env.QUEUE_API_KEY && (tokenParam === env.QUEUE_API_KEY || apiKeyHeader === env.QUEUE_API_KEY)) {
        isTokenAuth = true;
        authHeaders = {
          'X-Access-User-Id': apiKeyHeader ? 'local-agent' : 'system',
          'X-Access-User-Role': 'operator',
        };
        safeLog.log('[WebSocket] API key auth passed', {
          method: apiKeyHeader ? 'header' : 'query',
        });
      }

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

      // SECURITY: Require authentication for WebSocket connections
      if (!accessResult.verified && !isTokenAuth) {
        safeLog.warn('[WebSocket] Unauthorized connection attempt blocked');
        return new Response('Unauthorized: Authentication required for WebSocket', { status: 401 });
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

  // Queue consumer (requires paid plan - Cloudflare Queues)
  // async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
  //   return handlePushQueueBatch(batch, env);
  // },
};
