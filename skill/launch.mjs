// launch.mjs
import http from "node:http";
import crypto from "node:crypto";
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, renameSync as renameSync2, readFileSync as readFileSync2, existsSync as existsSync2, rmSync as rmSync2 } from "node:fs";
import { join as join2, resolve as resolve2, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
var historyDir = (dir) => join(dir, "history");
var journalPath = (dir) => join(historyDir(dir), "journal.jsonl");
function readJournal(dir) {
  const path = journalPath(dir);
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
var maxSeq = (dir, entries) => {
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
function reconcile(dir, { reason = "reconcile" } = {}) {
  mkdirSync(historyDir(dir), { recursive: true });
  const entries = readJournal(dir);
  const lastHashes = lastHashByFile(entries);
  let seq = maxSeq(dir, entries) + 1;
  const added = [];
  for (const [file, direction] of Object.entries(TRACKED_FILES)) {
    const livePath = join(dir, file);
    if (!existsSync(livePath)) continue;
    const content = readFileSync(livePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (lastHashes.get(file) === sha256) continue;
    let snapshot;
    for (; ; ) {
      snapshot = `${String(seq).padStart(5, "0")}_${file}`;
      try {
        writeFileSync(join(historyDir(dir), snapshot), content, { flag: "wx" });
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
    appendFileSync(journalPath(dir), JSON.stringify(entry) + "\n", "utf8");
    lastHashes.set(file, sha256);
    added.push(entry);
    seq += 1;
  }
  return added;
}

// launch.mjs
var here = dirname(fileURLToPath(import.meta.url));
var appPath = [join2(here, "app", "boundbox.html"), join2(here, "boundbox.html")].find((path) => existsSync2(path));
var args = process.argv.slice(2);
var argVal = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== void 0 ? args[i + 1] : fallback;
};
var exchangeDir = resolve2(argVal("dir", "./boundbox"));
var requestedPort = Number(argVal("port", "0"));
var idleSeconds = Number(argVal("idle-seconds", "1800"));
mkdirSync2(exchangeDir, { recursive: true });
var gitignorePath = join2(exchangeDir, ".gitignore");
if (!existsSync2(gitignorePath)) writeFileSync2(gitignorePath, "*\n", "utf8");
reconcile(exchangeDir, { reason: "launch" });
var sessionPath = join2(exchangeDir, ".session.json");
if (existsSync2(sessionPath)) {
  try {
    const prior = JSON.parse(readFileSync2(sessionPath, "utf8"));
    let alive = false;
    try {
      process.kill(prior.pid, 0);
      alive = true;
    } catch {
    }
    if (alive) {
      console.warn(`WARN: a BoundBox session is already serving this folder (pid ${prior.pid}).`);
      console.log(`URL: http://127.0.0.1:${prior.port}/${prior.token}/`);
      process.exit(0);
    }
    rmSync2(sessionPath);
  } catch {
    try {
      rmSync2(sessionPath);
    } catch {
    }
  }
}
var token = crypto.randomUUID();
var OUT_FILES = { boxes: "boxes.json", packet: "packet.json", project: "project.json" };
var lastActivity = Date.now();
var atomicWrite = (filename, text) => {
  const finalPath = join2(exchangeDir, filename);
  const tmpPath = join2(exchangeDir, `.${filename}.${process.pid}.tmp`);
  writeFileSync2(tmpPath, text, "utf8");
  try {
    renameWithRetry(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync2(tmpPath);
    } catch {
    }
    throw err;
  }
};
var respond = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
var requestOriginFor = (req) => {
  try {
    const origin = new URL(`http://${req.headers.host}`).origin;
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" ? origin : null;
  } catch {
    return null;
  }
};
var server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const requestPath = requestUrl.pathname;
  const requestOrigin = requestOriginFor(req);
  if (!requestOrigin) return respond(res, 404, { error: "not found" });
  if (req.method === "POST" && req.headers.origin) {
    let originMatches = false;
    try {
      originMatches = new URL(req.headers.origin).origin === requestOrigin;
    } catch {
    }
    if (!originMatches) return respond(res, 403, { error: "cross-origin writes are not allowed" });
  }
  if (req.method === "GET" && requestPath === "/") {
    res.writeHead(302, { location: `/${token}/`, "cache-control": "no-store" });
    res.end();
    return;
  }
  const [, reqToken, ...rest] = requestPath.split("/");
  if (reqToken !== token) return respond(res, 404, { error: "not found" });
  lastActivity = Date.now();
  const route = rest.join("/");
  if (req.method === "GET" && route === "") {
    try {
      if (!appPath) throw new Error("boundbox.html missing");
      return respond(res, 200, readFileSync2(appPath, "utf8"), "text/html; charset=utf-8");
    } catch {
      return respond(res, 500, { error: "boundbox.html missing (expected app/boundbox.html or a sibling bundle file)" });
    }
  }
  if (req.method === "GET" && route === "ping") {
    return respond(res, 200, { ok: true, idleSeconds });
  }
  if (req.method === "GET" && route === "source") {
    reconcile(exchangeDir, { reason: "source-read" });
    const sourcePath = join2(exchangeDir, "source.wireloom");
    if (!existsSync2(sourcePath)) return respond(res, 404, { error: "no source.wireloom in exchange folder" });
    return respond(res, 200, readFileSync2(sourcePath, "utf8"), "text/plain; charset=utf-8");
  }
  if (req.method === "GET" && route === "project") {
    try {
      reconcile(exchangeDir, { reason: "project-read" });
      const projectPath = join2(exchangeDir, "project.json");
      if (!existsSync2(projectPath)) {
        if (requestUrl.searchParams.get("optional") === "1") return respond(res, 204, "");
        return respond(res, 404, { error: "no project.json in exchange folder" });
      }
      return respond(res, 200, readFileSync2(projectPath, "utf8"), "application/json; charset=utf-8");
    } catch (err) {
      return respond(res, 500, { error: `project read failed on the server: ${err.message}` });
    }
  }
  if (req.method === "GET" && route === "history") {
    return respond(res, 200, { entries: readJournal(exchangeDir) });
  }
  if (req.method === "POST" && route === "save") {
    if (!/^application\/json/.test(req.headers["content-type"] ?? "")) {
      return respond(res, 415, { error: "content-type must be application/json" });
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25e6) req.destroy();
    });
    req.on("end", () => {
      let filename;
      let payload;
      try {
        const parsed = JSON.parse(body);
        if (!Object.hasOwn(parsed, "payload")) return respond(res, 400, { error: "payload is required" });
        payload = parsed.payload;
        filename = typeof parsed.kind === "string" && Object.hasOwn(OUT_FILES, parsed.kind) ? OUT_FILES[parsed.kind] : void 0;
      } catch (err) {
        return respond(res, 400, { error: `invalid JSON body: ${err.message}` });
      }
      if (!filename) return respond(res, 400, { error: `kind must be one of: ${Object.keys(OUT_FILES).join(", ")}` });
      try {
        reconcile(exchangeDir, { reason: "pre-save" });
        atomicWrite(filename, JSON.stringify(payload, null, 2));
        reconcile(exchangeDir, { reason: "save" });
      } catch (err) {
        return respond(res, 500, { error: `save failed on the server: ${err.message}` });
      }
      return respond(res, 200, { ok: true, file: filename });
    });
    return;
  }
  return respond(res, 404, { error: "not found" });
});
server.listen(requestedPort, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync2(sessionPath, JSON.stringify({ pid: process.pid, port, token, startedAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
  console.log(`BoundBox exchange: ${exchangeDir}`);
  console.log(`URL: http://127.0.0.1:${port}/${token}/`);
  console.log(`Idle timeout: ${idleSeconds}s. Ctrl+C to stop.`);
});
var shutdown = (code = 0) => {
  try {
    rmSync2(sessionPath);
  } catch {
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1e3).unref();
};
setInterval(() => {
  if (Date.now() - lastActivity > idleSeconds * 1e3) {
    console.log("Idle timeout reached; shutting down.");
    shutdown(0);
  }
}, 2e3).unref();
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
