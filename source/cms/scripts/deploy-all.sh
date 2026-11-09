#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
#
# One-shot deploy for the operator web app (the "cms" module). It is a SINGLE stack named
# `<vodStackName>-cms` (e.g. VideoOnDemand-cms) that owns Cognito + the authenticated API +
# CloudFront/S3 hosting. Steps:
#   1) deploy the cms stack
#   2) write frontend/.env from its outputs
#   3) `vite build`, `aws s3 sync` the built SPA to the site bucket, invalidate CloudFront
#
# Prereqs: AWS creds in the environment, CDK bootstrapped in the target account
# (`npx cdk bootstrap`), Node 20+. The VOD stack must already be deployed (this reads its
# /<vodStackName>/ SSM discovery params).
#
# Usage: scripts/deploy-all.sh [appName] [environment] [region] [vodStackName]
# Defaults for region and vodStackName (STACK_NAME) come from the repo-root .env (or $VOD_ENV_FILE), the
# same deploy config every other script reads.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/deployment/lib/env.sh"
load_env_file "$(deploy_env_file "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)")"

APP_NAME="${1:-${APP_NAME:-vod-cms}}"
ENVIRONMENT="${2:-${ENVIRONMENT:-dev}}"
REGION="${3:-${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}}"
VOD_STACK_NAME="${4:-${VOD_STACK_NAME:-${STACK_NAME:-VideoOnDemand}}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Pin the region for BOTH the CDK app env (CDK_DEFAULT_REGION) and the CDK CLI / AWS SDK deploy
# target (AWS_REGION / AWS_DEFAULT_REGION). Without the latter two, an ambient AWS_REGION wins and the
# stack deploys to the wrong region.
export CDK_DEFAULT_REGION="$REGION" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
CTX=(-c "appName=${APP_NAME}" -c "environment=${ENVIRONMENT}" -c "vodStackName=${VOD_STACK_NAME}")
# Must match the core stack: ON creates the quality-metrics rescue Lambda that copies per-frame metrics
# out of the 1-day intermediate bucket.
CTX+=(-c "packagingProfile=${PACKAGING_PROFILE:-OFF}")
# Extensions enabled in .env VOD_EXTENSIONS (comma-separated; must be installed under backend/extensions/).
# Each may add its own deploy-time context from the same .env: its optional deploy-context.sh appends to CTX.
VOD_EXTENSIONS="$(printf '%s' "${VOD_EXTENSIONS:-}" | tr -d '[:space:]')"
if [ -n "$VOD_EXTENSIONS" ]; then
  CTX+=(-c "vodExtensions=${VOD_EXTENSIONS}")
  IFS=',' read -r -a EXT_IDS <<< "$VOD_EXTENSIONS"
  for ext_id in "${EXT_IDS[@]}"; do
    ext_ctx="$ROOT/backend/extensions/$ext_id/deploy-context.sh"
    if [ -f "$ext_ctx" ]; then . "$ext_ctx"; fi
  done
fi

CMS_STACK="${VOD_STACK_NAME}-cms"

# npm workspaces: one root install covers the backend, frontend and the shared source/contract package.
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
[ -d "$REPO_ROOT/node_modules" ] || (cd "$REPO_ROOT" && npm ci)

echo "==> [1/2] Deploying ${CMS_STACK} (Cognito + API + CloudFront/OAC) [app=${APP_NAME} env=${ENVIRONMENT} region=${REGION}]..."
( cd "$ROOT/backend" && npx cdk deploy "$CMS_STACK" "${CTX[@]}" --require-approval never )

echo "==> Reading stack outputs..."
die() { echo "error: $*" >&2; exit 1; }
out() {
  local val
  val="$(aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true)"
  [ -n "$val" ] || die "could not read output '$2' from stack '$1' in region $REGION — did the deploy above actually finish?"
  printf '%s' "$val"
}
SITE_BUCKET="$(out "$CMS_STACK" SiteBucketName)"
DIST_ID="$(out "$CMS_STACK" DistributionId)"
DIST_DOMAIN="$(out "$CMS_STACK" DistributionDomainName)"
SOURCE_BUCKET="$(aws ssm get-parameter --name "/${VOD_STACK_NAME}/SourceBucket" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo '')"
[ -n "$SOURCE_BUCKET" ] \
  || die "could not read /${VOD_STACK_NAME}/SourceBucket from SSM in region $REGION — is the VOD stack '${VOD_STACK_NAME}' deployed there?"

echo "==> Writing frontend/.env ..."
cat > "$ROOT/frontend/.env" <<EOF
VITE_COGNITO_USER_POOL_ID=$(out "$CMS_STACK" UserPoolId)
VITE_COGNITO_CLIENT_ID=$(out "$CMS_STACK" UserPoolClientId)
VITE_COGNITO_IDENTITY_POOL_ID=$(out "$CMS_STACK" IdentityPoolId)
VITE_COGNITO_REGION=$(out "$CMS_STACK" CognitoRegion)
VITE_API_URL=$(out "$CMS_STACK" ApiUrl)
VITE_UPLOAD_BUCKET=$SOURCE_BUCKET
VITE_UPLOAD_REGION=$REGION
EOF
echo "    wrote $ROOT/frontend/.env"

echo "==> [2/2] Building + publishing the frontend to s3://${SITE_BUCKET} ..."
( cd "$ROOT/frontend" && npm run build )
aws s3 sync "$ROOT/frontend/dist" "s3://${SITE_BUCKET}" --delete --region "$REGION"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null
echo "    published; CloudFront invalidation created."

cat <<EOF

==> Done. CMS URL:  https://${DIST_DOMAIN}

    Create an operator user (self sign-up is off):
      aws cognito-idp admin-create-user --user-pool-id $(out "$CMS_STACK" UserPoolId) --username alice \\
        --user-attributes Name=email,Value=alice@example.com Name=email_verified,Value=true --region $REGION

    Local dev against the deployed API is still available:  ( cd frontend && npm run dev )
EOF
