import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const SKILL = join(ROOT, 'skill');
const REQUIRED = ['SKILL.md', 'PROMPTS.md', 'SCHEMA.md', 'launch.mjs', 'history.mjs', 'boundbox.html'];
const temporary = [];

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

const temp = (prefix) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
};

const startBundledLauncher = (launcher, dir) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [launcher, '--dir', dir, '--port', '0', '--idle-seconds', '120'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`bundled launcher never printed a URL: ${output}`));
  }, 10_000);
  const collect = (chunk) => {
    output += chunk;
    const match = output.match(/URL: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+\/)/);
    if (!match) return;
    clearTimeout(timer);
    resolve({ child, url: match[1] });
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

describe('portable skill bundle', () => {
  it('contains every non-empty runtime and instruction file', () => {
    for (const file of REQUIRED) {
      const path = join(SKILL, file);
      expect(existsSync(path), file).toBe(true);
      expect(readFileSync(path).length, file).toBeGreaterThan(0);
    }
    expect(readFileSync(join(SKILL, 'boundbox.html'))).toEqual(readFileSync(join(ROOT, 'app', 'boundbox.html')));
  });

  it('syncs to an explicit target without deleting unrelated files', async () => {
    const target = temp('boundbox-skill-target-');
    writeFileSync(join(target, 'keep.me'), 'untouched', 'utf8');

    await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'sync-skill.mjs'), '--skip-build', '--target', target], {
      cwd: ROOT,
    });
    await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'sync-skill.mjs'), '--skip-build', '--target', target], {
      cwd: ROOT,
    });

    expect(readFileSync(join(target, 'keep.me'), 'utf8')).toBe('untouched');
    for (const file of REQUIRED) {
      expect(readFileSync(join(target, file))).toEqual(readFileSync(join(SKILL, file)));
    }
  });

  it('launches and serves the app from the standalone skill directory', async () => {
    const installed = temp('boundbox-skill-installed-');
    const exchange = temp('boundbox-skill-live-');
    await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'sync-skill.mjs'), '--skip-build', '--target', installed], {
      cwd: ROOT,
    });
    const { child, url } = await startBundledLauncher(join(installed, 'launch.mjs'), exchange);
    try {
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Reset workspace');
      expect(await (await fetch(`${url}ping`)).json()).toEqual({ ok: true, idleSeconds: 120 });
    } finally {
      child.kill();
    }
  });
});
