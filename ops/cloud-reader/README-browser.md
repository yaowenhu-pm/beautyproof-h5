# Anonymous public-page browser adapter

This optional, isolated module supplements the existing HTTP resolver. The default service remains anonymous. It is not a CAPTCHA solver or guarantee that arbitrary new links are accessible. An opt-in memory-only session adapter is prepared for internal dedicated-account experiments, not public service; no real authenticated run or login UI has been implemented. Offline tests do not demonstrate live platform access.

Ubuntu 24.04 deployment uses the official Google Chrome stable channel (`channel: 'chrome'`) at its root-owned vendor installation path, supported by Ubuntu's existing Chrome AppArmor profile. The downloaded headless developer build failed sandbox initialization in the actual ECS preflight. Do not disable Chromium sandbox, disable AppArmor, or relax the global user-namespace policy. See [Chromium's official explanation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) and [Playwright supported channels](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge).

## Server contract

```js
import { resolvePublic, closePublicBrowser } from './browser-reader.mjs';
const result = await resolvePublic(url, platform, { signal }); // optional request AbortSignal
// Keep the server request timeout at least 35 seconds.
process.once('SIGTERM', async () => {
  await closePublicBrowser();
  // Also stop accepting requests / close the server in the owning application.
});
```

`createPublicBrowserReader({ chromium, parseLinkPage, platformFor, contentIdFor, resolveLink, ...testInjections })` returns `{ read, resolvePublic, close }`. All dependencies have local defaults; Playwright is imported only when the browser path is needed. `read(url, platform)` goes directly to the browser. `resolvePublic` uses existing anonymous HTTP for XHS first and only falls back for `network_error`, `timeout`, `parse_failed`, or `metadata_only`. It does **not** retry `browser_required` (ambiguous dynamic/check page), CAPTCHA, login, access, rate, APP-only, missing content or identity gates. Douyin goes directly to one ordinary browser navigation, never an HTTP-gate-then-browser retry.

The result preserves the resolver fields. Browser results use `resolverVersion: public-browser-1.0`; diagnostics contain only method, status, redirect host/path and elapsed time, never query tokens. Invalid input throws `TypeError`. Busy/closed returns unresolved `rate_limited`, never an upstream `network_error`; missing/unsupported Playwright or root execution returns `browser_required`. Both `read` and `resolvePublic` accept an optional third `{ signal }` argument; abort reaches HTTP fetch and closes the active browser context. Before returning a deadline result, the adapter allows at most three additional seconds for cleanup: briefly await context closure, then retire the entire browser if necessary. It releases the single-job lock only after the old context/browser is confirmed closed or the underlying operation has safely settled, including late `newContext` results. If browser retirement itself remains stuck, the lock stays closed and subsequent calls return `rate_limited`; they never launch an overlapping browser. A retired browser is recreated for the next new task, not used to retry the timed-out target. The host must serialize calls; the module also rejects simultaneous work. The module adds no global signal handlers; the owner must call `close()` or `closePublicBrowser()` on SIGTERM.

## Installation and runtime

Use a currently supported Node LTS release, an official, pinned Playwright package with `BrowserContext.routeWebSocket` support (1.48+), official Chrome and its Linux dependencies. The module launches Chrome headless; it does not install or download anything itself. A cloud installation is a separate operator action. The service must run as a dedicated **non-root** OS user with a working Chromium sandbox. No `--no-sandbox`, stealth package, custom User-Agent, fingerprint spoofing or persistent profile is supported. The default service never loads storageState or supplied cookies; only the explicit internal session adapter described below can receive a short-lived in-memory state.

One browser is shared serially. Every job creates and closes its own fresh anonymous browser context and page, with downloads disabled, service workers blocked, and CSP bypass disabled. Navigation plus HTTP fallback has a combined maximum 25-second budget, followed by at most three seconds of bounded cleanup (28 seconds total, excluding abnormal event-loop stalls). Each link is navigated once; DOM checks within that navigation do not reload it. A platform may set temporary anonymous cookies during normal rendering; contexts discard these when closed. Existing personal or POC login sessions are never loaded.

Only known platform/CDN HTTPS hosts may receive GET/HEAD subrequests; POST, child-frame navigation, media, WebSockets, event sources, downloads, nonstandard ports, credentials, literal IP hosts, unlisted domains and DNS answers containing private/link-local/metadata addresses are blocked. New popup pages are closed. An explicit platform gate ends the job. The allowlist may need evidence-backed expansion if legitimate JS resources change; failure is preferred over opening arbitrary network access.

