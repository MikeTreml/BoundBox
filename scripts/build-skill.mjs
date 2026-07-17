/**
 * Build the self-contained BoundBox skill bundle.
 *
 * Output in skill/:
 *   SKILL.md, PROMPTS.md, SCHEMA.md, launch.mjs, history.mjs, boundbox.html
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillDir = join(root, 'skill');

mkdirSync(skillDir, { recursive: true });

for (const doc of ['SKILL.md', 'PROMPTS.md', 'SCHEMA.md']) {
  const path = join(skillDir, doc);
  if (!existsSync(path)) throw new Error(`skill/${doc} is required before packaging`);
}

// Build the browser app from its authored modules, then place the resulting
// single-file app beside the bundled Node entry points.
await import('./build-app.mjs');
copyFileSync(join(root, 'app', 'boundbox.html'), join(skillDir, 'boundbox.html'));

const bundleNodeEntry = (entry, outfile) => build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
  logLevel: 'silent',
});

await Promise.all([
  bundleNodeEntry(join(root, 'launch.mjs'), join(skillDir, 'launch.mjs')),
  bundleNodeEntry(join(root, 'scripts', 'history.mjs'), join(skillDir, 'history.mjs')),
]);

for (const file of ['SKILL.md', 'PROMPTS.md', 'SCHEMA.md', 'launch.mjs', 'history.mjs', 'boundbox.html']) {
  const size = statSync(join(skillDir, file)).size;
  if (!size) throw new Error(`skill/${file} was emitted empty`);
}

console.log('OK skill bundle (6 files, self-contained)');
