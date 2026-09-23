#!/usr/bin/env bash
# Installs into one new version directory. Does not start services, open ports,
# change nginx/DNS, or replace the existing /v1 service.
set -euo pipefail
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$base"
case "$base" in /opt/beautyproof-xhs/releases/*) ;; *) echo 'Unpack under /opt/beautyproof-xhs/releases/<version>/ first' >&2; exit 2;; esac
test "$(id -u)" -eq 0
command -v git >/dev/null
python3 -c 'import sys; assert sys.version_info >= (3,12)'
test -x /opt/beautyproof-node/bin/node
test -f "$base/reader/read_xhs.py"
echo '070070a6b036c5d82259d304b46677a59981723b5929603eff8d273874211d0f  reader/read_xhs.py' | (cd "$base" && sha256sum -c -)
mkdir -p "$base/repos/downloaders"
repo="$base/repos/downloaders/XHS-Downloader"
if ! test -d "$repo/.git"; then git clone --no-checkout https://github.com/JoeanAmier/XHS-Downloader.git "$repo"; fi
git -C "$repo" checkout --detach 3261312721f0b37c705ba6515885bc7f34349f2f
test "$(git -C "$repo" rev-parse HEAD)" = 3261312721f0b37c705ba6515885bc7f34349f2f
# source.module.static creates Volume during import. Keep that source-side
# placeholder empty and immutable; reader_bootstrap redirects all live state
# to a fresh job directory before constructing XHS or opening any database.
test ! -L "$repo/Volume"
if test -e "$repo/Volume"; then
  test -d "$repo/Volume"
  test -z "$(find "$repo/Volume" -mindepth 1 -maxdepth 1 -print -quit)"
fi
install -d -m 0555 -o root -g root "$repo/Volume"
# The service runs non-root while its dependency is root-owned. Trust this one
# inspected immutable release checkout, never a wildcard or all repositories.
if ! git config --system --get-all safe.directory | grep -Fxq "$repo"; then git config --system --add safe.directory "$repo"; fi
python3 -m venv "$base/.venv"
"$base/.venv/bin/python" -m pip install --disable-pip-version-check -r "$repo/requirements.txt" -r "$base/requirements-extra.txt"
"$base/.venv/bin/python" -m pip check
/opt/beautyproof-node/bin/node --test "$base/job-server.test.mjs" "$base/outbound-bridge.test.mjs" "$base/local-transport.test.mjs" "$base/acceptance-report.test.mjs"
(cd "$base" && "$base/.venv/bin/python" -m unittest test_worker.py)
id beautyproof-reader >/dev/null
install -d -m 0700 -o beautyproof-reader -g beautyproof-reader /var/lib/beautyproof-xhs /var/lib/beautyproof-xhs/jobs
# These initialize the actual pinned library and three fresh SQLite databases,
# deny HTTP calls, and run as the service account. No platform links are read.
for check in 1 2; do
  runuser -u beautyproof-reader -- env -i PATH="$PATH" HOME=/var/lib/beautyproof-xhs LANG=C.UTF-8 \
    PYTHONIOENCODING=utf-8 PYTHON_DOTENV_DISABLED=1 PYTHONDONTWRITEBYTECODE=1 \
    "$base/.venv/bin/python" "$base/reader_bootstrap.py" --reader "$base/reader/read_xhs.py" \
    --smoke-test --smoke-parent /var/lib/beautyproof-xhs/jobs
done
printf 'Prepared release: %s\nNo service was enabled or started.\n' "$base"