**Deployment must also enforce network egress isolation outside the browser process.** DNS preflight checks cannot atomically pin Chromium's independent DNS connection; DNS rebinding and future browser-internal traffic must be contained by firewall/network namespace policy denying private/link-local/cloud metadata destinations (including IPv6) while permitting required public HTTPS and controlled DNS. Do not expose CDP, browser controls, localhost APIs, debug logs, HAR or traces publicly. Keep browser security updates pinned and reviewed.

## Body acceptance and failure behavior

Final main-frame platform and work ID must match the submitted work or its same-platform short-link resolution. Conflicting Douyin path/modal IDs are rejected, and current identity is checked again after DOM/HTML reads to detect SPA transitions. The original parser must return `reasonCode: ok`, `contentStatus: body`, `textStatus: full`, the correct `contentId`, and nonempty description. Every extracted pageText line must be present in normalized **visible DOM text**. Additionally, non-title body lines and description must match a visible work-description container, excluding known recommendation/comment containers: XHS `#detail-desc` / `.note-content`; Douyin `[data-e2e="video-desc"]`, `[data-e2e="detail-video-desc"]`, or `[data-e2e="note-desc"]`. These selectors are conservative and have not yet received live cloud acceptance; an unknown legitimate layout fails closed. Title-only, recommendation-only, hidden state or mismatched work does not pass. HTML parser input is limited to 2 MB; oversized pages are rejected, not partially accepted. Reading visible caption/description does not transcribe video speech.

403/429/401, visible CAPTCHA/login/access walls, APP-only messages, invalid redirects and identity changes stop without navigation retries. Waiting for ordinary rendering is bounded; unrecognized or non-visible body ends in `timeout` instead of a fabricated success. No comments, social actions, media download, model calls, signing reverse-engineering, proxy rotation or verification bypass are implemented.

Only the two recognized DOM-read navigation errors (`Execution context was destroyed` and `Unable to retrieve content because the page is navigating`) may resume observation of the **same open page**, at most twice in total. Each recovery starts again with platform, current work ID and gate checks, within the original 25-second deadline. This never calls `goto`, reload, HTTP resolution, or an external request again; it only observes a navigation already being performed by the page. Other errors and exhausted recovery counts fail normally. A changed work, login route or CAPTCHA route is rejected before further DOM reads.

Semantic reading and resource cleanup have separate deadlines. `readBrowser` starts managed context closure without awaiting an unbounded close in its `finally`; the wrapper receives the already determined result, stops the work timer, then performs bounded cleanup/browser retirement. A slow close does not turn an established `login_required`, other platform gate, or verified successful body into `timeout`. If cleanup remains unconfirmed, that original result is returned but the safety lock blocks new browser work with `rate_limited` until retirement is confirmed.

## Dedicated-account experiment preparation (not enabled)

The optional `createPublicBrowserReader({ sessionLease })` parameter is for an
operator-controlled experiment, not an HTTP field or environment setting.
`session-lease.mjs` accepts only dedicated-account/fixed-test grants, restricts
cookie/origin domains to one platform, clones state, and caps lifetime at 30
minutes (default 15). `ready` means valid lease data, not verified platform login.
Expiry or revoke stops new work and discards lease-held state. The reader checks
before context creation, before requests and before accepting body; a 50 ms
watchdog cancels active navigation, followed by bounded context cleanup. It does
not fall back to anonymous HTML or write refreshed cookies back to disk.

`authorized-acceptance.mjs --preflight` is offline and never opens a browser.
The exported runner is intended for a future private cloud-login controller;
it requires both platforms' leases, uses the original 20 cases, stops at access
gates, revokes leases at cleanup, and writes only redacted reports. Interrupted
items and unattempted items remain distinct. Mock reports are labeled
`offline_mock`; real runs would be `internal_authorized_experiment`, never public
website end-to-end tests. There is no login capture, QR UI or credential-file CLI.

Do not expose this adapter through `direct-server`, add a session environment
variable, transplant a local personal profile, or enable shared accounts for
public visitors. The previous deployment archive remains the anonymous tested
release; this preparation does not activate or redeploy it. See the [preparation
record](../../docs/authorized-reader-preparation-2026-09-20.md) for prerequisites.

## Offline verification

```powershell
node --test browser-reader.test.mjs
```

Tests inject an in-memory browser, DNS and HTTP resolver; no social URLs are actually requested, and no keys, profiles or models are used. Live acceptance still requires an authorized, small, independently logged sample set on the intended cloud host. Current browser code does not fix an unrelated ECS-to-website CDN access block.

Official references: [Playwright browser installation](https://playwright.dev/docs/browsers), [BrowserType sandbox/context options](https://playwright.dev/docs/api/class-browsertype), [WebSocket routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket), [Apache-2.0 license](https://github.com/microsoft/playwright/blob/main/LICENSE). Code licensing is separate from platform terms, content permissions and consent for any future account access.
