#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/autonomous-pi-agent.env}
CALLER_ID=${1:-production-overlord}
DRY_RUN=${ROTATE_TOKEN_DRY_RUN:-false}
if [[ $EUID -ne 0 && "$DRY_RUN" != "true" ]]; then
  echo "Run this as root." >&2
  exit 1
fi
TOKEN=${ROTATE_TOKEN_VALUE:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}

TOKEN="$TOKEN" CALLER_ID="$CALLER_ID" node - "$ENV_FILE" <<'NODE'
const fs = require("node:fs");
const filename = process.argv[2];
const token = process.env.TOKEN;
const caller = process.env.CALLER_ID;
const replacements = new Map([
  ["AGENT_TOKEN", `AGENT_TOKEN=${token}`],
  ["AGENT_TOKENS_JSON", `AGENT_TOKENS_JSON='${JSON.stringify({ [caller]: token })}'`],
]);
const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
for (const [key, replacement] of replacements) {
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = replacement;
  else lines.push(replacement);
}
fs.writeFileSync(filename, `${lines.filter((line, i) => line !== "" || i < lines.length - 1).join("\n")}\n`);
NODE
if [[ "$DRY_RUN" != "true" ]]; then
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  systemctl restart autonomous-pi-agent.service
fi
echo "Rotated ${CALLER_ID}; update the matching overlord worker registry token."
echo "$TOKEN"
