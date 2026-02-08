#!/usr/bin/env node
/**
 * KV Optimizer (static audit)
 *
 * Intent: Find KV usage patterns that tend to blow up quotas or create "control-plane" coupling.
 * This tool is deliberately dependency-free and read-only (except optional JSON output).
 *
 * Usage:
 *   node tools/kv-optimizer/kv-optimizer.mjs scan  --root <repoRoot> [--json report.json]
 *   node tools/kv-optimizer/kv-optimizer.mjs check --root <repoRoot> --baseline <baseline.json> [--json report.json]
 */

import fs from 'node:fs';
import path from 'node:path';

function usage(exitCode = 1) {
  console.log(
    [
      'kv-optimizer.mjs',
      '',
      'Commands:',
      '  scan --root <path> [--json <file>]',
      '  check --root <path> --baseline <file> [--json <file>]',
      '',
      'check thresholds (optional):',
      '  --allow-total-increase <n>',
      '  --allow-puts-increase <n>',
      '  --allow-puts-without-ttl-increase <n>',
      '  --allow-lists-increase <n>',
      '',
      'Examples:',
      '  node tools/kv-optimizer/kv-optimizer.mjs scan --root .',
      '  node tools/kv-optimizer/kv-optimizer.mjs scan --root . --json kv-report.json',
      '  node tools/kv-optimizer/kv-optimizer.mjs check --root . --baseline tools/kv-optimizer/baseline.json',
      '',
    ].join('\n')
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--allow-total-increase') args.allowTotalIncrease = Number(argv[++i]);
    else if (a === '--allow-puts-increase') args.allowPutsIncrease = Number(argv[++i]);
    else if (a === '--allow-puts-without-ttl-increase') args.allowPutsWithoutTTLIncrease = Number(argv[++i]);
    else if (a === '--allow-lists-increase') args.allowListsIncrease = Number(argv[++i]);
    else args._.push(a);
  }
  return args;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.wrangler' || e.name === 'dist' || e.name === 'coverage') {
      continue;
    }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && (p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.mjs'))) out.push(p);
  }
  return out;
}

