#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# deploy.sh - two-step deploy of the streaming-media WAF module, configured from the repo-root .env.
#
#   source/modules/waf/deploy.sh [--email E] [--stack S] [--region R] [--dry-run] [--help]
#
# A CLOUDFRONT-scope WAFv2 WebACL can only live in us-east-1, so it is a SEPARATE stack
# (StreamingMediaWaf, or <stack>-waf). The core VOD stack associates it via `wafWebAclArn`. We do NOT
# use a CDK cross-region reference (it would inject a Lambda-backed custom resource into the core
# stack and break its 0-Lambda invariant), so association is a two-step deploy:
#   1. deploy this module's stack (us-east-1) and capture its WebAclArn output;
#   2. redeploy the core VOD stack (in --region) with -c wafWebAclArn=<that ARN>.
#
# Configure WAF_ALLOWED_COUNTRIES and/or WAF_ALLOWED_IPS in .env. Re-run after changing them, and add
# the printed WAF_WEB_ACL_ARN to .env so later core deploys keep the association.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODULE_DIR="$ROOT_DIR/source/modules/waf"
CORE_DIR="$ROOT_DIR/source/core"

source "$ROOT_DIR/deployment/lib/env.sh"
load_env_file "$(deploy_env_file "$ROOT_DIR")"

DRY_RUN="false"
EMAIL_FLAG=""; STACK_FLAG=""; REGION_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN="true" ;;
    --email)    EMAIL_FLAG="${2:?--email needs a value}"; shift ;;
    --stack)    STACK_FLAG="${2:?--stack needs a value}"; shift ;;
    --region)   REGION_FLAG="${2:?--region needs a value}"; shift ;;
    --help|-h)  sed -n '6,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

EMAIL="${EMAIL_FLAG:-${EMAIL:-}}"
STACK="${STACK_FLAG:-${STACK_NAME:-}}"
REGION="${REGION_FLAG:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"

[ -n "$EMAIL" ] || die "email is required — set EMAIL in .env (or pass --email you@example.com)"
[ -n "${WAF_ALLOWED_COUNTRIES:-}" ] || [ -n "${WAF_ALLOWED_IPS:-}" ] \
  || die "set at least one of WAF_ALLOWED_COUNTRIES / WAF_ALLOWED_IPS in .env (an empty WebACL blocks all traffic)."

WAF_CTX=()
[ -n "$STACK" ]                     && WAF_CTX+=(-c "stackName=$STACK")
[ -n "${WAF_ALLOWED_COUNTRIES:-}" ] && WAF_CTX+=(-c "wafAllowedCountries=$WAF_ALLOWED_COUNTRIES")
[ -n "${WAF_ALLOWED_IPS:-}" ]       && WAF_CTX+=(-c "wafAllowedIps=$WAF_ALLOWED_IPS")

OUTPUTS_FILE="$(mktemp -t vod-waf-outputs.XXXXXX)"
trap 'rm -f "$OUTPUTS_FILE"' EXIT

echo "step 1/2: deploy the WAF module stack (us-east-1)"
echo "command: (cd source/modules/waf && npm run cdk -- deploy --all ${WAF_CTX[*]:-} --outputs-file <tmp> --require-approval never)"
if [ "$DRY_RUN" = "true" ]; then echo "[dry-run] no deploy performed."; exit 0; fi

ensure_workspace_deps "$ROOT_DIR"
( cd "$MODULE_DIR" && npm run cdk -- deploy --all "${WAF_CTX[@]}" --outputs-file "$OUTPUTS_FILE" --require-approval never )

# The outputs file is a flat {"StackName": {"OutputKey": "OutputValue", ...}} map, so a plain grep/sed
# pull avoids adding a python3/jq dependency for one string.
WEB_ACL_ARN="$(grep -o '"WebAclArn"[[:space:]]*:[[:space:]]*"[^"]*"' "$OUTPUTS_FILE" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"$/\1/')"
[ -n "$WEB_ACL_ARN" ] || die "could not read WebAclArn from the WAF stack outputs."
echo "WebAclArn: $WEB_ACL_ARN"

echo "step 2/2: redeploy the core VOD stack with the WebACL associated"
CORE_CTX=(-c "email=$EMAIL" -c "wafWebAclArn=$WEB_ACL_ARN")
[ -n "$STACK" ] && CORE_CTX+=(-c "stackName=$STACK")
echo "region: ${REGION:-<aws default>}"
echo "command: (cd source/core && npm run cdk -- deploy VideoOnDemand ${CORE_CTX[*]} --require-approval never)"
(
  cd "$CORE_DIR"
  if [ -n "$REGION" ]; then export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"; fi
  npm run cdk -- deploy VideoOnDemand "${CORE_CTX[@]}" --require-approval never
)
echo "done. The distribution now enforces the streaming-media WebACL (default BLOCK; allow by IP or country)."
echo "Add this line to .env so later core deploys keep the association:"
echo "  WAF_WEB_ACL_ARN=$WEB_ACL_ARN"
