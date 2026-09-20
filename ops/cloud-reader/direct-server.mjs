import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLink } from './lib/server/link-resolver.mjs';
import { emptyResolution } from './lib/shared/link-page.mjs';
import { contentIdFor, extractShareUrl, platformFor } from './lib/shared/links.mjs';

export const DIRECT_VERSION = '1.0-direct';
export const DIRECT_HOST = '127.0.0.1';
export const DIRECT_PORT = 18080;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const json = (response, status, body) => {
  const raw = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(raw);
};

const header = (request, name) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
};

export function publicKeyFromDerBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 512) throw new Error('invalid_public_key');
  try {
    return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('invalid_public_key');
  }
}

function readBody(request, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) return finish(new RequestError(413, 'body_too_large'));
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, size));
    const onAborted = () => finish(new RequestError(400, 'request_aborted'));
    const onError = () => finish(new RequestError(400, 'invalid_request'));
    const timer = setTimeout(() => finish(new RequestError(408, 'body_timeout')), timeoutMs);
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('aborted', onAborted);
    request.on('error', onError);
  });
}

const timeoutResult = (platform, url, startedAt, now) => ({
  ...emptyResolution(platform, new URL(url), 'timeout'),
  resolverVersion: DIRECT_VERSION,
  diagnostics: { transport: 'direct-https', upstreamStatus: 0, redirects: [], elapsedMs: Math.max(0, now() - startedAt) },
});

const errorResult = (platform, url, startedAt, now) => ({
  ...emptyResolution(platform, new URL(url), 'network_error'),
  resolverVersion: DIRECT_VERSION,
  diagnostics: { transport: 'direct-https', upstreamStatus: 0, redirects: [], elapsedMs: Math.max(0, now() - startedAt) },
});

const validationFailure = (platform, url, reasonCode, startedAt, now) => ({
  ...emptyResolution(platform, new URL(url), reasonCode),
  resolverVersion: DIRECT_VERSION,
  diagnostics: { transport: 'direct-https', upstreamStatus: 0, redirects: [], elapsedMs: Math.max(0, now() - startedAt) },
});

const normalResolvePublic = (url, platform) => resolveLink(new URL(url), platform);

function validatedResult(url, platform, raw, startedAt, now) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.platform !== platform) throw new Error('invalid_result');
    const source = new URL(url);
    const canonical = new URL(String(raw.canonicalUrl));
    if (platformFor(canonical) !== platform) throw new Error('identity_mismatch');
    const sourceId = contentIdFor(platform, source);
    const canonicalId = contentIdFor(platform, canonical);
    if (String(raw.contentId ?? '') !== canonicalId || (sourceId && sourceId !== canonicalId)) throw new Error('identity_mismatch');
    const resolved = raw.resolved === true;
    const extraction = raw.extraction && typeof raw.extraction === 'object' && !Array.isArray(raw.extraction) ? raw.extraction : {};
    const pageText = typeof extraction.pageText === 'string' ? extraction.pageText.trim() : '';
    const media = Array.isArray(extraction.media) ? extraction.media : [];
    if (resolved && !canonicalId) throw new Error('invalid_result');
    if (resolved && raw.contentStatus === 'body' && !(raw.reasonCode === 'ok' && extraction.textStatus === 'full' && pageText)) throw new Error('invalid_result');
    if (resolved && raw.contentStatus === 'title_only' && !(raw.reasonCode === 'metadata_only' && pageText)) throw new Error('invalid_result');
    if (resolved && raw.contentStatus === 'media_only' && !(raw.reasonCode === 'media_only' && media.length)) throw new Error('invalid_result');
    if (resolved && !['body', 'title_only', 'media_only'].includes(raw.contentStatus)) throw new Error('invalid_result');
    if (!resolved && ['ok', 'metadata_only', 'media_only'].includes(raw.reasonCode)) throw new Error('invalid_result');
    const redirects = Array.isArray(raw.diagnostics?.redirects) ? raw.diagnostics.redirects : [];
    if (resolved && !sourceId) {
      const first = redirects[0], last = redirects.at(-1);
      if (!first || !last || first.host !== source.hostname.toLowerCase() || first.path !== source.pathname) throw new Error('identity_mismatch');
      let lastUrl;
      try {
        lastUrl = new URL(`https://${last.host}${last.path}`);
      } catch {
        throw new Error('identity_mismatch');
      }
      if (platformFor(lastUrl) !== platform || contentIdFor(platform, lastUrl) !== canonicalId) throw new Error('identity_mismatch');
    }
    return raw;
  } catch (error) {
    const reasonCode = error instanceof Error && error.message === 'identity_mismatch' ? 'identity_mismatch' : 'parse_failed';
    return validationFailure(platform, url, reasonCode, startedAt, now);
  }
}

