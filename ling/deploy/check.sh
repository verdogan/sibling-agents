#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for script in \
  "$DEPLOY_DIR/setup-vm.sh" \
  "$DEPLOY_DIR/setup-fleet.sh" \
  "$DEPLOY_DIR/rotate-token.sh" \
  "$DEPLOY_DIR/egress-allowlist.sh" \
  "$DEPLOY_DIR/verify-egress.sh" \
  "$ROOT_DIR/overlord/deploy/setup-overlord.sh"; do
  bash -n "$script"
done

# The env helper must preserve operator changes and safely append shell metacharacters.
source "$DEPLOY_DIR/lib.sh"
ENV_FIXTURE="$TMP/service.env"
printf 'EXISTING=operator|value&kept\\exact\n' >"$ENV_FIXTURE"
ensure_env "$ENV_FIXTURE" EXISTING "replacement"
ensure_env "$ENV_FIXTURE" SPECIAL 'new|value&with\slashes'
grep -Fqx 'EXISTING=operator|value&kept\exact' "$ENV_FIXTURE"
grep -Fqx 'SPECIAL=new|value&with\slashes' "$ENV_FIXTURE"

# Rotation updates both compatibility and identity-scoped credentials without systemd.
ROTATE_TOKEN_DRY_RUN=true \
ROTATE_TOKEN_VALUE=0123456789abcdef0123456789abcdef \
ENV_FILE="$ENV_FIXTURE" \
  bash "$DEPLOY_DIR/rotate-token.sh" ci-caller >/dev/null
grep -Fqx 'AGENT_TOKEN=0123456789abcdef0123456789abcdef' "$ENV_FIXTURE"
grep -Fqx \
  'AGENT_TOKENS_JSON='"'"'{"ci-caller":"0123456789abcdef0123456789abcdef"}'"'" \
  "$ENV_FIXTURE"

# Exercise the two-worker inventory loop with ssh/scp fakes. Every ssh command
# must opt out of inheriting the inventory stream.
MOCK_BIN="$TMP/bin"
mkdir -p "$MOCK_BIN"
cat >"$MOCK_BIN/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SSH_LOG"
if [[ "$*" == *AGENT_TOKEN* ]]; then
  printf 'token-%s-0123456789abcdef\n' "$2"
fi
SH
cat >"$MOCK_BIN/scp" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SCP_LOG"
SH
chmod +x "$MOCK_BIN/ssh" "$MOCK_BIN/scp"
cat >"$TMP/inventory" <<'EOF'
worker-a host-a http://127.0.0.1:18781
worker-b host-b http://127.0.0.1:18782
EOF
SSH_LOG="$TMP/ssh.log" \
SCP_LOG="$TMP/scp.log" \
PATH="$MOCK_BIN:$PATH" \
SKIP_HEALTH_CHECK=true \
WORKER_REGISTRY_OUT="$TMP/workers.json" \
  bash "$DEPLOY_DIR/setup-fleet.sh" "$TMP/inventory" >/dev/null
[[ "$(wc -l <"$TMP/scp.log")" -eq 2 ]]
[[ "$(grep -c 'setup-vm.sh' "$TMP/ssh.log")" -eq 2 ]]
[[ "$(grep -vc '^-n ' "$TMP/ssh.log" || true)" -eq 0 ]]
node -e '
  const workers = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (workers.length !== 2 || workers[0].id !== "worker-a" || workers[1].id !== "worker-b") {
    process.exit(1);
  }
' "$TMP/workers.json"

# The egress ruleset, rendered with fake id and getent: loopback answers are
# scoped by uid before only the agent's packets go on to the allowlist, the
# final reject covers IPv6 but is reached by nothing the agent did not send,
# and a rerun replaces the table instead of appending to it.
cat >"$MOCK_BIN/id" <<'SH'
#!/usr/bin/env bash
echo 1234
SH
cat >"$MOCK_BIN/getent" <<'SH'
#!/usr/bin/env bash
printf '203.0.113.10    STREAM %s\n203.0.113.10    DGRAM\n203.0.113.11    STREAM\n' "$2"
SH
chmod +x "$MOCK_BIN/id" "$MOCK_BIN/getent"
EGRESS_DRY_RUN=true LOOPBACK_PORTS="53, 3128" PATH="$MOCK_BIN:$PATH" \
  bash "$DEPLOY_DIR/egress-allowlist.sh" >"$TMP/egress.nft" 2>"$TMP/egress-progress.log"
