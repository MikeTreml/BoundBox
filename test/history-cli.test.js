import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/history.mjs', import.meta.url));
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

const makeBase = () => {
  const base = mkdtempSync(join(tmpdir(), 'boundbox-cli-'));
  mkdirSync(join(base, 'boundbox'));
  return base;
};

describe('history.mjs CLI', () => {
  it('list works with the default ./boundbox dir — no --dir flag (review regression)', () => {
    const base = makeBase();
    writeFileSync(join(base, 'boundbox', 'source.wireloom'), 'v1');
    const res = run(['list'], base);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('source.wireloom');
    expect(res.stdout).toContain('ai-to-user');
    rmSync(base, { recursive: true, force: true });
  });

  it('restore preserves unjournaled content, reports it, and show recovers it', () => {
    const base = makeBase();
    const source = join(base, 'boundbox', 'source.wireloom');
    writeFileSync(source, 'v1');
    run(['list'], base); // journals v1 as seq 1
    writeFileSync(source, 'v2-unjournaled');

    const res = run(['restore', '1'], base);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('preserved unjournaled content first');
    expect(readFileSync(source, 'utf8')).toBe('v1');

    const show = run(['show', '2'], base); // seq 2 = the preserved v2
    expect(show.status).toBe(0);
    expect(show.stdout).toBe('v2-unjournaled');
    rmSync(base, { recursive: true, force: true });
  });

  it('fails cleanly on unknown seq, dangling --dir, and tampered journal entries', () => {
    const base = makeBase();
    writeFileSync(join(base, 'boundbox', 'boxes.json'), '{"a":1}');
    run(['list'], base);

    const unknown = run(['restore', '99'], base);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no journal entry');

    const dangling = run(['list', '--dir'], base);
    expect(dangling.status).toBe(2);
    expect(dangling.stderr).toContain('--dir requires a value');

    appendFileSync(
      join(base, 'boundbox', 'history', 'journal.jsonl'),
      JSON.stringify({ seq: 9001, file: '../../evil', snapshot: '..\\..\\payload' }) + '\n',
    );
    const tampered = run(['show', '9001'], base);
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain('refusing');
    rmSync(base, { recursive: true, force: true });
  });
});
