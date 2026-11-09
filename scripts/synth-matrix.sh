#!/bin/bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Synthesizes a CDK app across a fixed matrix of context combinations and writes every stack
# template to <out-dir>/<combo>/. Used to prove refactors leave the synthesized artifacts
# byte-identical: run before and after a change, then `diff -r` the two output dirs.
#
# VOD_ENV_FILE=none stops the apps loading the repo-root `.env`, so only the explicit `-c` values below
# are in effect.
#
# Usage: scripts/synth-matrix.sh <app-dir> <out-dir>
#   e.g. scripts/synth-matrix.sh source/core /tmp/golden
#        scripts/synth-matrix.sh source/modules/waf /tmp/golden

set -euo pipefail

APP_DIR="$(cd "${1:?app dir required}" && pwd)"
OUT_DIR="${2:?out dir required}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# Stage the copy next to the app (inside the repo) so Node's upward node_modules lookup still reaches
# the npm-workspaces root; the app's own (partial) node_modules, if any, is symlinked in.
WORK="$(mktemp -d "$(dirname "$APP_DIR")/.synth-matrix.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
rsync -a --exclude node_modules --exclude cdk.out --exclude coverage \
  --exclude '*.js' --exclude '*.d.ts' "$APP_DIR/" "$WORK/app/"
if [ -d "$APP_DIR/node_modules" ]; then ln -s "$APP_DIR/node_modules" "$WORK/app/node_modules"; fi

# Never load a deploy-config .env (the repo-root one would otherwise be found by every app).
export VOD_ENV_FILE=none
export CDK_DEFAULT_ACCOUNT=123456789012
export CDK_DEFAULT_REGION=us-east-1

# Context matrix per app (selected by the app directory name).
case "$(basename "$APP_DIR")" in
  core)
    declare -a COMBOS=(
      "ga|"
      "thumbnails-off|-c thumbnailsProfile=OFF"
      "packaging|-c packagingProfile=ON"
      "captions-admarkers-packaging|-c captionsProfile=ON -c adMarkersProfile=ON -c packagingProfile=ON"
      "metrics|-c perFrameMetrics=ON"
      "waf-assoc|-c wafWebAclArn=arn:aws:wafv2:us-east-1:123456789012:global/webacl/vod/abc123"
      "all|-c packagingProfile=ON -c captionsProfile=ON -c adMarkersProfile=ON -c perFrameMetrics=ON"
    ) ;;
  waf)
    declare -a COMBOS=(
      "waf-stack|-c wafAllowedCountries=US,CA -c wafAllowedIps=203.0.113.0/24"
    ) ;;
  ssai)
    declare -a COMBOS=(
      "ssai-stack|"
    ) ;;
  backend)  # source/cms/backend
    declare -a COMBOS=(
      "cms|"
      "cms-packaging|-c packagingProfile=ON"
    ) ;;
  *)
    # An app may ship its own matrix instead (same "name|context" lines, see below).
    declare -a COMBOS=()
    [ -f "$APP_DIR/synth-matrix.txt" ] || { echo "no context matrix defined for $(basename "$APP_DIR")" >&2; exit 1; } ;;
esac

# App-provided combos: <app>/synth-matrix.txt (blank lines and # comments skipped).
if [ -f "$APP_DIR/synth-matrix.txt" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    COMBOS+=("$line")
  done < "$APP_DIR/synth-matrix.txt"
fi

# Installed extensions add their own combos: one "name|-c key=value ..." line per combo (blank lines and
# # comments skipped) in <app>/extensions/<name>/synth-matrix.txt.
for f in "$APP_DIR"/extensions/*/synth-matrix.txt; do
  [ -f "$f" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    COMBOS+=("$line")
  done < "$f"
done

cd "$WORK/app"
for entry in "${COMBOS[@]}"; do
  name="${entry%%|*}"
  ctx="${entry#*|}"
  rm -rf cdk.out
  # shellcheck disable=SC2086
  if ! npx cdk synth -q -c email=ci@example.com $ctx > "$WORK/$name.log" 2>&1; then
    echo "SYNTH FAILED: $name" >&2
    tail -n 30 "$WORK/$name.log" >&2
    exit 1
  fi
  mkdir -p "$OUT_DIR/$name"
  cp cdk.out/*.template.json "$OUT_DIR/$name/"
  # The SSAI example ADS shared secret is random per synth (constructs/mediatailor.ts); mask it so
  # template diffs stay meaningful.
  sed -i.bak -E 's/(ADS_SHARED_SECRET": "|&key=)[0-9a-f]{32}/\1<masked>/g' "$OUT_DIR/$name/"*.template.json
  rm -f "$OUT_DIR/$name/"*.bak
  echo "ok  $name ($(ls cdk.out/*.template.json | wc -l | tr -d ' ') template(s))"
done
