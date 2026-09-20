#!/usr/bin/env bash
set -euo pipefail

# Review-first installer for Ubuntu 24.04 x86_64. It installs only names owned by
# BeautyProof, does not enable/start services, does not request a certificate,
# and does not change the system Node, global firewall policy, sysctl, UFW, or Nginx defaults.

readonly NODE_VERSION='v24.21.0'
readonly NODE_ARCHIVE='node-v24.21.0-linux-x64.tar.xz'
readonly NODE_SHA256='fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'
readonly NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
readonly READER_USER='beautyproof-reader'
readonly READER_GROUP='beautyproof-reader'
readonly APP_DIR='/opt/beautyproof-cloud-reader'
readonly NODE_DIR='/opt/node-v24.21.0-linux-x64'
readonly NODE_LINK='/opt/beautyproof-node'
readonly ENV_DIR='/etc/beautyproof-reader'
readonly ENV_FILE='/etc/beautyproof-reader/reader.env'
readonly ACME_ROOT='/var/www/beautyproof-reader-acme'
readonly DOMAIN='beautyproof-reader.121-196-215-79.sslip.io'
readonly SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

[[ ${EUID} -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ "$(uname -m)" == 'x86_64' ]] || { echo 'this reviewed package is pinned to Linux x86_64' >&2; exit 1; }
for command in curl sha256sum tar xz iptables ip6tables runuser systemctl; do command -v "${command}" >/dev/null || { echo "missing command: ${command}" >&2; exit 1; }; done
for file in direct-server.mjs browser-reader.mjs package.json package-lock.json; do [[ -f "${SOURCE_DIR}/${file}" ]] || { echo "missing source file: ${file}" >&2; exit 1; }; done
[[ -d "${SOURCE_DIR}/lib" ]] || { echo 'missing source directory: lib' >&2; exit 1; }

if ! getent group "${READER_GROUP}" >/dev/null; then groupadd --system "${READER_GROUP}"; fi
if ! id "${READER_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${READER_GROUP}" --home-dir /var/lib/beautyproof-reader --shell /usr/sbin/nologin "${READER_USER}"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "${tmp_dir}"' EXIT
if [[ ! -x "${NODE_DIR}/bin/node" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 --output "${tmp_dir}/${NODE_ARCHIVE}" "${NODE_URL}"
  printf '%s  %s\n' "${NODE_SHA256}" "${tmp_dir}/${NODE_ARCHIVE}" | sha256sum --check --status
  tar -xJf "${tmp_dir}/${NODE_ARCHIVE}" -C /opt
fi
[[ "$("${NODE_DIR}/bin/node" --version)" == "${NODE_VERSION}" ]] || { echo 'unexpected Node version in versioned directory' >&2; exit 1; }
if [[ -e "${NODE_LINK}" && ! -L "${NODE_LINK}" ]]; then echo "refusing to replace non-symlink ${NODE_LINK}" >&2; exit 1; fi
ln -sfn "${NODE_DIR}" "${NODE_LINK}"

if [[ -e "${APP_DIR}" && ! -f "${APP_DIR}/.beautyproof-reader-managed" ]]; then
  echo "refusing to overwrite unmanaged ${APP_DIR}" >&2
  exit 1
fi
install -d -o root -g "${READER_GROUP}" -m 0750 "${APP_DIR}" "${APP_DIR}/lib" "${APP_DIR}/lib/server" "${APP_DIR}/lib/shared"
install -o root -g "${READER_GROUP}" -m 0640 "${SOURCE_DIR}/direct-server.mjs" "${SOURCE_DIR}/browser-reader.mjs" "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/package-lock.json" "${APP_DIR}/"
install -o root -g "${READER_GROUP}" -m 0640 "${SOURCE_DIR}/lib/server/"*.mjs "${APP_DIR}/lib/server/"
install -o root -g "${READER_GROUP}" -m 0640 "${SOURCE_DIR}/lib/shared/"*.mjs "${APP_DIR}/lib/shared/"
touch "${APP_DIR}/.beautyproof-reader-managed"
chown root:"${READER_GROUP}" "${APP_DIR}/.beautyproof-reader-managed"
chmod 0640 "${APP_DIR}/.beautyproof-reader-managed"

(
  cd "${APP_DIR}"
  "${NODE_LINK}/bin/node" "${NODE_LINK}/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
  "${NODE_LINK}/bin/node" "${APP_DIR}/node_modules/playwright/cli.js" install-deps chromium
)
install -d -o "${READER_USER}" -g "${READER_GROUP}" -m 0700 /var/lib/beautyproof-reader /var/lib/beautyproof-reader/ms-playwright /var/cache/beautyproof-reader
runuser -u "${READER_USER}" -- env HOME=/var/lib/beautyproof-reader PLAYWRIGHT_BROWSERS_PATH=/var/lib/beautyproof-reader/ms-playwright "${NODE_LINK}/bin/node" "${APP_DIR}/node_modules/playwright/cli.js" install chromium

install -d -o root -g "${READER_GROUP}" -m 0750 "${ENV_DIR}"
if [[ ! -e "${ENV_FILE}" ]]; then
  printf '# Add exactly one BEAUTYPROOF_SITE_PUBLIC_KEY=<SPKI-DER-base64> line before starting.\n' > "${ENV_FILE}"
fi
chown root:"${READER_GROUP}" "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"
install -d -o root -g root -m 0755 "${ACME_ROOT}/.well-known/acme-challenge"

install_reviewed() {
  local source="$1" destination="$2" mode="$3"
  if [[ -e "${destination}" ]] && ! cmp -s "${source}" "${destination}"; then
    echo "refusing to overwrite changed owned file: ${destination}" >&2
    exit 1
  fi
  install -o root -g root -m "${mode}" "${source}" "${destination}"
}

install_reviewed "${SOURCE_DIR}/ops/beautyproof-reader-firewall.sh" /usr/local/sbin/beautyproof-reader-firewall 0755
install_reviewed "${SOURCE_DIR}/ops/beautyproof-reader-firewall.service" /etc/systemd/system/beautyproof-reader-firewall.service 0644
install_reviewed "${SOURCE_DIR}/ops/beautyproof-reader.service" /etc/systemd/system/beautyproof-reader.service 0644
install_reviewed "${SOURCE_DIR}/ops/nginx-acme.conf" /etc/nginx/sites-available/beautyproof-reader-acme.conf 0644
install_reviewed "${SOURCE_DIR}/ops/nginx-https.conf" /etc/nginx/sites-available/beautyproof-reader-https.conf 0644
systemctl daemon-reload

cat <<EOF
Installed reviewable files only; no service or Nginx site was enabled or started.

The temporary sslip.io hostname is currently blocked by the Hangzhou ECS ICP
compliance layer. Do not request a certificate for it and do not enable either
Nginx template. Replace the hostname and certificate paths in both reviewed
templates with a valid filed domain first.

Only after a valid domain, its certificate, and ${ENV_FILE} are ready:
  review and enable beautyproof-reader-https.conf under sites-enabled
  nginx -t && systemctl reload nginx
  systemctl enable --now beautyproof-reader.service

The main unit requires the per-UID egress firewall unit automatically.
EOF
