/**
 * BoundBox JIT launcher (D-006/D-008): zero-dependency local server + exchange folder.
 *
 *   node launch.mjs [--dir ./boundbox] [--port 0] [--idle-seconds 1800]
 *
 * Serves the app at http://127.0.0.1:{port}/{token}/ — the random token defeats
 * blind cross-origin POSTs from other pages. Exchange contract:
 *   {dir}/source.wireloom  in   (wireframe source, written by the AI)
 *   {dir}/boxes.json       out  (sketch profile)
 *   {dir}/packet.json      out  (iterate profile: source + edit deltas)
 *   {dir}/project.json     out  (persistence)
 * Writes are atomic (tmp + rename). The server exits after idle-seconds of
 * inactivity; nothing keeps running in the background.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile, readJournal, renameWithRetry } from './src/journal.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// --- CLI args ---------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const exchangeDir = resolve(argVal('dir', './boundbox'));
const requestedPort = Number(argVal('port', '0'));
const idleSeconds = Number(argVal('idle-seconds', '1800'));

// --- Exchange folder ----------------------------------------------------------
mkdirSync(exchangeDir, { recursive: true });
const gitignorePath = join(exchangeDir, '.gitignore');
if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, '*\n', 'utf8');

// Journal anything that changed while no server was running (D-016).
reconcile(exchangeDir, { reason: 'launch' });

// Second launch in the same folder: warn and reuse the live session (plan rule).
const sessionPath = join(exchangeDir, '.session.json');
if (existsSync(sessionPath)) {
  try {
    const prior = JSON.parse(readFileSync(sessionPath, 'utf8'));
    let alive = false;
    try { process.kill(prior.pid, 0); alive = true; } catch { /* dead */ }
    if (alive) {
      console.warn(`WARN: a BoundBox session is already serving this folder (pid ${prior.pid}).`);
      console.log(`URL: http://127.0.0.1:${prior.port}/${prior.token}/`);
      process.exit(0);
    }
    rmSync(sessionPath);
  } catch { try { rmSync(sessionPath); } catch { /* ignore */ } }
}

// --- Server -------------------------------------------------------------------
const token = crypto.randomUUID();
const OUT_FILES = { boxes: 'boxes.json', packet: 'packet.json', project: 'project.json' };
let lastActivity = Date.now();

const atomicWrite = (filename, text) => {
  const finalPath = join(exchangeDir, filename);
  const tmpPath = join(exchangeDir, `.${filename}.${process.pid}.tmp`);
  writeFileSync(tmpPath, text, 'utf8');
  try {
    renameWithRetry(tmpPath, finalPath);
  } catch (err) {
    try { rmSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
};

const respond = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  lastActivity = Date.now();
  const [, reqToken, ...rest] = req.url.split('?')[0].split('/');
  if (reqToken !== token) return respond(res, 404, { error: 'not found' });
  const route = rest.join('/');

  if (req.method === 'GET' && route === '') {
    try {
      return respond(res, 200, readFileSync(join(here, 'app', 'boundbox.html'), 'utf8'), 'text/html; charset=utf-8');
    } catch {
      return respond(res, 500, { error: 'app/boundbox.html missing' });
    }
  }

  if (req.method === 'GET' && route === 'source') {
    reconcile(exchangeDir, { reason: 'source-read' }); // journal AI writes before serving them
    const sourcePath = join(exchangeDir, 'source.wireloom');
    if (!existsSync(sourcePath)) return respond(res, 404, { error: 'no source.wireloom in exchange folder' });
    return respond(res, 200, readFileSync(sourcePath, 'utf8'), 'text/plain; charset=utf-8');
  }

  if (req.method === 'GET' && route === 'history') {
    return respond(res, 200, { entries: readJournal(exchangeDir) });
  }

  if (req.method === 'POST' && route === 'save') {
    if (!/^application\/json/.test(req.headers['content-type'] ?? '')) {
      return respond(res, 415, { error: 'content-type must be application/json' });
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 25_000_000) req.destroy(); });
    req.on('end', () => {
      let filename;
      let payload;
      try {
        const parsed = JSON.parse(body);
        payload = parsed.payload;
        filename = OUT_FILES[parsed.kind];
      } catch (err) {
        return respond(res, 400, { error: `invalid JSON body: ${err.message}` });
      }
      if (!filename) return respond(res, 400, { error: `kind must be one of: ${Object.keys(OUT_FILES).join(', ')}` });
      try {
        atomicWrite(filename, JSON.stringify(payload, null, 2));
        reconcile(exchangeDir, { reason: 'save' });
      } catch (err) {
        // Server-side failure (disk, antivirus lock) — not the client's fault.
        return respond(res, 500, { error: `save failed on the server: ${err.message}` });
      }
      return respond(res, 200, { ok: true, file: filename });
    });
    return;
  }

  return respond(res, 404, { error: 'not found' });
});

server.listen(requestedPort, '127.0.0.1', () => {
  const { port } = server.address();
  writeFileSync(sessionPath, JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }), 'utf8');
  console.log(`BoundBox exchange: ${exchangeDir}`);
  console.log(`URL: http://127.0.0.1:${port}/${token}/`);
  console.log(`Idle timeout: ${idleSeconds}s. Ctrl+C to stop.`);
});

const shutdown = (code = 0) => {
  try { rmSync(sessionPath); } catch { /* ignore */ }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();
};

setInterval(() => {
  if (Date.now() - lastActivity > idleSeconds * 1000) {
    console.log('Idle timeout reached; shutting down.');
    shutdown(0);
  }
}, 2000).unref();

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
