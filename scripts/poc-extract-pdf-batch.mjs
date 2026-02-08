import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function parseArgs(argv) {
  const args = { dir: null, endpoint: 'http://127.0.0.1:8792/__poc/extract-pdf-text', concurrency: 2 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--endpoint') args.endpoint = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] || '2');
    else positional.push(a);
  }
  args.dir = positional[0] || null;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node scripts/poc-extract-pdf-batch.mjs <dir> [--endpoint URL] [--concurrency N]');
    process.exit(2);
  }

  const root = resolve(args.dir);
  const files = walk(root).filter((p) => p.toLowerCase().endsWith('.pdf'));
  files.sort();

  if (files.length === 0) {
    console.error(`No .pdf files found under: ${root}`);
    process.exit(1);
  }

  const concurrency = Number.isFinite(args.concurrency) && args.concurrency > 0 ? Math.floor(args.concurrency) : 2;

  let idx = 0;
  let ok = 0;
  let fail = 0;
  let totalElapsed = 0;
  let totalBytes = 0;

  const results = [];

  async function worker() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= files.length) return;
      const path = files[myIdx];
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;

      try {
        const pdf = await import('node:fs').then((m) => m.readFileSync(path));
        totalBytes += pdf.byteLength;

        const res = await fetch(args.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/pdf' },
          body: pdf,
        });

        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}

        if (res.ok && json && json.ok) {
          ok++;
          totalElapsed += Number(json.elapsedMs || 0);
          results.push({ file: rel, status: res.status, ok: true, elapsedMs: json.elapsedMs, pages: json.totalPages, textLength: json.textLength });
        } else {
          fail++;
          results.push({ file: rel, status: res.status, ok: false, body: text.slice(0, 500) });
        }
      } catch (e) {
        fail++;
        results.push({ file: rel, status: 0, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`files=${files.length} ok=${ok} fail=${fail}`);
  if (ok > 0) {
    console.log(`avgElapsedMs=${Math.round(totalElapsed / ok)} totalBytes=${totalBytes}`);
  }

  // Print failures first for quick triage.
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures.slice(0, 50)) {
      console.log(`- ${f.file} status=${f.status} ${f.error ? `error=${f.error}` : ''}`);
    }
    if (failures.length > 50) console.log(`(and ${failures.length - 50} more)`);
  }
}

await main();

