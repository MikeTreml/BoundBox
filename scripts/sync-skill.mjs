/**
 * Build and install the BoundBox skill without deleting unrelated target files.
 *
 * Defaults to ~/.claude/skills/boundbox, ~/.cursor/skills/boundbox, and ~/.codex/skills/boundbox.
 * Use one or more --target paths to install somewhere else.
 * Use --skip-build only when skill/ has already been built and verified.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundleDir = join(root, 'skill');
const files = ['SKILL.md', 'PROMPTS.md', 'SCHEMA.md', 'launch.py', 'app.py', 'history.py', 'runtime.py', 'requirements.txt', 'boundbox.html'];

const args = process.argv.slice(2);
const targets = [];
let skipBuild = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--target') {
    if (!args[i + 1]) throw new Error('--target requires a directory');
    targets.push(resolve(args[i + 1]));
    i += 1;
  } else if (args[i] === '--skip-build') {
    skipBuild = true;
  } else {
    throw new Error(`unknown argument: ${args[i]}`);
  }
}

if (!targets.length) {
  targets.push(
    join(homedir(), '.claude', 'skills', 'boundbox'),
    join(homedir(), '.cursor', 'skills', 'boundbox'),
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'boundbox'),
  );
}

if (!skipBuild) await import('./build-skill.mjs');

for (const file of files) {
  const source = join(bundleDir, file);
  if (!existsSync(source) || !statSync(source).size) {
    throw new Error(`skill/${file} is missing or empty; run npm run skill:build`);
  }
}

for (const target of [...new Set(targets)]) {
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(join(bundleDir, file), join(target, file));
  console.log(`OK installed BoundBox skill -> ${target}`);
}
