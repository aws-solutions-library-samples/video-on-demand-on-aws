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
 * StreamingMediaWafStack — the separate us-east-1 stack of the streaming-media WAF module.
 *
 * A CLOUDFRONT-scope WAFv2 WebACL can only be created in us-east-1, so this stack is env-bound to
 * us-east-1 (see `bin/waf.ts`) and kept OUT of the core VOD stack. It owns the {@link WafConstruct}
 * (WebACL + optional IP set) and emits the WebACL ARN as a `CfnOutput` (`WebAclArn`). The operator
 * feeds that ARN into the core stack's `wafWebAclArn` context — a two-step deploy driven by
 * `deploy.sh` — which keeps the core stack 0-Lambda (a CDK cross-region reference
 * would inject a Lambda-backed custom resource into the consuming stack).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { WafContext } from './context';
import { WafConstruct } from './waf';

/** AWS Solutions Library Guidance identifier (matches the main VOD stack tag). */
const SOLUTION_ID = 'SO9674';

export interface StreamingMediaWafStackProps extends cdk.StackProps {
  /** Validated module context (at least one allow-list). */
  readonly context: WafContext;
}

export class StreamingMediaWafStack extends cdk.Stack {
  public readonly waf: WafConstruct;

  constructor(scope: Construct, id: string, props: StreamingMediaWafStackProps) {
    super(scope, id, props);

    this.templateOptions.description =
      `(${SOLUTION_ID}) Video on Demand on AWS - streaming-media WAF WebACL (CloudFront geo + IP allow-list). ` +
      'Deploy in us-east-1 and associate its WebAclArn output with the delivery distribution via wafWebAclArn.';
    cdk.Tags.of(this).add('SolutionId', SOLUTION_ID);

    this.waf = new WafConstruct(this, 'Waf', { context: props.context });

    new cdk.CfnOutput(this, 'WebAclArn', {
      description:
        'CLOUDFRONT-scope WebACL ARN. Pass this to the main VOD stack as -c wafWebAclArn=<arn> (or WAF_WEB_ACL_ARN).',
      value: this.waf.webAclArn,
    });
  }
}
