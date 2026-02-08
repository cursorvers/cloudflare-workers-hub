#!/usr/bin/env node
/**
 * One-command local triage for a session.
 *
 * Runs what it can based on available evidence files:
 * - Duplicates: requires 30_results/candidates.json
 * - Not Found: requires candidates.json + 40_changes/not_found_query.json with filters
 * - Misclassification: requires 40_changes/correct.json + incorrect.json non-empty arrays
 *
 * No freee API calls are made.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/triage.mjs [sessionDir]

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

function runNode(scriptPath, args) {
  const p = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
  return p;
}

function tryRun(label, script, sessionDir) {
  const p = runNode(script, [sessionDir]);
  if (p.status === 0) {
    process.stderr.write(`[triage] OK: ${label}\n`);
    if (p.stdout) process.stdout.write(p.stdout);
    if (p.stderr) process.stderr.write(p.stderr);
    return true;
  }
  // Non-zero: treat as "skipped" if it looks like missing prerequisites.
  const err = (p.stderr || '').trim();
  const out = (p.stdout || '').trim();
  const msg = err || out || `exit=${p.status}`;
  process.stderr.write(`[triage] SKIP: ${label} (${msg.split('\n')[0]})\n`);
  return false;
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);

const repoRoot = resolveRepoRoot();
const sessionDir = argv[0] ? path.resolve(argv[0]) : findLatestSession(repoRoot);
if (!sessionDir) {
  process.stderr.write('No sessionDir provided and no sessions found under logs/freee-mcp.\n');
  process.exit(1);
}

const triageDuplicates = path.join(repoRoot, 'scripts/freee-mcp/triage-duplicates.mjs');
const triageNotFound = path.join(repoRoot, 'scripts/freee-mcp/triage-not-found.mjs');
const triageMisclass = path.join(repoRoot, 'scripts/freee-mcp/triage-misclassification.mjs');

tryRun('duplicates', triageDuplicates, sessionDir);
tryRun('not-found', triageNotFound, sessionDir);
tryRun('misclassification', triageMisclass, sessionDir);

