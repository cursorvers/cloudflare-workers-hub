#!/usr/bin/env node
/**
 * Expense-first, evidence-first duplicate triage.
 *
 * Inputs:
 * - <sessionDir>/30_results/candidates.json
 *
 * Outputs:
 * - <sessionDir>/40_changes/duplicate_groups.json
 * - <sessionDir>/40_changes/duplicate_ids.txt
 *
 * This does not call freee API. It's local-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/triage-duplicates.mjs [sessionDir]

If sessionDir is omitted, uses the latest session under logs/freee-mcp/.
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

function resolveRepoRoot() {
  // scripts/freee-mcp/triage-duplicates.mjs -> repo root
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
  return { stdout: p.stdout, stderr: p.stderr };
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

const outDir = path.join(sessionDir, '40_changes');
fs.mkdirSync(outDir, { recursive: true });
const groupsPath = path.join(outDir, 'duplicate_groups.json');

// 1) Group duplicates (auto key detection is inside group-duplicates.mjs)
const grouped = runNode(repoRoot, 'scripts/freee-mcp/group-duplicates.mjs', [
  candidatesPath,
  '--out',
  groupsPath,
]);
process.stdout.write(grouped.stdout);

// 2) Extract IDs
const ids = runNode(repoRoot, 'scripts/freee-mcp/extract-ids.mjs', [groupsPath, '--unique']).stdout
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const idsPath = path.join(outDir, 'duplicate_ids.txt');
fs.writeFileSync(idsPath, ids.join('\n') + (ids.length ? '\n' : ''));

process.stderr.write(`Wrote IDs (${ids.length}) to: ${idsPath}\n`);
process.stderr.write('Next: fetch detail GETs for each id and save as 30_results/details_<id>.json\n');

