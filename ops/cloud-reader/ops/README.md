# BeautyProof reader deployment status

`install-reader.sh` installs the Node runtime, application dependencies, browser,
service units, firewall helper and Nginx templates, but does not enable or start
Nginx or the reader service automatically. On 2026-09-20 these dependencies were
installed on the designated Hangzhou ECS. Only the ACME-only Nginx configuration
and the per-user egress firewall were activated. The persistent reader systemd
unit and HTTPS virtual host remain disabled pending a valid public endpoint.

## Current public-network blocker

The proposed temporary host
`beautyproof-reader.121-196-215-79.sslip.io` receives `403 Server Beaver
Non-compliance ICP Filing` on the Hangzhou ECS. The ACME certificate request
therefore failed. This is an external ICP compliance block, not an application
health result.

Do not bypass the block, retry issuance for this temporary hostname, or enable
the HTTPS template. Wait for a valid filed domain, then replace the hostname and
certificate paths in both Nginx templates, review the resulting diff, obtain the
certificate through the ACME webroot, and only then enable HTTPS. Port 80 serves
only the ACME challenge path; every other path returns 404.

The loopback application may be installed and tested independently on
`127.0.0.1:18080`. Its public key must be placed in
`/etc/beautyproof-reader/reader.env` before the systemd unit can start.

## Runtime and acceptance

- The tested Node runtime is 24.21.0, with official Google Chrome
  153.0.8010.52. Use Playwright's `channel: 'chrome'` with `chromiumSandbox: true`.
  Ubuntu's existing `/etc/apparmor.d/chrome` policy is required; never disable
  AppArmor or run Chrome with `--no-sandbox`.
- `internal-acceptance.mjs` creates a temporary Ed25519 key pair in memory and
  starts the reader as the independent non-root account. It does not change the
  production key or enable a persistent service. The root test controller is
  separate from the non-root browser.
- Fixed input list: `candidates-20260920.json`. Each run saves a fresh JSON and
  Markdown report. Exit code 2 means all samples ran but at least one failed;
  it does not mean the script failed to start. Preserve all rounds.
- Work processing is bounded to 25 seconds plus at most 3 seconds of cleanup.
  If cleanup cannot confirm browser closure, subsequent work fails closed as
  `rate_limited`. Do not launch additional overlapping browser instances.
- Do not publish `smoke-entry.mjs`, `smoke-full.mjs`, private overrides, browser
  profiles, certificates, environment secrets or full social-media bodies.

## Safe activation after the domain blocker is resolved

1. Verify the user-approved hostname, DNS and Aliyun domain/access compliance.
2. Obtain a valid certificate with the ACME webroot. Run `nginx -t` before
   enabling HTTPS; verify external TLS without `-k` or trust overrides.
3. Configure a dedicated Ed25519 pair: private key only in Sites secret storage,
   public key only on ECS. Enable the firewall unit before the reader unit.
4. Verify unsigned/replayed requests are rejected; verify a correctly signed
   request returns the exact requestId/sourceUrl and matching work identity.
5. Set `BEAUTYPROOF_READER_URL` and `BEAUTYPROOF_READER_PRIVATE_KEY` in Sites,
   publish the reviewed code, then rerun all 20 through the real website.
   Do not equate the loopback test with this final step.
6. To roll back, remove both new Sites configuration values and republish the
   previous site version; stop the reader unit if unused. Do not enable the
   older outbound queue path as an automatic fallback.

Free certificate renewal is independent of the paid ECS renewal setting.
The ECS remains manually renewed; no paid add-on or automatic billing renewal
was enabled for this work.
