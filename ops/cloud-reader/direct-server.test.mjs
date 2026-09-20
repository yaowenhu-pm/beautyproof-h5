import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createDirectServer, DIRECT_VERSION } from './direct-server.mjs';

const workUrl = id => `https://www.douyin.com/video/${id}`;
const url = workUrl('7677397234564041990');
const validSuccess = (target, extra = {}) => {
  const parsed = new URL(target), contentId = parsed.pathname.split('/').filter(Boolean).at(-1);
  return {
    resolved: true, contentStatus: 'body', reasonCode: 'ok', platform: 'douyin', canonicalUrl: target, contentId,
    title: 'fixture', extraction: { pageText: 'fixture body', textStatus: 'full', media: [] },
    diagnostics: { upstreamStatus: 200, elapsedMs: 1, redirects: [{ host: parsed.hostname, path: parsed.pathname, status: 200 }] },
    ...extra,
  };
};
const validFailure = (target, extra = {}) => {
  const parsed = new URL(target), contentId = parsed.pathname.split('/').filter(Boolean).at(-1);
  return {
    resolved: false, contentStatus: 'unavailable', reasonCode: 'browser_required', platform: 'douyin', canonicalUrl: target, contentId,
    extraction: { pageText: '', textStatus: 'limited', media: [] }, diagnostics: { upstreamStatus: 200, elapsedMs: 1, redirects: [] },
    ...extra,
  };
};
const keys = () => generateKeyPairSync('ed25519');
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('condition_timeout');
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

const close = server => new Promise(resolve => server.close(resolve));

function signedBody(privateKey, payload, timestamp = Date.now(), raw = JSON.stringify(payload)) {
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-reader-timestamp': String(timestamp),
      'x-reader-signature': sign(null, Buffer.from(`${timestamp}\n${raw}`), privateKey).toString('base64'),
    },
  };
}

async function post(base, privateKey, payload, timestamp = Date.now(), overrides = {}) {
  const body = overrides.body ?? JSON.stringify(payload);
  const signed = signedBody(privateKey, payload, timestamp, overrides.signedRaw ?? body);
  const response = await fetch(`${base}/v1/resolve`, {
    method: 'POST',
    headers: { ...signed.headers, ...overrides.headers },
    body,
  });
  return { status: response.status, body: await response.json() };
}

const payload = target => ({ requestId: randomUUID(), nonce: randomUUID(), url: target });

test('health is minimal and signed resolve returns only current correlation fields plus result', async t => {
  const { privateKey, publicKey } = keys();
  const result = validSuccess(url, { marker: 'normal' });
  const server = createDirectServer({ publicKey, resolvePublic: async () => result });
  t.after(() => close(server));
  const base = await listen(server);
  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { ok: true, version: DIRECT_VERSION });
  const request = payload(url);
  const response = await post(base, privateKey, request);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { requestId: request.requestId, sourceUrl: url, result });
  assert.equal((await fetch(`${base}/health?verbose=1`)).status, 404);
  assert.equal((await fetch(`${base}/anything`)).status, 404);
});

test('short-link redirect aliases are matched by platform and content id, while a changed id is rejected', async t => {
  const { privateKey, publicKey } = keys();
  const xhsId = '68cf9f12000000001d018abc';
  const dyId = '7677397234564041990';
  const fixtures = new Map([
    ['https://xhslink.com/a/validAlias', {
      resolved: true, contentStatus: 'body', reasonCode: 'ok', platform: 'xiaohongshu',
      canonicalUrl: `https://www.xiaohongshu.com/explore/${xhsId}`, contentId: xhsId,
      title: 'fixture', extraction: { pageText: 'fixture body', textStatus: 'full', media: [] },
      diagnostics: { redirects: [
        { host: 'xhslink.com', path: '/a/validAlias', status: 302 },
        { host: 'www.xiaohongshu.com', path: `/discovery/item/${xhsId}`, status: 200 },
      ] },
    }],
    ['https://v.douyin.com/validAlias/', {
      resolved: true, contentStatus: 'body', reasonCode: 'ok', platform: 'douyin',
      canonicalUrl: `https://www.douyin.com/video/${dyId}`, contentId: dyId,
      title: 'fixture', extraction: { pageText: 'fixture body', textStatus: 'full', media: [] },
      diagnostics: { redirects: [
        { host: 'v.douyin.com', path: '/validAlias/', status: 302 },
        { host: 'www.douyin.com', path: `/share/video/${dyId}`, status: 200 },
      ] },
    }],
    ['https://xhslink.com/a/wrongAlias', {
      resolved: true, contentStatus: 'body', reasonCode: 'ok', platform: 'xiaohongshu',
      canonicalUrl: `https://www.xiaohongshu.com/explore/${xhsId}`, contentId: xhsId,
      title: 'fixture', extraction: { pageText: 'fixture body', textStatus: 'full', media: [] },
      diagnostics: { redirects: [
        { host: 'xhslink.com', path: '/a/wrongAlias', status: 302 },
        { host: 'www.xiaohongshu.com', path: '/discovery/item/68cf9f12000000001d018def', status: 200 },
      ] },
    }],
    ['https://v.douyin.com/wrongAlias/', {
      resolved: true, contentStatus: 'body', reasonCode: 'ok', platform: 'douyin',
      canonicalUrl: `https://www.douyin.com/video/${dyId}`, contentId: dyId,
      title: 'fixture', extraction: { pageText: 'fixture body', textStatus: 'full', media: [] },
      diagnostics: { redirects: [
        { host: 'v.douyin.com', path: '/wrongAlias/', status: 302 },
        { host: 'www.douyin.com', path: '/share/video/7525538910311632128', status: 200 },
      ] },
    }],
  ]);
  const server = createDirectServer({ publicKey, resolvePublic: async target => fixtures.get(target) });
  t.after(() => close(server));
  const base = await listen(server);

  for (const target of ['https://xhslink.com/a/validAlias', 'https://v.douyin.com/validAlias/']) {
    const response = await post(base, privateKey, payload(target));
    assert.equal(response.status, 200);
    assert.equal(response.body.result.resolved, true);
    assert.equal(response.body.result.reasonCode, 'ok');
  }
  for (const target of ['https://xhslink.com/a/wrongAlias', 'https://v.douyin.com/wrongAlias/']) {
    const response = await post(base, privateKey, payload(target));
    assert.equal(response.status, 200);
    assert.equal(response.body.result.resolved, false);
    assert.equal(response.body.result.reasonCode, 'identity_mismatch');
  }
});

