import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '2.0-anonymous-xhs';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const HOSTS = new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'xhslink.cn']);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = (res, status, value) => {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(data);
};
const failure = (status, code) => Object.assign(new Error(code), {status, code});
export function signingPayload(timestamp, nonce, method, path, token, body = Buffer.alloc(0)) {
  return Buffer.from(`${timestamp}\n${nonce}\n${method}\n${path}\n${token}\n${sha(body)}`);
}
export function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw failure(400, 'invalid_url');
  let url;
  try { url = new URL(value); } catch { throw failure(400, 'invalid_url'); }
  if (!HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port)) || url.hash) throw failure(400, 'invalid_url');
  const short = url.hostname === 'xhslink.cn' || url.hostname === 'xhslink.com';
  if (short ? !/^\/(?:o\/[A-Za-z\d]+|[A-Za-z\d]+)$/.test(url.pathname) : !/^\/(?:explore|discovery\/item)\/[a-f\d]{24}$/i.test(url.pathname)) throw failure(400, 'invalid_url');
  return value;
}
async function bodyOf(req) {
  if (Number(req.headers['content-length'] || 0) > 8192) throw failure(413, 'body_too_large');
  const chunks = [];
  let length = 0;
  const timeout = setTimeout(() => req.destroy(), 3000);
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 8192) throw failure(413, 'body_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timeout); }
}
function stopChild(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}
export function pythonExecutor({python, reader, worker, deadlineMs = 300000}) {
  return (url, directory) => new Promise(resolveResult => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG'].includes(key)));
    Object.assign(env, {PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1'});
    const child = spawn(python, [worker, '--reader', reader, '--out', directory], {env, cwd: dirname(resolve(worker)), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', overflow = false, settled = false, timedOut = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(value); } };
    const timer = setTimeout(() => { timedOut = true; stopChild(child); }, deadlineMs);
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 4 * 1024 * 1024) { overflow = true; stopChild(child); }
      else stdout += chunk;
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ok: false, error: 'worker_start_failed'}));
    child.on('close', code => {
      if (timedOut || overflow) return finish({ok: false, error: timedOut ? 'timeout' : 'result_too_large'});
      try {
        const data = JSON.parse(stdout.trim());
        finish(code === 0 ? data : {ok: false, error: data.error || 'worker_failed'});
      } catch { finish({ok: false, error: 'invalid_worker_result'}); }
    });
    child.stdin.end(JSON.stringify({url}));
  });
}
export async function createJobServer({publicKey, dataDirectory, execute, ttlMs = 3600000, maxPending = 3, maxJobs = 20, failureCooldownMs = 60000, now = Date.now} = {}) {
  if (!publicKey || !execute) throw new Error('missing_dependency');
  const root = resolve(dataDirectory);
  await mkdir(root, {recursive: true, mode: 0o700});
  const jobs = new Map(), nonces = new Map(), cooldowns = new Map(), queue = [];
  let active = false, rateWindow = -1, rateCount = 0;
  const prune = async () => {
    const time = now();
    for (const [key, until] of nonces) if (until <= time) nonces.delete(key);
    for (const [key, until] of cooldowns) if (until <= time) cooldowns.delete(key);
    for (const [id, job] of jobs) {
      if (job.expires <= time && !['queued', 'running'].includes(job.status)) {
        jobs.delete(id);
        const target = resolve(root, id);
        if (target.startsWith(root + sep) && UUID.test(id)) await rm(target, {recursive: true, force: true});
      }
    }
    // In-memory jobs intentionally do not survive restart; remove expired orphan
    // evidence under this service's private UUID directory only.
    for (const entry of await readdir(root, {withFileTypes: true})) {
      if (!entry.isDirectory() || !UUID.test(entry.name) || jobs.has(entry.name)) continue;
      const target = resolve(root, entry.name);
      if (target.startsWith(root + sep) && time - (await stat(target)).mtimeMs >= ttlMs) await rm(target, {recursive: true, force: true});
    }
  };
  const publicJob = job => ({jobId: job.id, requestId: job.requestId, sourceUrl: job.url, status: job.status,
    createdAt: new Date(job.created).toISOString(), expiresAt: new Date(job.expires).toISOString(),
    ...(job.started ? {startedAt: new Date(job.started).toISOString()} : {}),
    ...(job.finished ? {finishedAt: new Date(job.finished).toISOString()} : {}),
    ...(job.result ? {result: job.result} : {}), ...(job.error ? {error: job.error} : {}), pollAfterMs: 1500});
  const pump = async () => {
    if (active || !queue.length) return;
    active = true;
    const job = queue.shift(); job.status = 'running'; job.started = now();
    try {
      const output = await execute(job.url, resolve(root, job.id));
      if (!output.ok || !output.auditPassed) throw failure(422, output.error || 'audit_failed');
      const result = output.result;
      if (!result?.text?.trim() || result.mediaStatus !== 'complete' || result.images.length !== result.sourceImageCount || !/^[a-f\d]{24}$/.test(result.noteId)) throw failure(422, 'audit_failed');
      if (result.accountUsed !== false || result.browserCookiesRead !== false || result.cacheUsed !== false) throw failure(422, 'audit_failed');
      const evidence = await realpath(output.evidenceDirectory);
      const expected = resolve(root, job.id) + sep;
      if (!evidence.startsWith(expected)) throw failure(422, 'invalid_media_path');
      const files = [];
      for (const [i, image] of result.images.entries()) {
        if (image.index !== i + 1 || !/^images\/[\d]+\.[a-z\d]+$/.test(image.file)) throw failure(422, 'invalid_media_path');
        const file = await realpath(resolve(evidence, image.file));
        if (!file.startsWith(evidence + sep)) throw failure(422, 'invalid_media_path');
        const data = await readFile(file);
        if (data.length !== image.bytes || sha(data) !== image.sha256) throw failure(422, 'media_hash_mismatch');
        files.push(file);
      }
      job.files = files;
      job.result = {...result, images: result.images.map(({file, ...image}) => ({...image, mediaPath: `/v2/xhs/jobs/${job.id}/media/${image.index}`}))};
      job.status = 'complete';
    } catch (error) {
      job.error = /^[a-z_]{1,64}$/.test(error.code || '') ? error.code : 'worker_failed';
      job.status = 'failed'; cooldowns.set(sha(job.url), now() + failureCooldownMs);
    } finally {
      job.finished = now(); job.expires = job.finished + ttlMs; active = false; void pump();
    }
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, {ok: true, version: VERSION});
      const path = req.url || '';
      const match = /^\/v2\/xhs\/jobs\/([a-f\d-]{36})(?:\/media\/([1-9]\d{0,2}))?$/.exec(path);
      if (!(req.method === 'POST' && path === '/v2/xhs/jobs') && !(req.method === 'GET' && match)) throw failure(404, 'not_found');
      const timestamp = req.headers['x-reader-timestamp'], nonce = req.headers['x-reader-nonce'], token = req.headers['x-reader-job-token'] || '', signature = req.headers['x-reader-signature'];
      if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 60000 || typeof nonce !== 'string' || !UUID.test(nonce) || typeof token !== 'string' || token.length > 100 || typeof signature !== 'string' || !/^[A-Za-z\d+/]{86}==$/.test(signature)) throw failure(401, 'unauthorized');
      const raw = await bodyOf(req);
      if (!verify(null, signingPayload(timestamp, nonce, req.method, path, token, raw), publicKey, Buffer.from(signature, 'base64'))) throw failure(401, 'unauthorized');
      await prune();
      if (nonces.has(nonce)) throw failure(409, 'replayed_request');
      nonces.set(nonce, now() + 120000);
      const window = Math.floor(now() / 60000);
      if (window !== rateWindow) { rateWindow = window; rateCount = 0; }
      if (++rateCount > 180) throw failure(429, 'rate_limited');
      if (req.method === 'POST') {
        if (token || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(400, 'invalid_request');
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)); } catch { throw failure(400, 'invalid_json'); }
        if (!payload || Object.keys(payload).sort().join(',') !== 'requestId,url' || !UUID.test(payload.requestId || '')) throw failure(400, 'invalid_request');
        validateUrl(payload.url);
        if (cooldowns.has(sha(payload.url))) throw failure(429, 'upstream_cooldown');
        if (queue.length >= maxPending || jobs.size >= maxJobs) throw failure(429, 'queue_full');
        // requestId is idempotent only for the submitting application, never a cross-URL cache key.
        if ([...jobs.values()].some(job => job.requestId === payload.requestId)) throw failure(409, 'duplicate_request_id');
        const jobToken = randomBytes(32).toString('base64url'), id = randomUUID();
        const job = {id, tokenHash: sha(jobToken), requestId: payload.requestId, url: payload.url, status: 'queued', created: now(), expires: now() + ttlMs};
        jobs.set(id, job); queue.push(job);
        json(res, 202, {...publicJob(job), jobToken}); void pump(); return;
      }
      if (raw.length) throw failure(400, 'invalid_request');
      const job = jobs.get(match[1]);
      if (!job || !timingSafeEqual(Buffer.from(job.tokenHash, 'hex'), Buffer.from(sha(token), 'hex'))) throw failure(404, 'not_found');
      if (!match[2]) return json(res, 200, publicJob(job));
      if (job.status !== 'complete') throw failure(409, 'media_not_ready');
      const index = Number(match[2]) - 1, file = job.files[index], image = job.result.images[index];
      if (!file || !image) throw failure(404, 'not_found');
      const data = await readFile(file);
      if (sha(data) !== image.sha256) throw failure(422, 'media_hash_mismatch');
      const mime = {JPEG: 'image/jpeg', PNG: 'image/png', WEBP: 'image/webp', GIF: 'image/gif', AVIF: 'image/avif'}[image.format];
      if (!mime) throw failure(415, 'unsupported_image_format');
      res.writeHead(200, {'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': image.sha256}); res.end(data);
    } catch (error) { if (!res.headersSent) json(res, error.status || 503, {error: error.code || 'reader_unavailable'}); }
  });
  await prune();
  const timer = setInterval(() => { void prune().catch(() => {}); }, 60000); timer.unref();
  server.on('close', () => clearInterval(timer));
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  return server;
}
async function main() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const publicKey = createPublicKey({key: Buffer.from(process.env.BEAUTYPROOF_SITE_PUBLIC_KEY || '', 'base64'), format: 'der', type: 'spki'});
  const server = await createJobServer({publicKey, dataDirectory: process.env.XHS_JOB_DATA_DIR || '/var/lib/beautyproof-xhs/jobs',
    execute: pythonExecutor({python: process.env.XHS_PYTHON || resolve(here, '.venv/bin/python'), reader: resolve(here, 'reader/read_xhs.py'), worker: resolve(here, 'worker.py')})});
  server.listen(18081, '127.0.0.1', () => console.log(JSON.stringify({ok: true, version: VERSION, host: '127.0.0.1', port: 18081})));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
