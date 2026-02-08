#!/usr/bin/env node
/**
 * Filter a list of API paths (from freee_api_list_paths output) by substring query.
 *
 * Accepts:
 * - JSON: array of strings, or object containing an array of strings
 * - plain text: one path per line
 */

import fs from 'node:fs';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/filter-paths.mjs <file> --query <text> [--limit <n>]

Examples:
  node scripts/freee-mcp/filter-paths.mjs paths.json --query deals
  node scripts/freee-mcp/filter-paths.mjs paths.txt --query tax_code --limit 50
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { file: null, query: null, limit: 200 };
  const rest = [...argv];
  const f = rest.shift();
  if (!f || f === '--help' || f === '-h') usage(0);
  args.file = f;
  while (rest.length) {
    const t = rest.shift();
    if (t === '--help' || t === '-h') usage(0);
    if (t === '--query') args.query = rest.shift() ?? usage(2);
    else if (t === '--limit') args.limit = Number(rest.shift() ?? usage(2));
    else usage(2);
  }
  if (!args.query) usage(2);
  return args;
}

function extractStringArray(v) {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  if (!v || typeof v !== 'object') return null;
  for (const [, vv] of Object.entries(v)) {
    const arr = extractStringArray(vv);
    if (arr) return arr;
  }
  return null;
}

const { file, query, limit } = parseArgs(process.argv.slice(2));
const raw = fs.readFileSync(file, 'utf8');
let paths = null;
try {
  const parsed = JSON.parse(raw);
  paths = extractStringArray(parsed);
} catch {
  // Plain text
  paths = raw
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

if (!paths || !paths.length) {
  process.stderr.write('No paths found in input.\n');
  process.exit(1);
}

const q = String(query).toLowerCase();
const out = paths.filter((p) => String(p).toLowerCase().includes(q)).slice(0, Number.isFinite(limit) ? limit : 200);
process.stdout.write(out.join('\n') + '\n');

