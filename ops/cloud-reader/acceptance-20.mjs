// Fixed-sample, resolve-only acceptance. Never import a browser/profile/model module.
// Offline verification: node acceptance-20.mjs --self-test
// Live: --endpoint <HTTPS /api/resolve> --outdir <local directory>
// Signed: add --signed; READER_PRIVATE_KEY is PEM or base64 PKCS8 DER in memory.
// The sole HTTP exception is http://127.0.0.1:18080/v1/resolve with --signed.
// Optional private overrides JSON: { "7": "https://www.xiaohongshu.com/explore/<same-id>?..." }
// This file never reads smoke-entry.mjs and never writes full input queries or body text.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentIdFor, platformFor } from './lib/shared/links.mjs';

export const INTERVAL_MS = 10_500;
export const DEADLINE_MS = 45_000;
const RESPONSE_LIMIT = 1_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'candidates-20260920.json');
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const text = value => typeof value === 'string' ? value.trim() : '';
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const safeCode = value => typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : null;
const sleep = ms => new Promise(done => setTimeout(done, ms));

class AcceptanceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AcceptanceError(code); };

export function cleanUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? `${url.protocol}//${url.host}${url.pathname}` : '';
  } catch { return ''; }
}

function publicWork(value, platform) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_work_url'); }
  if (platformFor(url) !== platform || url.hash || url.toString() !== value || value.length > 2000) fail('invalid_work_url');
  const id = contentIdFor(platform, url);
  if (!id && !/^(?:v\.douyin\.com|(?:www\.)?xhslink\.(?:cn|com)|(?:www\.)?xhs\.cn)$/.test(url.hostname)) fail('invalid_work_url');
  // A path ID and modal_id must never name different works.
  const modal = platform === 'douyin' ? url.searchParams.get('modal_id') : null;
  if (modal && (!/^\d+$/.test(modal) || (id && id !== modal))) fail('conflicting_work_id');
  return { url, id };
}

export function validateEndpoint(value, signed) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_endpoint'); }
  const loopback = signed && value === 'http://127.0.0.1:18080/v1/resolve';
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash ||
      url.pathname !== (signed ? '/v1/resolve' : '/api/resolve')) fail('invalid_endpoint');
  return url.toString();
}

export function validateCandidates(data) {
  if (!record(data) || !Array.isArray(data.items) || data.items.length !== 20) fail('expected_20_fixed_candidates');
  return data.items.map((item, index) => {
    const platform = index < 10 ? 'xiaohongshu' : 'douyin';
    if (item?.platform !== platform || typeof item.inputUrl !== 'string') fail('invalid_candidate_order');
    publicWork(item.inputUrl, platform);
    return { index: index + 1, platform, originalUrl: item.inputUrl, inputUrl: item.inputUrl, overridden: false };
  });
}

export function applyOverrides(items, overrides = {}) {
  if (!record(overrides)) fail('invalid_overrides');
  const output = items.map(item => ({ ...item }));
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^(?:[1-9]|1\d|20)$/.test(key) || typeof value !== 'string') fail('invalid_override_entry');
    const item = output[Number(key) - 1];
    const original = publicWork(item.originalUrl, item.platform);
    const replacement = publicWork(value, item.platform);
    const sameIdentity = original.id
      ? replacement.id === original.id
      : !replacement.id && replacement.url.origin === original.url.origin && replacement.url.pathname === original.url.pathname;
    if (!sameIdentity) fail('override_identity_mismatch');
    item.inputUrl = value;
    item.overridden = true;
  }
  return output;
}

