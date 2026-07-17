// scripts/history.mjs
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2, resolve as resolve2 } from "node:path";

// src/journal.mjs
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  readdirSync,
  rmSync
} from "node:fs";
import { join, resolve, sep } from "node:path";
var TRACKED_FILES = {
  "source.wireloom": "ai-to-user",
  "boxes.json": "user-to-ai",
  "packet.json": "user-to-ai",
  "project.json": "user-to-ai"
};
var SNAPSHOT_RE = /^(\d{5,})_([A-Za-z0-9._-]+)$/;
var historyDir = (dir2) => join(dir2, "history");
var journalPath = (dir2) => join(historyDir(dir2), "journal.jsonl");
function readJournal(dir2) {
  const path = journalPath(dir2);
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      console.warn(`WARN: skipping corrupt journal line: ${line.slice(0, 80)}`);
    }
  }
  return entries;
}
var lastHashByFile = (entries) => {
  const map = /* @__PURE__ */ new Map();
  for (const entry of entries) map.set(entry.file, entry.sha256);
  return map;
};
var maxSeq = (dir2, entries) => {
  let max = 0;
  for (const e of entries) if (Number.isFinite(e.seq)) max = Math.max(max, e.seq);
  const hd = historyDir(dir2);
  if (existsSync(hd)) {
    for (const name of readdirSync(hd)) {
      const m = SNAPSHOT_RE.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
};
function snapshotPathFor(dir2, entry) {
  if (!Object.hasOwn(TRACKED_FILES, entry.file)) {
    throw new Error(`journal entry ${entry.seq} references untracked file "${entry.file}" \u2014 refusing (possible tampering)`);
  }
  const name = String(entry.snapshot ?? "");
  if (!SNAPSHOT_RE.test(name)) {
    throw new Error(`journal entry ${entry.seq} has invalid snapshot name "${name}" \u2014 refusing (possible tampering)`);
  }
  const base = resolve(historyDir(dir2));
  const path = resolve(base, name);
  if (!path.startsWith(base + sep)) {
    throw new Error(`journal entry ${entry.seq} snapshot resolves outside history/ \u2014 refusing (possible tampering)`);
  }
  return path;
}
function renameWithRetry(from, to, attempts = 4) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (i >= attempts - 1 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}
function reconcile(dir2, { reason = "reconcile" } = {}) {
  mkdirSync(historyDir(dir2), { recursive: true });
  const entries = readJournal(dir2);
  const lastHashes = lastHashByFile(entries);
  let seq = maxSeq(dir2, entries) + 1;
  const added = [];
  for (const [file, direction] of Object.entries(TRACKED_FILES)) {
    const livePath = join(dir2, file);
    if (!existsSync(livePath)) continue;
    const content = readFileSync(livePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (lastHashes.get(file) === sha256) continue;
    let snapshot;
    for (; ; ) {
      snapshot = `${String(seq).padStart(5, "0")}_${file}`;
      try {
        writeFileSync(join(historyDir(dir2), snapshot), content, { flag: "wx" });
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        seq += 1;
      }
    }
    const entry = {
      seq,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      file,
      direction,
      bytes: content.length,
      sha256,
      snapshot,
      reason
    };
    appendFileSync(journalPath(dir2), JSON.stringify(entry) + "\n", "utf8");
    lastHashes.set(file, sha256);
    added.push(entry);
    seq += 1;
  }
  return added;
}
function findEntry(entries, seq) {
  const matches = entries.filter((e) => e.seq === Number(seq));
  if (!matches.length) throw new Error(`no journal entry with seq ${seq}`);
  if (matches.length > 1) {
    throw new Error(`ambiguous seq ${seq} (${matches.length} entries \u2014 concurrent journaling); inspect history/journal.jsonl`);
  }
  return matches[0];
}
function readSnapshot(dir2, seq) {
  const entry = findEntry(readJournal(dir2), seq);
  const path = snapshotPathFor(dir2, entry);
  if (!existsSync(path)) throw new Error(`snapshot file missing: ${entry.snapshot}`);
  return { entry, content: readFileSync(path) };
}
function restore(dir2, seq) {
  const { entry, content } = readSnapshot(dir2, seq);
  const preserved = reconcile(dir2, { reason: `pre-restore-of-${entry.seq}` });
  const livePath = join(dir2, entry.file);
  const tmpPath = join(dir2, `.${entry.file}.restore.tmp`);
  writeFileSync(tmpPath, content);
  try {
    renameWithRetry(tmpPath, livePath);
  } catch (err) {
    try {
      rmSync(tmpPath);
    } catch {
    }
    throw new Error(`restore failed writing ${entry.file}: ${err.message}`);
  }
  const journaled = reconcile(dir2, { reason: `restore-of-${entry.seq}` });
  return { entry, preserved, journaled };
}

// scripts/history.mjs
var fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};
var parseArgs = (argv) => {
  let dir2 = "./boundbox";
  const positional2 = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") {
      const value = argv[i + 1];
      if (typeof value !== "string") fail("--dir requires a value");
      dir2 = value;
      i += 1;
    } else {
      positional2.push(argv[i]);
    }
  }
  return { dir: resolve2(dir2), positional: positional2 };
};
var { dir, positional } = parseArgs(process.argv.slice(2));
var [command, seqArg] = positional;
if (!existsSync2(dir)) fail(`exchange folder not found: ${dir}`);
var warnIfSessionLive = () => {
  const sessionPath = join2(dir, ".session.json");
  if (!existsSync2(sessionPath)) return;
  try {
    const { pid } = JSON.parse(readFileSync2(sessionPath, "utf8"));
    process.kill(pid, 0);
    console.warn(`WARN: a live BoundBox session (pid ${pid}) is serving this folder \u2014 avoid concurrent restores.`);
  } catch {
  }
};
switch (command) {
  case "list": {
    warnIfSessionLive();
    reconcile(dir, { reason: "history-list" });
    const entries = readJournal(dir);
    if (!entries.length) {
      console.log("journal is empty");
      break;
    }
    console.log("seq    when                      direction    file             bytes  reason");
    for (const e of entries) {
      console.log(
        `${String(e.seq).padStart(4)}   ${e.ts}  ${String(e.direction).padEnd(11)}  ${String(e.file).padEnd(16)} ${String(e.bytes).padStart(6)}  ${e.reason}`
      );
    }
    break;
  }
  case "show": {
    if (!seqArg) fail("usage: history.mjs show <seq>");
    try {
      const { content } = readSnapshot(dir, seqArg);
      process.stdout.write(content);
    } catch (err) {
      fail(err.message, 1);
    }
    break;
  }
  case "restore": {
    if (!seqArg) fail("usage: history.mjs restore <seq>");
    warnIfSessionLive();
    try {
      const { entry, preserved, journaled } = restore(dir, seqArg);
      if (preserved.length) {
        console.log(`preserved unjournaled content first: ${preserved.map((e) => `seq ${e.seq} (${e.file})`).join(", ")}`);
      }
      console.log(`restored ${entry.file} to seq ${entry.seq} (${entry.ts}, ${entry.bytes} bytes).`);
      console.log(journaled.length ? `restoration journaled as ${journaled.map((e) => `seq ${e.seq}`).join(", ")}.` : "live file already matched this version; no new journal entry needed.");
    } catch (err) {
      fail(err.message, 1);
    }
    break;
  }
  default:
    fail("usage: node scripts/history.mjs <list|show <seq>|restore <seq>> [--dir ./boundbox]");
}
