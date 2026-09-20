#!/usr/bin/env bash
set -euo pipefail

readonly READER_USER='beautyproof-reader'
readonly CHAIN='BPROOF_READER_OUT'
readonly COMMENT='beautyproof-reader-egress'

[[ ${EUID} -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
command -v iptables >/dev/null
command -v ip6tables >/dev/null
uid="$(id -u "${READER_USER}")"

ensure_chain() {
  local tool="$1"
  "${tool}" -w -N "${CHAIN}" 2>/dev/null || true
  "${tool}" -w -F "${CHAIN}"
  while "${tool}" -w -C OUTPUT -m owner --uid-owner "${uid}" -m comment --comment "${COMMENT}" -j "${CHAIN}" 2>/dev/null; do
    "${tool}" -w -D OUTPUT -m owner --uid-owner "${uid}" -m comment --comment "${COMMENT}" -j "${CHAIN}"
  done
  "${tool}" -w -I OUTPUT 1 -m owner --uid-owner "${uid}" -m comment --comment "${COMMENT}" -j "${CHAIN}"
}

apply_ipv4() {
  ensure_chain iptables
  iptables -w -A "${CHAIN}" -o lo -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -w -A "${CHAIN}" -o lo -p udp -d 127.0.0.53/32 --dport 53 -j ACCEPT
  iptables -w -A "${CHAIN}" -o lo -p tcp -d 127.0.0.53/32 --dport 53 -j ACCEPT
  local cidr
  for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
    iptables -w -A "${CHAIN}" -d "${cidr}" -j REJECT --reject-with icmp-port-unreachable
  done
  iptables -w -A "${CHAIN}" -j RETURN
}

apply_ipv6() {
  ensure_chain ip6tables
  ip6tables -w -A "${CHAIN}" -o lo -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  local cidr
  for cidr in ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 100::/64 2001:db8::/32 2001:10::/28 2002::/16 fc00::/7 fe80::/10 ff00::/8; do
    ip6tables -w -A "${CHAIN}" -d "${cidr}" -j REJECT --reject-with icmp6-port-unreachable
  done
  ip6tables -w -A "${CHAIN}" -j RETURN
}

remove_family() {
  local tool="$1"
  while "${tool}" -w -C OUTPUT -m owner --uid-owner "${uid}" -m comment --comment "${COMMENT}" -j "${CHAIN}" 2>/dev/null; do
    "${tool}" -w -D OUTPUT -m owner --uid-owner "${uid}" -m comment --comment "${COMMENT}" -j "${CHAIN}"
  done
  "${tool}" -w -F "${CHAIN}" 2>/dev/null || true
  "${tool}" -w -X "${CHAIN}" 2>/dev/null || true
}

case "${1:-}" in
  apply)
    apply_ipv4
    apply_ipv6
    ;;
  remove)
    remove_family iptables
    remove_family ip6tables
    ;;
  *)
    echo 'usage: beautyproof-reader-firewall {apply|remove}' >&2
    exit 2
    ;;
esac