function classifyBinding(line) {
  // Common patterns in this repo:
  // - env.CACHE.put/get
  // - env.KV.put/get
  // - env.USAGE_CACHE.put/get
  // - kv.put/get (local variable)
  //
  // Intentionally ignored:
  // - Cache API (Service Worker / Cloudflare Cache API) which uses `cache.put(request, response)`
  //   This is NOT Workers KV and should not be mixed into KV audits.
  if (/\benv\.CACHE!?\.?/.test(line)) return 'CACHE';
  if (/\benv\.USAGE_CACHE!?\.?/.test(line)) return 'USAGE_CACHE';
  if (/\benv\.KV!?\.?/.test(line)) return 'KV';
  if (/\bkv\.(put|get|delete|list)\(/.test(line)) return 'kv(var)';
  return 'unknown';
}

function extractLiteralKey(line) {
  // Best-effort: match .put('literal'...) / .get("literal"...)
  const m = line.match(/\.(?:put|get|delete)\(\s*(['"`])([^'"`]+)\1/);
  if (m) return m[2];
  return null;
}

function hasTTLNearby(lines, idx) {
  // Look at the current line and a few following lines to see if expirationTtl is present.
  for (let i = idx; i < Math.min(lines.length, idx + 6); i++) {
    if (/expirationTtl\s*:/.test(lines[i])) return true;
  }
  return false;
}

function keyPrefix(key) {
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(0, i) : key;
}

function scanFile(filePath, root) {
  // Ignore front-end service worker caches and build outputs (not KV).
  if (filePath.includes(`${path.sep}cockpit-pwa${path.sep}`)) return [];
  if (filePath.endsWith(`${path.sep}public${path.sep}sw.js`)) return [];
  if (filePath.endsWith(`${path.sep}out${path.sep}sw.js`)) return [];

  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split(/\r?\n/);
  const hits = [];
  const relFile = toPosix(path.relative(root, filePath));
  let ignoreNext = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('kv-optimizer:ignore-next')) {
      ignoreNext = true;
      continue;
    }
    if (line.includes('kv-optimizer:ignore')) continue;
    if (ignoreNext) {
      // Ignore exactly one subsequent non-empty, non-comment line.
      const t = line.trim();
      if (t === '' || t.startsWith('//')) continue;
      ignoreNext = false;
      continue;
    }
    if (!/\.(put|get|delete|list)\(/.test(line)) continue;
    if (!/(env\.(CACHE|KV|USAGE_CACHE)|\bkv\b)/.test(line)) continue;

    const op = (line.match(/\.(put|get|delete|list)\(/) || [])[1] || 'unknown';
    const binding = classifyBinding(line);
    const key = extractLiteralKey(line);
    const ttl = op === 'put' ? hasTTLNearby(lines, i) : null;

    hits.push({
      file: relFile,
      line: i + 1,
      op,
      binding,
      key,
      keyPrefix: key ? keyPrefix(key) : null,
      hasTTL: ttl,
      text: line.trim().slice(0, 240),
    });
  }

  return hits;
}

function summarize(hits) {
  const byBinding = new Map();
  const byOp = new Map();
  const byPrefix = new Map();

  let puts = 0;
  let gets = 0;
  let deletes = 0;
  let lists = 0;
  let putsWithTTL = 0;
  let putsWithoutTTL = 0;

  for (const h of hits) {
    byBinding.set(h.binding, (byBinding.get(h.binding) || 0) + 1);
    byOp.set(h.op, (byOp.get(h.op) || 0) + 1);
    if (h.keyPrefix) byPrefix.set(h.keyPrefix, (byPrefix.get(h.keyPrefix) || 0) + 1);

    if (h.op === 'put') {
      puts++;
      if (h.hasTTL) putsWithTTL++;
      else putsWithoutTTL++;
    } else if (h.op === 'get') {
      gets++;
    } else if (h.op === 'delete') {
      deletes++;
    } else if (h.op === 'list') {
      lists++;
    }
  }

  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  return {
    totalHits: hits.length,
    puts,
    gets,
    deletes,
    lists,
    putsWithTTL,
    putsWithoutTTL,
    byBinding: top(byBinding),
    byOp: top(byOp),
    byPrefix: top(byPrefix),
  };
}

function printReport(summary, hits) {
  console.log('KV Optimizer Report');
  console.log('');
  console.log(`Total calls: ${summary.totalHits}`);
  console.log(
    `puts: ${summary.puts} (with TTL: ${summary.putsWithTTL}, without TTL: ${summary.putsWithoutTTL}), gets: ${summary.gets}, deletes: ${summary.deletes}, lists: ${summary.lists}`
  );
  console.log('');

  console.log('Top bindings:');
  for (const [k, v] of summary.byBinding) console.log(`- ${k}: ${v}`);
  console.log('');

  console.log('Top ops:');
  for (const [k, v] of summary.byOp) console.log(`- ${k}: ${v}`);
  console.log('');

  console.log('Top key prefixes (literal only):');
  for (const [k, v] of summary.byPrefix) console.log(`- ${k}: ${v}`);
  console.log('');

  // Heuristics: highlight likely-hot or likely-risky callsites.
  const risky = hits.filter((h) => h.op === 'put' && h.hasTTL === false);
  const hotHints = hits.filter((h) => /rate-limiter|receipt-gmail-poller|queue/.test(h.file));

  console.log(`Risky puts (no TTL detected): ${risky.length}`);
  for (const h of risky.slice(0, 20)) {
    console.log(`- ${h.file}:${h.line} ${h.binding}.${h.op} key=${h.key || '(dynamic)'} :: ${h.text}`);
  }
  if (risky.length > 20) console.log(`- ... and ${risky.length - 20} more`);
  console.log('');

  console.log(`Hot-path hints (by filename heuristic): ${hotHints.length}`);
  for (const h of hotHints.slice(0, 20)) {
    console.log(`- ${h.file}:${h.line} ${h.binding}.${h.op} key=${h.key || '(dynamic)'} :: ${h.text}`);
  }
  if (hotHints.length > 20) console.log(`- ... and ${hotHints.length - 20} more`);
}

function loadBaseline(baselinePath) {
  const txt = fs.readFileSync(baselinePath, 'utf8');
  const json = JSON.parse(txt);
  if (!json || typeof json !== 'object') throw new Error('Invalid baseline JSON');
  if (!json.summary || typeof json.summary !== 'object') throw new Error('Invalid baseline JSON: missing summary');
  return json;
}

function num(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function checkAgainstBaseline(currentSummary, baselineSummary, args) {
  const allowTotal = num(args.allowTotalIncrease, 0);
  const allowPuts = num(args.allowPutsIncrease, 0);
  const allowPutsNoTtl = num(args.allowPutsWithoutTTLIncrease, 0);
  const allowLists = num(args.allowListsIncrease, 0);

  const bTotal = num(baselineSummary.totalHits, 0);
  const bPuts = num(baselineSummary.puts, 0);
  const bNoTtl = num(baselineSummary.putsWithoutTTL, 0);
  const bLists = num(baselineSummary.lists, 0);

  const deltaTotal = currentSummary.totalHits - bTotal;
  const deltaPuts = currentSummary.puts - bPuts;
  const deltaNoTtl = currentSummary.putsWithoutTTL - bNoTtl;
  const deltaLists = currentSummary.lists - bLists;

  const failures = [];
  if (deltaTotal > allowTotal) failures.push({ metric: 'totalHits', baseline: bTotal, current: currentSummary.totalHits, delta: deltaTotal, allow: allowTotal });
  if (deltaPuts > allowPuts) failures.push({ metric: 'puts', baseline: bPuts, current: currentSummary.puts, delta: deltaPuts, allow: allowPuts });
  if (deltaNoTtl > allowPutsNoTtl)
    failures.push({ metric: 'putsWithoutTTL', baseline: bNoTtl, current: currentSummary.putsWithoutTTL, delta: deltaNoTtl, allow: allowPutsNoTtl });
  if (deltaLists > allowLists) failures.push({ metric: 'lists', baseline: bLists, current: currentSummary.lists, delta: deltaLists, allow: allowLists });

  return { failures, deltas: { deltaTotal, deltaPuts, deltaNoTtl, deltaLists }, baseline: { bTotal, bPuts, bNoTtl, bLists } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) usage(1);
  if (cmd !== 'scan' && cmd !== 'check') usage(1);
  if (!args.root) usage(1);

  const root = path.resolve(args.root);
  const files = walk(root, []);

  let hits = [];
  for (const f of files) {
    // Keep scans reasonably scoped: ignore generated artifacts even if checked in.
    if (f.includes(`${path.sep}dist${path.sep}`)) continue;
    hits = hits.concat(scanFile(f, root));
  }

  const summary = summarize(hits);
  printReport(summary, hits);

  if (cmd === 'check') {
    if (!args.baseline) usage(1);
    const baselinePath = path.resolve(args.baseline);
    const baseline = loadBaseline(baselinePath);
    const baselineSummary = baseline.summary || {};

    const { failures } = checkAgainstBaseline(summary, baselineSummary, args);
    if (failures.length) {
      console.log('');
      console.log('Baseline check: FAILED');
      for (const f of failures) {
        console.log(`- ${f.metric}: baseline=${f.baseline}, current=${f.current}, delta=+${f.delta} (allowed +${f.allow})`);
      }
      process.exit(2);
    } else {
      console.log('');
      console.log('Baseline check: OK');
    }
  }

  if (args.json) {
    const report = { generatedAt: new Date().toISOString(), root, summary, hits };
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`Wrote JSON report: ${args.json}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
