// Isolated anonymous reader acceptance; no transport, credentials, or model client.
// The CLI writes a new JSONL report, never overwrites or resumes an earlier run.
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const INTERVAL_MS = 10_500;
export const DEADLINE_MS = 35_000;
const VERSION = 'cloud-r3-runner-1';
const HOSTS = {
  xiaohongshu: new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn', 'xhs.cn', 'www.xhs.cn']),
  douyin: new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']),
};
const SHORT = /^(?:v\.douyin\.com|(?:www\.)?xhslink\.(?:cn|com)|(?:www\.)?xhs\.cn)$/;
const GATES = new Set(['captcha', 'login_required', 'access_denied', 'rate_limited']);
const REASONS = new Set(['ok', 'metadata_only', 'media_only', 'app_only', 'not_found', 'captcha', 'login_required', 'access_denied', 'rate_limited', 'identity_mismatch', 'invalid_redirect', 'unsupported_page', 'parse_failed', 'network_error', 'timeout', 'browser_required']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => createHash('sha256').update(value).digest('hex');
const nativeText = value => typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n') : '';
const validId = (id, platform) => typeof id === 'string' && (platform === 'xiaohongshu' ? /^[0-9a-f]{24}$/i : /^\d{10,30}$/).test(id);
const boundedCode = value => typeof value === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(value) ? value : null;
function allowed(value, platform) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') && HOSTS[platform]?.has(url.hostname) ? url : null;
  } catch { return null; }
}
function workId(url, platform) {
  if (!url) return '';
  const pathId = platform === 'xiaohongshu'
    ? url.pathname.match(/^\/(?:explore|discovery\/item)\/([0-9a-f]{24})\/?$/i)?.[1]
    : url.pathname.match(/^\/(?:video|note|share\/(?:video|note|slides))\/(\d{10,30})\/?$/)?.[1];
  const modal = platform === 'douyin' ? url.searchParams.get('modal_id') : null;
  if (modal && (!validId(modal, platform) || (pathId && pathId !== modal))) return '';
  return pathId || modal || '';
}
function safePath(url, platform) {
  const id = workId(url, platform);
  if (id) return { path: url.pathname, pathCategory: 'work' };
  if (/^\/404(?:\/|$)/.test(url.pathname)) return { path: '/404/[redacted]', pathCategory: 'unavailable' };
  if (/captcha|verify|challenge/i.test(url.pathname)) return { path: '/[verification]', pathCategory: 'verification' };
  if (/\/(?:website-login|login|signin|passport|auth)(?:\/|$)/i.test(url.pathname)) return { path: '/[login]', pathCategory: 'login' };
  if (/^\/user\/profile(?:\/|$)/.test(url.pathname)) return { path: '/user/profile/[redacted]', pathCategory: 'profile' };
  if (/^\/(?:explore|jingxuan)\/?$/.test(url.pathname)) return { path: url.pathname, pathCategory: 'feed' };
  if (SHORT.test(url.hostname) && /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return { path: url.pathname, pathCategory: 'short' };
  return { path: '/[unsupported]', pathCategory: 'unsupported' };
}
const sameRoute = (a, b) => a?.host === b?.host && a?.pathname === b?.pathname;

export function validateManifest(data) {
  if (data?.frozen !== true || !Array.isArray(data.samples) || data.samples.length !== 20 || !Array.isArray(data.priorIds)) fail('frozen_20_and_prior_ids_required');
  if (data.priorIds.some(id => !validId(id, 'xiaohongshu') && !validId(id, 'douyin'))) fail('invalid_prior_id');
  const names = new Set();
  const samples = data.samples.map((item, index) => {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(item?.sampleId ?? '') || names.has(item.sampleId)) fail('invalid_sample_id');
    names.add(item.sampleId);
    const url = typeof item.inputUrl === 'string' && item.inputUrl.length <= 2000 ? allowed(item.inputUrl, item.platform) : null;
    if (!url || (!workId(url, item.platform) && !SHORT.test(url.hostname))) fail('invalid_sample_url');
    const expectedId = item.expectedId ?? '';
    if (expectedId && !validId(expectedId, item.platform)) fail('invalid_expected_id');
    const inputId = workId(url, item.platform);
    if (inputId && (!expectedId || inputId !== expectedId)) fail('expected_input_id_mismatch');
    return { index: index + 1, sampleId: item.sampleId, platform: item.platform, inputUrl: item.inputUrl, expectedId, inputId };
  });
  return { samples, priorIds: [...new Set(data.priorIds)] };
}

