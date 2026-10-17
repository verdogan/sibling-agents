#!/usr/bin/env bash
#
# Restricts outbound traffic for the agent's service user to an allowlist.
#
#   sudo bash deploy/egress-allowlist.sh
#   EGRESS_DRY_RUN=true bash deploy/egress-allowlist.sh   # print the ruleset only
#
# A dry run writes only the ruleset to stdout, ready for `nft -c -f -`, and its
# progress lines to stderr.
#
# Read this before using it:
#
#   * The allowlist is resolved to IP addresses when this script runs. If a
#     provider rotates addresses, traffic breaks until you rerun it. That is the
#     trade-off of doing this in the kernel instead of through a proxy. A rerun
#     replaces the table rather than adding to it.
#   * Filtering is by uid, so it only covers processes running as the service
#     user. Commands executed inside a docker sandbox leave through the
#     container's own network namespace and are not affected. Give those
#     containers `--network none`, or attach them to a network that routes
#     through a filtering proxy. Traffic other users send, and what the kernel
#     sends on no one's behalf such as IPv6 neighbour discovery, is left alone.
#   * Loopback is scoped by uid as well: over TCP the agent reaches what
#     listens on loopback as its own user, and not other users' local
#     services. Over UDP, which has no handshake to stop, it reaches only
#     LOOPBACK_PORTS, its own UDP listeners included. Lings sharing one user
#     can still reach each other's ports; separating those takes a user per
#     ling. LOOPBACK_PORTS lists ports the agent may reach whoever owns them,
#     such as a local stub resolver or a local proxy.
#   * The allowlist is IPv4 only. IPv6 to an allowed host is refused like any
#     other IPv6 destination, quickly, so clients fall back to IPv4.
#   * For anything stricter than this, put an HTTP proxy such as mitmproxy or
#     squid in front of the agent and allowlist by hostname there.
#
set -euo pipefail

APP_USER=${APP_USER:-piagent}
RESOLVER=${RESOLVER:-1.1.1.1}
LOOPBACK_PORTS=${LOOPBACK_PORTS:-53}
# The conntrack mark bits that tag loopback connections the agent opens, and
# those of them the agent's own uid has answered. Change them if something
# else on the host already uses these bits.
LOOPBACK_MARK=${LOOPBACK_MARK:-0x20000000}
LOOPBACK_ANSWERED_MARK=${LOOPBACK_ANSWERED_MARK:-0x40000000}
BOTH_MARKS="$(printf '0x%x' $((LOOPBACK_MARK | LOOPBACK_ANSWERED_MARK)))"
DRY_RUN=${EGRESS_DRY_RUN:-false}

# Progress goes to stdout, or to stderr in a dry run, whose stdout is the ruleset.
if [[ "$DRY_RUN" == "true" ]]; then
  exec 3>&2
else
  exec 3>&1
fi

# Hosts the agent is allowed to reach directly. Add the APIs your tasks need.
ALLOWED_HOSTS=(
  api.openai.com
)

if [[ $EUID -ne 0 && "$DRY_RUN" != "true" ]]; then
  echo "Run this as root." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" ]]; then
  command -v nft >/dev/null 2>&1 || { apt-get update && apt-get install -y nftables; }
fi

UID_NUM="$(id -u "$APP_USER")"

