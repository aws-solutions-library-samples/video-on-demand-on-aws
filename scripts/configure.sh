#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Interactive configuration for Guidance for Video on Demand on AWS. Writes the repo-root .env (the one deploy
# config every stack and script reads) and creates any Secrets Manager secrets a stage needs directly. Secret
# VALUES are never written to .env. Re-run any time: every prompt shows the saved value and Enter keeps it,
# so a re-run that only presses Enter changes nothing.
#
#   scripts/configure.sh                 # arrow-key menus on a terminal
#   VOD_WIZARD_PLAIN=1 scripts/configure.sh   # numbered menus (also used when stdin isn't a terminal)
#   VOD_ENV_FILE=.env.prod scripts/configure.sh   # configure another file

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${VOD_ENV_FILE:-$ROOT_DIR/.env}"
[[ "$ENV_FILE" == "none" ]] && ENV_FILE="$ROOT_DIR/.env"
# shellcheck source=SCRIPTDIR/lib/wizard.sh
source "$ROOT_DIR/scripts/lib/wizard.sh"
EXAMPLE_ENV_FILE="$ROOT_DIR/.env.example"   # its placeholder values count as "not set" (no warning)
if [[ ! -f "$ENV_FILE" ]]; then cp "$ROOT_DIR/.env.example" "$ENV_FILE"; FRESH_ENV=true; else FRESH_ENV=false; fi

# Companion module stacks: their stages appear only when the module is present.
has_module() { [[ -f "$ROOT_DIR/source/modules/$1/deploy.sh" ]]; }
BASE_STAGES=5   # Basics, Notifications and storage, Delivery (incl. the WAF allow-list), Overlays, Review

# Installed extensions: the directories under source/core/extensions and source/cms/backend/extensions (none
# ship in this repository). The Extensions stage picks which to enable (.env VOD_EXTENSIONS, read by every app);
# an enabled extension's own stages (its source/core/extensions/<name>/configure.sh, registered with
# register_extension_stages) run after it.
INSTALLED_EXTENSIONS=()
for d in "$ROOT_DIR"/source/core/extensions/*/ "$ROOT_DIR"/source/cms/backend/extensions/*/; do
  if [[ -d "$d" ]]; then INSTALLED_EXTENSIONS+=("$(basename "$d")"); fi
