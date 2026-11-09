#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# deploy.sh - one-command deploy of the core VOD transcoding stack (source/core).
#
#   deployment/deploy.sh [--email E] [--stack S] [--region R] [--dry-run] [--help]
#
# Reads .env the same way bin/vod.ts does (copy .env.example to
# .env and set EMAIL first), so a bare `deployment/deploy.sh` is enough for a normal
# deploy: installs dependencies (first run only), builds, then runs `cdk deploy`. An explicit
# --email/--stack/--region flag overrides the matching .env value.
#
# Overlays that need a companion module stack deploy with that module's own deploy.sh.
# For the operator web app: source/cms/scripts/deploy-all.sh (see README).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDK_DIR="$ROOT_DIR/source/core"

source "$ROOT_DIR/deployment/lib/env.sh"
ENV_FILE="$(deploy_env_file "$ROOT_DIR")"

EMAIL_FLAG=""; STACK_FLAG=""; REGION_FLAG=""; DRY_RUN="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --email)   EMAIL_FLAG="${2:?--email needs a value}"; shift ;;
    --stack)   STACK_FLAG="${2:?--stack needs a value}"; shift ;;
    --region)  REGION_FLAG="${2:?--region needs a value}"; shift ;;
    --dry-run) DRY_RUN="true" ;;
    --help|-h) sed -n '4,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# ---- load the deploy config (repo-root .env; comment/whitespace-safe; does NOT `source` the file) ----
load_env_file "$ENV_FILE"

EMAIL="${EMAIL_FLAG:-${EMAIL:-}}"
STACK="${STACK_FLAG:-${STACK_NAME:-}}"
[ -n "$EMAIL" ] \
  || die "email is required — copy .env.example to .env and set EMAIL, or pass --email you@example.com"

REGION="${REGION_FLAG:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"

CDK_ARGS=(-c "email=$EMAIL")
[ -n "$STACK" ] && CDK_ARGS+=(-c "stackName=$STACK")

# The stack SELECTOR the cdk CLI needs is the app's construct id ("VideoOnDemand", set in
# bin/vod.ts) - NOT the -c stackName context value above (that only renames the physical
# CloudFormation stack; the CLI still selects it by construct id). Passed explicitly so the command
# stays unambiguous.
echo "region: ${REGION:-<aws default>}"
echo "command: (npm ci && cd source/core && npm run build && npm run cdk -- deploy VideoOnDemand ${CDK_ARGS[*]} --require-approval never)"
if [ "$DRY_RUN" = "true" ]; then echo "[dry-run] no deploy performed."; exit 0; fi

(
  cd "$CDK_DIR"
  if [ -n "$REGION" ]; then export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"; fi
  ensure_workspace_deps "$ROOT_DIR"
  npm run build
  npm run cdk -- deploy VideoOnDemand "${CDK_ARGS[@]}" --require-approval never
)

echo "done. See the stack Outputs above (SourceBucket, DestinationBucket, CloudFrontDomainName, ...)."
