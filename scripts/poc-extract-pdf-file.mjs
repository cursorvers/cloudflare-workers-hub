import { readFileSync } from 'node:fs';

const filePath = process.argv[2];
const endpoint = process.argv[3] || 'http://127.0.0.1:8792/__poc/extract-pdf-text';

if (!filePath) {
  console.error('Usage: node scripts/poc-extract-pdf-file.mjs <path/to/file.pdf> [endpoint]');
  process.exit(2);
}

const pdf = readFileSync(filePath);

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/pdf' },
  body: pdf,
});

console.log(res.status);
console.log(await res.text());