export function evaluate(item, result, elapsedMs) {
  const diagnostic = result?.diagnostics ?? {};
  const hops = Array.isArray(diagnostic.redirects) ? diagnostic.redirects : [];
  const chain = [], ids = new Set();
  let chainValid = hops.length > 0 && hops.length <= 30;
  let first, last, stopReason = GATES.has(result?.reasonCode) ? result.reasonCode : null;
  for (const hop of hops) {
    const status = Number.isInteger(hop?.status) ? hop.status : null;
    if (!(status >= 200 && status < 400)) chainValid = false;
    if ([401, 403, 429].includes(status)) stopReason ||= ({ 401: 'login_required', 403: 'access_denied', 429: 'rate_limited' })[status];
    const safeParts = typeof hop?.host === 'string' && /^[a-z0-9.-]+$/i.test(hop.host) && typeof hop?.path === 'string' && hop.path.startsWith('/') && !hop.path.startsWith('//') && !/[?#\\]/.test(hop.path);
    const url = safeParts ? allowed(`https://${hop.host}${hop.path}`, item.platform) : null;
    if (!url) { chainValid = false; chain.push({ host: '[invalid]', path: '/[redacted]', pathCategory: 'invalid', status }); continue; }
    first ??= url; last = url;
    const id = workId(url, item.platform); if (id) ids.add(id);
    const path = safePath(url, item.platform);
    if (path.pathCategory === 'login') stopReason ||= 'login_required';
    if (path.pathCategory === 'verification') stopReason ||= 'captcha';
    chain.push({ host: url.hostname, ...path, contentId: id || null, status });
  }
  if ([401, 403, 429].includes(diagnostic.upstreamStatus)) stopReason ||= ({ 401: 'login_required', 403: 'access_denied', 429: 'rate_limited' })[diagnostic.upstreamStatus];
  const input = new URL(item.inputUrl), canonical = allowed(result?.canonicalUrl, item.platform);
  const returnedId = validId(result?.contentId, item.platform) ? result.contentId : null;
  const expectedId = item.expectedId || (ids.size === 1 ? [...ids][0] : '');
  chainValid &&= sameRoute(first, input) && ids.size === 1 && ids.has(expectedId) && workId(last, item.platform) === expectedId &&
    hops.at(-1)?.status >= 200 && hops.at(-1)?.status < 300 && diagnostic.upstreamStatus >= 200 && diagnostic.upstreamStatus < 300;
  const identityValid = Boolean(chainValid && expectedId && returnedId === expectedId && workId(canonical, item.platform) === expectedId && result?.platform === item.platform);
  const description = nativeText(result?.description), pageText = nativeText(result?.extraction?.pageText), title = nativeText(result?.title);
  const withoutTitle = title && pageText.startsWith(`${title}\n`) ? pageText.slice(title.length + 1).trim() : pageText;
  const body = description && withoutTitle.startsWith(description) ? withoutTitle : description && pageText.startsWith(description) ? pageText : '';
  const full = result?.resolved === true && result?.reasonCode === 'ok' && result?.contentStatus === 'body' && result?.extraction?.textStatus === 'full';
  const accepted = !stopReason && identityValid && full && Boolean(body);
  const reason = stopReason || (REASONS.has(result?.reasonCode) ? result.reasonCode : 'invalid_result');
  const reportedReason = !accepted && reason === 'ok' ? !identityValid ? 'identity_validation_failed' : !full ? 'full_body_status_failed' : 'missing_description' : reason;
  return {
    index: item.index, sampleId: item.sampleId, platform: item.platform, status: accepted ? 'success' : 'failed', accepted, reason: reportedReason,
    expectedId: expectedId || null, returnedId, identityValid, identityBasis: item.expectedId ? 'frozen_expected_id' : 'this_response_redirect_not_independent_anchor',
    readerCalls: 1, elapsedMs, upstreamStatus: Number.isInteger(diagnostic.upstreamStatus) ? diagnostic.upstreamStatus : null,
    resolverVersion: boundedCode(result?.resolverVersion), method: ['html', 'browser'].includes(diagnostic.method) ? diagnostic.method : null,
    readerElapsedMs: Number.isFinite(diagnostic.elapsedMs) ? diagnostic.elapsedMs : null,
    mainDocumentResponsesReported: hops.length, totalNetworkRequests: null, redirectChain: chain,
    bodyLength: [...body].length, bodyUtf8Bytes: Buffer.byteLength(body), bodySha256: body ? sha(body) : null,
    descriptionLength: [...description].length, mediaCount: Array.isArray(result?.extraction?.media) ? result.extraction.media.length : 0,
    stopReason,
  };
}

export async function runBatch(manifest, reader, emit, { clock = Date.now, delay = sleep, signal, deadlineMs = DEADLINE_MS } = {}) {
  const rows = [], seen = new Set(manifest.priorIds), seenInputs = new Set();
  let lastStart = -Infinity, stoppedReason = null;
  for (const item of manifest.samples) {
    const base = { index: item.index, sampleId: item.sampleId, platform: item.platform, accepted: false, readerCalls: 0, expectedId: item.expectedId || null };
    let row;
    if (signal?.aborted) stoppedReason ||= 'operator_cancelled';
    if (stoppedReason) row = { ...base, status: 'not_run', reason: stoppedReason };
    else if ((item.expectedId && seen.has(item.expectedId)) || seenInputs.has(item.inputUrl)) row = { ...base, status: 'duplicate', reason: 'duplicate_input_or_prior_work' };
    else {
      try { await delay(Math.max(0, INTERVAL_MS - (clock() - lastStart)), undefined, { signal }); }
      catch { stoppedReason = 'operator_cancelled'; }
      if (signal?.aborted) stoppedReason ||= 'operator_cancelled';
      if (stoppedReason) row = { ...base, status: 'not_run', reason: stoppedReason };
      else {
        lastStart = clock(); seenInputs.add(item.inputUrl);
        const controller = new AbortController();
        const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
        let timer;
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => reader.resolvePublic(item.inputUrl, item.platform, { signal: controller.signal })),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('reader_deadline'), { code: 'reader_deadline' })); }, deadlineMs); }),
          ]);
          row = evaluate(item, result, Math.max(0, clock() - lastStart));
          stoppedReason = row.stopReason;
          if (row.identityValid && seen.has(row.expectedId)) { row.accepted = false; row.status = 'duplicate'; row.reason = 'duplicate_returned_work'; }
          if (row.identityValid) seen.add(row.expectedId);
        } catch (error) {
          stoppedReason = error?.code === 'reader_deadline' ? 'reader_deadline' : 'reader_exception';
          row = { ...base, status: 'failed', reason: stoppedReason, readerCalls: 1, elapsedMs: Math.max(0, clock() - lastStart) };
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
        if (item.expectedId) seen.add(item.expectedId);
        if (signal?.aborted) { stoppedReason = 'operator_cancelled'; row.accepted = false; row.status = 'failed'; row.reason = stoppedReason; }
      }
    }
    rows.push(row); await emit({ type: 'result', ...row });
  }
  const summary = { type: 'summary', complete: true, denominator: 20, successCount: rows.filter(row => row.accepted).length,
    attemptedCount: rows.filter(row => row.readerCalls).length, duplicateCount: rows.filter(row => row.status === 'duplicate').length,
    notRunCount: rows.filter(row => row.status === 'not_run').length, independentObservedWorks: new Set(rows.filter(row => row.identityValid).map(row => row.expectedId)).size,
    readerCalls: rows.reduce((sum, row) => sum + row.readerCalls, 0), mainDocumentResponsesReported: rows.reduce((sum, row) => sum + (row.mainDocumentResponsesReported || 0), 0),
    totalNetworkRequests: null, stoppedReason, modelCalls: 0 };
  await emit(summary); return summary;
}

