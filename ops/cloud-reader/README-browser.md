# Anonymous public-page browser adapter

This optional, isolated module supplements the existing HTTP resolver. It is not a CAPTCHA solver, authenticated crawler, or guarantee that arbitrary new links are accessible. Offline tests do not demonstrate live platform access.

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

The result preserves the resolver fields. Browser results use `resolverVersion: public-browser-1.0`; diagnostics contain only status, redirect host/path and elapsed time, never query tokens. Invalid input throws `TypeError`. Busy/closed returns unresolved `network_error`; missing/unsupported Playwright or root execution returns `browser_required`. Both `read` and `resolvePublic` accept an optional third `{ signal }` argument; abort reaches HTTP fetch and closes the active browser context. A deadline response does not release the single-job lock until the actual operation and cleanup settle, including a late `newContext` result. The host must serialize calls; the module also rejects simultaneous work. The module adds no global signal handlers; the owner must call `close()` or `closePublicBrowser()` on SIGTERM.

## Installation and runtime

Use a currently supported Node LTS release, an official, pinned Playwright package with `BrowserContext.routeWebSocket` support (1.48+), its matching official Chromium, and the browser's Linux dependencies. This implementation uses the package's ordinary Chromium in headless mode; it does not install or download anything itself. A cloud installation is a separate operator action. The service must run as a dedicated **non-root** OS user with a working Chromium sandbox. No `--no-sandbox`, stealth package, custom User-Agent, fingerprint spoofing, persistent profile, storageState or supplied cookies are accepted.

One browser is shared serially. Every job creates and closes its own fresh anonymous browser context and page, with downloads disabled, service workers blocked, and CSP bypass disabled. Navigation plus HTTP fallback has a combined maximum 25-second budget. Each link is navigated once; DOM checks within that navigation do not reload it. A platform may set temporary anonymous cookies during normal rendering; contexts discard these when closed. Existing personal or POC login sessions are never loaded.

Only known platform/CDN HTTPS hosts may receive GET/HEAD subrequests; POST, child-frame navigation, media, WebSockets, event sources, downloads, nonstandard ports, credentials, literal IP hosts, unlisted domains and DNS answers containing private/link-local/metadata addresses are blocked. New popup pages are closed. An explicit platform gate ends the job. The allowlist may need evidence-backed expansion if legitimate JS resources change; failure is preferred over opening arbitrary network access.

**Deployment must also enforce network egress isolation outside the browser process.** DNS preflight checks cannot atomically pin Chromium's independent DNS connection; DNS rebinding and future browser-internal traffic must be contained by firewall/network namespace policy denying private/link-local/cloud metadata destinations (including IPv6) while permitting required public HTTPS and controlled DNS. Do not expose CDP, browser controls, localhost APIs, debug logs, HAR or traces publicly. Keep browser security updates pinned and reviewed.

## Body acceptance and failure behavior

Final main-frame platform and work ID must match the submitted work or its same-platform short-link resolution. Conflicting Douyin path/modal IDs are rejected, and current identity is checked again after DOM/HTML reads to detect SPA transitions. The original parser must return `reasonCode: ok`, `contentStatus: body`, `textStatus: full`, the correct `contentId`, and nonempty description. Every extracted pageText line must be present in normalized **visible DOM text**. Additionally, non-title body lines and description must match a visible work-description container, excluding known recommendation/comment containers: XHS `#detail-desc` / `.note-content`; Douyin `[data-e2e="video-desc"]`, `[data-e2e="detail-video-desc"]`, or `[data-e2e="note-desc"]`. These selectors are conservative and have not yet received live cloud acceptance; an unknown legitimate layout fails closed. Title-only, recommendation-only, hidden state or mismatched work does not pass. HTML parser input is limited to 2 MB; oversized pages are rejected, not partially accepted. Reading visible caption/description does not transcribe video speech.

403/429/401, visible CAPTCHA/login/access walls, APP-only messages, invalid redirects and identity changes stop without navigation retries. Waiting for ordinary rendering is bounded; unrecognized or non-visible body ends in `timeout` instead of a fabricated success. No comments, social actions, media download, model calls, signing reverse-engineering, proxy rotation or verification bypass are implemented.

## Offline verification

```powershell
node --test browser-reader.test.mjs
```

Tests inject an in-memory browser, DNS and HTTP resolver; no social URLs are actually requested, and no keys, profiles or models are used. Live acceptance still requires an authorized, small, independently logged sample set on the intended cloud host. Current browser code does not fix an unrelated ECS-to-website CDN access block.

Official references: [Playwright browser installation](https://playwright.dev/docs/browsers), [BrowserType sandbox/context options](https://playwright.dev/docs/api/class-browsertype), [WebSocket routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket), [Apache-2.0 license](https://github.com/microsoft/playwright/blob/main/LICENSE). Code licensing is separate from platform terms, content permissions and consent for any future account access.