export async function loadResolvePublic() {
  try {
    const browser = await import('./browser-reader.mjs');
    if (typeof browser.resolvePublic === 'function') {
      return {
        resolvePublic: browser.resolvePublic,
        closePublicBrowser: typeof browser.closePublicBrowser === 'function' ? browser.closePublicBrowser : async () => {},
      };
    }
    if (typeof browser.createBrowserReader === 'function') {
      const instance = await browser.createBrowserReader();
      const resolvePublic = instance?.resolvePublic ?? instance?.read;
      if (typeof resolvePublic === 'function') return { resolvePublic, closePublicBrowser: typeof instance.close === 'function' ? instance.close : async () => {} };
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND')) throw error;
  }
  return { resolvePublic: normalResolvePublic, closePublicBrowser: async () => {} };
}

export function createDirectServer({
  publicKey,
  resolvePublic = normalResolvePublic,
  now = Date.now,
  bodyLimit = 12 * 1024,
  bodyTimeoutMs = 3000,
  requestDeadlineMs = 35000,
  nonceTtlMs = 120000,
  successTtlMs = 300000,
  failureTtlMs = 10000,
  globalPerMinute = 20,
  maxPending = 3,
} = {}) {
  if (!publicKey || typeof resolvePublic !== 'function') throw new Error('missing_dependency');
  const nonces = new Map();
  const cache = new Map();
  const inFlight = new Map();
  const queue = [];
  let active = null;
  let rateWindow = -1;
  let rateCount = 0;

  const prune = current => {
    for (const [nonce, expires] of nonces) if (expires <= current) nonces.delete(nonce);
    for (const [url, entry] of cache) if (entry.expires <= current) cache.delete(url);
    while (cache.size > 100) cache.delete(cache.keys().next().value);
  };

  const cacheResult = (url, result, current) => {
    cache.set(url, { result, expires: current + (result?.resolved === true ? successTtlMs : failureTtlMs) });
  };

  const removeQueued = task => {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
  };

  const settleTimeout = task => {
    if (task.settled) return;
    task.settled = true;
    if (task.state === 'queued') removeQueued(task);
    if (task.state === 'running') task.controller?.abort();
    if (inFlight.get(task.url) === task) inFlight.delete(task.url);
    const result = timeoutResult(task.platform, task.url, task.startedAt, now);
    cacheResult(task.url, result, now());
    task.resolve(result);
  };

  const drain = () => {
    if (active) return;
    while (queue.length) {
      const task = queue.shift();
      if (!task.settled) return void run(task);
    }
  };

  const run = async task => {
    active = task;
    task.state = 'running';
    task.controller = new AbortController();
    try {
      const result = await resolvePublic(task.url, task.platform, { signal: task.controller.signal });
      if (!task.settled) {
        task.settled = true;
        clearTimeout(task.timer);
        if (inFlight.get(task.url) === task) inFlight.delete(task.url);
        const safeResult = validatedResult(task.url, task.platform, result, task.startedAt, now);
        cacheResult(task.url, safeResult, now());
        task.resolve(safeResult);
      }
    } catch {
      if (!task.settled) {
        task.settled = true;
        clearTimeout(task.timer);
        if (inFlight.get(task.url) === task) inFlight.delete(task.url);
        const result = errorResult(task.platform, task.url, task.startedAt, now);
        cacheResult(task.url, result, now());
        task.resolve(result);
      }
    } finally {
      active = null;
      drain();
    }
  };

  const schedule = (url, platform, deadlineAt, startedAt) => {
    const current = now();
    const cached = cache.get(url);
    if (cached && cached.expires > current) return Promise.resolve(cached.result);
    if (cached) cache.delete(url);
    const existing = inFlight.get(url);
    if (existing) return existing.promise;
    if (active && queue.filter(task => !task.settled).length >= maxPending) throw new RequestError(429, 'queue_full');
    let resolveTask;
    const promise = new Promise(resolve => { resolveTask = resolve; });
    const task = { url, platform, deadlineAt, startedAt, promise, resolve: resolveTask, state: active ? 'queued' : 'new', settled: false, controller: null, timer: null };
    task.timer = setTimeout(() => settleTimeout(task), Math.max(0, deadlineAt - current));
    inFlight.set(url, task);
    if (active) queue.push(task); else void run(task);
    return promise;
  };

  const server = createServer(async (request, response) => {
    const startedAt = now();
    try {
      if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true, version: DIRECT_VERSION });
      if (request.method !== 'POST' || request.url !== '/v1/resolve') throw new RequestError(404, 'not_found');
      if (!/^application\/json(?:\s*;|$)/i.test(header(request, 'content-type'))) throw new RequestError(415, 'json_required');
      const timestamp = header(request, 'x-reader-timestamp');
      const signature = header(request, 'x-reader-signature');
      if (!/^\d{13}$/.test(timestamp) || Math.abs(startedAt - Number(timestamp)) > 60000 || !SIGNATURE.test(signature)) throw new RequestError(401, 'unauthorized');
      const contentLength = header(request, 'content-length');
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > bodyLimit)) throw new RequestError(413, 'body_too_large');
      const raw = await readBody(request, bodyLimit, bodyTimeoutMs);
      const signed = Buffer.concat([Buffer.from(`${timestamp}\n`), raw]);
      if (!verify(null, signed, publicKey, Buffer.from(signature, 'base64'))) throw new RequestError(401, 'unauthorized');
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { throw new RequestError(400, 'invalid_json'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'nonce,requestId,url') throw new RequestError(400, 'invalid_request');
      if (!UUID.test(payload.requestId ?? '') || !UUID.test(payload.nonce ?? '') || typeof payload.url !== 'string' || payload.url.length > 2000) throw new RequestError(400, 'invalid_request');
      const window = Math.floor(startedAt / 60000);
      if (window !== rateWindow) { rateWindow = window; rateCount = 0; }
      if (++rateCount > globalPerMinute) throw new RequestError(429, 'rate_limited');
      prune(startedAt);
      if ((nonces.get(payload.nonce) ?? 0) > startedAt) throw new RequestError(409, 'replayed_request');
      nonces.set(payload.nonce, startedAt + nonceTtlMs);
      const input = extractShareUrl(payload.url);
      if (!input || input !== payload.url) throw new RequestError(400, 'invalid_url');
      const parsed = new URL(input);
      const platform = platformFor(parsed);
      if (!platform) throw new RequestError(400, 'invalid_url');
      const result = await schedule(input, platform, startedAt + requestDeadlineMs, startedAt);
      return json(response, 200, { requestId: payload.requestId, sourceUrl: payload.url, result });
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 503;
      const code = error instanceof RequestError ? error.code : 'reader_unavailable';
      return json(response, status, { error: code });
    }
  });

  return server;
}

export async function main() {
  const publicKey = publicKeyFromDerBase64(process.env.BEAUTYPROOF_SITE_PUBLIC_KEY ?? '');
  const browser = await loadResolvePublic();
  const server = createDirectServer({ publicKey, resolvePublic: browser.resolvePublic });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const serverClosed = new Promise(resolve => server.close(resolve));
    const browserClosed = Promise.resolve().then(() => browser.closePublicBrowser());
    await Promise.all([serverClosed, browserClosed]);
  };
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(DIRECT_PORT, DIRECT_HOST, resolve);
  });
  console.log(JSON.stringify({ ok: true, version: DIRECT_VERSION, host: DIRECT_HOST, port: DIRECT_PORT }));
}

if (process.argv[1] && pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url) await main();
