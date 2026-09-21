// All inputs and readers below are synthetic; this file makes no network calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, validateManifest, runBatch, openReport, INTERVAL_MS } from './new-batch-acceptance.mjs';

const id = n => n.toString(16).padStart(24, '0');
const body = 'OFFLINE_BODY_NOT_TO_BE_SAVED';
const secret = 'OFFLINE_QUERY_NOT_TO_BE_SAVED';
const sample = n => ({ sampleId: `MOCK${n}`, platform: 'xiaohongshu', inputUrl: `https://www.xiaohongshu.com/explore/${id(n)}?xsec_token=${secret}`, expectedId: id(n) });
const fixture = () => ({ frozen: true, priorIds: [], samples: Array.from({ length: 20 }, (_, i) => sample(i + 1)) });
const reply = (item, contentId = item.expectedId) => {
  const input = new URL(item.inputUrl), canonical = new URL(`https://www.xiaohongshu.com/explore/${contentId}`);
  const redirects = [{ host: input.hostname, path: input.pathname, status: 200 }];
  if (input.hostname !== canonical.hostname || input.pathname !== canonical.pathname) {
    redirects[0].status = 302; redirects.push({ host: canonical.hostname, path: canonical.pathname, status: 200 });
  }
  return { resolved: true, reasonCode: 'ok', contentStatus: 'body', platform: 'xiaohongshu', contentId,
    canonicalUrl: canonical.href, title: 'OFFLINE_TITLE', description: body, resolverVersion: 'test-3.3',
    extraction: { textStatus: 'full', pageText: `OFFLINE_TITLE\n${body}`, media: [{ url: `https://media.invalid/private?token=${secret}` }] },
    diagnostics: { method: 'html', upstreamStatus: 200, redirects, elapsedMs: 1 } };
};
async function batch(data, respond, options = {}) {
  const manifest = validateManifest(data), records = [], starts = []; let virtual = 0, calls = 0;
  const summary = await runBatch(manifest, { resolvePublic: async (url, platform, { signal }) => {
    starts.push(virtual); assert.equal(platform, 'xiaohongshu'); assert.ok(signal instanceof AbortSignal);
    return respond(manifest.samples.find(item => item.inputUrl === url), calls++);
  } }, async record => records.push(record), { clock: () => virtual, delay: async ms => { virtual += ms; }, ...options });
  return { records, summary, calls, starts };
}

test('20 original inputs, single reader call per item, >=10.5s starts, body metrics only', async () => {
  const { records, summary, calls, starts } = await batch(fixture(), item => reply(item));
  assert.equal(summary.successCount, 20); assert.equal(summary.denominator, 20); assert.equal(calls, 20);
  assert.equal(records.length, 21); assert.equal(summary.totalNetworkRequests, null);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= INTERVAL_MS);
  const serialized = JSON.stringify(records);
  for (const forbidden of [body, secret, 'OFFLINE_TITLE', 'xsec_token=', 'media.invalid']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(records[0].bodyLength, body.length); assert.match(records[0].bodySha256, /^[0-9a-f]{64}$/);
});

test('native nonempty body and all identity evidence required', () => {
  const item = validateManifest(fixture()).samples[0];
  for (const change of [
    result => { result.description = { text: body }; },
    result => { result.description = null; },
    result => { result.description = ''; result.extraction.pageText = result.title; },
    result => { result.extraction.textStatus = 'partial'; },
    result => { result.contentId = id(999); },
    result => { result.canonicalUrl = `https://www.xiaohongshu.com/explore/${id(999)}`; },
    result => { result.diagnostics.redirects.push({ host: 'www.xiaohongshu.com', path: '/explore', status: 200 }); },
    result => { result.diagnostics.upstreamStatus = 500; },
  ]) { const result = reply(item); change(result); assert.equal(evaluate(item, result, 1).accepted, false); }
});

