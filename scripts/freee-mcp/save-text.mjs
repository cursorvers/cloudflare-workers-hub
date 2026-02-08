#!/usr/bin/env node
/**
 * Save raw text from stdin to a file (no parsing).
 *
 * Use-cases:
 * - Persist freee_api_list_paths output when you copied it as plain text.
 * - Keep evidence even when the UI doesn't provide JSON.
 */

import fs from 'node:fs';
import path from 'node:path';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/save-text.mjs <outFile>

Reads stdin and writes it as-is to <outFile>.

Examples:
  pbpaste | node scripts/freee-mcp/save-text.mjs logs/freee-mcp/.../30_results/paths.txt
  cat paths.txt | node scripts/freee-mcp/save-text.mjs logs/freee-mcp/.../30_results/paths.txt
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

const outFile = process.argv[2];
if (!outFile || outFile === '--help' || outFile === '-h') usage(0);

const input = fs.readFileSync(0, 'utf8');
const outPath = path.resolve(outFile);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, input);
process.stderr.write(`Saved text to: ${outPath}\n`);