export const openReport = reportPath => open(reportPath, 'wx', 0o600);

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--reader', '--manifest', '--report'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) fail('invalid_arguments');
    args[argv[i]] = argv[i + 1];
  }
  if (Object.keys(args).length !== 3 || Object.values(args).some(value => !isAbsolute(value))) fail('three_absolute_paths_required');
  if (process.platform !== 'linux' || process.getuid?.() === 0) fail('nonroot_linux_required');
  const inputBytes = await readFile(args['--manifest']);
  const manifest = validateManifest(JSON.parse(inputBytes));
  const readerPath = args['--reader'], root = dirname(readerPath), sourceHashes = {};
  for (const name of ['browser-reader.mjs', 'lib/server/link-resolver.mjs', 'lib/shared/link-page.mjs', 'lib/shared/links.mjs']) {
    sourceHashes[name] = sha(await readFile(name === 'browser-reader.mjs' ? readerPath : join(root, name)));
  }
  // Reserve output before importing/calling the reader. EEXIST means zero reader calls.
  const output = await openReport(args['--report']);
  const emit = async value => { await output.writeFile(`${JSON.stringify(value)}\n`); await output.sync(); };
  const controller = new AbortController();
  const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let reader;
  try {
    await emit({ type: 'header', runnerVersion: VERSION, runnerSha256: sha(await readFile(new URL(import.meta.url))),
      startedAt: new Date().toISOString(), mode: 'real_anonymous_in_process_reader_not_site_e2e', environment: 'linux_cloud',
      manifestSha256: sha(inputBytes), sourceHashes, denominator: 20, priorIdCount: manifest.priorIds.length,
      intervalMs: INTERVAL_MS, intervalScope: 'reader_call_starts_not_browser_subrequests', deadlineMs: DEADLINE_MS,
      modelCalls: 0, savedBody: false, savedQueries: false, suppliedCredentials: false, totalNetworkRequests: null });
    reader = await import(pathToFileURL(readerPath).href);
    if (typeof reader.resolvePublic !== 'function' || typeof reader.closePublicBrowser !== 'function') fail('invalid_reader_exports');
    return await runBatch(manifest, reader, emit, { signal: controller.signal });
  } finally {
    controller.abort();
    let timer;
    try { await Promise.race([Promise.resolve().then(() => reader?.closePublicBrowser?.()).catch(() => {}), new Promise(done => { timer = setTimeout(done, 3000); })]); }
    finally { clearTimeout(timer); await output.close(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const summary = await main(); console.log(JSON.stringify(summary));
    // Dedicated CLI process: terminate residual browser handles after bounded cleanup.
    process.exit(summary.successCount === 20 ? 0 : 2);
  } catch {
    console.error(JSON.stringify({ error: 'runner_failed_no_raw_error_logged' })); process.exit(1);
  }
}
