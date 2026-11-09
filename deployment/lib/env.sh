#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# env.sh - shared helpers for the deployment/ scripts. Source this file; do not execute it.
#   source "$ROOT_DIR/deployment/lib/env.sh"

die() { echo "error: $*" >&2; exit 1; }

# deploy_env_file <repo-root> - print the deploy-config file to load: $VOD_ENV_FILE when set (a path,
# or `none` for no file), else the repo-root .env. Mirrors deployEnvPath() in source/contract, which the
# CDK apps use, so scripts and `cdk` commands always read the same file.
deploy_env_file() {
  local root="$1"
  case "${VOD_ENV_FILE:-}" in
    none) printf '' ;;
    '') printf '%s' "$root/.env" ;;
    *) [ -f "$VOD_ENV_FILE" ] || die "VOD_ENV_FILE=$VOD_ENV_FILE: file not found"; printf '%s' "$VOD_ENV_FILE" ;;
  esac
}

# ensure_workspace_deps <repo-root> - install the npm workspaces (the core packages share one root
# lockfile and node_modules) if they are not installed yet. `npm ci` also builds source/contract
# through its `prepare` script. Companion modules, when present, are a separate workspaces root
# (source/modules) installed after it, since they link the built source/contract.
ensure_workspace_deps() {
  local root="$1"
  [ -d "$root/node_modules" ] || (cd "$root" && npm ci)
  if [ -f "$root/source/modules/package.json" ] && [ ! -d "$root/source/modules/node_modules" ]; then
    (cd "$root/source/modules" && npm ci)
  fi
}

# load_env_file <path> - load a dotenv-style file into the current shell (comment/whitespace-safe;
# does NOT `source` the file, so it tolerates values a real shell would mis-parse). No-op if the
# path doesn't exist, so callers that can get everything they need from flags/ambient env still work
# without a .env file present.
load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|\#*) continue ;; esac
    [ "${line#*=}" = "$line" ] && continue
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    printf -v "$key" '%s' "$val"
    export "$key"
  done < "$file"
}
