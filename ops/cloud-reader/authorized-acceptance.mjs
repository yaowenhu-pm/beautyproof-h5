// Prepared, internal-only experiment. No credentials, login UI or public endpoint.
// A future operator-controlled cloud login flow must supply in-memory leases.
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicBrowserReader } from './browser-reader.mjs';
import { validateCandidates, applyOverrides, evaluateResponse, INTERVAL_MS } from './acceptance-20.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PURPOSE = 'internal-fixed-20-test';
const PLATFORMS = ['xiaohongshu', 'douyin'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = code => Object.assign(new Error(code), { code });

export async function preflight() {
  const items = validateCandidates(JSON.parse(await readFile(join(HERE, 'candidates-20260920.json'), 'utf8')));
  return {
    status: 'prepared_not_live_verified', purpose: PURPOSE,
    fixedCandidates: items.length, counts: { xiaohongshu: 10, douyin: 10 },
    fixture: 'candidates-20260920.json', networkRequests: 0, modelCalls: 0,
    sessionInput: 'in_memory_dedicated_account_leases_only',
    publicServiceEnabled: false, interactiveLoginPrepared: false,
    blockers: ['dedicated_accounts_missing', 'operator_cloud_login_required', 'platform_usage_authorization_unverified'],
    separateDeploymentBlocker: 'public_https_domain_unavailable',
  };
}

function requireLeases(leases) {
  if (!leases || PLATFORMS.some(platform => {
    const lease = leases[platform];
    if (!lease || typeof lease.getState !== 'function' || typeof lease.revoke !== 'function' || typeof lease.status !== 'function') return true;
    const status = lease.status();
    return status.state !== 'ready' || status.platform !== platform;
  })) throw error('both_dedicated_session_leases_required');
}

// Exported only for a future trusted operator controller. HTTP requests cannot
// invoke this function, submit state, choose samples or choose target endpoints.
export async function runAuthorizedAcceptance({ leases, outputDir, inputOverrides = {}, signal } = {}, dependencies = {}) {
  requireLeases(leases);
  const clock = dependencies.clock ?? Date.now;
  const monotonic = dependencies.monotonic ?? (() => performance.now());
  const delay = dependencies.sleep ?? sleep;
  const makeReader = dependencies.makeReader ?? (options => createPublicBrowserReader(options));
  const items = applyOverrides(validateCandidates(JSON.parse(await readFile(join(HERE, 'candidates-20260920.json'), 'utf8'))), inputOverrides);
  const readers = new Map();
  const startedAt = new Date(clock()).toISOString();
  const rows = [];
  let previousStart = -Infinity;
  let stoppedReason = null;
  let runDir;
  const mode = dependencies.makeReader ? 'offline_mock' : 'internal_authorized_experiment';
  try {
    if (!dependencies.makeReader && (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0)) throw error('dedicated_nonroot_linux_required');
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw error('output_directory_required');
    await mkdir(resolve(outputDir), { recursive: true, mode: 0o700 });
    runDir = await mkdtemp(join(resolve(outputDir), 'authorized-20-'));
    const manifest = () => ({
      schemaVersion: 1, purpose: PURPOSE, mode, startedAt, updatedAt: new Date(clock()).toISOString(),
      fixture: 'candidates-20260920.json', expectedCount: 20,
      completedCount: rows.length, acceptedCount: rows.filter(row => row.accepted).length,
      complete: rows.length === 20, stoppedReason, attemptsPerCandidate: 1, intervalMs: INTERVAL_MS,
      transport: 'in_process_not_public_site', publicServiceEnabled: false,
      authenticatedByPlatform: 'not_inferred_from_storage_state',
      modelCalls: 0, bodyStored: false, cookiesStored: false,
      sessionsBeforeCleanup: Object.fromEntries(PLATFORMS.map(platform => {
        const { state, expiresAt } = leases[platform].status();
        return [platform, { state, expiresAt }];
      })),
      notRunIndexes: items.slice(rows.length).map(item => item.index), results: rows,
    });
    for (const item of items) {
      if (signal?.aborted) { stoppedReason = 'operator_cancelled'; break; }
      if (PLATFORMS.some(platform => leases[platform].status().state !== 'ready')) { stoppedReason = 'session_unavailable'; break; }
      const wait = Math.max(0, INTERVAL_MS - (monotonic() - previousStart));
      if (wait) await delay(wait);
      if (signal?.aborted) { stoppedReason = 'operator_cancelled'; break; }
      if (PLATFORMS.some(platform => leases[platform].status().state !== 'ready')) { stoppedReason = 'session_unavailable'; break; }
      previousStart = monotonic();
      let reader = readers.get(item.platform);
      if (!reader) {
        reader = makeReader({ sessionLease: leases[item.platform] });
        readers.set(item.platform, reader);
      }
      const timestamp = new Date(clock()).toISOString();
      let result, readFailed = false;
      try { result = await reader.read(item.inputUrl, item.platform, { signal }); }
      catch { readFailed = true; stoppedReason = 'experiment_failed'; }
      // Reuse the existing body/identity evaluator. There is no HTTP response in
      // this adapter: remove the synthetic evaluator status before saving.
      const row = evaluateResponse(item, result, { signed: false, httpStatus: 200, timestamp,
        elapsedMs: Math.max(0, Math.round(monotonic() - previousStart)) });
      row.httpStatus = null;
      row.requestTransport = 'in_process';
      row.title = ''; // Do not persist full content or potentially personalized titles.
      row.endedAt = new Date(clock()).toISOString();
      if (readFailed) { row.accepted = false; row.reason = 'experiment_failed'; row.failureChecks = ['experiment_failed']; }
      if (signal?.aborted || leases[item.platform].status().state !== 'ready') {
        const reason = signal?.aborted ? 'operator_cancelled' : 'session_unavailable';
        row.accepted = false; row.reason = reason;
        row.failureChecks.push(reason);
        row.bodyLength = 0; row.bodyUtf8Bytes = 0; row.bodySha256 = null;
        stoppedReason = reason;
      }
      rows.push(row);
      // Immutable checkpoint files, never overwrite an earlier run or record.
      await writeFile(join(runDir, `checkpoint-${String(rows.length).padStart(2, '0')}.json`), `${JSON.stringify(manifest(), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (stoppedReason) break;
      // Explicit platform access gates stop this experiment; do not keep using
      // an account through a challenge or rate limit just to finish the table.
      if (['captcha', 'access_denied', 'rate_limited', 'login_required'].includes(row.reason)) { stoppedReason = 'platform_access_gate'; break; }
    }
    const report = manifest();
    const reportPath = join(runDir, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { report, reportPath };
  } finally {
    // Revoke first, so pending work cannot use state during cleanup.
    for (const platform of PLATFORMS) leases[platform].revoke();
    await Promise.allSettled([...readers.values()].map(reader => reader.close()));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--preflight') {
    console.error('Usage: node authorized-acceptance.mjs --preflight (offline only; no session files or login commands accepted)');
    process.exitCode = 1;
  } else console.log(JSON.stringify(await preflight(), null, 2));
}
