#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Interactive deploy of Guidance for Video on Demand on AWS: the core stack plus whichever modules the
# repo-root .env (written by scripts/configure.sh) enables, in the order that needs the fewest core
# redeploys: modules the core reads (WAF, extension modules) first, then core, then SSAI and the CMS.
# The non-interactive per-stack scripts (deployment/deploy.sh, source/modules/*/deploy.sh) still work.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=SCRIPTDIR/lib/wizard.sh
source "$ROOT_DIR/scripts/lib/wizard.sh"
TOTAL_STAGES=7   # extension deploy-wizard.sh files add theirs; read by stage/banner
cd "$ROOT_DIR"
# Companion module stacks (WAF, SSAI) are optional; their stages skip when the module is absent.
has_module() { [[ -f "$ROOT_DIR/source/modules/$1/deploy.sh" ]]; }
# Installed core extensions may hook in: each source/core/extensions/<name>/deploy-wizard.sh appends functions
# to these arrays (and adds its stage count to TOTAL_STAGES). Preflight checks run after the account check;
# plan lines print before the core stack; pre-core stages run before WAF; pre-CMS steps run before the CMS deploy.
WIZARD_PREFLIGHT=(); WIZARD_PLAN=(); WIZARD_PRE_CORE_STAGES=(); WIZARD_PRE_CMS=()
# extension_on ID: is ID enabled in .env VOD_EXTENSIONS? (Loaded in Preflight; hooks check it themselves.)
extension_on() { [[ ",$(printf '%s' "${VOD_EXTENSIONS:-}" | tr -d '[:space:]')," == *",$1,"* ]]; }
for f in "$ROOT_DIR"/source/core/extensions/*/deploy-wizard.sh; do
  # shellcheck source=/dev/null
  if [[ -f "$f" ]]; then source "$f"; fi
done
# shellcheck source=SCRIPTDIR/../deployment/lib/env.sh
source "$ROOT_DIR/deployment/lib/env.sh"
ENV_FILE="$(deploy_env_file "$ROOT_DIR")"
[[ -n "$ENV_FILE" ]] || ENV_FILE="$ROOT_DIR/.env"
WORK_DIR="$(mktemp -d -t vod-deploy.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
DONE=()

# run "description" cmd...: show + run a command; on failure offer to stop (returns 1 if you continue,
# so callers either branch on it or append `|| true`).
run() {
  local desc="$1"; shift
  note "\$ $*"
  if "$@"; then printf '  %s✓ %s%s\n' "$GREEN" "$desc" "$RESET"; DONE+=("$desc"); return 0; fi
  warn "$desc FAILED (see the output above)"
  confirm "Continue with the remaining stages anyway?" || exit 1
  return 1
}
in_dir() { (cd "$1" && shift && "$@"); }
ssm_get() { aws ssm get-parameter --name "/$STACK_NAME/$1" --query Parameter.Value --output text 2>/dev/null || true; }
is_on() { [[ "${!1:-OFF}" == "ON" ]]; }
# cms_output KEY: an output of the CMS stack (empty when it isn't deployed).
cms_output() {
  local v; v=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME-cms" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null) || return 0
  [[ "$v" == None ]] || printf '%s' "$v"
}
# cms_user_exists: the saved operator (CMS_ADMIN_USER) is already in the CMS user pool.
cms_user_exists() {
  local pool user; user="${CMS_ADMIN_USER:-}"; [[ -n "$user" ]] || return 1
  pool=$(cms_output UserPoolId); [[ -n "$pool" ]] || return 1
  aws cognito-idp admin-get-user --user-pool-id "$pool" --username "$user" >/dev/null 2>&1
}

banner "Video on Demand on AWS - deploy"

# ── 1. Preflight ─────────────────────────────────────────────────────────────────────────────
stage "Preflight: config, account, bootstrap, build"
if [[ ! -f "$ENV_FILE" ]] || [[ -z "$(_existing EMAIL || true)" ]]; then
  warn "No deploy config with EMAIL at $ENV_FILE."
  if confirm "Run scripts/configure.sh now to create it?"; then scripts/configure.sh; else exit 1; fi
fi
load_env_file "$ENV_FILE"
STACK_NAME="${STACK_NAME:-VideoOnDemand}"
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
[[ -n "$AWS_REGION" ]] || { ask_value --validate v_region AWS_REGION "AWS Region to deploy into"; write_env AWS_REGION "$AWS_REGION"; export AWS_REGION; }
export AWS_DEFAULT_REGION="$AWS_REGION"
for t in node npm aws; do command -v "$t" >/dev/null 2>&1 || { warn "$t is required"; exit 1; }; done
ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || { warn "no working AWS credentials (try: aws login / aws configure)"; exit 1; }
say "Config:   $ENV_FILE"
say "Account:  $ACCOUNT  ($(aws sts get-caller-identity --query Arn --output text))"
say "Region:   $AWS_REGION"
say "Stack:    $STACK_NAME"
confirm "Deploy to this account and Region?" || exit 1
WAF_ON=false; [[ -n "${WAF_ALLOWED_COUNTRIES:-}${WAF_ALLOWED_IPS:-}" ]] && has_module waf && WAF_ON=true
for f in ${WIZARD_PREFLIGHT[@]+"${WIZARD_PREFLIGHT[@]}"}; do "$f"; done
for r in "$AWS_REGION" $([[ "$WAF_ON" == true && "$AWS_REGION" != us-east-1 ]] && echo us-east-1); do
  if aws ssm get-parameter --region "$r" --name /cdk-bootstrap/hnb659fds/version >/dev/null 2>&1; then
    note "CDK bootstrapped in $r"
  elif confirm "CDK is not bootstrapped in $r. Bootstrap it now?"; then
    run "bootstrapped $r" npx --yes cdk bootstrap "aws://$ACCOUNT/$r" || true
  else
    warn "deploys to $r will fail until it is bootstrapped"
  fi
done
ensure_workspace_deps "$ROOT_DIR"
# Only what the core deploy needs: the CMS frontend is built by source/cms/scripts/deploy-all.sh, after its stack
# outputs are written to frontend/.env, and only when the CMS is chosen in the Plan stage.
run "built the core packages" npm run build --silent -w @vod/contract -w @vod/core || true
pause

# ── 2. Plan ──────────────────────────────────────────────────────────────────────────────────
stage "Plan"
SSAI_ON=false; CMS_ON=false
if ! has_module ssai; then
  : # SSAI companion module not installed.
elif is_on PACKAGING_PROFILE && is_on AD_MARKERS_PROFILE; then
  confirm "Deploy the MediaTailor SSAI module (server-side ads on HLS/TS)?" && SSAI_ON=true
  if [[ "$SSAI_ON" == true && "$WAF_ON" == true ]] && ! is_on WAF_ALLOW_MANIFESTS; then
    warn "With the WAF, SSAI needs WAF_ALLOW_MANIFESTS=ON and WAF_ALLOW_PATH_PREFIXES=/creatives/ (MediaTailor"
    warn "fetches manifests + creatives from AWS addresses), or playback returns 504. Run scripts/configure.sh."
  fi
else
  note "SSAI module unavailable: it needs PACKAGING_PROFILE=ON and AD_MARKERS_PROFILE=ON (scripts/configure.sh)."
fi
# Defaults to the DEPLOY_CMS choice saved by scripts/configure.sh; the answer is written back to .env.
true_false DEPLOY_CMS "Deploy the operator web app (CMS)?" false
[[ "$DEPLOY_CMS" == true ]] && CMS_ON=true
say ""
say "Deploy order:"
for f in ${WIZARD_PLAN[@]+"${WIZARD_PLAN[@]}"}; do "$f"; done
[[ "$WAF_ON" == true ]] && step "${STACK_NAME}-waf   WAF WebACL in us-east-1 (allow-lists set)"
step "$STACK_NAME   core stack (packaging=${PACKAGING_PROFILE:-OFF} adMarkers=${AD_MARKERS_PROFILE:-OFF} captions=${CAPTIONS_PROFILE:-OFF} metrics=${PER_FRAME_METRICS:-OFF} thumbnails=${THUMBNAILS_PROFILE:-ON})"
[[ "$SSAI_ON" == true ]] && step "$STACK_NAME-MediaTailor   SSAI"
[[ "$CMS_ON" == true ]] && step "$STACK_NAME-cms   operator web app (then a core redeploy to allow its uploads)"
# Redeploys skip first-deploy messaging: the SNS confirmation reminder and the operator-login setup.
CORE_EXISTS=false; aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1 && CORE_EXISTS=true
CMS_USER_EXISTS=false
if [[ "$CMS_ON" == true ]] && cms_user_exists; then CMS_USER_EXISTS=true; fi
if [[ "$CORE_EXISTS" == true ]] \
   && confirm "$STACK_NAME already exists. Preview the core changes (cdk diff) first?"; then
  in_dir source/core npm run --silent cdk -- diff VideoOnDemand || true
fi
confirm "Proceed with this plan?" || exit 1

# ── Extension stages (before the core stack) ─────────────────────────────────────────────────
for f in ${WIZARD_PRE_CORE_STAGES[@]+"${WIZARD_PRE_CORE_STAGES[@]}"}; do "$f"; done

# ── 3. WAF ───────────────────────────────────────────────────────────────────────────────────
stage "WAF module (us-east-1)"
if [[ "$WAF_ON" == true ]]; then
  OUT="$WORK_DIR/waf-outputs.json"
  if run "deployed the WAF stack" in_dir source/modules/waf npm run --silent cdk -- deploy --all \
       --require-approval never --outputs-file "$OUT"; then
    WAF_WEB_ACL_ARN=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next(v["WebAclArn"] for v in d.values() if "WebAclArn" in v))' "$OUT")
    write_env WAF_WEB_ACL_ARN "$WAF_WEB_ACL_ARN"
    export WAF_WEB_ACL_ARN
    note "Saved so every later core deploy keeps the association."
  fi
  pause
elif ! has_module waf; then
  note "WAF companion module not installed: skipping."
else
  note "No WAF_ALLOWED_COUNTRIES / WAF_ALLOWED_IPS: skipping."
fi

# ── 4. Core ──────────────────────────────────────────────────────────────────────────────────
stage "Core stack"
say "Deploying $STACK_NAME (about 5 minutes on first deploy, including CloudFront updating globally)."
run "deployed $STACK_NAME" deployment/deploy.sh || true
CF_DOMAIN=$(ssm_get CloudFrontDomainName)
say "CloudFront: https://$CF_DOMAIN"
say "Upload to:  s3://$(ssm_get SourceBucket)/"
if [[ "$CORE_EXISTS" != true ]]; then
  step "Check $EMAIL for the SNS 'Subscription Confirmation' email and confirm it to get workflow notifications."
fi
if [[ "$CMS_ON" == true && "$CMS_USER_EXISTS" != true ]]; then
  note "Next: the CMS stage creates your operator login; Cognito then emails $EMAIL a temporary password."
elif [[ "$CMS_ON" != true && "$CORE_EXISTS" != true ]]; then
  note "No CMS selected, so no login or password email (upload to the source bucket above instead)."
fi
pause

# ── 5. SSAI ──────────────────────────────────────────────────────────────────────────────────
stage "MediaTailor SSAI module"
if [[ "$SSAI_ON" == true ]]; then
  if run "deployed $STACK_NAME-MediaTailor" in_dir source/modules/ssai npm run --silent cdk -- deploy --all --require-approval never; then
    note "Ad-stitched HLS: $(ssm_get SsaiHlsManifestEndpointPrefix)<guid>/hls/index.m3u8"
  fi
  pause
else
  note "Not selected: skipping."
fi

# ── 6. CMS ───────────────────────────────────────────────────────────────────────────────────
stage "Operator web app (CMS)"
if [[ "$CMS_ON" == true ]]; then
  for f in ${WIZARD_PRE_CMS[@]+"${WIZARD_PRE_CMS[@]}"}; do "$f"; done
  choose CMS_ENVIRONMENT "CMS environment" prod \
    "prod|retains the user pool when the stack is deleted" \
    "dev|deletes everything with the stack"
  if run "deployed $STACK_NAME-cms" source/cms/scripts/deploy-all.sh vod-cms "$CMS_ENVIRONMENT"; then
    CMS_DOMAIN=$(cms_output DistributionDomainName)
    POOL_ID=$(cms_output UserPoolId)
    SIGN_IN="sign in as ${CMS_ADMIN_USER:-}"
    if cms_user_exists; then
      note "Operator login: ${CMS_ADMIN_USER} (already set up)"
    else
      ask_value CMS_ADMIN_USER "Operator username to create (self sign-up is off)" admin
      write_env CMS_ADMIN_USER "$CMS_ADMIN_USER"
      if aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$CMS_ADMIN_USER" >/dev/null 2>&1; then
        note "Operator login: $CMS_ADMIN_USER (already set up)"
        SIGN_IN="sign in as $CMS_ADMIN_USER"
      else
        run "created $CMS_ADMIN_USER (temporary password emailed to $EMAIL)" aws cognito-idp admin-create-user \
          --user-pool-id "$POOL_ID" --username "$CMS_ADMIN_USER" \
          --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true --output text --query User.Username || true
        SIGN_IN="sign in as $CMS_ADMIN_USER with the temporary password emailed to $EMAIL"
      fi
    fi
    ORIGIN="https://$CMS_DOMAIN"
    if [[ ",${UPLOAD_CORS_ORIGINS:-}," != *",$ORIGIN,"* ]]; then
      UPLOAD_CORS_ORIGINS="${UPLOAD_CORS_ORIGINS:+$UPLOAD_CORS_ORIGINS,}$ORIGIN"
      write_env UPLOAD_CORS_ORIGINS "$UPLOAD_CORS_ORIGINS"
      say "The CMS uploads from $ORIGIN, so $STACK_NAME is redeployed now to add it to the source bucket CORS (about 1-2 minutes)."
      run "redeployed $STACK_NAME with upload CORS" deployment/deploy.sh || true
    fi
    say "CMS: $ORIGIN  ($SIGN_IN)"
  fi
  pause
else
  note "Not selected: skipping."
fi

# ── 7. Smoke test ────────────────────────────────────────────────────────────────────────────
stage "Smoke test"
if command -v ffmpeg >/dev/null 2>&1 && confirm_yes "Transcode a 30 s colour-bar test clip now (a few minutes)?"; then
  KEY="smoke-test-$(date +%Y%m%d%H%M%S).mp4"
  ffmpeg -loglevel error -y -f lavfi -i "smptehdbars=size=1280x720:rate=25:duration=30" \
    -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=30" \
    -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -shortest "$WORK_DIR/$KEY"
  run "uploaded $KEY" aws s3 cp --only-show-errors "$WORK_DIR/$KEY" "s3://$(ssm_get SourceBucket)/$KEY" || true
  TABLE=$(ssm_get DynamoDBTable); STATUS=""; deadline=$(( $(date +%s) + 1200 ))
  while (( $(date +%s) < deadline )); do
    read -r STATUS HLS_URL <<<"$(aws dynamodb scan --table-name "$TABLE" --filter-expression "srcVideo = :k" \
      --expression-attribute-values "{\":k\":{\"S\":\"$KEY\"}}" --query "Items[0].[workflowStatus.S, hlsUrl.S]" --output text 2>/dev/null || true)"
    [[ "$STATUS" == Complete || "$STATUS" == Error ]] && break
    printf '  %s… %s%s\r' "$DIM" "${STATUS:-waiting for the workflow to start}" "$RESET"; sleep 15
  done
  printf '\n'
  if [[ "$STATUS" == Complete ]]; then
    printf '  %s✓ transcoded%s %s\n' "$GREEN" "$RESET" "$HLS_URL"; DONE+=("smoke test")
    confirm "Open it in the hls.js demo player?" && \
      open_url "https://hlsjs.video-dev.org/demo/?src=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$HLS_URL")"
  else
    warn "status: ${STATUS:-no record}. Check the $STACK_NAME-orchestrator execution in the Step Functions console."
  fi
else
  note "Skipped. To test later, see the README Quickstart."
fi

finish
for d in "${DONE[@]}"; do printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$d"; done
say "CloudFront: https://$CF_DOMAIN"
[[ -n "${CMS_DOMAIN:-}" ]] && say "CMS:        https://$CMS_DOMAIN"
