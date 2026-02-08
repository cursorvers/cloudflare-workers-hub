#!/usr/bin/env node
/**
 * Extract stable record IDs from a JSON file.
 *
 * Supports:
 * - output of group-duplicates.mjs (duplicate_groups[].ids)
 * - arrays of objects containing id/deal_id/expense_application_id/expense_id
 */

import fs from 'node:fs';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/extract-ids.mjs <jsonFile> [--unique] [--limit <n>]

Examples:
  node scripts/freee-mcp/extract-ids.mjs 40_changes/duplicate_groups.json --unique
  node scripts/freee-mcp/extract-ids.mjs 30_results/candidates.json --limit 50
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { file: null, unique: false, limit: null };
  const rest = [...argv];
  const f = rest.shift();
  if (!f || f === '--help' || f === '-h') usage(0);
  args.file = f;
  while (rest.length) {
    const t = rest.shift();
    if (t === '--help' || t === '-h') usage(0);
    if (t === '--unique') args.unique = true;
    else if (t === '--limit') args.limit = Number(rest.shift() ?? usage(2));
    else usage(2);
  }
  return args;
}

function pickId(item) {
  for (const k of ['id', 'deal_id', 'expense_application_id', 'expense_id']) {
    const v = item?.[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

function tryExtractIds(obj) {
  const ids = [];

  if (Array.isArray(obj)) {
    for (const it of obj) {
      if (typeof it === 'string' || typeof it === 'number') ids.push(String(it));
      else if (it && typeof it === 'object') {
        const id = pickId(it);
        if (id) ids.push(id);
      }
    }
    return ids;
  }

  if (!obj || typeof obj !== 'object') return ids;

  // group-duplicates output
  if (Array.isArray(obj.duplicate_groups)) {
    for (const g of obj.duplicate_groups) {
      if (Array.isArray(g?.ids)) ids.push(...g.ids.map(String));
    }
    return ids;
  }

  // Find the first nested array and try that.
  for (const [, v] of Object.entries(obj)) {
    if (Array.isArray(v)) return tryExtractIds(v);
  }

  // Common nested patterns.
  for (const k of ['data', 'result', 'results']) {
    const v = obj[k];
    if (Array.isArray(v)) return tryExtractIds(v);
    if (v && typeof v === 'object') {
      for (const [, vv] of Object.entries(v)) {
        if (Array.isArray(vv)) return tryExtractIds(vv);
      }
    }
  }

  return ids;
}

const { file, unique, limit } = parseArgs(process.argv.slice(2));
const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
let ids = tryExtractIds(obj).filter(Boolean);
if (unique) ids = [...new Set(ids)];
if (Number.isFinite(limit)) ids = ids.slice(0, limit);
process.stdout.write(ids.join('\n') + '\n');

