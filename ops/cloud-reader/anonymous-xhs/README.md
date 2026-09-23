# Anonymous Xiaohongshu job reader

Version `2.0-anonymous-xhs` adds a separately deployable asynchronous service on
`127.0.0.1:18081`. It does not change the existing port 18080 service. The single
page fetch reader is byte-for-byte the lab reader SHA-256
`070070a6b036c5d82259d304b46677a59981723b5929603eff8d273874211d0f`.

## Current deployment evidence

On 2026-09-22 the existing Aliyun ECS console redirected to the login page. No
active deployment credentials were available. This package is prepared locally;
it has **not** been installed on the ECS. Historical setup identifies a Hangzhou
ECS and an ICP-blocked temporary host; neither a recovered public HTTPS endpoint
nor product end-to-end success has been verified today.

## HTTP contract

Every route below requires an Ed25519 signature using the dedicated site key.
`GET /health` is the sole unsigned route and returns only health/version.

Headers: `x-reader-timestamp` (13 digit Unix ms), `x-reader-nonce` (UUID),
`x-reader-signature` (base64 Ed25519). GET requests additionally require the
`x-reader-job-token` returned only at submission. Sign the UTF-8 string:

```text
timestamp + "\n" + nonce + "\n" + method + "\n" + path + "\n"
+ (jobToken || "") + "\n" + hex_sha256(raw_request_body)
```

The body of a GET is empty. Method, exact path, token and body digest are signed;
timestamps are limited to 60 seconds and nonces cannot be replayed. This is the
same key type as `/v1/resolve`, with a distinct v2 signing format.

- `POST /v2/xhs/jobs`, JSON `{requestId: UUID, url: completeShareUrl}` returns 202
  `{jobId, jobToken, requestId, sourceUrl, status, expiresAt, pollAfterMs}`.
- `GET /v2/xhs/jobs/{jobId}` returns `{jobId, requestId, sourceUrl, status,
  expiresAt, result?, error?, pollAfterMs}`. Status is `queued`, `running`,
  `complete`, or `failed`.
- `GET /v2/xhs/jobs/{jobId}/media/{oneBasedIndex}` returns the exact verified
  image bytes, with `X-Content-SHA256`. Media access requires both signature and
  the matching job token. Local paths are never returned.

`result` contains `noteId`, `title`, `text`, `textSha256`, `canonicalUrl`, `type`,
`imagesRole`, `mediaStatus: complete`, `sourceImageCount`, `checkedAt`,
`readerSha256`, `accountUsed: false`, `browserCookiesRead: false`,
`cacheUsed: false`, `redirects[{host,path,status}]` (page requests only, including
the submitted short URL and final note URL, without query secrets), and ordered
`images[{index, url, sha256, bytes, width, height, format, frames, mediaPath}]`.
The `url` is the original validated public CDN URL upgraded to HTTPS. Its query
parameters are preserved. A CDN link may expire later; it is not permanent
storage, and a later proxy fetch must not assume bytes are still unchanged.

The website must keep keys/tokens server-side, bind jobs to its own user/session,
and proxy authorized media. A job token is not a browser session credential. Do
not give clients arbitrary cloud job IDs or let an unauthenticated visitor use
the service as a URL downloader.

## Evidence and bounds

Each job uses a new process and a new output directory. There is no successful
body cache. The unchanged reader requires exact note identity and all images;
the independent `compare_runs.audit_run` rechecks saved page, raw note, full
text, image count/order, all frames, and hashes. The service then verifies saved
media paths and hashes again before exposing them. Empty text cannot complete.
Video output means description and image list/cover, without audio transcription.

One worker runs at a time, with three queued jobs, at most 20 retained jobs, a
300 second execution bound, 60 second failure cooldown and one hour data TTL.
The dedicated private data directory is removed only for expired UUID jobs;
expired evidence from a previous process is also pruned. Restart invalidates
in-memory job handles. All failures are explicit. No retries, paid models,
account Cookie, browser profile, proxy rotation or CAPTCHA handling are used.

## Install and verify on the existing ECS

1. Restore the user's existing Aliyun console session. Inspect running services,
   free disk and port 18081 before changes. Keep port 18081 loopback only.
2. Unpack this package under a new `/opt/beautyproof-xhs/releases/<version>/`.
   Run `install.sh`. It fetches the pinned third-party source itself and installs
   dependencies; it does not overwrite another release, activate a service,
   open a port, alter DNS, or change Nginx.
