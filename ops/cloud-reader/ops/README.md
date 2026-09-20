# BeautyProof reader deployment status

These files are staged for review only. `install-reader.sh` installs the Node
runtime, application dependencies, browser, service units, firewall helper and
Nginx templates, but it does not enable or start Nginx or the reader service.

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
