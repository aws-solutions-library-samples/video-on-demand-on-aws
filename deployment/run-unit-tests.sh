#!/bin/bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#

[ "$DEBUG" == 'true' ] && set -x
set -e

prepare_jest_coverage_report() {
  local component_name=$1

  if [ ! -d "coverage" ]; then
      echo "ValidationError: Missing required directory coverage after running unit tests"
      exit 129
  fi

  # prepare coverage reports
  rm -fr coverage/lcov-report
  mkdir -p "$coverage_reports_top_path/jest"
  coverage_report_path="$coverage_reports_top_path/jest/$component_name"
  rm -fr "$coverage_report_path"
  mkdir -p "$(dirname "$coverage_report_path")"
  mv coverage "$coverage_report_path"
}

run_javascript_test() {
  local component_path=$1
  local component_name=$2

  echo "------------------------------------------------------------------------------"
  echo "[Test] Run javascript unit test with coverage for $component_name"
  echo "------------------------------------------------------------------------------"
  echo "cd $component_path"
  cd "$component_path"

  # run unit tests (dependencies are installed once for all npm workspaces, below)
  npm test

  # prepare coverage reports
  prepare_jest_coverage_report "$component_name"
}

# Get reference for all important folders
template_dir="$PWD"
source_dir="$template_dir/../source"
coverage_reports_top_path="$template_dir/coverage-reports"

# The core packages are npm workspaces sharing one root lockfile: install + build once, then test each.
(cd "$source_dir/.." && npm ci && npm run build)

# Workspace paths under source/, in dependency order.
declare -a packages=(
  "contract"
  "core"
)

# Companion modules, when present, are a separate workspaces root (source/modules) with its own lockfile.
if [ -f "$source_dir/modules/package.json" ]; then
  (cd "$source_dir/modules" && npm ci && npm run build)
  for module in drm waf ssai; do
    if [ -d "$source_dir/modules/$module" ]; then packages+=("modules/$module"); fi
  done
fi

for package in "${packages[@]}"
do
  rm -rf "$source_dir/$package/coverage"
  mkdir "$source_dir/$package/coverage"
  run_javascript_test "$source_dir/$package" $package

  # Check the result of the test and exit if a failure is identified
  if [ $? -eq 0 ]
  then
    echo "Test for $package passed"
  else
    echo "******************************************************************************"
    echo "Test FAILED for $package"
    echo "******************************************************************************"
    exit 1
  fi

done
