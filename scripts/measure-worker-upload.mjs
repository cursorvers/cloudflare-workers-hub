import { spawnSync } from 'node:child_process';

// Wrapper around `wrangler build` that extracts the upload size line.
// This stays local (no deploy) and is useful to catch size regressions.

function runWranglerBuild() {
  // Build the default (hub/envless) script; `--env=` avoids Wrangler warnings when envs exist.
  const args = ['wrangler', 'build', '--env='];
  const res = spawnSync('npx', args, { encoding: 'utf8' });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const combined = `${stdout}\n${stderr}`.trim();
  if (res.status !== 0) {
    const msg = combined || `wrangler exited with status ${res.status ?? 'unknown'}`;
    throw new Error(msg);
  }
  return combined;
}

function parseSizes(output) {
  const m = output.match(/Total Upload:\s*([0-9.]+)\s*KiB\s*\/\s*gzip:\s*([0-9.]+)\s*KiB/);
  if (!m) return null;
  return { totalKiB: Number(m[1]), gzipKiB: Number(m[2]) };
}

try {
  const out = runWranglerBuild();
  const sizes = parseSizes(out);
  if (!sizes) {
    console.error(out);
    throw new Error('Failed to parse size line from `wrangler build` output');
  }
  console.log(`Total Upload: ${sizes.totalKiB.toFixed(2)} KiB`);
  console.log(`gzip:        ${sizes.gzipKiB.toFixed(2)} KiB`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[measure-worker-upload] ${msg}`);
  process.exit(1);
}
