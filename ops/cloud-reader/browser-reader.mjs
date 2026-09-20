import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parseLinkPage as defaultParser, emptyResolution } from './lib/shared/link-page.mjs';
import { platformFor as defaultPlatform, contentIdFor as defaultContentId } from './lib/shared/links.mjs';
import { resolveLink as defaultResolveLink } from './lib/server/link-resolver.mjs';

const VERSION = 'public-browser-1.0';
const MAX_HTML_BYTES = 2_000_000;
const FALLBACK_REASONS = new Set(['network_error', 'timeout', 'parse_failed', 'metadata_only']);
const CDN_ROOTS = {
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com', 'xhscdn.net'],
  douyin: ['douyin.com', 'iesdouyin.com', 'douyinstatic.com', 'douyinpic.com', 'byteimg.com', 'bytegecko.com', 'bytetos.com', 'ibytedtos.com', 'pstatp.com'],
};
const normalize = value => String(value ?? '').normalize('NFC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();

function pathGate(url) {
  if (/(?:captcha|verify|challenge)/i.test(url.pathname)) return 'captcha';
  if (/\/(?:website-login|login|passport)(?:\/|$)/i.test(url.pathname)) return 'login_required';
  return '';
}

function conflictingIdentity(url, platform) {
  if (platform !== 'douyin') return false;
  const pathId = url.pathname.match(/\/(?:video|note|share\/(?:video|note|slides))\/(\d+)(?:\/|$)/)?.[1];
  const modalId = url.searchParams.get('modal_id');
  return Boolean(pathId && modalId && /^\d+$/.test(modalId) && pathId !== modalId);
}

function textGate(snapshot) {
  if (snapshot.captcha || /请完成(?:安全)?验证|拖动滑块|请输入验证码|请进行安全验证|verify you are human/i.test(snapshot.text)) return 'captcha';
  if (snapshot.login || /登录后(?:查看|浏览)|请先登录/.test(snapshot.text)) return 'login_required';
  if (/仅支持在小红书\s*APP\s*内查看|仅(?:限|支持).*App\s*内(?:打开|查看)|打开(?:抖音|小红书)\s*(?:APP|App)?(?:查看|观看)(?:完整|本条|该)/i.test(snapshot.text)) return 'app_only';
  if (/访问频繁|请求过于频繁|访问过于频繁/.test(snapshot.text)) return 'rate_limited';
  if (snapshot.denied || /访问被拒绝|访问受限|Access Denied|Attention Required/i.test(snapshot.text)) return 'access_denied';
  return '';
}

// Read only visible DOM. Do not inspect cookies, storage, browser profiles, or fetch private APIs.
function visibleSnapshot({ platform }) {
  const visible = element => {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const any = selector => [...document.querySelectorAll(selector)].some(visible);
  const workSelector = platform === 'xiaohongshu' ? '#detail-desc, .note-content' : '[data-e2e="video-desc"], [data-e2e="detail-video-desc"], [data-e2e="note-desc"]';
  const workTexts = [...document.querySelectorAll(workSelector)]
    .filter(element => visible(element) && !element.closest('[data-e2e*="recommend"], .recommend-container, .recommend-list, .comments-container'))
    .map(element => element.innerText?.slice(0, 20_000) ?? '').filter(Boolean).slice(0, 20);
  return {
    text: (document.body?.innerText ?? '').slice(0, 200_000),
    workTexts,
    captcha: any('.captcha-container, .captcha-modal, .captcha-verify-container, #captcha, #captcha_container, #captcha-verify-container, iframe[src*="captcha"], iframe[src*="verify"]'),
    login: any('.login-container, .login-modal, .login-panel, [data-e2e="login-dialog"]'),
    denied: any('.access-wrapper, .blocked-wrapper'),
  };
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Reject mapped/transition/link-local/private IPv6; only public global-unicast is allowed.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0:|db8:)/i.test(address) && !/^2002:/i.test(address);
}

export function createPublicBrowserReader({
  chromium,
  parseLinkPage = defaultParser,
  platformFor = defaultPlatform,
  contentIdFor = defaultContentId,
  resolveLink = defaultResolveLink,
  lookup = dnsLookup,
  fetcher = globalThis.fetch,
  getuid = typeof process.getuid === 'function' ? () => process.getuid() : () => undefined,
  importPlaywright = () => import('playwright'),
  now = Date.now,
  totalMs = 25_000,
  cleanupMs = 3_000,
  pollMs = 250,
} = {}) {
  const budget = Math.max(1, Math.min(25_000, totalMs));
  const cleanupBudget = Math.max(1, Math.min(3_000, cleanupMs));
  let browserPromise, activeContext, activeTask, busy = false, closing = false;
  const contextClosures = new WeakMap();
  const closedContexts = new WeakSet();
  const browserRetirements = new WeakMap();
  const closedBrowsers = new WeakSet();

  async function bounded(promise, ms) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise).then(value => ({ settled: true, value }), () => ({ settled: true, value: false })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), Math.max(0, ms)); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function closeContext(context) {
    if (!context) return true;
    if (!contextClosures.has(context)) contextClosures.set(context, Promise.resolve().then(() => context.close()).then(() => {
      closedContexts.add(context);
      if (activeContext === context) activeContext = undefined;
      return true;
    }, () => false));
    return contextClosures.get(context);
  }

  function release(task) {
    // A context may finish closing while its browser is already being retired.
    // Never let the next task reuse an instance with browser.close still in flight.
    if (task.browserPromise && browserRetirements.has(task.browserPromise) && !closedBrowsers.has(task.browserPromise)) return;
    if (activeTask === task) { activeTask = undefined; busy = false; }
  }

  function retireBrowser(promise) {
    if (!promise) return Promise.resolve(true);
    if (!browserRetirements.has(promise)) browserRetirements.set(promise, promise.then(async browser => {
      try { await browser.close(); return true; }
      catch { return typeof browser.isConnected === 'function' && !browser.isConnected(); }
    }, () => true).then(stopped => {
      if (stopped) {
        closedBrowsers.add(promise);
        if (browserPromise === promise) browserPromise = undefined;
      }
      return stopped;
    }));
    return browserRetirements.get(promise);
  }

  function quiesce(task) {
    if (activeContext === task.context) activeContext = undefined;
    release(task);
    return true;
  }

  async function cleanupTask(task) {
    if (task.cleanupPromise) return task.cleanupPromise;
    task.cleanupPromise = (async () => {
      const until = Date.now() + cleanupBudget;
      const remaining = () => Math.max(0, until - Date.now());
      // Usually context.close settles within a few milliseconds. Wait before exposing
      // a timeout result, so the very next serial request does not observe stale busy.
      const grace = Math.min(500, Math.floor(cleanupBudget / 2));
      if (task.context) {
        const result = await bounded(closeContext(task.context), grace);
        if (result.settled && result.value) return quiesce(task);
      } else {
        await bounded(task.donePromise, grace);
        if (task.workSettled && (!task.context || closedContexts.has(task.context))) return quiesce(task);
        if (task.context && closedContexts.has(task.context)) return quiesce(task);
      }
      if (task.browserPromise) {
        // A hanging newContext / context.close is isolated by retiring this browser.
        // No new browser is allowed until closure of the old one is confirmed.
        const retirement = retireBrowser(task.browserPromise).then(stopped => stopped ? quiesce(task) : false);
        const result = await bounded(retirement, remaining());
        return result.settled && result.value;
      }
      await bounded(task.donePromise, remaining());
      return task.workSettled ? quiesce(task) : false;
    })();
    return task.cleanupPromise;
  }

  async function close() {
    closing = true;
    activeTask?.cancel?.();
    if (activeTask) await cleanupTask(activeTask);
    await bounded(retireBrowser(browserPromise), cleanupBudget);
  }

  async function getBrowser(remaining, task) {
    if (closing) throw new Error('closed');
    if (getuid() === 0) throw new Error('root_disallowed');
    if (!browserPromise) {
      browserPromise = (async () => {
        const engine = chromium ?? (await importPlaywright()).chromium;
        // Ubuntu's packaged AppArmor policy supports the official root-owned Chrome path.
        // Never disable the browser sandbox or the host user-namespace protection.
        return engine.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, timeout: remaining });
      })();
      browserPromise.catch(() => { browserPromise = undefined; });
    }
    task.browserPromise = browserPromise;
    return browserPromise;
  }

  function begin(url, platform, signal) {
    let start;
    try { start = new URL(url); } catch { return null; }
    if (!['xiaohongshu', 'douyin'].includes(platform) || platformFor(start) !== platform || start.hash) return null;
    return { start, workUrl: start, platform, started: now(), deadline: now() + budget,
      redirects: [], upstreamStatus: 0, reason: '', context: null, cancelled: false,
      signal, controller: new AbortController() };
  }

  const failure = (task, reason) => ({
    ...emptyResolution(task.platform, task.workUrl, reason), resolverVersion: VERSION,
    diagnostics: { method: 'browser', upstreamStatus: task.upstreamStatus, redirects: task.redirects, elapsedMs: Math.max(0, now() - task.started) },
  });

  function finish(task, result) {
    return { ...result, resolverVersion: VERSION, diagnostics: {
      method: 'browser', upstreamStatus: task.upstreamStatus, redirects: task.redirects, elapsedMs: Math.max(0, now() - task.started),
    } };
  }

  async function timed(task, operation) {
    let timer;
    const cancellation = new Promise(resolve => {
      task.cancel = () => {
        task.cancelled = true;
        task.reason ||= 'timeout';
        task.controller.abort();
        void closeContext(task.context);
        resolve(failure(task, task.reason));
      };
      timer = setTimeout(task.cancel, Math.max(1, task.deadline - now()));
      task.signal?.addEventListener('abort', task.cancel, { once: true });
      if (task.signal?.aborted) task.cancel();
    });
    const work = Promise.resolve().then(() => task.cancelled ? failure(task, task.reason) : operation());
    task.donePromise = work.then(() => true, () => true);
    void task.donePromise.then(() => {
      task.workSettled = true;
      if (!task.context || closedContexts.has(task.context) || closedBrowsers.has(task.browserPromise)) release(task);
    });
    try {
      const result = await Promise.race([work, cancellation]);
      if (task.cancelled || (task.context && !closedContexts.has(task.context))) {
        await cleanupTask(task);
        // Include bounded cleanup in elapsed time without changing the original failure.
        return { ...result, diagnostics: { ...result.diagnostics, elapsedMs: Math.max(0, now() - task.started) } };
      }
      return result;
    }
    finally { clearTimeout(timer); task.signal?.removeEventListener('abort', task.cancel); }
  }

  async function readBrowser(task) {
    const remaining = () => Math.max(1, task.deadline - now());
    let page;
    try {
      const browser = await getBrowser(remaining(), task);
      if (task.cancelled || closing) return failure(task, 'timeout');
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', bypassCSP: false });
      task.context = context;
      if (task.cancelled || closing) { await closeContext(context); return failure(task, 'timeout'); }
      activeContext = context;
      context.setDefaultTimeout(remaining());
      context.setDefaultNavigationTimeout(remaining());
      const stop = reason => { task.reason ||= reason; void closeContext(context); };
      // Fail closed when using an old Playwright without WebSocket interception.
      if (typeof context.routeWebSocket !== 'function') return failure(task, 'browser_required');
      await context.routeWebSocket(/.*/, async socket => { try { await socket.close(); } catch { /* Context may already be closing. */ } });
      const dnsChecks = new Map();
      const publicHost = hostname => {
        if (!dnsChecks.has(hostname)) dnsChecks.set(hostname, Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true }))
          .then(records => records.length > 0 && records.every(record => publicAddress(record.address))).catch(() => false));
        return dnsChecks.get(hostname);
      };
      await context.route('**/*', async route => {
        const request = route.request();
        let target;
        try { target = new URL(request.url()); } catch { await route.abort('blockedbyclient'); return; }
        const isMain = request.isNavigationRequest() && request.frame() === page?.mainFrame();
        const validTransport = target.protocol === 'https:' && !target.username && !target.password && (!target.port || target.port === '443') && !isIP(target.hostname.replace(/^\[|\]$/g, ''));
        if (isMain) {
          if (!validTransport || platformFor(target) !== task.platform) { task.reason ||= 'invalid_redirect'; await route.abort('blockedbyclient'); return; }
          if (conflictingIdentity(target, task.platform)) { task.reason ||= 'identity_mismatch'; await route.abort('blockedbyclient'); return; }
          const gate = pathGate(target);
          if (gate) { task.reason ||= gate; await route.abort('blockedbyclient'); return; }
          const expected = contentIdFor(task.platform, task.workUrl), next = contentIdFor(task.platform, target);
          if (expected && next && expected !== next) { task.reason ||= 'identity_mismatch'; await route.abort('blockedbyclient'); return; }
          if (!expected && next) task.workUrl = target;
        }
        const allowedHost = platformFor(target) === task.platform || CDN_ROOTS[task.platform].some(root => target.hostname === root || target.hostname.endsWith(`.${root}`));
        const blockedResource = ['media', 'websocket', 'eventsource'].includes(request.resourceType()) || /\.(?:mp4|m3u8|m4s|mp3|webm|mov|wav)(?:$|\?)/i.test(target.pathname);
        if (!validTransport || !allowedHost || blockedResource || !['GET', 'HEAD'].includes(request.method()) || (request.isNavigationRequest() && !isMain) || !(await publicHost(target.hostname))) {
          if (isMain) task.reason ||= 'access_denied';
          await route.abort('blockedbyclient'); return;
        }
        if (task.cancelled || task.reason) { await route.abort('blockedbyclient'); return; }
        await route.continue();
      });
      context.on('page', candidate => { if (page && candidate !== page) void candidate.close().catch(() => {}); });
      page = await context.newPage();
      page.on('download', download => { void download.cancel().catch(() => {}); stop('unsupported_page'); });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('response', response => {
        const request = response.request();
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        let target;
        try { target = new URL(response.url()); } catch { stop('invalid_redirect'); return; }
        task.upstreamStatus = response.status();
        if (task.redirects.length >= 8) { stop('invalid_redirect'); return; }
        task.redirects.push({ host: target.hostname, path: target.pathname.slice(0, 160), status: response.status() });
        if (response.status() === 401) stop('login_required');
        if (response.status() === 403) stop('access_denied');
        if (response.status() === 429) stop('rate_limited');
      });
      await page.goto(task.start.toString(), { waitUntil: 'domcontentloaded', timeout: remaining() });
      while (!task.cancelled && !task.reason && now() < task.deadline) {
        const current = new URL(page.url());
        if (platformFor(current) !== task.platform) return failure(task, 'invalid_redirect');
        if (conflictingIdentity(current, task.platform)) return failure(task, 'identity_mismatch');
        const gate = pathGate(current);
        if (gate) return failure(task, gate);
        const id = contentIdFor(task.platform, task.workUrl), currentId = contentIdFor(task.platform, current);
        if (!id || !currentId) return failure(task, 'unsupported_page');
        if (id !== currentId) return failure(task, 'identity_mismatch');
        const snapshot = await page.evaluate(visibleSnapshot, { platform: task.platform });
        const visibleGate = textGate(snapshot);
        if (visibleGate) return failure(task, visibleGate);
        const originalHtml = await page.content();
        // Bound parser input, and reject rather than claiming success from a truncated page.
        const bytes = Buffer.from(originalHtml, 'utf8');
        const html = bytes.subarray(0, MAX_HTML_BYTES).toString('utf8');
        if (bytes.length > MAX_HTML_BYTES) return failure(task, 'unsupported_page');
        const parsed = parseLinkPage(html, task.platform, task.workUrl, current, task.upstreamStatus || 200);
        // pushState / SPA changes do not necessarily produce a navigation request.
        const afterRead = new URL(page.url());
        if (task.cancelled || task.reason) return failure(task, task.reason || 'timeout');
        if (platformFor(afterRead) !== task.platform) return failure(task, 'invalid_redirect');
        if (conflictingIdentity(afterRead, task.platform) || contentIdFor(task.platform, afterRead) !== id) return failure(task, 'identity_mismatch');
        if (['captcha', 'login_required', 'app_only', 'access_denied', 'rate_limited', 'identity_mismatch', 'invalid_redirect', 'not_found'].includes(parsed.reasonCode)) return finish(task, parsed);
        const body = normalize(snapshot.text);
        const text = String(parsed.extraction?.pageText ?? '').trim();
        // Every parser-extracted line must appear in visible DOM, including the full description.
        const lines = text.split(/\r?\n/).map(normalize).filter(Boolean);
        const title = normalize(parsed.title);
        const scopedBody = (snapshot.workTexts ?? []).map(normalize).some(scope =>
          normalize(parsed.description) && scope.includes(normalize(parsed.description)) &&
          lines.every(line => line === title || scope.includes(line)));
        if (parsed.resolved && parsed.reasonCode === 'ok' && parsed.contentStatus === 'body' &&
            parsed.extraction?.textStatus === 'full' && parsed.contentId === id &&
            scopedBody && lines.length && lines.every(line => body.includes(line))) return finish(task, parsed);
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining())));
      }
      return failure(task, task.reason || 'timeout');
    } catch {
      return failure(task, task.reason || (task.cancelled || now() >= task.deadline ? 'timeout' : !task.context ? 'browser_required' : 'network_error'));
    } finally { await closeContext(task.context); }
  }

  async function execute(url, platform, useHttp, { signal } = {}) {
    const task = begin(url, platform, signal);
    if (!task) throw new TypeError('Invalid public platform URL');
    if (conflictingIdentity(task.start, platform)) return failure(task, 'identity_mismatch');
    if (busy || activeContext || closing) return failure(task, 'rate_limited');
    busy = true;
    activeTask = task;
    return timed(task, async () => {
        if (useHttp && platform === 'xiaohongshu') {
          let result;
          try {
            result = await resolveLink(task.start, platform, (input, options = {}) => fetcher(input, {
              ...options, signal: options.signal ? AbortSignal.any([options.signal, task.controller.signal]) : task.controller.signal,
            }));
          }
          catch { result = failure(task, 'network_error'); }
          if (task.cancelled) return failure(task, 'timeout');
          if (!FALLBACK_REASONS.has(result.reasonCode)) return { ...result, diagnostics: { ...result.diagnostics, method: 'html' } };
        }
        return readBrowser(task);
    });
  }

  return { read: (url, platform, options) => execute(url, platform, false, options), resolvePublic: (url, platform, options) => execute(url, platform, true, options), close };
}

let defaultReader;
export function resolvePublic(url, platform, options) {
  defaultReader ??= createPublicBrowserReader();
  return defaultReader.resolvePublic(url, platform, options);
}
export async function closePublicBrowser() { if (defaultReader) await defaultReader.close(); }
