import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPublicBrowserReader } from './browser-reader.mjs';

const XHS = 'https://www.xiaohongshu.com/explore/abcdef1234567890abcdef12?xsec_token=PRIVATE';
const DY = 'https://www.douyin.com/video/7483456789012345678';
const TITLE = '离线测试标题';
const DESC = '这是真正的离线作品正文，不是推荐视频或登录页。';
function fixture(platform = 'douyin', { id, title = TITLE, desc = DESC } = {}) {
  if (platform === 'douyin') return `<script>window._ROUTER_DATA=${JSON.stringify({ data: { aweme_id: id ?? '7483456789012345678', desc } })}</script>`;
  id ??= 'abcdef1234567890abcdef12';
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [id]: { note: { noteId: id, title, desc } } } } })}</script>`;
}

function harness(options = {}) {
  const calls = { launches: [], contexts: [], urls: [], requests: [], http: 0, browserClosed: 0 };
  const browser = { async newContext(config) {
    const context = new EventEmitter();
    context.config = config;
    context.closed = false;
    context.close = async () => {
      if (options.delayFirstCleanup && calls.contexts.indexOf(context) === 0) await new Promise(resolve => { calls.releaseCleanup = resolve; });
      context.closed = true;
    };
    context.setDefaultTimeout = () => {};
    context.setDefaultNavigationTimeout = () => {};
    context.routeWebSocket = async (_pattern, handler) => { context.wsHandler = handler; };
    context.route = async (_pattern, handler) => { context.handler = handler; };
    context.newPage = async () => {
      const page = new EventEmitter();
      const frame = {};
      let evaluateIndex = 0, contentIndex = 0;
      page.mainFrame = () => frame;
      page.url = () => page.current;
      page.close = async () => { page.closed = true; };
      page.evaluate = async () => {
        calls.evaluateCount = (calls.evaluateCount ?? 0) + 1;
        const fault = options.evaluateFaults?.[evaluateIndex++];
        if (fault?.url) page.current = fault.url;
        if (fault?.message) throw new Error(fault.message);
        if (options.evaluateDelayMs) await new Promise(resolve => setTimeout(resolve, options.evaluateDelayMs));
        return { text: options.visible ?? (options.platform === 'xiaohongshu' ? `${TITLE}\n${DESC}` : DESC), workTexts: [DESC], ...options.snapshot };
      };
      page.content = async () => {
        calls.contentCount = (calls.contentCount ?? 0) + 1;
        const fault = options.contentFaults?.[contentIndex++];
        if (fault?.url) page.current = fault.url;
        if (fault?.message) throw new Error(fault.message);
        if (options.spaSwitch) page.current = options.spaSwitch;
        return options.html ?? fixture(options.platform);
      };
      page.goto = async (url, config) => {
        calls.urls.push(url);
        calls.gotoConfig = config;
        if (options.hang || (options.hangFirst && calls.urls.length === 1)) return new Promise(() => {});
        const navigation = options.navigation ?? [{ url, status: options.status ?? 200 }];
        for (const item of navigation) {
          const request = await simulate(item.url, { navigation: true });
          if (request.outcome !== 'continue') throw new Error('request blocked');
          page.current = item.url;
          page.emit('response', { request: () => request, status: () => item.status, url: () => item.url });
          if (context.closed) throw new Error('page closed');
        }
        for (const item of options.resources ?? []) await simulate(item.url, item);
      };
      async function simulate(url, spec = {}) {
        const request = {
          url: () => url, isNavigationRequest: () => Boolean(spec.navigation),
          frame: () => spec.child ? {} : frame, resourceType: () => spec.type ?? (spec.navigation ? 'document' : 'script'), method: () => spec.method ?? 'GET',
        };
        await context.handler({ request: () => request,
          abort: async () => { request.outcome = 'abort'; }, continue: async () => { request.outcome = 'continue'; } });
        calls.requests.push(request);
        return request;
      }
      context.page = page;
      context.emit('page', page);
      return page;
    };
    calls.contexts.push(context);
    if (options.delayFirstContext && calls.contexts.length === 1) await new Promise(resolve => { calls.releaseContext = resolve; });
    return context;
  }, async close() {
    calls.browserClosed++;
    if (options.delayBrowserClose) await new Promise(resolve => { calls.releaseBrowser = resolve; });
    for (const context of calls.contexts) context.closed = true;
  } };
  const chromium = { async launch(config) { calls.launches.push(config); return browser; } };
  const reader = createPublicBrowserReader({
    chromium, getuid: () => 1000, lookup: async () => [{ address: '1.1.1.1' }], totalMs: 100, cleanupMs: 40, pollMs: 1,
    resolveLink: async () => { calls.http++; return { resolved: false, reasonCode: options.httpReason ?? 'parse_failed' }; },
    ...options.inject,
  });
  return { reader, calls };
}

test('Douyin goes directly to one ordinary browser navigation; text/identity must match', async () => {
  const { reader, calls } = harness();
  const result = await reader.resolvePublic(DY, 'douyin');
  assert.equal(result.reasonCode, 'ok');
  assert.equal(result.contentStatus, 'body');
  assert.equal(result.extraction.pageText, DESC);
  assert.equal(calls.http, 0);
  assert.equal(calls.urls.length, 1);
  assert.deepEqual(calls.launches[0], { channel: 'chrome', headless: true, chromiumSandbox: true, timeout: calls.launches[0].timeout });
  assert.deepEqual(calls.contexts[0].config, { acceptDownloads: false, serviceWorkers: 'block', bypassCSP: false });
  assert.equal(calls.contexts[0].closed, true);
  assert.equal(result.diagnostics.redirects[0].path, '/video/7483456789012345678');
  await reader.close();
});

test('XHS HTTP parse failure falls back and retains original share token only in navigation', async () => {
  const { reader, calls } = harness({ platform: 'xiaohongshu' });
  const result = await reader.resolvePublic(XHS, 'xiaohongshu');
  assert.equal(result.reasonCode, 'ok');
  assert.equal(calls.http, 1);
  assert.deepEqual(calls.urls, [XHS]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  await reader.close();
});

test('HTTP gates and browser_required are not retried in browser', async () => {
  for (const reason of ['captcha', 'access_denied', 'login_required', 'app_only', 'rate_limited', 'browser_required', 'not_found', 'identity_mismatch']) {
    const { reader, calls } = harness({ httpReason: reason });
    assert.equal((await reader.resolvePublic(XHS, 'xiaohongshu')).reasonCode, reason);
    assert.equal(calls.launches.length, 0);
    await reader.close();
  }
});

test('HTTP body is returned without importing or launching Playwright', async () => {
  const original = { resolved: true, reasonCode: 'ok', sentinel: 'unchanged' };
  const { reader, calls } = harness({ inject: { resolveLink: async () => original } });
  assert.deepEqual(await reader.resolvePublic(XHS, 'xiaohongshu'), { ...original, diagnostics: { method: 'html' } });
  assert.equal(calls.launches.length, 0);
});

test('visible captcha, login and app-only pages stop even when state contains correct body', async () => {
  for (const [snapshot, visible, reason] of [
    [{ captcha: true }, DESC, 'captcha'], [{ login: true }, DESC, 'login_required'],
    [{}, '仅支持在小红书 APP 内查看', 'app_only'], [{}, '访问过于频繁', 'rate_limited'],
  ]) {
    const { reader, calls } = harness({ snapshot, visible });
    assert.equal((await reader.read(DY, 'douyin')).reasonCode, reason);
    assert.equal(calls.urls.length, 1);
    assert.equal(calls.contexts[0].closed, true);
  }
});

test('401/403/429 are terminal and never parsed as success', async () => {
  for (const [status, reason] of [[401, 'login_required'], [403, 'access_denied'], [429, 'rate_limited']]) {
    const { reader, calls } = harness({ status });
    assert.equal((await reader.read(DY, 'douyin')).reasonCode, reason);
    assert.equal(calls.contexts[0].closed, true);
  }
});

test('different work and off-platform main-frame redirects are aborted', async () => {
  for (const [url, reason] of [['https://www.douyin.com/video/7483456789012345679', 'identity_mismatch'], ['https://evil.example/video/7483456789012345678', 'invalid_redirect'], ['https://www.douyin.com/login/', 'login_required']]) {
    const { reader, calls } = harness({ navigation: [{ url, status: 200 }] });
    assert.equal((await reader.read(DY, 'douyin')).reasonCode, reason);
    assert.equal(calls.requests[0].outcome, 'abort');
  }
});

test('short URL adopts only same-platform final work ID and records token-free chain', async () => {
  const short = 'https://v.douyin.com/realOfflineFixture/';
  const { reader } = harness({ navigation: [{ url: short, status: 302 }, { url: DY, status: 200 }] });
  const result = await reader.read(short, 'douyin');
  assert.equal(result.reasonCode, 'ok');
  assert.equal(result.contentId, '7483456789012345678');
  assert.equal(result.diagnostics.redirects.length, 2);
});

test('hidden body, title-only and wrong note fixtures cannot succeed', async () => {
  for (const options of [
    { visible: '推荐视频以及别的正文' },
    { platform: 'xiaohongshu', html: fixture('xiaohongshu', { desc: '' }), visible: TITLE },
    { html: fixture('douyin', { id: '7483456789012345679' }) },
  ]) {
    const { reader } = harness({ ...options, inject: { totalMs: 15 } });
    const result = await reader.read(options.platform === 'xiaohongshu' ? XHS : DY, options.platform ?? 'douyin');
    assert.equal(result.resolved, false);
  }
});

test('more than 2MB HTML is rejected before parsing', async () => {
  let parsed = false;
  const { reader } = harness({ html: '界'.repeat(700_000), inject: { parseLinkPage: () => { parsed = true; } } });
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'unsupported_page');
  assert.equal(parsed, false);
});

test('blocks off-list hosts, media, sockets, private URLs, POST and child-frame navigation', async () => {
  const resources = [
    { url: 'https://lf1-cdn-tos.bytegecko.com/script.js' },
    { url: 'https://evil.example/script.js' }, { url: 'https://127.0.0.1/private' },
    { url: 'http://100.100.100.200/latest/meta-data/' }, { url: 'https://www.douyin.com/video.mp4', type: 'media' },
    { url: 'wss://www.douyin.com/ws', type: 'websocket' }, { url: 'https://www.douyin.com/write', method: 'POST' },
    { url: 'https://www.douyin.com/frame', navigation: true, child: true },
    { url: 'https://douyin.com.evil.example/a.js' },
  ];
  const { reader, calls } = harness({ resources });
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'ok');
  assert.equal(calls.requests[1].outcome, 'continue');
  assert.ok(calls.requests.slice(2).every(request => request.outcome === 'abort'));
  let socketClosed = false;
  calls.contexts[0].wsHandler({ close: () => { socketClosed = true; } });
  assert.ok(socketClosed);
});

test('DNS resolving allowed hostname to private or metadata IP fails closed', async () => {
  for (const address of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '100.100.100.200', '::1', '::ffff:127.0.0.1', 'fc00::1']) {
    const { reader, calls } = harness({ inject: { lookup: async () => [{ address }] } });
    assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'access_denied');
    assert.equal(calls.requests[0].outcome, 'abort');
  }
});

test('one browser is reused, each job gets fresh anonymous context, concurrent jobs rejected', async () => {
  const { reader, calls } = harness();
  const first = reader.read(DY, 'douyin');
  assert.equal((await reader.read(DY, 'douyin')).resolved, false);
  assert.equal((await first).resolved, true);
  assert.equal((await reader.read(DY, 'douyin')).resolved, true);
  assert.equal(calls.launches.length, 1);
  assert.equal(calls.contexts.length, 2);
  assert.ok(calls.contexts.every(context => context.closed));
  await reader.close();
  assert.equal(calls.browserClosed, 1);
  assert.equal((await reader.read(DY, 'douyin')).resolved, false);
});

test('deadline closes hanging page and returns within the bounded deadline', async () => {
  const { reader, calls } = harness({ hang: true, inject: { totalMs: 20 } });
  const start = Date.now();
  const result = await reader.read(DY, 'douyin');
  assert.equal(result.reasonCode, 'timeout');
  assert.ok(Date.now() - start < 300);
  assert.equal(calls.contexts[0].closed, true);
  await reader.close();
});

test('root execution, missing Playwright and invalid URLs do not open browser pages', async () => {
  const root = harness({ inject: { getuid: () => 0 } });
  assert.equal((await root.reader.read(DY, 'douyin')).reasonCode, 'browser_required');
  assert.equal(root.calls.launches.length, 0);
  const absent = createPublicBrowserReader({ getuid: () => 1000, importPlaywright: async () => { throw new Error('not installed'); } });
  assert.equal((await absent.read(DY, 'douyin')).reasonCode, 'browser_required');
  await assert.rejects(() => absent.read('https://localhost/a', 'douyin'), /Invalid/);
});

test('HTTP phase and browser fallback share one total deadline', async () => {
  const { reader, calls } = harness({ inject: { totalMs: 15, resolveLink: () => new Promise(resolve => setTimeout(() => resolve({ reasonCode: 'parse_failed' }), 40)) } });
  assert.equal((await reader.resolvePublic(XHS, 'xiaohongshu')).reasonCode, 'timeout');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls.launches.length, 0);
});

test('external request abort waits for context closure, then next serial job can run', async () => {
  const { reader, calls } = harness({ hangFirst: true });
  const controller = new AbortController();
  const work = reader.read(DY, 'douyin', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  assert.equal((await work).reasonCode, 'timeout');
  assert.equal(calls.contexts[0].closed, true);
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'ok');
  assert.equal(calls.contexts.length, 2);
  assert.equal(calls.launches.length, 1);
  await reader.close();
});

test('already-aborted request starts no HTTP request or browser', async () => {
  const { reader, calls } = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await reader.resolvePublic(XHS, 'xiaohongshu', { signal: controller.signal })).reasonCode, 'timeout');
  assert.equal(calls.http, 0);
  assert.equal(calls.launches.length, 0);
});

test('abort signal reaches raw HTTP fetch and no browser fallback follows', async () => {
  let requestSignal;
  const { reader, calls } = harness({ inject: {
    resolveLink: (url, platform, fetcher) => fetcher(url, { signal: AbortSignal.timeout(1000) }),
    fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  } });
  const controller = new AbortController();
  const work = reader.resolvePublic(XHS, 'xiaohongshu', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  assert.equal((await work).reasonCode, 'timeout');
  assert.equal(requestSignal.aborted, true);
  assert.equal(calls.launches.length, 0);
});

test('timeout before newContext finishes retires old browser before next job', async () => {
  const { reader, calls } = harness({ delayFirstContext: true, inject: { totalMs: 15 } });
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'timeout');
  assert.equal(calls.browserClosed, 1);
  assert.equal(calls.contexts.length, 1);
  assert.equal(calls.contexts[0].closed, true);
  assert.equal(calls.urls.length, 0);
  assert.equal((await reader.read(DY, 'douyin')).resolved, true);
  assert.equal(calls.launches.length, 2);
  calls.releaseContext();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.contexts[0].closed, true);
  assert.equal(calls.urls.length, 1); // Late old task never navigates.
});

test('slow context cleanup retires browser without replacing a successful semantic result', async () => {
  const { reader, calls } = harness({ delayFirstCleanup: true, inject: { totalMs: 15 } });
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'ok');
  assert.equal(calls.browserClosed, 1);
  assert.equal(calls.contexts.length, 1);
  assert.equal(calls.contexts[0].closed, true);
  assert.equal((await reader.read(DY, 'douyin')).resolved, true);
  assert.equal(calls.launches.length, 2);
  calls.releaseCleanup();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await reader.read(DY, 'douyin')).resolved, true);
});

test('hanging navigation timeout is cleaned before return and next task is not false network_error', async () => {
  const { reader, calls } = harness({ hangFirst: true, inject: { totalMs: 20 } });
  const first = await reader.read(DY, 'douyin');
  assert.equal(first.reasonCode, 'timeout');
  assert.equal(calls.contexts[0].closed, true);
  const second = await reader.read(DY, 'douyin');
  assert.equal(second.reasonCode, 'ok');
  assert.equal(calls.urls.length, 2); // Exactly one navigation per requested task.
  assert.equal(calls.launches.length, 1);
});

test('cleanup has a finite grace budget and genuinely stuck browser reports rate_limited', async () => {
  const { reader, calls } = harness({ delayFirstCleanup: true, delayBrowserClose: true, inject: { totalMs: 15, cleanupMs: 30 } });
  const started = Date.now();
  const first = await reader.read(DY, 'douyin');
  assert.equal(first.reasonCode, 'ok');
  assert.equal(first.resolved, true);
  assert.ok(Date.now() - started < 200);
  assert.equal(first.diagnostics.method, 'browser');
  assert.equal(calls.contexts[0].closed, false);
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'rate_limited');
  assert.equal(calls.contexts.length, 1);
  assert.equal(calls.launches.length, 1);
  calls.releaseCleanup();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'rate_limited'); // Retirement is still in flight.
  assert.equal(calls.launches.length, 1);
  calls.releaseBrowser();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.contexts[0].closed, true);
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'ok');
  assert.equal(calls.launches.length, 2);
});

test('an HTTP resolver ignoring abort cannot overlap a new task after bounded cleanup', async () => {
  const { reader, calls } = harness({ inject: { totalMs: 10, cleanupMs: 10, resolveLink: () => new Promise(() => {}) } });
  assert.equal((await reader.resolvePublic(XHS, 'xiaohongshu')).reasonCode, 'timeout');
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'rate_limited');
  assert.equal(calls.launches.length, 0);
});

test('login gate obtained after 15ms survives context cleanup beyond the work deadline', async () => {
  const { reader, calls } = harness({
    evaluateDelayMs: 15, snapshot: { login: true }, delayFirstCleanup: true,
    inject: { totalMs: 40, cleanupMs: 100 },
  });
  const started = Date.now();
  const result = await reader.read(DY, 'douyin');
  assert.equal(result.reasonCode, 'login_required');
  assert.equal(result.resolved, false);
  assert.ok(result.diagnostics.elapsedMs >= 40); // The work timer would have fired during cleanup.
  assert.ok(Date.now() - started < 250);
  assert.equal(calls.browserClosed, 1);
  assert.equal(calls.contexts[0].closed, true);
  assert.equal(calls.urls.length, 1);
  calls.releaseCleanup();
});

test('verified body survives cleanup beyond the work deadline with unchanged text', async () => {
  const { reader, calls } = harness({
    evaluateDelayMs: 15, delayFirstCleanup: true, inject: { totalMs: 40, cleanupMs: 100 },
  });
  const result = await reader.read(DY, 'douyin');
  assert.equal(result.reasonCode, 'ok');
  assert.equal(result.resolved, true);
  assert.equal(result.contentStatus, 'body');
  assert.equal(result.extraction.pageText, DESC);
  assert.ok(result.diagnostics.elapsedMs >= 40);
  assert.equal(calls.browserClosed, 1);
  assert.equal(calls.contexts[0].closed, true);
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'ok');
  assert.equal(calls.launches.length, 2);
  calls.releaseCleanup();
});

test('conflicting modal identity and SPA identity changes cannot pass', async () => {
  const first = harness();
  assert.equal((await first.reader.read(`${DY}?modal_id=7483456789012345679`, 'douyin')).reasonCode, 'identity_mismatch');
  assert.equal(first.calls.launches.length, 0);
  const second = harness({ spaSwitch: 'https://www.douyin.com/video/7483456789012345679' });
  assert.equal((await second.reader.read(DY, 'douyin')).reasonCode, 'identity_mismatch');
});

test('body text found only outside the work-description container is not accepted', async () => {
  const { reader } = harness({ visible: DESC, snapshot: { workTexts: ['推荐作品的另一段文字'] }, inject: { totalMs: 15 } });
  assert.equal((await reader.read(DY, 'douyin')).resolved, false);
});

test('same-work navigation context change is observed again without another goto or HTTP request', async () => {
  for (const faults of [
    { evaluateFaults: [{ message: 'Execution context was destroyed, most likely because of a navigation', url: `${DY}?from=normal-navigation` }] },
    { contentFaults: [{ message: 'Unable to retrieve content because the page is navigating and changing the content', url: DY }] },
  ]) {
    const { reader, calls } = harness(faults);
    const result = await reader.read(DY, 'douyin');
    assert.equal(result.reasonCode, 'ok');
    assert.equal(result.contentId, '7483456789012345678');
    assert.equal(result.extraction.pageText, DESC);
    assert.equal(calls.evaluateCount, 2);
    assert.equal(calls.urls.length, 1);
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.http, 0);
    assert.equal(calls.contexts.length, 1);
  }
});

test('navigation recovery rechecks work identity, platform, login and captcha before another DOM read', async () => {
  for (const [target, reason] of [
    ['https://www.douyin.com/video/7483456789012345679', 'identity_mismatch'],
    ['https://www.douyin.com/login/', 'login_required'],
    ['https://www.douyin.com/captcha/', 'captcha'],
    ['https://evil.example/', 'invalid_redirect'],
  ]) {
    const { reader, calls } = harness({ evaluateFaults: [{ message: 'Execution context was destroyed', url: target }] });
    const result = await reader.read(DY, 'douyin');
    assert.equal(result.resolved, false);
    assert.equal(result.reasonCode, reason);
    assert.equal(calls.evaluateCount, 1);
    assert.equal(calls.urls.length, 1);
    assert.equal(calls.http, 0);
  }
});

test('navigation observation recovery is capped at two and does not recover other exceptions', async () => {
  const { reader, calls } = harness({ evaluateFaults: Array.from({ length: 8 }, () => ({ message: 'Execution context was destroyed' })) });
  assert.equal((await reader.read(DY, 'douyin')).reasonCode, 'network_error');
  assert.equal(calls.evaluateCount, 3); // Initial observation plus at most two recoveries.
  assert.equal(calls.urls.length, 1);
  assert.equal(calls.http, 0);
  const other = harness({ evaluateFaults: [{ message: 'Some unrelated DOM or browser failure' }] });
  assert.equal((await other.reader.read(DY, 'douyin')).reasonCode, 'network_error');
  assert.equal(other.calls.evaluateCount, 1);
});

test('navigation context recovery keeps the original total deadline', async () => {
  const { reader, calls } = harness({
    evaluateFaults: [{ message: 'Execution context was destroyed' }], inject: { totalMs: 10, pollMs: 100 },
  });
  const started = Date.now();
  const result = await reader.read(DY, 'douyin');
  assert.equal(result.reasonCode, 'timeout');
  assert.ok(Date.now() - started < 200);
  assert.equal(calls.urls.length, 1);
  assert.equal(calls.evaluateCount, 1);
});