3. Run `acceptance.mjs` with the frozen four sample manifest as non-root
   `beautyproof-reader`, `--environment ecs`, the release venv Python and reader.
   Store evidence outside the repository. It tests HTTP submit/poll/media,
   a known platform failure, three positive candidates and repeats successes.
   Do not call local-only evidence a cloud test.
4. After cloud acceptance, create a new systemd unit from the provided template,
   substituting only the inspected release directory. It uses the existing
   dedicated public-key env file and egress firewall. Do not enable or replace
   the old reader unit. Keep the release path fixed for rollback.
5. Public website access additionally requires a valid reachable HTTPS domain
   and a reviewed Nginx route to 18081. The former temporary domain's ICP block
   must be resolved through a valid endpoint, not bypassed. Do not automatically
   alter the existing site to assume cloud success.

Rollback: disable/stop only the new `beautyproof-xhs.service`, remove only its new
proxy routes if they were installed, and keep the previous release/evidence.
No cloud resource purchase or DNS change is part of this package.

## Alternative outbound bridge to the existing website

`outbound-bridge.mjs` supports a website-hosted queue without any public ECS
listener. Run this **instead of** the standalone 18081 service. It embeds the
same sidecar over private IPC protected by a key generated in memory.
The private outbound env file contains `READER_PRIVATE_KEY` (dedicated Ed25519
PKCS8 base64 or PEM) and `BEAUTYPROOF_XHS_WORKER_URL` (the exact HTTPS website URL
ending `/api/reader-jobs/worker`). The corresponding public key belongs in the
website's secret/config store. Neither key value is in this package.

The service launches each Python child from its fresh job directory with dotenv
loading disabled. The pinned upstream library opens SQLite databases even when
its download records are disabled. `reader_bootstrap.py` therefore redirects its
runtime state to that job's new `upstream-state` directory before constructing
the reader. The source checkout retains only an empty root-owned, read-only
`Volume` placeholder required by upstream import. Do not make the source tree
writable or share its database directory between jobs. Installation runs two
non-root initialization checks using the actual pinned dependency with HTTP
requests denied, before any real link acceptance run.

The embedded sidecar uses a private Unix socket on Linux (a random named pipe
on Windows), retaining HTTP signatures and job-token checks. It opens no TCP
port. This is required because the reader user's existing egress rules reject
new loopback TCP connections. The acceptance runner uses the same transport;
do not disable or broaden the firewall to make local IPC work.

Outbound POST authentication matches the existing worker protocol:
`x-reader-timestamp` and `x-reader-signature`, Ed25519 signing UTF-8
`timestamp + "\n" + exact JSON body`; each body includes a fresh UUID `nonce`.

- `{action: 'take', nonce}` receives `{job: null | {id,url,claimToken},pollAfterMs}`.
- Every 20 seconds during a read, `{action:'heartbeat',nonce}` keeps the worker
  presence current. The website owns worker ID `anonymous-v2`.
- `{action:'complete',nonce,id,claimToken,sourceUrl,status,result? ,error?}` sends
  complete verified content or `{code,message}` failure. The endpoint must bind
  claim token and source URL and accept the same completion idempotently. A
  transient delivery failure resends only the same already obtained result once;
  it does not fetch the social platform again.

The maximum completion body is 100,000 bytes. Full text and full image list are
never truncated to fit; overlarge results fail closed. Website jobs should allow
the full 300 second execution plus queue time. Website user/job ownership and
media proxy authorization are handled by the website, not this bridge.

The bridge follows no redirects, stops on HTTP 401/403/404, and stops after three
consecutive other errors. The unit has `Restart=no`. Historical ECS-to-Sites
requests also encountered Cloudflare 403, so this alternative still needs a
real ECS network acceptance run after console access is restored. Preparing the
bridge does not establish that this outbound route is currently reachable.

## Source and license

The external dependency is `JoeanAmier/XHS-Downloader` commit
`3261312721f0b37c705ba6515885bc7f34349f2f`, whose checked LICENSE is GPL-3.0.
Third-party source, sessions and generated evidence are not included in this
repository/package. The installer fetches the fixed dependency into the private
server release for this test. Keep its original license and notices with that
checkout. This record is a source-license observation, not platform permission
or a claim that every future distribution model has been reviewed.

Offline checks: `node --test job-server.test.mjs`.

Real HTTP acceptance:

```text
node acceptance.mjs --manifest /private/manifest.json --out /private/evidence
  --python /release/.venv/bin/python --reader /release/reader/read_xhs.py
  --environment ecs
```
