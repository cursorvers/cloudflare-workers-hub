#!/usr/bin/env node
/**
 * freee-mcp helper: compare "correct" vs "incorrect" examples and surface fields
 * that differ most.
 *
 * Inputs:
 * - correct.json: array (or object containing an array)
 * - incorrect.json: array (or object containing an array)
 *
 * Output:
 * - JSON report listing candidate fields to inspect (account/tax/partner/memo etc).
 *
 * This script is intentionally heuristic and read-only: it helps produce a rule hypothesis.
 */

import fs from 'node:fs';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/analyze-misclassification.mjs <correct.json> <incorrect.json> [options]

Options:
  --array <field>       Force array field name if inputs are objects (applies to both files).
  --fields <a,b,c>      Comma-separated list of fields to analyze (default: common fields + all top-level scalar keys).
  --id-field <field>    ID field name (default: auto).
  --out <file>          Write full report JSON to a file (default: stdout).
  --help                Show help.

Examples:
  node scripts/freee-mcp/analyze-misclassification.mjs correct.json incorrect.json
  node scripts/freee-mcp/analyze-misclassification.mjs correct.json incorrect.json --fields account_item_id,tax_code,partner_id
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { correct: null, incorrect: null, array: null, fields: null, idField: null, out: null };
  const rest = [...argv];
  const c = rest.shift();
  const i = rest.shift();
  if (!c || !i || c === '--help' || i === '--help') usage(0);
  args.correct = c;
  args.incorrect = i;

  while (rest.length) {
    const t = rest.shift();
    if (t === '--help' || t === '-h') usage(0);
    if (t === '--array') args.array = rest.shift() ?? usage(2);
    else if (t === '--fields') args.fields = rest.shift() ?? usage(2);
    else if (t === '--id-field') args.idField = rest.shift() ?? usage(2);
    else if (t === '--out') args.out = rest.shift() ?? usage(2);
    else usage(2);
  }
  return args;
}

function tryGetArray(obj, forcedField) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;
  if (forcedField) return Array.isArray(obj[forcedField]) ? obj[forcedField] : null;

  for (const [, v] of Object.entries(obj)) {
    if (Array.isArray(v)) return v;
  }
  for (const k of ['data', 'result', 'results']) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      for (const [, vv] of Object.entries(v)) {
        if (Array.isArray(vv)) return vv;
      }
    }
  }
  return null;
}

function pickId(item, forcedField) {
  if (forcedField) return item?.[forcedField] != null ? String(item[forcedField]) : '';
  for (const k of ['id', 'deal_id', 'expense_application_id', 'expense_id']) {
    const v = item?.[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function scalarString(v) {
  if (v === undefined) return '_';
  if (v === null) return 'null';
  if (typeof v === 'string' && v.trim() === '') return '_';
  if (isScalar(v)) return String(v);
  return '_obj';
}

function addCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function distFor(items, field) {
  const m = new Map();
  for (const it of items) addCount(m, scalarString(it?.[field]));
  return m;
}

function topN(map, n = 5) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

function jensenShannonLike(p, q) {
  // Small, stable "distance" to sort fields; not a strict JS divergence implementation.
  // We compute overlap vs mismatch on top values only.
  const keys = new Set([...p.keys(), ...q.keys()]);
  let totalP = 0;
  let totalQ = 0;
  for (const v of p.values()) totalP += v;
  for (const v of q.values()) totalQ += v;
  let score = 0;
  for (const k of keys) {
    const pp = (p.get(k) ?? 0) / (totalP || 1);
    const qq = (q.get(k) ?? 0) / (totalQ || 1);
    score += Math.abs(pp - qq);
  }
  return score / 2;
}

const args = parseArgs(process.argv.slice(2));
const correctObj = JSON.parse(fs.readFileSync(args.correct, 'utf8'));
const incorrectObj = JSON.parse(fs.readFileSync(args.incorrect, 'utf8'));
const correctItems = tryGetArray(correctObj, args.array);
const incorrectItems = tryGetArray(incorrectObj, args.array);
if (!correctItems || !incorrectItems) {
  process.stderr.write('Could not find arrays in inputs. Try: --array <field>\n');
  process.exit(1);
}

// Field selection:
// 1) If user provided --fields, use that.
// 2) Else use a pragmatic default list + all scalar keys seen in samples.
const defaultFields = [
  'account_item_id',
  'tax_code',
  'tax_code_id',
  'tax_rate',
  'partner_id',
  'partner_name',
  'description',
  'memo',
  'remarks',
  'note',
  'item_id',
  'category',
  'status',
];

let fields = [];
if (args.fields) {
  fields = args.fields.split(',').map((s) => s.trim()).filter(Boolean);
} else {
  const seen = new Set(defaultFields);
  const sample = [...correctItems.slice(0, 20), ...incorrectItems.slice(0, 20)];
  for (const it of sample) {
    if (!it || typeof it !== 'object') continue;
    for (const [k, v] of Object.entries(it)) {
      if (isScalar(v)) seen.add(k);
    }
  }
  fields = [...seen];
}

const report = [];
for (const field of fields) {
  const p = distFor(correctItems, field);
  const q = distFor(incorrectItems, field);
  const dist = jensenShannonLike(p, q);
  report.push({
    field,
    distance: dist,
    correct_top: topN(p, 5),
    incorrect_top: topN(q, 5),
  });
}

report.sort((a, b) => b.distance - a.distance);

const result = {
  generated_at: new Date().toISOString(),
  correct_count: correctItems.length,
  incorrect_count: incorrectItems.length,
  id_sample: {
    correct: correctItems.slice(0, 5).map((x) => pickId(x, args.idField)).filter(Boolean),
    incorrect: incorrectItems.slice(0, 5).map((x) => pickId(x, args.idField)).filter(Boolean),
  },
  top_fields: report.slice(0, 15),
  notes: [
    'Use this report to form a deterministic rule hypothesis.',
    'Preferred fix is production code; one-off patches require Write Mode checklist.',
  ],
};

const outJson = JSON.stringify(result, null, 2);
if (args.out) {
  fs.writeFileSync(args.out, outJson);
  process.stderr.write(`Wrote report to: ${args.out}\n`);
} else {
  process.stdout.write(outJson + '\n');
}

