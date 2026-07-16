import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile, readJournal, restore, readSnapshot, TRACKED_FILES } from '../src/journal.mjs';

const makeDir = () => mkdtempSync(join(tmpdir(), 'boundbox-journal-'));

describe('exchange journal', () => {
  it('journals tracked files with correct directions and skips untracked ones', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'source.wireloom'), 'window:\n  text "v1"\n');
    writeFileSync(join(dir, 'boxes.json'), '{"boundbox":"1","boxes":[]}');
    writeFileSync(join(dir, '.session.json'), '{"pid":1}');

    const added = reconcile(dir, { reason: 'launch' });
    expect(added.map((e) => [e.file, e.direction])).toEqual([
      ['source.wireloom', 'ai-to-user'],
      ['boxes.json', 'user-to-ai'],
    ]);
    expect(added[0].seq).toBe(1);
    expect(added[1].seq).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes identical content and journals every distinct version', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'source.wireloom'), 'v1');
    reconcile(dir);
    reconcile(dir); // unchanged — no new entry
    writeFileSync(join(dir, 'source.wireloom'), 'v2');
    reconcile(dir, { reason: 'source-read' });

    const entries = readJournal(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0].sha256).not.toBe(entries[1].sha256);
    expect(readFileSync(join(dir, 'history', entries[0].snapshot), 'utf8')).toBe('v1');
    expect(readFileSync(join(dir, 'history', entries[1].snapshot), 'utf8')).toBe('v2');
    rmSync(dir, { recursive: true, force: true });
  });

  it('restore brings back byte-identical content and journals the restoration', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'source.wireloom'), 'v1-original');
    reconcile(dir);
    writeFileSync(join(dir, 'source.wireloom'), 'v2-regression');
    reconcile(dir);

    const { entry, preserved, journaled } = restore(dir, 1);
    expect(entry.file).toBe('source.wireloom');
    expect(preserved).toHaveLength(0); // v2 was already journaled
    expect(journaled).toHaveLength(1);
    expect(readFileSync(join(dir, 'source.wireloom'), 'utf8')).toBe('v1-original');

    const entries = readJournal(dir);
    expect(entries).toHaveLength(3);
    expect(entries[2].reason).toBe('restore-of-1');
    expect(entries[2].sha256).toBe(entries[0].sha256);
    rmSync(dir, { recursive: true, force: true });
  });

  it('restore journals unjournaled live content BEFORE overwriting it (critical review fix)', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'source.wireloom'), 'v1');
    reconcile(dir);
    // AI writes a new version with no chokepoint running — unjournaled.
    writeFileSync(join(dir, 'source.wireloom'), 'v2-unjournaled');

    const { preserved } = restore(dir, 1);
    expect(preserved).toHaveLength(1);
    expect(preserved[0].reason).toBe('pre-restore-of-1');

    // Live file is back to v1, and v2 is fully recoverable from history.
    expect(readFileSync(join(dir, 'source.wireloom'), 'utf8')).toBe('v1');
    const { content } = readSnapshot(dir, preserved[0].seq);
    expect(content.toString('utf8')).toBe('v2-unjournaled');
    rmSync(dir, { recursive: true, force: true });
  });

  it('never reuses a snapshot seq even when a journal line was lost to corruption', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'source.wireloom'), 'v1');
    reconcile(dir);
    writeFileSync(join(dir, 'source.wireloom'), 'v2');
    reconcile(dir); // seq 2, snapshot 00002_source.wireloom

    // Simulate a crash that corrupted the seq-2 journal line (snapshot survives).
    const journalFile = join(dir, 'history', 'journal.jsonl');
    const [line1] = readFileSync(journalFile, 'utf8').split('\n');
    writeFileSync(journalFile, line1 + '\nCORRUPTED-PARTIAL-WRITE\n');

    writeFileSync(join(dir, 'source.wireloom'), 'v3');
    const added = reconcile(dir);
    expect(added[0].seq).toBe(3); // seq scan includes snapshot filenames
    expect(readFileSync(join(dir, 'history', '00002_source.wireloom'), 'utf8')).toBe('v2');
    expect(readFileSync(join(dir, 'history', '00003_source.wireloom'), 'utf8')).toBe('v3');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses tampered journal entries instead of resolving paths outside history/', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'boxes.json'), '{"a":1}');
    reconcile(dir);
    appendFileSync(
      join(dir, 'history', 'journal.jsonl'),
      JSON.stringify({ seq: 9001, file: '../../evil.bat', snapshot: '..\\..\\payload', sha256: 'x' }) + '\n',
    );
    expect(() => restore(dir, 9001)).toThrowError(/refusing/);
    expect(() => readSnapshot(dir, 9001)).toThrowError(/refusing/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects restore of an unknown seq without touching anything', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'boxes.json'), '{"a":1}');
    reconcile(dir);
    expect(() => restore(dir, 99)).toThrowError(/no journal entry/);
    expect(readJournal(dir)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates corrupt journal lines and continues seq from the last valid entry', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'boxes.json'), '{"a":1}');
    reconcile(dir);
    appendFileSync(join(dir, 'history', 'journal.jsonl'), 'THIS IS NOT JSON\n');
    writeFileSync(join(dir, 'boxes.json'), '{"a":2}');
    const added = reconcile(dir);
    expect(added[0].seq).toBe(2);
    expect(readJournal(dir)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tracks exactly the four exchange files', () => {
    expect(Object.keys(TRACKED_FILES).sort()).toEqual(
      ['boxes.json', 'packet.json', 'project.json', 'source.wireloom'].sort(),
    );
  });
});