test('malformed resolver success is reported as parse_failed rather than network_error', async t => {
  const { privateKey, publicKey } = keys();
  const malformed = validSuccess(url, { extraction: { pageText: '', textStatus: 'full', media: [] } });
  const server = createDirectServer({ publicKey, resolvePublic: async () => malformed });
  t.after(() => close(server));
  const base = await listen(server);
  const response = await post(base, privateKey, payload(url));
  assert.equal(response.status, 200);
  assert.equal(response.body.result.resolved, false);
  assert.equal(response.body.result.reasonCode, 'parse_failed');
});

test('exact raw body is authenticated; stale signatures, replay and non-platform URLs are rejected', async t => {
  const { privateKey, publicKey } = keys();
  let calls = 0;
  const server = createDirectServer({ publicKey, resolvePublic: async target => validSuccess(target, { revision: ++calls }) });
  t.after(() => close(server));
  const base = await listen(server);
  const first = payload(url);
  assert.equal((await post(base, privateKey, first)).status, 200);
  assert.equal((await post(base, privateKey, first)).status, 409);
  const stale = payload(url);
  assert.equal((await post(base, privateKey, stale, Date.now() - 61000)).status, 401);
  const tampered = payload(url);
  assert.equal((await post(base, privateKey, tampered, Date.now(), { signedRaw: JSON.stringify({ ...tampered, url: workUrl('7088264143073053966') }) })).status, 401);
  const invalidReplay = payload('https://127.0.0.1/');
  assert.equal((await post(base, privateKey, invalidReplay)).status, 400);
  assert.equal((await post(base, privateKey, invalidReplay)).status, 409);
  for (const invalid of ['http://www.douyin.com/video/1', 'https://user@www.douyin.com/video/1', 'https://www.douyin.com/']) {
    assert.equal((await post(base, privateKey, payload(invalid))).status, 400);
  }
  assert.equal(calls, 1);
});

test('coalescing and cache retain only result, never another requestId or nonce', async t => {
  const { privateKey, publicKey } = keys();
  let calls = 0;
  let release;
  const result = validSuccess(url, { revision: 1 });
  const server = createDirectServer({ publicKey, resolvePublic: async () => { calls++; return new Promise(resolve => { release = () => resolve(result); }); } });
  t.after(() => close(server));
  const base = await listen(server);
  const first = payload(url), second = payload(url);
  const one = post(base, privateKey, first);
  await waitFor(() => calls === 1);
  const two = post(base, privateKey, second);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.equal(a.body.requestId, first.requestId);
  assert.equal(b.body.requestId, second.requestId);
  assert.deepEqual(a.body.result, result);
  assert.deepEqual(b.body.result, result);
  const third = payload(url);
  const cached = await post(base, privateKey, third);
  assert.equal(calls, 1);
  assert.equal(cached.body.requestId, third.requestId);
  assert.equal(JSON.stringify(cached.body).includes(first.nonce), false);
  assert.equal(JSON.stringify(cached.body).includes(second.requestId), false);
});

