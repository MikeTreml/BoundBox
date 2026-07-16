import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCH = fileURLToPath(new URL('../launch.mjs', import.meta.url));

function startLauncher(dir, extraArgs = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [LAUNCH, '--dir', dir, '--port', '0', ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`launcher never printed URL. output: ${out}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/URL: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+\/)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ child, url: match[1], output: () => out });
      }
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`launcher exited early (code ${code}) before printing URL. output: ${out}`));
      }
    });
    child.on('error', reject);
  });
}

describe('launch.mjs exchange contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boundbox-test-'));
  let child;
  let url;

  beforeAll(async () => {
    ({ child, url } = await startLauncher(dir, ['--idle-seconds', '120']));
  });

  afterAll(() => {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the exchange folder with a self-gitignore', () => {
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('*');
  });

  it('serves the app page at the tokened URL', async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('BoundBox');
  });

  it('rejects requests without the session token', async () => {
    const base = url.replace(/\/[0-9a-f-]+\/$/, '/');
    const res = await fetch(`${base}wrong-token/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'boxes', payload: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('accepts a whitelisted save and writes valid JSON atomically', async () => {
    const payload = { boundbox: '1', boxes: [{ label: 'hero', bbox: [39, 156, 859, 417] }] };
    const res = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'boxes', payload }),
    });
    expect(res.status).toBe(200);
    const written = JSON.parse(readFileSync(join(dir, 'boxes.json'), 'utf8'));
    expect(written.boxes[0].label).toBe('hero');
  });

  it('rejects non-whitelisted kinds and wrong content types', async () => {
    const bad = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: '../evil', payload: {} }),
    });
    expect(bad.status).toBe(400);

    const wrongType = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'nope',
    });
    expect(wrongType.status).toBe(415);
  });

  it('GET source 404s when absent and serves it when present', async () => {
    expect((await fetch(`${url}source`)).status).toBe(404);
    writeFileSync(join(dir, 'source.wireloom'), 'window:\n  text "Hi"\n', 'utf8');
    const res = await fetch(`${url}source`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('text "Hi"');
  });

  it('journals saves and AI source writes at the chokepoints (D-016)', async () => {
    writeFileSync(join(dir, 'source.wireloom'), 'window:\n  text "Revised"\n', 'utf8');
    await fetch(`${url}source`); // source-read chokepoint journals the AI write

    const res = await fetch(`${url}history`);
    expect(res.status).toBe(200);
    const { entries } = await res.json();

    const boxesEntry = entries.find((e) => e.file === 'boxes.json');
    expect(boxesEntry).toBeDefined();
    expect(boxesEntry.direction).toBe('user-to-ai');
    expect(boxesEntry.reason).toBe('save');

    const sourceEntries = entries.filter((e) => e.file === 'source.wireloom');
    expect(sourceEntries.length).toBeGreaterThanOrEqual(2); // "Hi" then "Revised"
    expect(sourceEntries.at(-1).direction).toBe('ai-to-user');
    expect(existsSync(join(dir, 'history', sourceEntries.at(-1).snapshot))).toBe(true);
  });
});

describe('launch.mjs lifecycle', () => {
  it('exits on idle timeout and removes its session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boundbox-idle-'));
    const { child } = await startLauncher(dir, ['--idle-seconds', '1']);
    const code = await new Promise((r) => child.on('exit', r));
    expect(code).toBe(0);
    expect(existsSync(join(dir, '.session.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});
