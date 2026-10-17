#!/usr/bin/env bash
#
# Provision every Ling worker in an inventory and emit overlord registry JSON.
# Inventory lines are: worker-id  ssh-target  base-url
# Example:
#   worker-a  ops@10.0.0.11  http://10.0.0.11:8787
#   worker-b  ops@10.0.0.12  http://10.0.0.12:8787
#
# Bearer tokens require a trusted private network, VPN, or TLS-terminating proxy.
set -euo pipefail

INVENTORY=${1:-}
if [[ -z "$INVENTORY" || ! -f "$INVENTORY" ]]; then
  echo "Usage: bash deploy/setup-fleet.sh <inventory>" >&2
  exit 1
fi

LING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY_OUT=${WORKER_REGISTRY_OUT:-ling-workers.json}
MAX_CONCURRENCY=${MAX_CONCURRENCY:-2}
APPLY_EGRESS=${APPLY_EGRESS:-false}
SKIP_HEALTH_CHECK=${SKIP_HEALTH_CHECK:-false}
TMP="$(mktemp)"
ARCHIVE="$(mktemp --suffix=.tar)"
trap 'rm -f "$TMP" "$ARCHIVE"' EXIT
tar -C "$LING_DIR" \
  --exclude=node_modules --exclude=.git --exclude=.env --exclude=dist \
  --exclude=workspaces --exclude=auth --exclude=data --exclude=runtime-home \
  -cf "$ARCHIVE" .

while read -r worker_id ssh_target base_url extra; do
  [[ -z "$worker_id" || "$worker_id" == \#* ]] && continue
  if [[ -z "$ssh_target" || -z "$base_url" || -n "${extra:-}" ]]; then
    echo "Invalid inventory line for ${worker_id}; expected three fields." >&2
    exit 1
  fi
  remote="/tmp/ling-provision-${worker_id}"
  echo "==> ${worker_id}: copying Ling to ${ssh_target}"
  ssh -n "$ssh_target" "rm -rf '$remote' && mkdir -p '$remote'"
  scp "$ARCHIVE" "$ssh_target:$remote/ling.tar"
  ssh -n "$ssh_target" "tar -C '$remote' -xf '$remote/ling.tar' && rm '$remote/ling.tar'"
  echo "==> ${worker_id}: provisioning worker"
  ssh -n "$ssh_target" \
    "cd '$remote' && sudo env WORKER_ID='$worker_id' BIND_ADDRESS='${WORKER_BIND_ADDRESS:-127.0.0.1}' MAX_CONCURRENCY='$MAX_CONCURRENCY' bash deploy/setup-vm.sh"
  if [[ "$APPLY_EGRESS" == "true" ]]; then
    ssh -n "$ssh_target" "cd '$remote' && sudo bash deploy/egress-allowlist.sh"
  fi
  token="$(ssh -n "$ssh_target" "sudo awk -F= '\$1==\"AGENT_TOKEN\"{print \$2}' /etc/autonomous-pi-agent.env")"
  if [[ -z "$token" ]]; then
    echo "${worker_id}: could not read generated token" >&2
    exit 1
  fi
  printf '%s\t%s\t%s\n' "$worker_id" "$base_url" "$token" >>"$TMP"
done <"$INVENTORY"

node - "$TMP" "$REGISTRY_OUT" <<'NODE'
const [input, output] = process.argv.slice(2);
const fs = require("node:fs");
const workers = fs.readFileSync(input, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const [id, baseUrl, token] = line.split("\t");
  return { id, baseUrl, token, maxConcurrency: Number(process.env.MAX_CONCURRENCY || 2) };
});
fs.writeFileSync(output, `${JSON.stringify(workers, null, 2)}\n`, { mode: 0o600 });
NODE
chmod 600 "$REGISTRY_OUT"

if [[ "$SKIP_HEALTH_CHECK" != "true" ]]; then
  echo "==> Verifying worker health from the overlord host"
  node - "$REGISTRY_OUT" <<'NODE'
const fs = require("node:fs");
const workers = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
(async () => {
  for (const worker of workers) {
    const response = await fetch(`${worker.baseUrl.replace(/\/+$/, "")}/healthz`);
    if (!response.ok) throw new Error(`${worker.id} health returned HTTP ${response.status}`);
    console.log(`${worker.id}: healthy`);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
fi

cat <<EOF

Wrote ${REGISTRY_OUT} at mode 0600.
Set LING_WORKERS_JSON to its compact JSON contents on the overlord.
Rotate a worker by replacing AGENT_TOKEN in /etc/autonomous-pi-agent.env,
restarting that worker, and updating only its registry entry.
EOF
