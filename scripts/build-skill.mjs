/**
 * Build the self-contained BoundBox skill bundle.
 *
 * Output in skill/:
 *   SKILL.md, PROMPTS.md, SCHEMA.md, launch.py, app.py, history.py, runtime.py,
 *   requirements.txt, boundbox.html
 */
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

// Build the browser canvas from its authored modules, then place it beside the
// Python/Streamlit runtime files.
await import('./build-app.mjs');
copyFileSync(join(root, 'app', 'boundbox.html'), join(skillDir, 'boundbox.html'));
for (const file of ['launch.py', 'app.py', 'history.py', 'runtime.py', 'requirements.txt']) copyFileSync(join(root, file), join(skillDir, file));

for (const file of ['SKILL.md', 'PROMPTS.md', 'SCHEMA.md', 'launch.py', 'app.py', 'history.py', 'runtime.py', 'requirements.txt', 'boundbox.html']) {
  const size = statSync(join(skillDir, file)).size;
  if (!size) throw new Error(`skill/${file} was emitted empty`);
}

console.log('OK skill bundle (9 files, Python/Streamlit runtime + self-contained canvas)');
