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
 * CDK app entrypoint for the VOD v7.0.0 stack.
 *
 * Reads + validates the deploy-time context (so `stackName` can be applied as the physical stack
 * name and so an invalid context fails synth fast), instantiates the {@link VideoOnDemand} stack
 * with the `DefaultStackSynthesizer` (bootstrap-version rule off, matching the packaged template),
 * and applies the cdk-nag `AwsSolutionsChecks` aspect app-wide.
 */

import 'source-map-support/register';
import * as dotenv from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { DefaultStackSynthesizer } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { deployEnvPath } from '@vod/contract';
import { VideoOnDemand } from '../lib/vod-stack';
import { parseVodContext, withEnvFallback } from '../lib/context';

// Deploy-time parameters live in the repo-root `.env` (see `.env.example`), shared by every app in
// the solution, so they need not be passed as long `-c key=value` command lines. dotenv does not
// override already-set vars, and explicit `-c` / cdk.json context still wins (see `withEnvFallback`).
const envFile = deployEnvPath(__dirname);
if (envFile) {
  dotenv.config({ path: envFile });
}

// AWS Solutions Constructs prints an AWS_SOLUTIONS_CONSTRUCTS_WARNING for every default it thinks a prop
// overrides. The CloudFrontToS3 props in constructs/delivery.ts are deliberate, and its lifecycle defaults
// trip a false "Possible override of transitionAfter value" dozens of times per synth. Silence them with the
// library's own switch; `overrideWarningsEnabled=true` in the environment (or .env) shows them again.
if (!process.env.overrideWarningsEnabled) process.env.overrideWarningsEnabled = 'false';

const app = new cdk.App();

// Validate context up front; `stackName` (optional) becomes the physical CloudFormation stack name.
// `withEnvFallback` sources any unset context key from the matching UPPER_SNAKE `.env` var.
const context = parseVodContext(withEnvFallback(app.node));

new VideoOnDemand(app, 'VideoOnDemand', { // NOSONAR
  stackName: context.stackName,
  synthesizer: new DefaultStackSynthesizer({
    generateBootstrapVersionRule: false,
  }),
}); // NOSONAR

// cdk-nag
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