export function privateKeyFromEnvironment(value) {
  if (typeof value !== 'string' || !value.trim()) fail('missing_reader_private_key');
  try {
    const source = value.trim();
    const key = source.startsWith('-----BEGIN PRIVATE KEY-----')
      ? createPrivateKey(source)
      : createPrivateKey({ key: Buffer.from(source, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') fail('invalid_reader_private_key');
    return key;
  } catch { fail('invalid_reader_private_key'); }
}

export function createRequest(inputUrl, signed, privateKey, now = Date.now()) {
  const requestId = signed ? randomUUID() : null;
  const payload = signed ? { requestId, nonce: randomUUID(), url: inputUrl } : { url: inputUrl };
  const raw = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (signed) {
    if (privateKey?.asymmetricKeyType !== 'ed25519' || privateKey.type !== 'private') fail('invalid_reader_private_key');
    const timestamp = String(now);
    headers['x-reader-timestamp'] = timestamp;
    headers['x-reader-signature'] = sign(null, Buffer.from(`${timestamp}\n${raw}`, 'utf8'), privateKey).toString('base64');
  }
  return { requestId, raw, headers };
}

function titleForReport(value, inputUrl) {
  let title = text(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
  for (const secret of new URL(inputUrl).searchParams.values()) {
    if (secret.length >= 4) title = title.split(secret).join('[redacted]');
  }
  return title.replace(/https?:\/\/[^\s<>"']+/gi, match => cleanUrl(match)).slice(0, 180);
}

function redirectedIdentity(item, redirects) {
  if (!Array.isArray(redirects) || !redirects.length) return { id: '', chain: [], valid: false };
  const chain = [];
  let invalid = false;
  for (const hop of redirects) {
    if (!record(hop) || typeof hop.host !== 'string' || typeof hop.path !== 'string' ||
        !/^[a-z0-9.-]+$/i.test(hop.host) || !hop.path.startsWith('/') || hop.path.startsWith('//') || /[?#\\]/.test(hop.path)) {
      invalid = true;
      continue;
    }
    const url = new URL(`https://${hop.host}${hop.path}`);
    if (platformFor(url) !== item.platform) invalid = true;
    chain.push({ url: cleanUrl(url), contentId: contentIdFor(item.platform, url), status: Number.isInteger(hop.status) ? hop.status : null });
  }
  const ids = [...new Set(chain.map(hop => hop.contentId).filter(Boolean))];
  const startsAtInput = chain[0]?.url === cleanUrl(item.inputUrl);
  return { id: ids.length === 1 ? ids[0] : '', chain, valid: !invalid && startsAtInput && ids.length === 1 };
}

// description is the parser's body field. pageText can include a title prefix;
// requiring body evidence prevents title-only metadata from satisfying acceptance.
export function bodyEvidence(result) {
  const description = text(result?.description).replace(/\r\n/g, '\n');
  const pageText = text(result?.extraction?.pageText).replace(/\r\n/g, '\n');
  const title = text(result?.title).replace(/\r\n/g, '\n');
  if (!description || !pageText) return '';
  const withoutTitle = title && pageText.startsWith(`${title}\n`) ? pageText.slice(title.length + 1).trim() : pageText;
  // Description is capped at 800 characters by the resolver; pageText preserves
  // the longer body. For Douyin, desc may legitimately also supply the title.
  if (withoutTitle.startsWith(description)) return withoutTitle;
  if (pageText.startsWith(description)) return pageText;
  return '';
}

function baseline(item, context) {
  return {
    index: item.index, platform: item.platform, inputUrl: cleanUrl(item.inputUrl),
    originalUrl: cleanUrl(item.originalUrl), inputOverridden: item.overridden,
    timestamp: context.timestamp, elapsedMs: context.elapsedMs, httpStatus: context.httpStatus ?? null,
    requestTransport: context.signed ? 'signed-resolve' : 'site-resolve',
    accepted: false, failureChecks: [], reason: null, method: null, transport: null,
    title: '', bodyLength: 0, bodyUtf8Bytes: 0, bodySha256: null, mediaCount: 0,
    expectedContentId: contentIdFor(item.platform, new URL(item.inputUrl)) || null,
    contentId: null, canonicalUrl: '', identityBasis: null, redirectChain: [],
    resolved: false, contentStatus: null, textStatus: null,
  };
}

export function evaluateResponse(item, payload, context) {
  const row = baseline(item, context);
  const envelope = record(payload);
  const result = context.signed ? record(envelope?.result) : envelope;
  if (context.httpStatus < 200 || context.httpStatus >= 300) {
    row.failureChecks = ['http_status'];
    row.reason = safeCode(envelope?.error) || `http_${context.httpStatus}`;
    return row;
  }
  if (!result) {
    row.failureChecks = ['invalid_result']; row.reason = 'invalid_result'; return row;
  }
  if (context.signed && (envelope.requestId !== context.requestId || envelope.sourceUrl !== item.inputUrl)) row.failureChecks.push('request_correlation');
  const diagnostics = record(result.diagnostics) || {};
  row.reason = safeCode(result.reasonCode);
  row.method = safeCode(diagnostics.method) || safeCode(result.extraction?.method) || safeCode(result.method);
  row.transport = safeCode(diagnostics.transport) || safeCode(result.transport);
  row.resolved = result.resolved === true;
  row.contentStatus = safeCode(result.contentStatus);
  row.textStatus = safeCode(result.extraction?.textStatus);
  row.title = titleForReport(result.title, item.inputUrl);
  row.contentId = /^[a-z0-9]{1,80}$/i.test(text(result.contentId)) ? text(result.contentId) : null;
  row.canonicalUrl = cleanUrl(result.canonicalUrl);
  row.mediaCount = Array.isArray(result.extraction?.media) ? result.extraction.media.length : 0;
  const redirect = redirectedIdentity(item, diagnostics.redirects);
  row.redirectChain = redirect.chain;
  if (row.expectedContentId) row.identityBasis = 'input_url';
  else if (redirect.valid) { row.expectedContentId = redirect.id; row.identityBasis = 'redirect_chain'; }
  let canonical;
  try { canonical = new URL(result.canonicalUrl); } catch { /* Missing identity fails below. */ }
  if (result.platform !== item.platform || !canonical || platformFor(canonical) !== item.platform) row.failureChecks.push('platform_match');
  const canonicalId = canonical ? contentIdFor(item.platform, canonical) : '';
  if (!row.expectedContentId || row.contentId !== row.expectedContentId || canonicalId !== row.expectedContentId ||
      (redirect.chain.some(hop => hop.contentId && hop.contentId !== row.expectedContentId))) row.failureChecks.push('content_id_match');
  if (canonical && item.platform === 'douyin') {
    const modal = canonical.searchParams.get('modal_id');
    if (modal && modal !== canonicalId) row.failureChecks.push('canonical_id_conflict');
  }
  if (!row.resolved || row.reason !== 'ok' || row.contentStatus !== 'body' || row.textStatus !== 'full') row.failureChecks.push('full_body_status');
  const body = bodyEvidence(result);
  row.bodyLength = [...body].length;
  row.bodyUtf8Bytes = Buffer.byteLength(body, 'utf8');
  row.bodySha256 = body ? sha256(body) : null;
  if (!body) row.failureChecks.push('nonempty_corresponding_body');
  row.accepted = row.failureChecks.length === 0;
  return row;
}

async function readJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) fail('empty_response');
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) { void reader.cancel().catch(() => {}); fail('response_too_large'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { fail('invalid_json_response'); }
  } finally { reader.releaseLock(); }
}

export async function requestOnce(item, config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const clock = dependencies.clock || Date.now;
  const monotonic = dependencies.monotonic || (() => performance.now());
  const request = createRequest(item.inputUrl, config.signed, config.privateKey, clock());
  const started = monotonic();
  const context = { signed: config.signed, requestId: request.requestId, timestamp: new Date(clock()).toISOString() };
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AcceptanceError('deadline_exceeded')); }, dependencies.deadlineMs ?? DEADLINE_MS);
    });
    const operation = (async () => {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST', headers: request.headers, body: request.raw,
        redirect: 'error', credentials: 'omit', signal: controller.signal,
      });
      context.httpStatus = response.status;
      return readJSON(response);
    })();
    const payload = await Promise.race([operation, deadline]);
    return evaluateResponse(item, payload, { ...context, elapsedMs: Math.max(0, Math.round(monotonic() - started)) });
  } catch (error) {
    const row = baseline(item, { ...context, elapsedMs: Math.max(0, Math.round(monotonic() - started)) });
    row.reason = controller.signal.aborted ? 'deadline_exceeded' : error instanceof AcceptanceError ? error.code : 'request_failed';
    row.failureChecks = [row.reason];
    return row;
  } finally { clearTimeout(timer); }
}

