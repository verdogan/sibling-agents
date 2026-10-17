#!/usr/bin/env bash

ensure_env() {
  local file=$1 key=$2 value=$3
  if ! grep -q "^${key}=" "$file"; then
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}
