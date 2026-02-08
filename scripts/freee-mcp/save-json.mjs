#!/usr/bin/env node
/**
 * Save JSON from stdin to a file (pretty-printed) with basic validation.
 *
 * This is intentionally local-only and read-only: it helps you persist evidence
 * from freee-mcp tool outputs into the session folder.
 */

import fs from 'node:fs';
import path from 'node:path';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/save-json.mjs <outFile>

Reads JSON from stdin, validates it, and writes pretty JSON to <outFile>.

Examples:
  pbpaste | node scripts/freee-mcp/save-json.mjs logs/freee-mcp/.../30_results/candidates.json
  cat response.json | node scripts/freee-mcp/save-json.mjs logs/freee-mcp/.../30_results/details_123.json
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

const outFile = process.argv[2];
if (!outFile || outFile === '--help' || outFile === '-h') usage(0);

const input = fs.readFileSync(0, 'utf8');
let parsed;
try {
  parsed = JSON.parse(input);
} catch (e) {
  process.stderr.write(`Invalid JSON. Not writing.\n`);
  process.exit(1);
}

const outPath = path.resolve(outFile);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2) + '\n');

let shape = typeof parsed;
if (Array.isArray(parsed)) shape = `array(${parsed.length})`;
else if (parsed && typeof parsed === 'object') shape = `object(keys=${Object.keys(parsed).length})`;

process.stderr.write(`Saved JSON (${shape}) to: ${outPath}\n`);

