import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCH = fileURLToPath(new URL('../launch.mjs', import.meta.url));

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { host },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

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
    const html = await res.text();
    expect(html).toContain('BoundBox');
    expect(html).toContain('Reset workspace');
    expect(html).toContain("openProject({ silentMissing: true })");
  });

  it('redirects the stable preview root into the tokenized app', async () => {
    const root = new URL(url);
    root.pathname = '/';
    const res = await fetch(root, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(new URL(url).pathname);
  });

  it('does not disclose the token to a DNS-rebinding Host header', async () => {
    const root = new URL(url);
    root.pathname = '/';
    const res = await requestWithHost(root, 'attacker.example');
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  it('keeps an open UI session active through the heartbeat endpoint', async () => {
    const res = await fetch(`${url}ping`, { cache: 'no-store' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, idleSeconds: 120 });
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

    const inherited = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'constructor', payload: {} }),
    });
    expect(inherited.status).toBe(400);

    const wrongType = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'nope',
    });
    expect(wrongType.status).toBe(415);

    const crossOrigin = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ kind: 'boxes', payload: {} }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('GET source 404s when absent and serves it when present', async () => {
    expect((await fetch(`${url}source`)).status).toBe(404);
    writeFileSync(join(dir, 'source.wireloom'), 'window:\n  text "Hi"\n', 'utf8');
    const res = await fetch(`${url}source`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('text "Hi"');
  });

  it('GET project 404s when absent and round-trips a saved project without caching', async () => {
    expect((await fetch(`${url}project`)).status).toBe(404);
    expect((await fetch(`${url}project?optional=1`)).status).toBe(204);
    const project = {
      kind: 'boundbox-project', schemaVersion: 1, mode: 'sketch',
      canvas: { w: 1024, h: 768 }, counter: 0,
      context: { description: '', style: '', background: '' },
      boxes: [], wireframe: null, options: { zoom: 1 },
    };
    const saved = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', payload: project }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))).toEqual(project);

    const opened = await fetch(`${url}project`);
    expect(opened.status).toBe(200);
    expect(opened.headers.get('content-type')).toMatch(/^application\/json/);
    expect(opened.headers.get('cache-control')).toBe('no-store');
    expect(await opened.json()).toEqual(project);
  });

  it('preserves an unjournaled live project before a save overwrites it', async () => {
    const v1 = { kind: 'hand-edited', version: 1 };
    const v2 = { kind: 'saved-by-app', version: 2 };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(v1), 'utf8');

    const res = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', payload: v2 }),
    });
    expect(res.status).toBe(200);

    const entries = (await (await fetch(`${url}history`)).json()).entries
      .filter((entry) => entry.file === 'project.json');
    const preSave = entries.find((entry) => entry.reason === 'pre-save');
    expect(preSave).toBeDefined();
    expect(JSON.parse(readFileSync(join(dir, 'history', preSave.snapshot), 'utf8'))).toEqual(v1);
    expect(entries.at(-1).reason).toBe('save');
    expect(JSON.parse(readFileSync(join(dir, 'history', entries.at(-1).snapshot), 'utf8'))).toEqual(v2);
  });

  it('returns a server error instead of crashing when project.json cannot be read', async () => {
    const path = join(dir, 'project.json');
    rmSync(path, { force: true });
    mkdirSync(path);
    const res = await fetch(`${url}project`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/project read failed on the server/);
    rmSync(path, { recursive: true, force: true });
  });

  it('rejects malformed JSON and a missing payload as client errors', async () => {
    const malformed = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);

    const missing = await fetch(`${url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project' }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/payload is required/);
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

    const projectEntry = entries.find((e) => e.file === 'project.json');
    expect(projectEntry).toBeDefined();
    expect(projectEntry.direction).toBe('user-to-ai');
  });
});

describe('launch.mjs lifecycle', () => {
  it('stays alive across its idle boundary while heartbeat traffic continues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boundbox-heartbeat-'));
    const { child, url } = await startLauncher(dir, ['--idle-seconds', '1']);
    try {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect((await fetch(`${url}ping`)).status).toBe(200);
        expect(child.exitCode).toBeNull();
      }
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('exits on idle timeout and removes its session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boundbox-idle-'));
    const { child } = await startLauncher(dir, ['--idle-seconds', '1']);
    const code = await new Promise((r) => child.on('exit', r));
    expect(code).toBe(0);
    expect(existsSync(join(dir, '.session.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('ignores stale-token traffic when deciding whether to idle out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boundbox-stale-token-'));
    const { child, url } = await startLauncher(dir, ['--idle-seconds', '1']);
    const stale = new URL(url);
    stale.pathname = '/stale-token/ping';
    const spammer = setInterval(() => fetch(stale).catch(() => {}), 100);
    try {
      const code = await new Promise((resolve) => child.on('exit', resolve));
      expect(code).toBe(0);
      expect(existsSync(join(dir, '.session.json'))).toBe(false);
    } finally {
      clearInterval(spammer);
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
