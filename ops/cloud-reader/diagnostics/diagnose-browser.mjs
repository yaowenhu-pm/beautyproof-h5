// Offline preparation only. Actual target access requires explicit --run-once.
// Run ONLY after the sample batch has finished, in a dedicated OS process group /
// transient systemd unit: RuntimeMaxSec=34s, TimeoutStopSec=1s, KillMode=control-group.
// The OS supervisor must reap Chrome descendants if Node's hard watchdog exits.
// This module does not modify reader routing, headers, launch flags, body acceptance,
// sandbox policy, cookie handling, or retry behavior.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const TARGET = 'https://www.douyin.com/video/7677397234564041990';
const HARD_EXIT_MS = 33_500;
const REASONS = new Set(['ok', 'metadata_only', 'media_only', 'app_only', 'captcha', 'login_required', 'not_found', 'browser_required', 'parse_failed', 'identity_mismatch', 'rate_limited', 'timeout', 'network_error', 'access_denied', 'invalid_redirect', 'unsupported_page']);
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOENT', 'EACCES', 'ERR_MODULE_NOT_FOUND', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_ABORTED', 'ERR_NETWORK_CHANGED']);

function errorCode(error) {
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  if (error?.name === 'AbortError') return 'ABORTED';
  if (ERROR_CODES.has(error?.code)) return error.code;
  // Never log a raw message, stack, URL, browser arguments, or environment.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/Target (?:page, context or browser|closed)|has been closed/i.test(message)) return 'TARGET_CLOSED';
  const netCode = message.match(/net::(ERR_[A-Z_]+)/)?.[1];
  return ERROR_CODES.has(netCode) ? netCode : 'UNKNOWN';
}

export function instrumentChromium(chromium, emit, clock = () => performance.now()) {
  const cache = new WeakMap();
  let sequence = 0;
  const measure = async (phase, operation) => {
    const id = ++sequence, started = clock();
    emit({ phase, id, event: 'start', elapsedMs: 0 });
    try {
      const value = await operation();
      emit({ phase, id, event: 'end', elapsedMs: Math.max(0, Math.round(clock() - started)) });
      return value;
    } catch (error) {
      emit({ phase, id, event: 'error', elapsedMs: Math.max(0, Math.round(clock() - started)), errorCode: errorCode(error) });
      throw error;
    }
  };
  const wrap = (target, type) => {
    if (cache.has(target)) return cache.get(target);
    const instrumented = new Proxy(target, {
      get(object, property) {
        const member = Reflect.get(object, property, object);
        if (typeof member !== 'function') return member;
        if (type === 'browser' && property === 'newContext') return (...args) => measure('newContext', async () => wrap(await member.apply(object, args), 'context'));
        if (type === 'context' && property === 'newPage') return (...args) => measure('newPage', async () => wrap(await member.apply(object, args), 'page'));
        if (type === 'context' && property === 'on') return (event, listener) => {
          if (event !== 'page') return member.call(object, event, listener);
          member.call(object, event, (candidate, ...args) => listener.call(instrumented, wrap(candidate, 'page'), ...args));
          return instrumented;
        };
        if (type === 'page' && property === 'goto') return (...args) => measure('goto', () => member.apply(object, args));
        if (property === 'close') return (...args) => measure(`${type}.close`, () => member.apply(object, args));
        // Preserve the native receiver and all original arguments for every API.
        return member.bind(object);
      },
    });
    cache.set(target, instrumented);
    return instrumented;
  };
  return new Proxy(chromium, {
    get(object, property) {
      const member = Reflect.get(object, property, object);
      if (property === 'launch') return (...args) => measure('launch', async () => wrap(await member.apply(object, args), 'browser'));
      return typeof member === 'function' ? member.bind(object) : member;
    },
  });
}

function deadline(promise, milliseconds) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(1, milliseconds)); }),
  ]).finally(() => clearTimeout(timer));
}