done
if [[ ${#INSTALLED_EXTENSIONS[@]} -gt 0 ]]; then
  # shellcheck disable=SC2207
  INSTALLED_EXTENSIONS=($(printf '%s\n' "${INSTALLED_EXTENSIONS[@]}" | sort -u))
fi
# extension_on ID: is ID in VOD_EXTENSIONS (as saved in .env)?
extension_on() { [[ ",$(env_get VOD_EXTENSIONS | tr -d '[:space:]')," == *",$1,"* ]]; }
EXT_STAGE_IDS=(); EXT_STAGE_FNS=(); EXT_STAGE_COUNTS=()
# register_extension_stages ID FUNCTION COUNT: run FUNCTION (COUNT stages) when extension ID is enabled.
register_extension_stages() { EXT_STAGE_IDS+=("$1"); EXT_STAGE_FNS+=("$2"); EXT_STAGE_COUNTS+=("$3"); }
for f in "$ROOT_DIR"/source/core/extensions/*/configure.sh; do
  # shellcheck source=/dev/null
  if [[ -f "$f" ]]; then source "$f"; fi
done
# TOTAL_STAGES: the base stages, the Extensions stage (when any are installed), and the enabled extensions' own.
count_stages() {
  TOTAL_STAGES=$BASE_STAGES
  if [[ ${#INSTALLED_EXTENSIONS[@]} -gt 0 ]]; then TOTAL_STAGES=$((TOTAL_STAGES + 1)); fi
  local i
  for ((i = 0; i < ${#EXT_STAGE_IDS[@]}; i++)); do
    if extension_on "${EXT_STAGE_IDS[$i]}"; then TOTAL_STAGES=$((TOTAL_STAGES + EXT_STAGE_COUNTS[i])); fi
  done
}
count_stages
NEXT=("deployment/deploy.sh                                  # core stack")   # manual deploy commands

STAGE_NAMES="Basics → Notifications and storage → Delivery → Overlays"
if [[ ${#INSTALLED_EXTENSIONS[@]} -gt 0 ]]; then STAGE_NAMES="$STAGE_NAMES → Extensions"; fi
if [[ "$FRESH_ENV" == true ]]; then ENV_STATE="new, created from .env.example"; else ENV_STATE="existing, saved values are offered"; fi
banner "Video on Demand on AWS · configure" \
  "Choose your deploy settings. They are saved to one .env file that every stack and script reads; nothing is deployed yet." \
  "Writes|$(_tilde "$ENV_FILE") ($ENV_STATE)" \
  "Stages|$TOTAL_STAGES: $STAGE_NAMES → Review" \
  "Next|scripts/deploy-wizard.sh deploys what you chose"

# ── 1. Basics ────────────────────────────────────────────────────────────────────────────────
stage "Basics: AWS access, notification email, stack name, Region, CMS"
# AWS access first: deploying needs working credentials with enough permissions, so say so before any questions.
aws_access_help() {
  say "${BOLD}Sign in from another terminal, then choose Retry:${RESET}"
  step "aws login                        # AWS CLI 2.32+: sign in with your console credentials"
  step "aws sso login${AWS_PROFILE:+ --profile $AWS_PROFILE}                    # IAM Identity Center (first time: aws configure sso)"
  say ""
  say "${BOLD}Or quit, set credentials in this shell, and re-run:${RESET}"
  step "export AWS_PROFILE=NAME          # a profile from ~/.aws/config"
  note "  or export AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN."
  say ""
}
aws_permissions_note() {
  note "Deploying needs permission to bootstrap CDK (once per account and Region) and to create CloudFormation,"
  note "IAM, S3, Step Functions, MediaConvert, CloudFront, DynamoDB, SNS and SSM resources: use an administrator"
  note "role in a non-production account, or one that can assume the CDK bootstrap roles (cdk-hnb659fds-*)."
}
while :; do
  CALLER="" ACCOUNT=""
  if ! command -v aws >/dev/null 2>&1; then
    warn "The AWS CLI isn't installed (needed to deploy)."
    note "Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    say ""
  elif IDENT=$(aws sts get-caller-identity --query '[Account,Arn]' --output text 2>/dev/null) && [[ -n "$IDENT" ]]; then
    ACCOUNT="${IDENT%%[[:space:]]*}"; CALLER="${IDENT##*[[:space:]]}"
  else
    warn "No working AWS credentials${AWS_PROFILE:+ for profile $AWS_PROFILE} (aws sts get-caller-identity failed)."
    say ""
    aws_access_help
  fi
  if [[ -n "$CALLER" ]]; then
    printf '  %s✓%s AWS account %s%s%s
' "$GREEN" "$RESET" "$BOLD" "$ACCOUNT" "$RESET"
    note "  as $CALLER${AWS_PROFILE:+ (profile $AWS_PROFILE)}"
    case "$CALLER" in *ReadOnly*|*readonly*|*ViewOnly*) warn "This looks like a read-only role: it can't deploy. Sign in with a deploy role before scripts/deploy-wizard.sh.";; esac
    aws_permissions_note
    break
  fi
  aws_permissions_note
  say ""
  _menu AWS_NEXT "AWS access" "" retry \
    "retry|I've signed in: check again" \
    "continue|configure now, sign in before deploying" \
    "quit|stop here"
  case "$AWS_NEXT" in
    retry) say "" ;;
    continue) SKIPPED+=("sign in to AWS (aws login) before scripts/deploy-wizard.sh"); break ;;
    *) exit 1 ;;
  esac
done
say ""
say "Workflow notifications (asset complete or failed) are emailed here through Amazon SNS. At deploy, AWS"
say "sends this address a subscription confirmation: click its link to start receiving them."
say ""
ask_value --validate v_email EMAIL "Notification email"
write_env EMAIL "$EMAIL"
ask_value --validate v_stack_name STACK_NAME "Core stack name (module stacks derive their names from it)" "VideoOnDemand"
write_env STACK_NAME "$STACK_NAME"
say ""
REGION_DEFAULT="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
[[ -n "$REGION_DEFAULT" ]] || REGION_DEFAULT=$(aws configure get region 2>/dev/null || true)
[[ -n "$REGION_DEFAULT" ]] || REGION_DEFAULT=us-east-1
choose --validate v_region AWS_REGION "AWS Region" "$REGION_DEFAULT" \
  "us-east-1|US East (N. Virginia) - higher MediaConvert job concurrency" \
  "us-west-2|US West (Oregon) - higher MediaConvert job concurrency" \
  "eu-west-1|Europe (Ireland) - higher MediaConvert job concurrency" \
  "us-east-2|US East (Ohio)" \
  "eu-central-1|Europe (Frankfurt)" \
  "eu-west-2|Europe (London)" \
  "ap-northeast-1|Asia Pacific (Tokyo)" \
  "ap-southeast-2|Asia Pacific (Sydney)" \
  "ap-south-1|Asia Pacific (Mumbai)" \
  "ca-central-1|Canada (Central)" \
  "sa-east-1|South America (São Paulo)" \
  "__other__|type a Region code"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
say ""
note "The operator web app (CMS) is a separate stack: browser upload, asset status and playback, behind a Cognito"
note "login. scripts/deploy-wizard.sh deploys it after the core stack and emails $EMAIL a temporary password."
true_false DEPLOY_CMS "Also deploy the operator web app (CMS)?" false

# ── 2. Notifications and storage ─────────────────────────────────────────────────────────────
stage "Notifications and storage"
true_false ENABLE_SNS "Email success/failure notifications (SNS)?" true
say ""
choose ARCHIVE_SOURCE "Archive source files after publish" NONE \
  "NONE|keep sources in S3 Standard" \
  "GLACIER|Glacier Flexible Retrieval: lower cost, minutes-to-hours restore" \
  "DEEP_ARCHIVE|Glacier Deep Archive: lowest cost, up to 12 h restore"
say ""
ask_value --optional --validate v_pos_int DESTINATION_RETENTION_DAYS "Delete transcoded outputs after N days (blank keeps them forever)"
write_env DESTINATION_RETENTION_DAYS "$DESTINATION_RETENTION_DAYS"

# ── 3. Delivery ──────────────────────────────────────────────────────────────────────────────
stage "Delivery (CloudFront) and viewer access"
choose PRICE_CLASS "CloudFront price class (which edge locations serve viewers)" PriceClass_All \
  "PriceClass_100|North America and Europe: lowest cost" \
  "PriceClass_200|+ Asia, Middle East and Africa" \
  "PriceClass_All|all edge locations: best latency worldwide"
say ""
# Viewer access: one choice, so countries are asked once (CloudFront geo restriction OR the WAF allow-list).
ACCESS_CUR=public
if [[ -n "$(env_get WAF_ALLOWED_COUNTRIES)$(env_get WAF_ALLOWED_IPS)" ]] && has_module waf; then ACCESS_CUR=waf
elif [[ -n "$(env_get WAF_WEB_ACL_ARN)" ]]; then ACCESS_CUR=arn
elif [[ -n "$(env_get GEO_RESTRICTION)" ]]; then ACCESS_CUR=geo; fi
ACCESS_OPTS=("public|anyone with a playback URL" "geo|only listed countries (CloudFront geo restriction, no extra stack)")
if has_module waf; then
  ACCESS_OPTS+=("waf|only listed countries and/or IPv4 ranges (WAF allow-list, a separate us-east-1 stack)")
fi
ACCESS_OPTS+=("arn|attach a WAF WebACL you already have (CLOUDFRONT scope)")
_menu ACCESS "Restrict who can watch?" "$ACCESS_CUR" public "${ACCESS_OPTS[@]}"
clear_waf_lists() { write_env WAF_ALLOWED_COUNTRIES ""; write_env WAF_ALLOWED_IPS ""; write_env WAF_ALLOW_MANIFESTS ""; write_env WAF_ALLOW_PATH_PREFIXES ""; }
ask_geo() {
  ask_value "$@" --validate v_country_list GEO_RESTRICTION "Only serve viewers in these countries (ISO codes, e.g. US,CA)"
  write_env GEO_RESTRICTION "$(printf '%s' "$GEO_RESTRICTION" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
}
# Leaving the WAF allow-list: drop the WebACL ARN the deploy wizard saved, or the next core deploy keeps it attached.
if [[ "$ACCESS_CUR" == waf && "$ACCESS" != waf ]]; then
  clear_waf_lists; write_env WAF_WEB_ACL_ARN ""
  note "WAF allow-list removed: the next core deploy detaches it (delete the <stack>-waf stack in us-east-1 yourself)."
fi
case "$ACCESS" in
  public)
    write_env GEO_RESTRICTION ""; write_env WAF_WEB_ACL_ARN "" ;;
  geo)
    write_env WAF_WEB_ACL_ARN ""; ask_geo ;;
  waf)
    write_env GEO_RESTRICTION ""
    note "A default-block WebACL: only listed countries and/or IPs get through. Give at least one list."
    while :; do
      ask_value --optional --validate v_country_list WAF_ALLOWED_COUNTRIES "Allowed viewer countries (ISO codes, e.g. US,CA,GB)"
      WAF_ALLOWED_COUNTRIES=$(printf '%s' "$WAF_ALLOWED_COUNTRIES" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')
      MY_IP=""
      if [[ -z "$(env_get WAF_ALLOWED_IPS)" ]]; then
        MY_IP=$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
        [[ -n "$MY_IP" ]] && note "Default below is your current public IP (from checkip.amazonaws.com)."
      fi
      ask_value --optional --validate v_cidr_list WAF_ALLOWED_IPS "Allowed IPv4 CIDRs (comma-separated)" "${MY_IP:+$MY_IP/32}"
      WAF_ALLOWED_IPS=$(printf '%s' "$WAF_ALLOWED_IPS" | tr -d '[:space:]')
      [[ -n "$WAF_ALLOWED_COUNTRIES$WAF_ALLOWED_IPS" ]] && break
      warn "At least one list is required (an empty allow-list blocks every viewer)."
      if confirm "Skip the WAF allow-list instead (anyone can watch)?"; then ACCESS=public; break; fi
    done
    if [[ "$ACCESS" == public ]]; then clear_waf_lists; write_env WAF_WEB_ACL_ARN ""; else
    write_env WAF_ALLOWED_COUNTRIES "$WAF_ALLOWED_COUNTRIES"; write_env WAF_ALLOWED_IPS "$WAF_ALLOWED_IPS"
    if has_module ssai; then
      # MediaTailor fetches manifests + ad creatives from AWS addresses: allow those, keep segments/keys gated.
      note "With SSAI, MediaTailor must reach the manifests and /creatives/ (segments and keys stay gated)."
      SSAI_STATE=no; [[ "$(env_get WAF_ALLOW_MANIFESTS)" == ON ]] && SSAI_STATE=yes
      if confirm_state "Allow manifests and /creatives/ through the WAF for SSAI?" "$SSAI_STATE"; then
        write_env WAF_ALLOW_MANIFESTS ON; write_env WAF_ALLOW_PATH_PREFIXES /creatives/
      else
        write_env WAF_ALLOW_MANIFESTS OFF; write_env WAF_ALLOW_PATH_PREFIXES ""
      fi
    fi
    NEXT=("source/modules/waf/deploy.sh                          # WAF in us-east-1, then the core stack with its WebACL")
    fi ;;
  arn)
    clear_waf_lists
    ask_value --validate v_waf_arn WAF_WEB_ACL_ARN "WAF WebACL ARN (CLOUDFRONT scope, us-east-1)"
    write_env WAF_WEB_ACL_ARN "$WAF_WEB_ACL_ARN"
    ask_geo --optional ;;
esac
say ""
UPLOAD_STATE=no; [[ -n "$(env_get UPLOAD_CORS_ORIGINS)" ]] && UPLOAD_STATE=yes
if confirm_state "Allow browser uploads from other origins (upload CORS)?" "$UPLOAD_STATE"; then
  note "scripts/deploy-wizard.sh adds the CMS origin automatically; add others (e.g. local dev) here."
  ask_value --optional --validate v_cors_origins UPLOAD_CORS_ORIGINS "Browser origins allowed to upload ('*' or http(s)://host[:port], comma-separated)"
  write_env UPLOAD_CORS_ORIGINS "$(printf '%s' "$UPLOAD_CORS_ORIGINS" | tr -d '[:space:]')"
elif [[ "$UPLOAD_STATE" == yes ]]; then
  note "Kept the saved upload CORS origins unchanged."
fi

# ── 4. Overlays ──────────────────────────────────────────────────────────────────────────────
stage "Opt-in overlays (each leaves the default template unchanged when OFF)"
note "Docs: README.md (Configuration)."
if has_module ssai; then note "The SSAI module needs Multi-format packaging and SCTE-35 ad markers both ON."; fi
say ""
on_off PACKAGING_PROFILE "Multi-format packaging (HLS/TS + CMAF-HLS + DASH)?" OFF
on_off AD_MARKERS_PROFILE "SCTE-35 ad markers from <source>.esam.xml sidecars?" OFF
on_off CAPTIONS_PROFILE "WebVTT/IMSC captions from <source>.vtt sidecars?" OFF
on_off PER_FRAME_METRICS "Per-frame quality metrics (VMAF/QVBR/SHOT_CHANGE; adds encode time)?" OFF
on_off THUMBNAILS_PROFILE "Poster + thumbnails?" ON

# ── Extensions ───────────────────────────────────────────────────────────────────────────────
if [[ ${#INSTALLED_EXTENSIONS[@]} -gt 0 ]]; then
  stage "Extensions (installed in this tree)"
  note "Each enabled extension is turned on for every app (core stack + CMS) through VOD_EXTENSIONS in .env."
  say ""
  ENABLED=(); ans=""
  for id in "${INSTALLED_EXTENSIONS[@]}"; do
    if extension_on "$id"; then d=yes; t="(current)"; else d=no; t=""; fi
    _yesno ans "Enable the $id extension?" "$d" Yes No "$t"
    if [[ "$ans" == yes ]]; then ENABLED+=("$id"); fi
  done
  write_env VOD_EXTENSIONS "$(IFS=,; echo "${ENABLED[*]+"${ENABLED[*]}"}")"
  count_stages
fi
for ((i = 0; i < ${#EXT_STAGE_IDS[@]}; i++)); do
  if extension_on "${EXT_STAGE_IDS[$i]}"; then "${EXT_STAGE_FNS[$i]}"; fi
done


# ── Review ───────────────────────────────────────────────────────────────────────────────────
stage "Review and next step"
# row KEY [DEFAULT]: one line of the effective config (saved value, else the default).
row() {
  local v; v=$(env_get "$1")
  if [[ -n "$v" ]]; then printf '    %-28s %s\n' "$1" "$v"
  else printf '    %-28s %s%s%s\n' "$1" "$DIM" "${2:-(not set)}${2:+ (default)}" "$RESET"; fi
}
say "${BOLD}Basics${RESET}";   row EMAIL; row STACK_NAME VideoOnDemand; row AWS_REGION; row DEPLOY_CMS false
say "${BOLD}Workflow${RESET}"; row ENABLE_SNS true; row ENABLE_SQS false; row ARCHIVE_SOURCE NONE; row DESTINATION_RETENTION_DAYS "keep forever"
say "${BOLD}Delivery${RESET}"; row PRICE_CLASS PriceClass_All; row GEO_RESTRICTION "none"; row WAF_WEB_ACL_ARN "none"
if has_module waf; then row WAF_ALLOWED_COUNTRIES "none"; row WAF_ALLOWED_IPS "none"; fi
row UPLOAD_CORS_ORIGINS "none"
say "${BOLD}Overlays${RESET}"; row PACKAGING_PROFILE OFF; row AD_MARKERS_PROFILE OFF; row CAPTIONS_PROFILE OFF; row PER_FRAME_METRICS OFF; row THUMBNAILS_PROFILE ON
if [[ ${#INSTALLED_EXTENSIONS[@]} -gt 0 ]]; then say "${BOLD}Extensions${RESET}"; row VOD_EXTENSIONS "none"; fi
say ""
show_changes
(( ${#WRITTEN_SECRET[@]} )) && note "Secrets created/updated: ${WRITTEN_SECRET[*]}"
if (( ${#SKIPPED[@]} )); then warn "Still to do by hand:"; for s in "${SKIPPED[@]}"; do step "$s"; done; fi
say ""
_menu NEXT_STEP "What next?" "" deploy \
  "deploy|run scripts/deploy-wizard.sh now (guided deploy, confirms before each stack)" \
  "manual|show the individual deploy commands" \
  "exit|finish here (edit $(basename "$ENV_FILE") or re-run this wizard any time)"
case "$NEXT_STEP" in
  deploy) exec "$ROOT_DIR/scripts/deploy-wizard.sh" ;;
  manual)
    say ""
    say "Deploy in this order:"
    for c in "${NEXT[@]}"; do step "$c"; done
    if [[ "$(env_get DEPLOY_CMS)" == true ]]; then
      step "source/cms/scripts/deploy-all.sh vod-cms $(v=$(env_get CMS_ENVIRONMENT); echo "${v:-prod}")         # operator CMS (then create a Cognito user)"
    fi
    if has_module ssai; then
      note "Optional: source/modules/ssai/deploy.sh (needs PACKAGING_PROFILE + AD_MARKERS_PROFILE ON)"
    fi
    ;;
  *) note "Saved. When ready: scripts/deploy-wizard.sh" ;;
esac