echo "==> Resolving allowlist" >&3
ADDRESSES=()
for host in "${ALLOWED_HOSTS[@]}"; do
  mapfile -t resolved < <(getent ahostsv4 "$host" | awk '{print $1}' | sort -u)
  if [[ ${#resolved[@]} -eq 0 ]]; then
    echo "    could not resolve ${host}, aborting" >&2
    exit 1
  fi
  echo "    ${host} -> ${resolved[*]}" >&3
  ADDRESSES+=("${resolved[@]}")
done

JOINED="$(printf '%s, ' "${ADDRESSES[@]}")"
JOINED="${JOINED%, }"

# The first two lines make the load replace an existing table: declaring it
# first means the delete cannot fail, and without the delete a rerun appends
# a second copy of every rule after the first.
RULESET="$(cat <<EOF
table inet agent_egress
delete table inet agent_egress

table inet agent_egress {
  set allowed_v4 {
    type ipv4_addr
    elements = { ${JOINED} }
  }

  chain output {
    type filter hook output priority 0; policy accept;

    # A loopback connection the agent opens is marked, and the answers on it
    # pass only when the agent's uid sends them or they come from one of
    # LOOPBACK_PORTS. So the agent reaches its own listeners -- the Chrome
    # agent-browser drives, for one -- and not another user's: an overlord, a
    # database, a ling running as a different user. Over TCP the listener's
    # SYN-ACK is dropped, so no connection forms. That includes a syncookie
    # SYN-ACK, which has no owner, and which the agent could force by flooding
    # the listener with SYNs that never complete. A reset and an ICMP error
    # carry nothing from the listener and pass, so a closed port still fails at
    # once. These rules apply to every uid, because the answer comes from the
    # listener's.
    #
    # Once an answer from the agent's uid has passed, the connection is marked
    # as answered, and the rest of its answers pass without that test. They
    # could not all meet it, because the kernel sends some of them from a
    # socket no process owns: ACKs before the listener has accepted the
    # connection, and once it has closed it, the data still queued, its FIN
    # and the ACKs from TIME_WAIT.
    oifname "lo" meta skuid ${UID_NUM} ct state new ct mark set ct mark or ${LOOPBACK_MARK}
    oifname "lo" ct direction reply ct mark and ${BOTH_MARKS} == ${BOTH_MARKS} accept
    oifname "lo" ct direction reply ct mark and ${LOOPBACK_MARK} == ${LOOPBACK_MARK} meta l4proto { tcp, udp } th sport { ${LOOPBACK_PORTS} } accept
    oifname "lo" ct direction reply ct mark and ${LOOPBACK_MARK} == ${LOOPBACK_MARK} meta skuid ${UID_NUM} ct mark set ct mark or ${LOOPBACK_ANSWERED_MARK} accept
    oifname "lo" ct direction reply ct mark and ${LOOPBACK_MARK} == ${LOOPBACK_MARK} tcp flags & rst == rst accept
    oifname "lo" ct direction reply ct mark and ${LOOPBACK_MARK} == ${LOOPBACK_MARK} ct state related accept
    oifname "lo" ct direction reply ct mark and ${LOOPBACK_MARK} == ${LOOPBACK_MARK} drop

    # Only what the agent's uid sends goes on to the allowlist. What another
    # uid sends, and what the kernel sends on no one's behalf -- IPv6
    # neighbour discovery and MLD, for which a refusal would cut the whole
    # host off IPv6 -- keeps the accept policy.
    meta skuid ${UID_NUM} jump agent_out
  }

  chain agent_out {
    ct state established,related accept

    # UDP has no handshake, so a datagram to another user's loopback service
    # would arrive though its answer is dropped above. The agent's own loopback
    # UDP may go only to LOOPBACK_PORTS.
    oifname "lo" udp dport != { ${LOOPBACK_PORTS} } reject with icmpx type admin-prohibited

    # Loopback, confined to the agent's own listeners by the rules above.
    oifname "lo" accept

    # DNS to the configured resolver only.
    ip daddr ${RESOLVER} udp dport 53 accept
    ip daddr ${RESOLVER} tcp dport 53 accept

    ip daddr @allowed_v4 tcp dport { 80, 443 } accept

    # Cloud metadata is a common target for a confused agent. Never allow it.
    ip daddr 169.254.169.254 drop

    log prefix "agent-egress-drop " level info
    # icmpx rejects IPv4 and IPv6 alike. A plain icmp reject matches IPv4 only,
    # and the agent's IPv6 would fall through to the output chain's accept policy.
    reject with icmpx type admin-prohibited
  }
}
EOF
)"

if [[ "$DRY_RUN" == "true" ]]; then
  printf '%s\n' "$RULESET"
  exit 0
fi

echo "==> Applying nftables ruleset"
nft -f - <<<"$RULESET"

echo "==> Persisting"
mkdir -p /etc/nftables.d
nft list table inet agent_egress >/etc/nftables.d/agent-egress.nft
echo 'include "/etc/nftables.d/*.nft"' >/etc/nftables.conf.d-include 2>/dev/null || true
grep -q 'nftables.d' /etc/nftables.conf 2>/dev/null || \
  echo 'include "/etc/nftables.d/*.nft"' >>/etc/nftables.conf
systemctl enable nftables >/dev/null 2>&1 || true

cat <<EOF

Applied. The agent (uid ${UID_NUM}) can now reach only:
  ${ALLOWED_HOSTS[*]}
plus DNS to ${RESOLVER}, its own loopback TCP listeners, and loopback ports
${LOOPBACK_PORTS} whoever owns them. IPv6 is refused apart from loopback.

Verify:
  sudo bash deploy/verify-egress.sh

Remove:
  sudo nft delete table inet agent_egress

EOF
