import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { preflight, runAuthorizedAcceptance } from './authorized-acceptance.mjs';
import { contentIdFor } from './lib/shared/links.mjs';

const makeLeases = () => Object.fromEntries(['xiaohongshu', 'douyin'].map(platform => {
  let state = 'ready';
  return [platform, { status: () => ({ state, platform, expiresAt: Date.now() + 900_000 }),
    getState: () => ({ cookies: [], origins: [] }), revoke: () => { state = 'revoked'; } }];
}));
async function output(t) {
  const dir = await mkdtemp(join(tmpdir(), 'beautyproof-authorized-test-'));
  t.after(async () => {
    assert.equal(dirname(dir), tmpdir());
    assert.ok(basename(dir).startsWith('beautyproof-authorized-test-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
function mocks({ leases, gateAt = 0, revokeAt = 0, throwAt = 0, cancelAt = 0, controller } = {}) {
  const calls = { reads: [], closed: 0, delays: [] };
  let elapsed = 0;
  return { calls, dependencies: {
    monotonic: () => elapsed,
    sleep: async ms => { calls.delays.push(ms); elapsed += ms; },
    makeReader: ({ sessionLease }) => ({
      async read(raw, platform) {
        assert.equal(sessionLease.status().platform, platform);
        calls.reads.push(raw); elapsed += 5;
        const n = calls.reads.length;
        if (n === throwAt) throw Error('PRIVATE_FAILURE_DO_NOT_EXPOSE');
        if (n === revokeAt) leases[platform].revoke();
        if (n === cancelAt) controller.abort();
        const start = new URL(raw);
        const id = contentIdFor(platform, start) || n.toString(16).padStart(24, '0');
        const canonicalUrl = platform === 'xiaohongshu' ? `https://www.xiaohongshu.com/explore/${id}` : `https://www.douyin.com/video/${id}`;
        const target = new URL(canonicalUrl);
        const desc = `MOCK_BODY_DO_NOT_PERSIST_${n}`;
        return { platform, canonicalUrl, contentId: id, title: 'MOCK_TITLE_DO_NOT_PERSIST', description: desc,
          resolved: n !== gateAt, reasonCode: n === gateAt ? 'captcha' : 'ok', contentStatus: 'body',
          extraction: { textStatus: 'full', pageText: desc, media: [] },
          diagnostics: { method: 'browser', redirects: [{ host: start.hostname, path: start.pathname, status: 302 }, { host: target.hostname, path: target.pathname, status: 200 }] } };
      }, async close() { calls.closed++; },
    }),
  } };
}

test('preflight is offline and explicitly not live-verified or login-ready', async () => {
  const result = await preflight();
  assert.equal(result.fixedCandidates, 20);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.publicServiceEnabled, false);
  assert.equal(result.interactiveLoginPrepared, false);
});
test('missing accounts reject before constructing a reader', async () => {
  let created = false;
  await assert.rejects(runAuthorizedAcceptance({}, { makeReader: () => { created = true; } }), /both_dedicated_session_leases_required/);
  assert.equal(created, false);
});
test('fixed 20 mock inputs run once and create redacted immutable reports', async t => {
  const leases = makeLeases(), { calls, dependencies } = mocks({ leases });
  const dir = await output(t);
  const { report, reportPath } = await runAuthorizedAcceptance({ leases, outputDir: dir }, dependencies);
  assert.equal(report.mode, 'offline_mock');
  assert.equal(report.complete, true);
  assert.equal(report.acceptedCount, 20);
  assert.equal(calls.reads.length, 20);
  assert.equal(new Set(calls.reads).size, 20);
  assert.equal(calls.closed, 2);
  assert.equal(report.publicServiceEnabled, false);
  assert.equal(report.transport, 'in_process_not_public_site');
  assert.equal(report.results.every(row => row.httpStatus === null), true);
  assert.ok(calls.delays.every(ms => ms >= 10_495));
  assert.equal(leases.douyin.status().state, 'revoked');
  const raw = await readFile(reportPath, 'utf8');
  assert.ok(!raw.includes('MOCK_BODY_DO_NOT_PERSIST'));
  assert.ok(!raw.includes('MOCK_TITLE_DO_NOT_PERSIST'));
  assert.equal(report.results[0].bodyLength > 0, true);
});
test('session revoke during a result prevents success and preserves not-run rows', async t => {
  const leases = makeLeases(), { calls, dependencies } = mocks({ leases, revokeAt: 2 });
  const { report } = await runAuthorizedAcceptance({ leases, outputDir: await output(t) }, dependencies);
  assert.equal(report.complete, false);
  assert.equal(report.completedCount, 2);
  assert.equal(report.acceptedCount, 1);
  assert.equal(report.stoppedReason, 'session_unavailable');
  assert.deepEqual(report.notRunIndexes, Array.from({ length: 18 }, (_, n) => n + 3));
  assert.equal(calls.reads.length, 2);
});
test('platform captcha stops without paid retry or processing later samples', async t => {
  const leases = makeLeases(), { dependencies, calls } = mocks({ leases, gateAt: 1 });
  const { report } = await runAuthorizedAcceptance({ leases, outputDir: await output(t) }, dependencies);
  assert.equal(report.stoppedReason, 'platform_access_gate');
  assert.equal(report.completedCount, 1);
  assert.equal(report.acceptedCount, 0);
  assert.equal(calls.reads.length, 1);
});
test('reader errors are redacted, leases revoked and readers closed', async t => {
  const leases = makeLeases(), { dependencies, calls } = mocks({ leases, throwAt: 1 });
  const { report } = await runAuthorizedAcceptance({ leases, outputDir: await output(t) }, dependencies);
  assert.equal(report.stoppedReason, 'experiment_failed');
  assert.equal(report.complete, false);
  assert.equal(report.completedCount, 1);
  assert.equal(report.notRunIndexes.length, 19);
  assert.equal(report.results[0].reason, 'experiment_failed');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_FAILURE'));
  assert.equal(calls.closed, 1);
  assert.equal(leases.xiaohongshu.status().state, 'revoked');
});
test('operator cancellation stops new requests without counting them as passed', async t => {
  const leases = makeLeases(), controller = new AbortController();
  const { dependencies, calls } = mocks({ leases, cancelAt: 1, controller });
  const { report } = await runAuthorizedAcceptance({ leases, outputDir: await output(t), signal: controller.signal }, dependencies);
  assert.equal(report.stoppedReason, 'operator_cancelled');
  assert.equal(calls.reads.length, 1);
  assert.equal(report.complete, false);
  assert.equal(report.acceptedCount, 0);
});

test('the twentieth request throwing is an attempted failure, never an unrun or passed item', async t => {
  const leases = makeLeases(), { dependencies, calls } = mocks({ leases, throwAt: 20 });
  const { report } = await runAuthorizedAcceptance({ leases, outputDir: await output(t) }, dependencies);
  assert.equal(calls.reads.length, 20);
  assert.equal(report.completedCount, 20);
  assert.equal(report.complete, true);
  assert.equal(report.acceptedCount, 19);
  assert.deepEqual(report.notRunIndexes, []);
  assert.equal(report.results[19].reason, 'experiment_failed');
  assert.equal(report.results[19].accepted, false);
  assert.equal(report.sessionsBeforeCleanup.douyin.state, 'ready');
  assert.equal(leases.douyin.status().state, 'revoked');
});