# A dry run's stdout is the ruleset and nothing else, so nft -c -f can read it.
[[ "$(head -n 1 "$TMP/egress.nft")" == "table inet agent_egress" ]]
if grep -q '==>' "$TMP/egress.nft"; then
  echo "the egress dry run mixes progress lines into the ruleset" >&2
  exit 1
fi
grep -q 'Resolving allowlist' "$TMP/egress-progress.log"
grep -Fq 'elements = { 203.0.113.10, 203.0.113.11 }' "$TMP/egress.nft"
grep -Fq 'delete table inet agent_egress' "$TMP/egress.nft"
grep -Fq 'oifname "lo" meta skuid 1234 ct state new ct mark set ct mark or 0x20000000' "$TMP/egress.nft"
grep -Fq 'ct mark and 0x60000000 == 0x60000000 accept' "$TMP/egress.nft"
grep -Fq 'th sport { 53, 3128 } accept' "$TMP/egress.nft"
grep -Fq 'ct mark and 0x20000000 == 0x20000000 meta skuid 1234 ct mark set ct mark or 0x40000000 accept' "$TMP/egress.nft"
grep -Fq 'ct mark and 0x20000000 == 0x20000000 drop' "$TMP/egress.nft"
# Answers on a connection the agent's uid has answered pass before the drop,
# which would otherwise take those the kernel sends from an orphaned socket.
[[ "$(grep -n 'ct mark and 0x60000000 == 0x60000000 accept' "$TMP/egress.nft" | cut -d: -f1)" -lt \
   "$(grep -n 'ct mark and 0x20000000 == 0x20000000 drop' "$TMP/egress.nft" | cut -d: -f1)" ]]
grep -Fq 'oifname "lo" udp dport != { 53, 3128 } reject' "$TMP/egress.nft"
grep -Fq 'reject with icmpx type admin-prohibited' "$TMP/egress.nft"
if grep -q 'reject with icmp ' "$TMP/egress.nft"; then
  echo "egress ruleset still ends in an IPv4-only reject" >&2
  exit 1
fi
# The output hook chain hands on only the agent's packets and refuses nothing
# itself, so packets with no owner, IPv6 neighbour discovery among them, keep
# its accept policy.
sed -n '/^  chain output {/,/^  }/p' "$TMP/egress.nft" >"$TMP/egress-output.nft"
[[ "$(grep -v '^ *#' "$TMP/egress-output.nft" | grep -c 'skuid 1234 jump agent_out')" -eq 1 ]]
if grep -v '^ *#' "$TMP/egress-output.nft" | grep -Eq 'reject|log prefix|skuid != '; then
  echo "the egress output chain refuses traffic the agent did not send" >&2
  exit 1
fi
[[ "$(grep -n 'ct mark and 0x20000000 == 0x20000000 drop' "$TMP/egress.nft" | cut -d: -f1)" -lt \
   "$(grep -n 'jump agent_out' "$TMP/egress.nft" | cut -d: -f1)" ]]
[[ "$(grep -n '^  chain agent_out {' "$TMP/egress.nft" | cut -d: -f1)" -lt \
   "$(grep -n 'reject with icmpx' "$TMP/egress.nft" | tail -1 | cut -d: -f1)" ]]
grep -q "another user's loopback listener blocked" "$DEPLOY_DIR/verify-egress.sh"
grep -q "neighbour discovery" "$DEPLOY_DIR/verify-egress.sh"
grep -q "large response it closed at once" "$DEPLOY_DIR/verify-egress.sh"

# A negated command never trips set -e, so this one says so itself.
if grep -q 'usermod .*docker' "$DEPLOY_DIR/setup-vm.sh"; then
  echo "setup-vm.sh adds a user to the docker group" >&2
  exit 1
fi
grep -q 'CONTAINER_RUNTIME=podman' "$DEPLOY_DIR/setup-vm.sh"
grep -q 'podman run' "$DEPLOY_DIR/verify-egress.sh"

echo "all deployment checks passed"
