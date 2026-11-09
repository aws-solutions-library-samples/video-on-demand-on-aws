#!/usr/bin/env node
/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/


/**
 * CDK app entry point for the streaming-media WAF module: one us-east-1 stack
 * (`StreamingMediaWaf`, or `<stackName>-waf`) holding a CLOUDFRONT-scope WAFv2 WebACL. Deploy it,
 * then pass its `WebAclArn` output to the core stack as `wafWebAclArn` (see `deploy.sh`).
 */

import 'source-map-support/register';
import * as dotenv from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { DefaultStackSynthesizer } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { deployEnvPath, withEnvFallback } from '@vod/contract';
import { parseWafContext } from '../lib/context';
import { StreamingMediaWafStack } from '../lib/waf-stack';

// The solution's deploy config is the repo-root `.env`; explicit `-c` context still wins.
const envFile = deployEnvPath(__dirname);
if (envFile) {
  dotenv.config({ path: envFile });
}

const app = new cdk.App();
const context = parseWafContext(withEnvFallback(app.node));

// CloudFront-scope WAF must live in us-east-1; an env-bound stack needs a resolvable account.
new StreamingMediaWafStack(app, 'StreamingMediaWaf', {
  stackName: context.stackName ? `${context.stackName}-waf` : undefined,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  synthesizer: new DefaultStackSynthesizer({
    generateBootstrapVersionRule: false,
  }),
  context,
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