async function runOnce() {
  const started = performance.now();
  const emit = event => console.log(JSON.stringify({ ...event, sinceStartMs: Math.max(0, Math.round(performance.now() - started)) }));
  // Upstream debug modes may print page URLs/arguments; fail closed instead.
  if (process.env.DEBUG || process.env.PWDEBUG) {
    emit({ phase: 'startup', event: 'error', errorCode: 'DEBUG_LOGGING_DISALLOWED' });
    process.exitCode = 64;
    return;
  }
  let reader, finishing = false;
  const controller = new AbortController();
  const hardExit = setTimeout(() => {
    emit({ phase: 'watchdog', event: 'error', errorCode: 'HARD_DEADLINE' });
    process.exit(124); // Dedicated OS cgroup must reap any unresponsive descendants.
  }, HARD_EXIT_MS);
  const finish = async code => {
    if (finishing) return;
    finishing = true;
    controller.abort();
    const remaining = Math.max(1, Math.min(3_000, HARD_EXIT_MS - (performance.now() - started) - 100));
    const closed = reader ? await deadline(reader.close(), remaining) : true;
    emit({ phase: 'shutdown', event: closed ? 'end' : 'error', ...(closed ? {} : { errorCode: 'CLEANUP_DEADLINE' }) });
    clearTimeout(hardExit);
    process.exit(closed ? code : 124);
  };
  process.once('SIGTERM', () => { void finish(143); });
  process.once('SIGINT', () => { void finish(130); });
  process.once('uncaughtException', error => { emit({ phase: 'process', event: 'error', errorCode: errorCode(error) }); void finish(1); });
  process.once('unhandledRejection', error => { emit({ phase: 'process', event: 'error', errorCode: errorCode(error) }); void finish(1); });
  try {
    emit({ phase: 'dependencies', event: 'start', elapsedMs: 0 });
    const [{ chromium }, { createPublicBrowserReader }] = await Promise.all([
      import('playwright'), import('../browser-reader.mjs'),
    ]);
    emit({ phase: 'dependencies', event: 'end', elapsedMs: Math.round(performance.now() - started) });
    reader = createPublicBrowserReader({ chromium: instrumentChromium(chromium, emit) });
    emit({ phase: 'read', event: 'start', elapsedMs: 0 });
    const result = await reader.read(TARGET, 'douyin', { signal: controller.signal });
    emit({ phase: 'read', event: 'end', elapsedMs: Math.round(performance.now() - started),
      resolved: result.resolved === true, reasonCode: REASONS.has(result.reasonCode) ? result.reasonCode : 'unknown' });
    await finish(result.resolved === true && result.contentStatus === 'body' ? 0 : 2);
  } catch (error) {
    emit({ phase: 'read', event: 'error', errorCode: errorCode(error) });
    await finish(1);
  }
}

async function selfTest() {
  const { default: assert } = await import('node:assert/strict');
  const { EventEmitter } = await import('node:events');
  const events = [], calls = [];
  const secret = 'DO_NOT_LOG_THIS_FAKE_QUERY_OR_BODY';
  const nativePage = {
    async goto(url, options) { calls.push({ kind: 'goto', receiver: this, url, options }); return null; },
    async close() { calls.push({ kind: 'page.close', receiver: this }); },
    custom() { return this; },
  };
  const nativeContext = Object.assign(new EventEmitter(), {
    async newPage() { this.emit('page', nativePage); return nativePage; }, async close() {},
  });
  const nativeBrowser = { async newContext(options) { calls.push({ kind: 'context', options }); return nativeContext; }, async close() {} };
  const original = { async launch(options) { calls.push({ kind: 'launch', receiver: this, options }); return nativeBrowser; } };
  const wrapped = instrumentChromium(original, event => events.push(event));
  const launchOptions = { channel: 'chrome', chromiumSandbox: true, headless: true };
  const browser = await wrapped.launch(launchOptions);
  const contextOptions = { acceptDownloads: false, serviceWorkers: 'block', bypassCSP: false };
  const context = await browser.newContext(contextOptions);
  let eventPage;
  assert.equal(context.on('page', candidate => { eventPage = candidate; }), context);
  const page = await context.newPage();
  assert.equal(eventPage, page); // Initial page event and newPage share the cached proxy.
  nativeContext.emit('page', nativePage);
  assert.equal(eventPage, page); // A later event cannot look like an unrelated popup.
  assert.notEqual(eventPage, nativePage);
  const gotoOptions = { timeout: 25_000, waitUntil: 'domcontentloaded' };
  await page.goto(`https://offline.invalid/?secret=${secret}`, gotoOptions);
  assert.equal(calls.find(call => call.kind === 'launch').options, launchOptions);
  assert.equal(calls.find(call => call.kind === 'launch').receiver, original);
  assert.equal(calls.find(call => call.kind === 'context').options, contextOptions);
  assert.equal(calls.find(call => call.kind === 'goto').options, gotoOptions);
  assert.equal(calls.find(call => call.kind === 'goto').receiver, nativePage);
  assert.equal(page.custom(), nativePage);
  const timeoutError = Object.assign(new Error(`timeout ${secret}`), { name: 'TimeoutError' });
  nativePage.goto = async () => { throw timeoutError; };
  await assert.rejects(page.goto('https://offline.invalid/'), error => error === timeoutError);
  await page.close(); await context.close(); await browser.close();
  assert.equal(events.find(event => event.event === 'error').errorCode, 'TIMEOUT');
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(JSON.stringify(events).includes('offline.invalid'), false);
  assert.deepEqual(new Set(events.map(event => event.phase)), new Set(['launch', 'newContext', 'newPage', 'goto', 'page.close', 'context.close', 'browser.close']));
  console.log(JSON.stringify({ offlineSelfTest: 'passed', networkCalls: 0, logEvents: events.length }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') await selfTest();
  else if (process.argv.length === 3 && process.argv[2] === '--run-once') await runOnce();
  else { console.log(JSON.stringify({ errorCode: 'EXPLICIT_MODE_REQUIRED', modes: ['--self-test', '--run-once'] })); process.exitCode = 64; }
}
