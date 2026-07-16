/**
 * Exchange journal CLI (boundbox.exchange-journal, D-016).
 *
 *   node scripts/history.mjs list            [--dir ./boundbox]
 *   node scripts/history.mjs show <seq>      [--dir ./boundbox]
 *   node scripts/history.mjs restore <seq>   [--dir ./boundbox]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJournal, reconcile, restore, readSnapshot } from '../src/journal.mjs';

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

const parseArgs = (argv) => {
  let dir = './boundbox';
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      const value = argv[i + 1];
      if (typeof value !== 'string') fail('--dir requires a value');
      dir = value;
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { dir: resolve(dir), positional };
};

const { dir, positional } = parseArgs(process.argv.slice(2));
const [command, seqArg] = positional;

if (!existsSync(dir)) fail(`exchange folder not found: ${dir}`);

// A live server journals at its own chokepoints; concurrent CLI writes could
// interleave journal entries. Warn so restores happen with the session closed.
const warnIfSessionLive = () => {
  const sessionPath = join(dir, '.session.json');
  if (!existsSync(sessionPath)) return;
  try {
    const { pid } = JSON.parse(readFileSync(sessionPath, 'utf8'));
    process.kill(pid, 0);
    console.warn(`WARN: a live BoundBox session (pid ${pid}) is serving this folder — avoid concurrent restores.`);
  } catch { /* dead or unreadable — fine */ }
};

switch (command) {
  case 'list': {
    warnIfSessionLive();
    reconcile(dir, { reason: 'history-list' }); // catch anything unjournaled first
    const entries = readJournal(dir);
    if (!entries.length) {
      console.log('journal is empty');
      break;
    }
    console.log('seq    when                      direction    file             bytes  reason');
    for (const e of entries) {
      console.log(
        `${String(e.seq).padStart(4)}   ${e.ts}  ${String(e.direction).padEnd(11)}  ${String(e.file).padEnd(16)} ${String(e.bytes).padStart(6)}  ${e.reason}`,
      );
    }
    break;
  }
  case 'show': {
    if (!seqArg) fail('usage: history.mjs show <seq>');
    try {
      const { content } = readSnapshot(dir, seqArg);
      process.stdout.write(content);
    } catch (err) {
      fail(err.message, 1);
    }
    break;
  }
  case 'restore': {
    if (!seqArg) fail('usage: history.mjs restore <seq>');
    warnIfSessionLive();
    try {
      const { entry, preserved, journaled } = restore(dir, seqArg);
      if (preserved.length) {
        console.log(`preserved unjournaled content first: ${preserved.map((e) => `seq ${e.seq} (${e.file})`).join(', ')}`);
      }
      console.log(`restored ${entry.file} to seq ${entry.seq} (${entry.ts}, ${entry.bytes} bytes).`);
      console.log(journaled.length
        ? `restoration journaled as ${journaled.map((e) => `seq ${e.seq}`).join(', ')}.`
        : 'live file already matched this version; no new journal entry needed.');
    } catch (err) {
      fail(err.message, 1);
    }
    break;
  }
  default:
    fail('usage: node scripts/history.mjs <list|show <seq>|restore <seq>> [--dir ./boundbox]');
}
