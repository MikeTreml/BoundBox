/**
 * Exchange journal (boundbox.exchange-journal, D-016).
 *
 * Append-only ledger of everything sent between the agents and the user
 * through the exchange folder. Every distinct version of every tracked file
 * is snapshotted into {dir}/history/ and indexed in history/journal.jsonl,
 * so an overwritten wireframe or layout can always be recovered.
 *
 * Guarantees (hardened per the 2026-07-16 adversarial review):
 * - Nothing in history/ is ever deleted or overwritten (snapshots are written
 *   with the exclusive 'wx' flag; seq collisions bump instead of clobbering).
 * - restore() journals the CURRENT live content before touching it, so a
 *   restore can never destroy an unjournaled version.
 * - Journal entries are validated before their paths are used (tampered
 *   file/snapshot fields are refused, never resolved outside history/).
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync,
  readdirSync, rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const TRACKED_FILES = {
  'source.wireloom': 'ai-to-user',
  'boxes.json': 'user-to-ai',
  'packet.json': 'user-to-ai',
  'project.json': 'user-to-ai',
};

const SNAPSHOT_RE = /^(\d{5,})_([A-Za-z0-9._-]+)$/;

const historyDir = (dir) => join(dir, 'history');
const journalPath = (dir) => join(historyDir(dir), 'journal.jsonl');

/** Parse journal.jsonl, skipping corrupt lines with a warning. */
export function readJournal(dir) {
  const path = journalPath(dir);
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      console.warn(`WARN: skipping corrupt journal line: ${line.slice(0, 80)}`);
    }
  }
  return entries;
}

const lastHashByFile = (entries) => {
  const map = new Map();
  for (const entry of entries) map.set(entry.file, entry.sha256);
  return map;
};

/**
 * Highest sequence number observed in EITHER the journal or the snapshot
 * filenames on disk. Scanning both means a journal line lost to corruption
 * or a concurrent writer can never cause a snapshot to be reused.
 */
const maxSeq = (dir, entries) => {
  let max = 0;
  for (const e of entries) if (Number.isFinite(e.seq)) max = Math.max(max, e.seq);
  const hd = historyDir(dir);
  if (existsSync(hd)) {
    for (const name of readdirSync(hd)) {
      const m = SNAPSHOT_RE.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
};

/**
 * Validate a journal entry's file/snapshot fields and return the snapshot's
 * absolute path. Throws on anything that smells like tampering — untracked
 * file names or snapshot names that could escape history/.
 */
export function snapshotPathFor(dir, entry) {
  if (!Object.hasOwn(TRACKED_FILES, entry.file)) {
    throw new Error(`journal entry ${entry.seq} references untracked file "${entry.file}" — refusing (possible tampering)`);
  }
  const name = String(entry.snapshot ?? '');
  if (!SNAPSHOT_RE.test(name)) {
    throw new Error(`journal entry ${entry.seq} has invalid snapshot name "${name}" — refusing (possible tampering)`);
  }
  const base = resolve(historyDir(dir));
  const path = resolve(base, name);
  if (!path.startsWith(base + sep)) {
    throw new Error(`journal entry ${entry.seq} snapshot resolves outside history/ — refusing (possible tampering)`);
  }
  return path;
}

/** rename with a short retry for Windows EPERM/EBUSY (antivirus, open handles). */
export function renameWithRetry(from, to, attempts = 4) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (i >= attempts - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

/**
 * Snapshot every tracked file whose content differs from its last journal
 * entry. Safe to call at any time; identical content is deduped by hash.
 * Returns the entries it appended.
 */
export function reconcile(dir, { reason = 'reconcile' } = {}) {
  mkdirSync(historyDir(dir), { recursive: true });
  const entries = readJournal(dir);
  const lastHashes = lastHashByFile(entries);
  let seq = maxSeq(dir, entries) + 1;
  const added = [];

  for (const [file, direction] of Object.entries(TRACKED_FILES)) {
    const livePath = join(dir, file);
    if (!existsSync(livePath)) continue;
    const content = readFileSync(livePath); // Buffer — binary-safe
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (lastHashes.get(file) === sha256) continue;

    // Exclusive create; on collision (corrupt journal line, concurrent
    // writer) bump the seq rather than ever overwriting existing history.
    let snapshot;
    for (;;) {
      snapshot = `${String(seq).padStart(5, '0')}_${file}`;
      try {
        writeFileSync(join(historyDir(dir), snapshot), content, { flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        seq += 1;
      }
    }

    const entry = {
      seq,
      ts: new Date().toISOString(),
      file,
      direction,
      bytes: content.length,
      sha256,
      snapshot,
      reason,
    };
    appendFileSync(journalPath(dir), JSON.stringify(entry) + '\n', 'utf8');
    lastHashes.set(file, sha256);
    added.push(entry);
    seq += 1;
  }
  return added;
}

/** Find the single entry for seq; ambiguity (concurrent journaling) is an error. */
export function findEntry(entries, seq) {
  const matches = entries.filter((e) => e.seq === Number(seq));
  if (!matches.length) throw new Error(`no journal entry with seq ${seq}`);
  if (matches.length > 1) {
    throw new Error(`ambiguous seq ${seq} (${matches.length} entries — concurrent journaling); inspect history/journal.jsonl`);
  }
  return matches[0];
}

/** Validated read of a snapshot's content by seq. */
export function readSnapshot(dir, seq) {
  const entry = findEntry(readJournal(dir), seq);
  const path = snapshotPathFor(dir, entry);
  if (!existsSync(path)) throw new Error(`snapshot file missing: ${entry.snapshot}`);
  return { entry, content: readFileSync(path) };
}

/**
 * Restore the live file to the version at `seq`.
 *
 * Order matters: the current live state is journaled FIRST, so a restore can
 * never destroy an unjournaled version (critical finding from the 2026-07-16
 * review). The restoration itself is then journaled. Returns the restored
 * entry plus whatever entries were appended along the way.
 */
export function restore(dir, seq) {
  const { entry, content } = readSnapshot(dir, seq);

  const preserved = reconcile(dir, { reason: `pre-restore-of-${entry.seq}` });

  const livePath = join(dir, entry.file);
  const tmpPath = join(dir, `.${entry.file}.restore.tmp`);
  writeFileSync(tmpPath, content);
  try {
    renameWithRetry(tmpPath, livePath);
  } catch (err) {
    try { rmSync(tmpPath); } catch { /* best effort */ }
    throw new Error(`restore failed writing ${entry.file}: ${err.message}`);
  }

  const journaled = reconcile(dir, { reason: `restore-of-${entry.seq}` });
  return { entry, preserved, journaled };
}
