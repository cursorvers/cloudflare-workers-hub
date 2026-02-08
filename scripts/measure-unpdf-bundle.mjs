import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outdir = '/tmp/unpdf-bundle-measure';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const outfile = join(outdir, 'bundle.js');
const metafile = join(outdir, 'meta.json');

const result = await build({
  entryPoints: ['src/poc/unpdf-bundle-entry.ts'],
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  bundle: true,
  minify: true,
  sourcemap: false,
  treeShaking: true,
  logLevel: 'silent',
  metafile: true,
  outfile,
});

const js = readFileSync(outfile);
const gz = gzipSync(js, { level: 9 });
writeFileSync(metafile, JSON.stringify(result.metafile, null, 2));
const meta = result.metafile;
const outKey = Object.keys(meta.outputs || {}).find((k) => k.endsWith('bundle.js'));
if (!outKey) {
  throw new Error('esbuild metafile missing bundle.js output');
}
const inputs = meta.outputs[outKey].inputs || {};

const inputSizes = Object.entries(inputs)
  .map(([path, info]) => ({ path, bytes: info.bytesInOutput || 0 }))
  .sort((a, b) => b.bytes - a.bytes);

const top = inputSizes.slice(0, 20).filter((x) => x.bytes > 0);
const unpdfInputs = inputSizes.filter((x) =>
  /node_modules\/unpdf\b|node_modules\/pdfjs-dist\b|node_modules\/(?:pdfjs|pdf\.js)\b/i.test(x.path)
);

console.log(`JS: ${js.byteLength} bytes`);
console.log(`gzip: ${gz.byteLength} bytes`);
console.log('');
console.log('Top contributors (bytes in output):');
for (const t of top) {
  console.log(`- ${t.bytes.toString().padStart(10, ' ')}  ${t.path}`);
}
console.log('');
console.log('unpdf-related inputs:');
if (unpdfInputs.length === 0) {
  console.log('- (none detected)  NOTE: this likely means the dependency graph was tree-shaken away');
} else {
  for (const u of unpdfInputs.slice(0, 50)) {
    console.log(`- ${u.bytes.toString().padStart(10, ' ')}  ${u.path}`);
  }
}
