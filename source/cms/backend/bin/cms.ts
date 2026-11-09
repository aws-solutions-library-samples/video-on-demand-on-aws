#!/usr/bin/env node
/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                                *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at http://www.apache.org/licenses/LICENSE-2.0                  *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * VOD operator web app (optional COMPANION stack, the "cms" module), deployed as a SINGLE
 * stack named `<vodStackName>-cms` (e.g. `VideoOnDemand-cms`) — a suffix of the parent VOD stack.
 *
 * This is NOT part of the GA transcoding stack (`source/core`). It stands up Cognito auth, an
 * authenticated API that reads the VOD stack's SSM discovery params + DynamoDB job table, and
 * CloudFront/S3 hosting for the SPA. Because it is a separate app, a Lambda-backed API here does not
 * affect the GA 0-Lambda / cdk-nag zero-findings invariants — this companion carries its own posture.
 *
 * Deploy-time context (all optional):
 *   -c vodStackName=VideoOnDemand    the VOD stack whose /<name>/ SSM params to read; also the
 *                                    cms stack name prefix -> `<vodStackName>-cms` (default "VideoOnDemand")
 *   -c appName=vod-cms               resource name prefix (default "vod-cms")
 *   -c environment=dev|staging|prod  removal policy (prod => RETAIN)  (default "dev")
 *   -c packagingProfile=OFF|ON       MUST match the VOD stack's own packagingProfile (default: PACKAGING_PROFILE, else "OFF").
 *                                    ON wires the Quality-metrics rescue Lambda + EventBridge
 *                                    rule + the `/${vodStackName}/IntermediateBucket` SSM read. This is
 *                                    a synth-time flag (not an auto-detected lookup) because a
 *                                    CloudFormation cross-stack SSM reference — either
 *                                    `valueForStringParameter` or `valueFromLookup` — hard-fails
 *                                    synth/deploy if the parameter doesn't exist, which it won't when
 *                                    the VOD stack's packagingProfile is OFF (no intermediate bucket).
 *
 * Extensions under `backend/extensions/` (see lib/extensions.ts) read their own context keys.
 */
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DEFAULT_VOD_STACK_NAME, withEnvFallback } from '@vod/contract';
import { CmsStack } from '../lib/cms-stack';

const app = new cdk.App();

const appName = (app.node.tryGetContext('appName') as string) ?? 'vod-cms';
const environment = (app.node.tryGetContext('environment') as string) ?? 'dev';
const vodStackName = (app.node.tryGetContext('vodStackName') as string) ?? DEFAULT_VOD_STACK_NAME;
// Falls back to PACKAGING_PROFILE (scripts/deploy-all.sh loads the repo-root .env) so it matches the core stack.
const packagingProfile = ((withEnvFallback(app.node).tryGetContext('packagingProfile') as string) ?? 'OFF') === 'ON' ? 'ON' : 'OFF';

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

new CmsStack(app, `${vodStackName}-cms`, {
  env,
  appName,
  environment,
  vodStackName,
  packagingProfile,
});

// This companion app manages its own security posture (documented prototype suppressions live in
// the stack). It is intentionally independent of the VOD stack's zero-findings gate.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