test('unknown short ID requires input-first, one ID, final work and canonical match', () => {
  const data = fixture(); data.samples[0] = { ...sample(1), inputUrl: 'https://xhslink.cn/o/MOCKCODE', expectedId: null };
  const item = validateManifest(data).samples[0], result = reply(item, id(1));
  assert.equal(evaluate(item, result, 1).accepted, true);
  assert.equal(evaluate(item, result, 1).identityBasis, 'this_response_redirect_not_independent_anchor');
  for (const mutate of [r => { r.diagnostics.redirects = []; }, r => { r.diagnostics.redirects[0].path = '/o/OTHER'; },
    r => { r.diagnostics.redirects.push({ host: 'www.xiaohongshu.com', path: '/explore', status: 200 }); },
    r => { r.diagnostics.redirects[1].path = `/explore/${id(2)}`; }]) {
    const changed = structuredClone(result); mutate(changed); assert.equal(evaluate(item, changed, 1).accepted, false);
  }
});

test('prior and within-batch duplicates remain in fixed denominator without replacement', async () => {
  const data = fixture(); data.priorIds = [id(1)]; data.samples[2].inputUrl = 'https://xhslink.cn/o/MOCKSHORT'; data.samples[2].expectedId = null;
  const run = await batch(data, item => reply(item, item.sampleId === 'MOCK3' ? id(2) : item.expectedId));
  assert.equal(run.calls, 19); assert.equal(run.summary.denominator, 20); assert.equal(run.summary.duplicateCount, 2);
  assert.equal(run.summary.successCount, 18); assert.equal(run.records[2].reason, 'duplicate_returned_work');
});

for (const gate of ['captcha', 'login_required', 'access_denied', 'rate_limited', 401, 403, 429]) {
  test(`stop whole batch on ${gate}, preserve remaining not_run`, async () => {
    const run = await batch(fixture(), (item, n) => {
      const result = reply(item);
      if (n === 1) { if (typeof gate === 'number') result.diagnostics.redirects[0].status = gate; else result.reasonCode = gate; }
      return result;
    });
    assert.equal(run.calls, 2); assert.equal(run.summary.notRunCount, 18); assert.equal(run.summary.denominator, 20);
    assert.equal(run.records[1].accepted, false);
  });
}

test('not_found/app_only fail only their item, no retry', async () => {
  const run = await batch(fixture(), (item, n) => { const result = reply(item); if (n < 2) result.reasonCode = ['not_found', 'app_only'][n]; return result; });
  assert.equal(run.calls, 20); assert.equal(run.summary.successCount, 18); assert.equal(run.summary.stoppedReason, null);
});

test('deadline stops batch, never overlaps a still-running reader', async () => {
  const run = await batch(fixture(), () => new Promise(() => {}), { deadlineMs: 5 });
  assert.equal(run.calls, 1); assert.equal(run.summary.notRunCount, 19); assert.equal(run.summary.stoppedReason, 'reader_deadline');
});

test('unknown paths are redacted and no query is saved', () => {
  const item = validateManifest(fixture()).samples[0], result = reply(item);
  result.diagnostics.redirects.push({ host: 'www.xiaohongshu.com', path: `/404/${secret}`, status: 200 });
  const output = evaluate(item, result, 1); assert.equal(output.accepted, false);
  assert.equal(JSON.stringify(output).includes(secret), false);
});

test('existing report path fails exclusive reservation', async () => {
  await assert.rejects(openReport(new URL(import.meta.url)), { code: 'EEXIST' });
});

test('bad fixtures fail offline before any reader calls', () => {
  for (const mutate of [data => { data.samples.pop(); }, data => { data.frozen = false; }, data => { data.samples[0].inputUrl = 'https://127.0.0.1/private'; },
    data => { data.samples[0].expectedId = id(99); }]) {
    const data = fixture(); mutate(data); assert.throws(() => validateManifest(data));
  }
});
