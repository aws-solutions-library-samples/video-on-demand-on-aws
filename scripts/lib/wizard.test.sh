#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Smoke test for scripts/lib/wizard.sh and scripts/configure.sh, driven through the numbered (plain) menus
# with piped answers. Runs configure.sh from a temporary copy of the public tree (no extensions or modules)
# with a stub `aws`, so it touches no AWS account. Usage: scripts/lib/wizard.test.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d -t vod-wizard-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

echo "wizard library"
if (
  set -euo pipefail
  # shellcheck source=SCRIPTDIR/wizard.sh
  source "$REPO/scripts/lib/wizard.sh"
  ENV_FILE="$TMP/lib.env"
  printf '# Header\n# What A is.\nA=1\n# What B is.\n# B=\nC=3\n' > "$ENV_FILE"
  orig=$(cat "$ENV_FILE")
  write_env A 1 >/dev/null
  [[ "$(cat "$ENV_FILE")" == "$orig" ]] || { echo "unchanged write rewrote the file"; exit 1; }
  (( ${#CHANGED[@]} == 0 )) || { echo "unchanged write recorded a change"; exit 1; }
  write_env B two >/dev/null
  [[ "$(sed -n 5p "$ENV_FILE")" == "B=two" ]] || { echo "placeholder not un-commented in place"; exit 1; }
  write_env A "" >/dev/null
  grep -q '^A=' "$ENV_FILE" && { echo "clear left an active line"; exit 1; }
  grep -q '^# A=$' "$ENV_FILE" || { echo "clear did not comment the key out"; exit 1; }
  write_env D 'x\y&z' >/dev/null
  [[ "$(env_get D)" == 'x\y&z' ]] || { echo "special characters mangled"; exit 1; }
  v_email ops@test.dev >/dev/null && ! v_email you@example.com >/dev/null || { echo "v_email"; exit 1; }
  v_cidr_list "203.0.113.0/24, 10.0.0.1/32" >/dev/null && ! v_cidr_list "300.1.1.1/24" >/dev/null || { echo "v_cidr_list"; exit 1; }
  v_country_list "us,CA" >/dev/null && ! v_country_list "USA" >/dev/null || { echo "v_country_list"; exit 1; }
  v_waf_arn "arn:aws:wafv2:us-east-1:123456789012:global/webacl/a/b" >/dev/null && ! v_waf_arn "arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/a/b" >/dev/null || { echo "v_waf_arn"; exit 1; }
  v_cors_origins "*,http://localhost:5174" >/dev/null && ! v_cors_origins "https://a.com/path" >/dev/null || { echo "v_cors_origins"; exit 1; }
); then pass "write_env edits in place, clears, no-ops; validators"; else fail "write_env / validators"; fi

# A copy of the public tree: configure.sh + the library + .env.example only.
ROOT="$TMP/tree"; mkdir -p "$ROOT/scripts/lib" "$TMP/bin"
cp "$REPO/scripts/configure.sh" "$ROOT/scripts/"; cp "$REPO/scripts/lib/wizard.sh" "$ROOT/scripts/lib/"
cp "$REPO/.env.example" "$ROOT/"
# Stub aws: `sts get-caller-identity` succeeds unless STUB_NO_CREDS=1; everything else fails (no Region config).
cat > "$TMP/bin/aws" <<'STUB'
#!/bin/sh
if [ "$1" = sts ] && [ -z "$STUB_NO_CREDS" ]; then printf '123456789012\tarn:aws:sts::123456789012:assumed-role/Deployer/test\n'; exit 0; fi
exit 255
STUB
chmod +x "$TMP/bin/aws"
# run_configure: configure.sh in plain mode, killed by SIGALRM (exit 142) if it hangs (macOS has no `timeout`).
run_configure() {
  env -u AWS_REGION -u AWS_DEFAULT_REGION -u VOD_ENV_FILE PATH="$TMP/bin:$PATH" VOD_WIZARD_PLAIN=1 \
    perl -e 'alarm shift; exec @ARGV' 20 bash "$ROOT/scripts/configure.sh"
}

echo "configure.sh"
# First run. Stage 1: banner, placeholder email rejected, bad email, real email, stack, Region, pause.
# Stage 2: SNS, archive, retention (bad then 30), pause. Stage 3: price class, advanced=yes, geo, bad WAF
# ARN then skip, CORS, pause. Stage 4: five overlays (captions on), pause. Review: 3 = exit.
FIRST=$'\nyou@example.com\nnot-an-email\nops@test.dev\n\n\ny\n\n\n\nabc\n30\n\n2\ny\nus,ca\nbad-arn\n\n\n\n\n\ny\n\n\n\n3\n'
out=$(printf '%s' "$FIRST" | run_configure 2>&1) || { fail "first run exited non-zero"; printf '%s\n' "$out" | tail -20; }
E="$ROOT/.env"
check "placeholder email rejected"        "grep -q \"example address\" <<<\"\$out\""
check "example placeholder not warned"    "! grep -q \"saved EMAIL\" <<<\"\$out\""
check "EMAIL saved in place"              "grep -q '^EMAIL=ops@test.dev$' '$E' && [[ \$(grep -n '^EMAIL=' '$E' | cut -d: -f1) -lt 15 ]]"
check "Region defaults to us-east-1"      "grep -q '^AWS_REGION=us-east-1$' '$E'"
check "retention re-prompts, then saved"  "grep -q 'positive whole number' <<<\"\$out\" && grep -q '^DESTINATION_RETENTION_DAYS=30$' '$E'"
check "price class picked from menu"      "grep -q '^PRICE_CLASS=PriceClass_200$' '$E'"
check "geo codes normalised"              "grep -q '^GEO_RESTRICTION=US,CA$' '$E'"
check "bad WAF ARN rejected, not written" "grep -q 'WebACL ARN (arn' <<<\"\$out\" && ! grep -q '^WAF_WEB_ACL_ARN=' '$E'"
check "captions ON, others unchanged"     "grep -q '^CAPTIONS_PROFILE=ON$' '$E' && grep -q '^THUMBNAILS_PROFILE=ON$' '$E' && grep -q '^PACKAGING_PROFILE=OFF$' '$E'"
check "no blank KEY= lines written"       "! grep -qE '^[A-Z_]+=$' '$E'"
check "ENABLE_SQS not asked"              "! grep -q 'SQS queue' <<<\"\$out\""
check "CMS choice saved"                  "grep -q '^DEPLOY_CMS=true$' '$E'"
check "AWS account checked first"         "grep -q 'AWS account 123456789012' <<<\"\$out\""
cp "$E" "$TMP/after-first.env" 2>/dev/null || true

# Re-run pressing Enter everywhere (advanced options now default to yes: geo, WAF ARN, CORS).
RERUN=$'\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n3\n'
out=$(printf '%s' "$RERUN" | run_configure 2>&1) || { fail "re-run exited non-zero"; printf '%s\n' "$out" | tail -20; }
check "Enter-only re-run leaves .env byte-identical" "cmp -s '$E' '$TMP/after-first.env'"
check "re-run reports no changes"         "grep -q 'No changes' <<<\"\$out\""
check "prompts show the current value"    "grep -q 'current: ops@test.dev' <<<\"\$out\" && grep -q '(current)' <<<\"\$out\""

# "-" clears an optional value: retention cleared on stage 2.
CLEAR=$'\n\n\n\n\n\n\n\n-\n\n\n\n\n\n\n\n\n\n\n\n\n\n3\n'
out=$(printf '%s' "$CLEAR" | run_configure 2>&1) || { fail "clear run exited non-zero"; printf '%s\n' "$out" | tail -20; }
check "'-' clears an optional value"      "! grep -q '^DESTINATION_RETENTION_DAYS=' '$E' && grep -q 'DESTINATION_RETENTION_DAYS .*30.* → (unset)' <<<\"\$out\""

# Closed stdin aborts instead of looping.
rm -f "$E"
# No credentials: sign-in instructions, then 3 = quit (non-zero, before any question).
if out=$(printf '\n3\n' | STUB_NO_CREDS=1 run_configure 2>&1); then fail "no-creds quit should exit non-zero"; fi
check "no creds: sign-in help, then quit"  "grep -q 'aws login' <<<\"\$out\" && grep -q 'cdk-hnb659fds' <<<\"\$out\" && ! grep -q 'Notification email' <<<\"\$out\""
if printf '\n' | run_configure >/dev/null 2>&1; then fail "closed stdin should fail"
else rc=$?; check "closed stdin aborts (no hang)" "[[ $rc -ne 142 ]]"; fi

echo
if (( FAILS )); then echo "$FAILS check(s) failed"; exit 1; fi
echo "all checks passed"
