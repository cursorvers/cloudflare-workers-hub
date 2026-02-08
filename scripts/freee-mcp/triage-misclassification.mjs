#!/usr/bin/env node
/**
 * Expense-first, evidence-first misclassification triage.
 *
 * Inputs:
 * - <sessionDir>/40_changes/correct.json
 * - <sessionDir>/40_changes/incorrect.json
 *
 * Output:
 * - <sessionDir>/40_changes/misclassification_report.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/triage-misclassification.mjs [sessionDir]

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

function mustBeNonEmptyArray(filePath) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`Missing file: ${filePath}\n`);
    process.exit(1);
  }
  const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(obj) || obj.length === 0) {
    process.stderr.write(`File must be a non-empty JSON array: ${filePath}\n`);
    process.stderr.write('Save 3-10 examples into correct.json / incorrect.json then re-run.\n');
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);

const repoRoot = resolveRepoRoot();
const sessionDir = argv[0] ? path.resolve(argv[0]) : findLatestSession(repoRoot);
if (!sessionDir) {
  process.stderr.write('No sessionDir provided and no sessions found under logs/freee-mcp.\n');
  process.exit(1);
}

const correctPath = path.join(sessionDir, '40_changes/correct.json');
const incorrectPath = path.join(sessionDir, '40_changes/incorrect.json');
mustBeNonEmptyArray(correctPath);
mustBeNonEmptyArray(incorrectPath);

const outDir = path.join(sessionDir, '40_changes');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'misclassification_report.json');

const report = runNode(repoRoot, 'scripts/freee-mcp/analyze-misclassification.mjs', [
  correctPath,
  incorrectPath,
  '--out',
  outPath,
]);

// analyze-misclassification writes to file; we also print stdout for quick visibility.
process.stdout.write(report);
process.stderr.write(`Wrote report to: ${outPath}\n`);