test('global resolver concurrency is one with at most three queued unique URLs; duplicates coalesce', async t => {
  const { privateKey, publicKey } = keys();
  const releases = [];
  let running = 0, maxRunning = 0, calls = 0;
  const server = createDirectServer({ publicKey, resolvePublic: async target => {
    calls++;
    running++;
    maxRunning = Math.max(maxRunning, running);
    return new Promise(resolve => releases.push(() => { running--; resolve(validSuccess(target, { source: target })); }));
  } });
  t.after(() => close(server));
  const base = await listen(server);
  const urls = ['7088264143073053966', '7661210942511910163', '7629237441732702132', '7356180215036497171', '7372483858861722921'].map(workUrl);
  const accepted = [post(base, privateKey, payload(urls[0]))];
  await waitFor(() => calls === 1);
  accepted.push(post(base, privateKey, payload(urls[1])));
  accepted.push(post(base, privateKey, payload(urls[2])));
  accepted.push(post(base, privateKey, payload(urls[3])));
  await new Promise(resolve => setTimeout(resolve, 20));
  const full = await post(base, privateKey, payload(urls[4]));
  assert.equal(full.status, 429);
  for (let expected = 1; expected <= 4; expected++) {
    await waitFor(() => releases.length >= expected);
    releases[expected - 1]();
  }
  assert.ok((await Promise.all(accepted)).every(response => response.status === 200));
  assert.equal(calls, 4);
  assert.equal(maxRunning, 1);
});

test('global fixed-window rate limit counts cache hits and resets next minute', async t => {
  const { privateKey, publicKey } = keys();
  let time = 1700000000000, calls = 0;
  const server = createDirectServer({ publicKey, now: () => time, resolvePublic: async target => validSuccess(target, { revision: ++calls }) });
  t.after(() => close(server));
  const base = await listen(server);
  for (let i = 0; i < 20; i++) assert.equal((await post(base, privateKey, payload(url), time)).status, 200);
  assert.equal((await post(base, privateKey, payload(url), time)).status, 429);
  assert.equal(calls, 1);
  time += 60000;
  assert.equal((await post(base, privateKey, payload(url), time)).status, 200);
});

test('success is cached five minutes and failure ten seconds without extending on hits', async t => {
  const { privateKey, publicKey } = keys();
  let time = 1700000000000;
  const calls = new Map();
  const successUrl = url, failureUrl = workUrl('7088264143073053966');
  const server = createDirectServer({ publicKey, now: () => time, resolvePublic: async target => {
    calls.set(target, (calls.get(target) ?? 0) + 1);
    return target === successUrl ? validSuccess(target, { revision: calls.get(target) }) : validFailure(target, { revision: calls.get(target) });
  } });
  t.after(() => close(server));
  const base = await listen(server);
  await post(base, privateKey, payload(successUrl), time);
  time += 299999;
  assert.equal((await post(base, privateKey, payload(successUrl), time)).body.result.revision, 1);
  time += 1;
  assert.equal((await post(base, privateKey, payload(successUrl), time)).body.result.revision, 2);
  await post(base, privateKey, payload(failureUrl), time);
  time += 9999;
  assert.equal((await post(base, privateKey, payload(failureUrl), time)).body.result.revision, 1);
  time += 1;
  assert.equal((await post(base, privateKey, payload(failureUrl), time)).body.result.revision, 2);
});

test('total deadline returns one timeout result and never retries a stuck resolver', async t => {
  const { privateKey, publicKey } = keys();
  let calls = 0;
  const server = createDirectServer({ publicKey, requestDeadlineMs: 30, resolvePublic: async () => { calls++; return new Promise(() => {}); } });
  t.after(() => close(server));
  const base = await listen(server);
  const response = await post(base, privateKey, payload(url));
  assert.equal(response.status, 200);
  assert.equal(response.body.result.resolved, false);
  assert.equal(response.body.result.reasonCode, 'timeout');
  assert.equal(calls, 1);
});

test('body size and total body-read time are bounded before JSON parsing', async t => {
  const { privateKey, publicKey } = keys();
  const server = createDirectServer({ publicKey, bodyLimit: 64, bodyTimeoutMs: 30, resolvePublic: async () => assert.fail('resolver must not run') });
  t.after(() => close(server));
  const base = await listen(server);
  const oversized = payload(url);
  assert.equal((await post(base, privateKey, oversized)).status, 413);
  const raw = '{';
  const timestamp = Date.now();
  const signed = signedBody(privateKey, null, timestamp, raw);
  const status = await new Promise((resolve, reject) => {
    const endpoint = new URL('/v1/resolve', base);
    const request = httpRequest(endpoint, { method: 'POST', headers: signed.headers }, response => {
      response.resume();
      response.once('end', () => { request.destroy(); resolve(response.statusCode); });
    });
    request.once('error', reject);
    request.write(raw);
  });
  assert.equal(status, 408);
});
