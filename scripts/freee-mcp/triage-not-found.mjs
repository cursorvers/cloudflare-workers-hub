#!/usr/bin/env node
/**
 * Expense-first, evidence-first "Not Found" triage.
 *
 * Inputs:
 * - <sessionDir>/30_results/candidates.json
 * - <sessionDir>/40_changes/not_found_query.json
 *
 * Outputs:
 * - <sessionDir>/40_changes/not_found_matches.json
 * - <sessionDir>/40_changes/not_found_ids.txt
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/triage-not-found.mjs [sessionDir]

If sessionDir is omitted, uses the latest session under logs/freee-mcp/.
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

function resolveRepoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
}

function findLatestSession(repoRoot) {
  const base = path.join(repoRoot, 'logs/freee-mcp');
  if (!fs.existsSync(base)) return null;
  const dates = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (!dates.length) return null;
  const lastDate = dates[dates.length - 1];
  const dayDir = path.join(base, lastDate);
  const sessions = fs
    .readdirSync(dayDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (!sessions.length) return null;
  return path.join(dayDir, sessions[sessions.length - 1]);
}

function runNode(repoRoot, relScript, args) {
  const scriptPath = path.join(repoRoot, relScript);
  const p = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
  if (p.status !== 0) {
    process.stderr.write(p.stderr || '');
    process.exit(p.status ?? 1);
  }
  return p.stdout;
}

function isPlaceholderDate(s) {
  return !s || s === 'YYYY-MM-DD';
}

function hasAnyFilter(q) {
  return Boolean(
    (q.date && !isPlaceholderDate(q.date)) ||
      (q.amount && String(q.amount).trim()) ||
      (q.partner && String(q.partner).trim()) ||
      (q.contains && String(q.contains).trim()) ||
      (Array.isArray(q.field) && q.field.length),
  );
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);

const repoRoot = resolveRepoRoot();
const sessionDir = argv[0] ? path.resolve(argv[0]) : findLatestSession(repoRoot);
if (!sessionDir) {
  process.stderr.write('No sessionDir provided and no sessions found under logs/freee-mcp.\n');
  process.exit(1);
}

const candidatesPath = path.join(sessionDir, '30_results/candidates.json');
if (!fs.existsSync(candidatesPath)) {
  process.stderr.write(`Missing candidates.json: ${candidatesPath}\n`);
  process.stderr.write('Save a list GET response as 30_results/candidates.json first.\n');
  process.exit(1);
}

const queryPath = path.join(sessionDir, '40_changes/not_found_query.json');
if (!fs.existsSync(queryPath)) {
  process.stderr.write(`Missing not_found_query.json: ${queryPath}\n`);
  process.stderr.write('This should be created by the session template. Re-create session if missing.\n');
  process.exit(1);
}

const q = JSON.parse(fs.readFileSync(queryPath, 'utf8'));
if (!hasAnyFilter(q)) {
  process.stderr.write(`No usable filters in: ${queryPath}\n`);
  process.stderr.write('Edit not_found_query.json (set date/amount/contains/partner) then re-run.\n');
  process.exit(2);
}

const args = [candidatesPath];
if (q.array) args.push('--array', String(q.array));
if (q.id_field) args.push('--id-field', String(q.id_field));
if (q.date_field) args.push('--date-field', String(q.date_field));
if (q.amount_field) args.push('--amount-field', String(q.amount_field));
if (q.partner_field) args.push('--partner-field', String(q.partner_field));
if (q.date && !isPlaceholderDate(q.date)) args.push('--date', String(q.date));
if (q.amount && String(q.amount).trim()) args.push('--amount', String(q.amount));
if (q.partner && String(q.partner).trim()) args.push('--partner', String(q.partner));
if (q.contains && String(q.contains).trim()) args.push('--contains', String(q.contains));
if (Array.isArray(q.field)) {
  for (const f of q.field) args.push('--field', String(f));
}
if (q.limit) args.push('--limit', String(q.limit));

const outJson = runNode(repoRoot, 'scripts/freee-mcp/find-candidates.mjs', args);
const outObj = JSON.parse(outJson);

const outDir = path.join(sessionDir, '40_changes');
fs.mkdirSync(outDir, { recursive: true });
const matchesPath = path.join(outDir, 'not_found_matches.json');
fs.writeFileSync(matchesPath, JSON.stringify(outObj, null, 2) + '\n');

const ids = (outObj.results ?? []).map((r) => r?.id).filter(Boolean);
const idsPath = path.join(outDir, 'not_found_ids.txt');
fs.writeFileSync(idsPath, ids.join('\n') + (ids.length ? '\n' : ''));

process.stdout.write(outJson);
process.stderr.write(`Wrote matches to: ${matchesPath}\n`);
process.stderr.write(`Wrote IDs (${ids.length}) to: ${idsPath}\n`);

