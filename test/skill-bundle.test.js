import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'SKILL.md', 'PROMPTS.md', 'SCHEMA.md',
  'launch.py', 'app.py', 'history.py', 'runtime.py',
  'requirements.txt', 'boundbox.html',
];

describe('skill bundle', () => {
  it('ships the Python/Streamlit runtime as nine non-empty files', () => {
    for (const file of files) {
      const path = join(root, 'skill', file);
      expect(existsSync(path), `skill/${file}`).toBe(true);
      expect(statSync(path).size, `skill/${file} empty`).toBeGreaterThan(0);
    }
  });

  it('installs to Cursor skills as well as Claude and Codex', () => {
    const source = readFileSync(join(root, 'scripts', 'sync-skill.mjs'), 'utf8');
    expect(source).toContain(".cursor', 'skills', 'boundbox'");
    expect(source).toContain(".claude', 'skills', 'boundbox'");
    expect(source).toContain(".codex");
  });

  it('launch and history entrypoints are Python, not Node', () => {
    expect(readFileSync(join(root, 'skill', 'launch.py'), 'utf8')).toContain('streamlit');
    expect(readFileSync(join(root, 'skill', 'history.py'), 'utf8')).toContain('from runtime import');
    expect(existsSync(join(root, 'skill', 'launch.mjs'))).toBe(false);
    expect(existsSync(join(root, 'skill', 'history.mjs'))).toBe(false);
  });
});