export async function runAcceptance(items, config, dependencies = {}) {
  validateEndpoint(config.endpoint, config.signed);
  if (items.length !== 20) fail('expected_20_fixed_candidates');
  const monotonic = dependencies.monotonic || (() => performance.now());
  const delay = dependencies.sleep || sleep;
  const rows = [];
  let previousStart = -Infinity;
  for (const item of items) {
    const wait = Math.max(0, INTERVAL_MS - (monotonic() - previousStart));
    if (wait) await delay(wait);
    previousStart = monotonic();
    // Exactly one request per item. No retries, fallback endpoint, or sample substitution.
    const row = await requestOnce(item, config, dependencies);
    rows.push(row);
    if (dependencies.onResult) await dependencies.onResult(row, rows);
  }
  return rows;
}

export function reportFor(rows, config, startedAt, complete) {
  return {
    schemaVersion: 1, fixture: 'candidates-20260920.json', startedAt,
    updatedAt: new Date().toISOString(), endpoint: cleanUrl(config.endpoint), signed: Boolean(config.signed),
    complete, intervalMs: INTERVAL_MS, deadlineMs: DEADLINE_MS, attemptsPerCandidate: 1,
    expectedCount: 20, completedCount: rows.length, acceptedCount: rows.filter(row => row.accepted).length,
    bodyLengthUnit: 'Unicode code points; excludes distinct title prefix', bodyStored: false,
    identityNote: 'Long URLs match their input work ID. Short URLs require a returned redirect chain from the original short URL to one consistent work ID; this is response evidence, not an independently known ID.',
    results: rows,
  };
}

const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function renderMarkdown(report) {
  const lines = [
    '# 固定 20 条公开链接读取验收', '',
    `状态：${report.complete ? '完成' : '进行中'}；已测试 ${report.completedCount}/20；正文通过 ${report.acceptedCount}。`, '',
    `Endpoint：${report.endpoint}；签名：${report.signed ? 'Ed25519' : '无'}。`,
    `请求开始时间至少相隔 ${INTERVAL_MS / 1000} 秒；每条限时 ${DEADLINE_MS / 1000} 秒；每条仅请求一次。`, '',
    '通过条件：HTTP 成功、完整正文状态、对应非空正文、平台与作品 ID 一致；签名模式另校验 requestId 和原始 sourceUrl。标题不单独算正文。',
    '短链接 ID 根据本次响应中的同平台跳转链核对；不是预先独立确认的 ID。未保存正文、签名、私钥、媒体 URL 或输入查询参数。',
    'method / transport 留空表示服务未提供；不据此猜测读取方式。', '',
    '| # | 平台 | URL | 通过 | ID依据 / ID | 标题 | 正文长度 | SHA256 | 媒体 | reason | method | transport | HTTP | 耗时ms | 时间 | 未通过项 |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- | ---: | --- | --- | --- | ---: | ---: | --- | --- |',
  ];
  for (const row of report.results) lines.push(`| ${[
    row.index, row.platform, row.inputUrl, row.accepted ? '是' : '否', `${row.identityBasis || ''} / ${row.contentId || ''}`,
    row.title, row.bodyLength, row.bodySha256, row.mediaCount, row.reason, row.method, row.transport,
    row.httpStatus, row.elapsedMs, row.timestamp, row.failureChecks.join(', '),
  ].map(cell).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

export async function selfTest() {
  const items = validateCandidates(JSON.parse(await readFile(FIXTURE, 'utf8')));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const mockBody = 'MOCK_BODY_NEVER_PERSIST 这是独立于标题的公开正文。';
  const secret = 'PRIVATE_QUERY_SENTINEL';
  const overridden = applyOverrides(items, { '7': `${items[6].inputUrl}?xsec_token=${secret}&xsec_source=pc_share` });
  assert.equal(overridden[6].overridden, true);
  assert.equal(items[6].overridden, false);
  assert.throws(() => applyOverrides(items, { '7': items[7].inputUrl }), /override_identity_mismatch/);
  assert.throws(() => applyOverrides(items, { '1': items[6].inputUrl }), /override_identity_mismatch/);
  assert.throws(() => applyOverrides(items, { '21': items[6].inputUrl }), /invalid_override_entry/);
  assert.throws(() => validateEndpoint('https://mock.invalid/api/analyze', false), /invalid_endpoint/);
  assert.throws(() => validateEndpoint('http://mock.invalid/v1/resolve', true), /invalid_endpoint/);
  assert.throws(() => validateEndpoint('http://127.0.0.1:18080/api/resolve', false), /invalid_endpoint/);
  assert.equal(validateEndpoint('http://127.0.0.1:18080/v1/resolve', true), 'http://127.0.0.1:18080/v1/resolve');
  assert.equal(privateKeyFromEnvironment(privateKey.export({ format: 'pem', type: 'pkcs8' })).asymmetricKeyType, 'ed25519');
  assert.equal(privateKeyFromEnvironment(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')).asymmetricKeyType, 'ed25519');

  const mockResult = item => {
    const source = new URL(item.inputUrl);
    const id = contentIdFor(item.platform, source) || `66728521000000001c0370${String(item.index).padStart(2, '0')}`;
    const canonical = item.platform === 'xiaohongshu' ? `https://www.xiaohongshu.com/explore/${id}` : `https://www.douyin.com/video/${id}`;
    const destination = new URL(canonical);
    return {
      resolved: true, contentStatus: 'body', reasonCode: 'ok', platform: item.platform,
      contentId: id, canonicalUrl: canonical, title: '模拟标题', description: mockBody,
      extraction: { textStatus: 'full', pageText: `模拟标题\n${mockBody}`, media: [{ type: 'image', url: 'https://mock.invalid/private?token=MEDIA_SECRET' }] },
      diagnostics: { method: 'mock', transport: 'offline-mock', redirects: [
        { host: source.host, path: source.pathname, status: 302 },
        { host: destination.host, path: destination.pathname, status: 200 },
      ] },
    };
  };
  const context = { httpStatus: 200, signed: false, timestamp: new Date(0).toISOString(), elapsedMs: 0 };
  const direct = items[6];
  assert.equal(evaluateResponse(direct, mockResult(direct), context).accepted, true);
  const titleOnly = mockResult(direct); titleOnly.description = ''; titleOnly.extraction.pageText = titleOnly.title;
  assert.equal(evaluateResponse(direct, titleOnly, context).bodyLength, 0);
  assert.equal(evaluateResponse(direct, titleOnly, context).accepted, false);
  const partial = mockResult(direct); partial.extraction.textStatus = 'partial';
  assert.equal(evaluateResponse(direct, partial, context).accepted, false);
  const wrongId = mockResult(direct); wrongId.contentId = 'wrong';
  assert.equal(evaluateResponse(direct, wrongId, context).accepted, false);
  const wrongPlatform = mockResult(direct); wrongPlatform.platform = 'douyin';
  assert.equal(evaluateResponse(direct, wrongPlatform, context).accepted, false);
  const wrongCanonical = mockResult(direct); wrongCanonical.canonicalUrl = items[7].inputUrl;
  assert.equal(evaluateResponse(direct, wrongCanonical, context).accepted, false);
  const shortWithoutChain = mockResult(items[0]); shortWithoutChain.diagnostics.redirects = [];
  assert.equal(evaluateResponse(items[0], shortWithoutChain, context).accepted, false);
  const wrongChain = mockResult(items[0]); wrongChain.diagnostics.redirects[0].path = '/o/not-the-input';
  assert.equal(evaluateResponse(items[0], wrongChain, context).accepted, false);
  const bodyMismatch = mockResult(direct); bodyMismatch.extraction.pageText = '另一个正文';
  assert.equal(evaluateResponse(direct, bodyMismatch, context).accepted, false);
  const dy = mockResult(items[10]); dy.title = mockBody; dy.extraction.pageText = mockBody;
  assert.equal(evaluateResponse(items[10], dy, context).accepted, true);
  assert.equal(evaluateResponse(direct, { requestId: 'wrong', sourceUrl: direct.inputUrl, result: mockResult(direct) }, { ...context, signed: true, requestId: 'expected' }).accepted, false);

  let virtualNow = 1_800_000_000_000;
  const starts = [], seen = [], nonces = new Set(), requestIds = new Set();
  const config = { endpoint: 'https://mock.invalid/v1/resolve', signed: true, privateKey };
  const rows = await runAcceptance(overridden, config, {
    clock: () => virtualNow, monotonic: () => virtualNow, sleep: async ms => { virtualNow += ms; },
    fetchImpl: async (url, options) => {
      assert.equal(url, config.endpoint); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      const payload = JSON.parse(options.body), timestamp = options.headers['x-reader-timestamp'];
      assert.equal(verify(null, Buffer.from(`${timestamp}\n${options.body}`), publicKey, Buffer.from(options.headers['x-reader-signature'], 'base64')), true);
      assert.deepEqual(Object.keys(payload).sort(), ['nonce', 'requestId', 'url']);
      assert.equal(nonces.has(payload.nonce), false); assert.equal(requestIds.has(payload.requestId), false);
      nonces.add(payload.nonce); requestIds.add(payload.requestId);
      const item = overridden[seen.length]; assert.equal(payload.url, item.inputUrl);
      starts.push(virtualNow); seen.push(payload.url);
      if (item.index === 2) return Response.json({ error: 'rate_limited' }, { status: 429 });
      const result = mockResult(item);
      if (item.index === 7) result.title = `title ${secret} https://mock.invalid/path?xsec_token=${secret}`;
      if (item.index === 7) result.extraction.pageText = `${result.title}\n${mockBody}`;
      return Response.json({ requestId: payload.requestId, sourceUrl: payload.url, result });
    },
  });
  assert.equal(seen.length, 20); assert.deepEqual(seen, overridden.map(item => item.inputUrl));
  assert.equal(rows.filter(row => row.accepted).length, 19);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= INTERVAL_MS);
  assert.equal(rows[0].identityBasis, 'redirect_chain');
  assert.equal(rows[6].identityBasis, 'input_url');
  assert.equal(rows[0].bodyLength, [...mockBody].length);
  assert.equal(rows[0].bodySha256, sha256(mockBody));
  const output = reportFor(rows, config, new Date(0).toISOString(), true);
  const serialized = `${JSON.stringify(output)}\n${renderMarkdown(output)}`;
  for (const forbidden of [secret, mockBody, 'MEDIA_SECRET', 'xsec_token=', 'BEGIN PRIVATE KEY', 'x-reader-signature']) assert.equal(serialized.includes(forbidden), false);

  let unsignedCalls = 0;
  const unsigned = await requestOnce(direct, { endpoint: 'https://mock.invalid/api/resolve', signed: false }, {
    fetchImpl: async (_, options) => {
      unsignedCalls++;
      assert.deepEqual(JSON.parse(options.body), { url: direct.inputUrl });
      assert.equal('x-reader-signature' in options.headers, false);
      return Response.json(mockResult(direct));
    },
  });
  assert.equal(unsigned.accepted, true); assert.equal(unsignedCalls, 1);
  let timedCalls = 0;
  const timeout = await requestOnce(direct, config, { deadlineMs: 5, fetchImpl: async () => { timedCalls++; return new Promise(() => {}); } });
  assert.equal(timeout.reason, 'deadline_exceeded'); assert.equal(timedCalls, 1);
  const stalledBody = await requestOnce(direct, config, {
    deadlineMs: 5,
    fetchImpl: async (_, options) => new Response(new ReadableStream({
      start(controller) { options.signal.addEventListener('abort', () => controller.error(new Error('mock_aborted')), { once: true }); },
    })),
  });
  assert.equal(stalledBody.reason, 'deadline_exceeded');
  const invalidJson = await requestOnce(direct, config, { fetchImpl: async () => new Response('not JSON') });
  assert.equal(invalidJson.reason, 'invalid_json_response');
  const blockedRedirect = await requestOnce(direct, config, { fetchImpl: async () => { throw new Error(`do not log ${secret}`); } });
  assert.equal(blockedRedirect.reason, 'request_failed');
  console.log(JSON.stringify({ ok: true, mode: 'offline-mock', fixtureCount: 20, mockRunRequests: seen.length, realNetworkRequests: 0, verified: ['ed25519-raw-signature', 'fixed-order-no-retry', 'minimum-10.5s-interval', '45s-default-deadline', 'request-correlation', 'platform-and-work-id', 'short-url-redirect-identity', 'body-not-title', 'same-work-overrides', 'report-redaction', 'signed-and-unsigned', 'timeout-and-http-errors'] }));
}

function parseArgs(argv) {
  const options = { signed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--signed') options.signed = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--help') options.help = true;
    else if (['--endpoint', '--outdir', '--input-overrides'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('missing_argument_value');
      const key = { '--endpoint': 'endpoint', '--outdir': 'outdir', '--input-overrides': 'overrides' }[arg];
      if (options[key]) fail('duplicate_argument');
      options[key] = argv[++i];
    } else fail('unknown_argument');
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Offline: node acceptance-20.mjs --self-test\nSite: node acceptance-20.mjs --endpoint https://<site>/api/resolve --outdir <local-directory> [--input-overrides <private-json>]\nCloud: node acceptance-20.mjs --endpoint https://<reader>/v1/resolve --signed --outdir <local-directory> [--input-overrides <private-json>]\nLoopback: node acceptance-20.mjs --endpoint http://127.0.0.1:18080/v1/resolve --signed --outdir <local-directory>\nSigned mode reads READER_PRIVATE_KEY (Ed25519 PEM or base64 PKCS8 DER) from environment only.\nOverrides JSON uses 1-based indexes, e.g. {"7":"https://www.xiaohongshu.com/explore/<same-id>?..."}.\nFixed fixture: candidates-20260920.json next to this script. No retries or endpoint fallback.');
    return;
  }
  if (args.selfTest) {
    if (args.endpoint || args.outdir || args.overrides || args.signed) fail('self_test_cannot_mix_live_options');
    return selfTest();
  }
  if (!args.endpoint || !args.outdir) fail('endpoint_and_outdir_required');
  const endpoint = validateEndpoint(args.endpoint, args.signed);
  const privateKey = args.signed ? privateKeyFromEnvironment(process.env.READER_PRIVATE_KEY) : undefined;
  const items = validateCandidates(JSON.parse(await readFile(FIXTURE, 'utf8')));
  const selected = args.overrides ? applyOverrides(items, JSON.parse(await readFile(resolve(args.overrides), 'utf8'))) : items;
  const config = { endpoint, signed: args.signed, privateKey };
  const startedAt = new Date().toISOString();
  const outdir = resolve(args.outdir);
  await mkdir(outdir, { recursive: true });
  const stem = `acceptance-20-${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const jsonPath = join(outdir, `${stem}.json`), markdownPath = join(outdir, `${stem}.md`);
  // Incremental checkpoints preserve every completed attempt if a run is interrupted.
  // Rerunning is an explicit new run of all 20; there is no hidden resume/retry.
  const persist = async (rows, complete) => {
    const report = reportFor(rows, config, startedAt, complete);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await writeFile(markdownPath, renderMarkdown(report), { mode: 0o600 });
  };
  await persist([], false);
  const rows = await runAcceptance(selected, config, {
    onResult: async (row, completed) => {
      await persist(completed, false);
      console.log(JSON.stringify({ index: row.index, accepted: row.accepted, reason: row.reason, elapsedMs: row.elapsedMs, timestamp: row.timestamp }));
    },
  });
  await persist(rows, true);
  console.log(JSON.stringify({ complete: true, tested: rows.length, accepted: rows.filter(row => row.accepted).length, jsonPath, markdownPath }));
  if (rows.some(row => !row.accepted)) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    // Never echo raw exception messages, HTTP payloads, URLs with queries, or keys.
    console.error(JSON.stringify({ complete: false, error: error instanceof AcceptanceError ? error.code : 'acceptance_runner_failed' }));
    process.exitCode = 1;
  }
}
