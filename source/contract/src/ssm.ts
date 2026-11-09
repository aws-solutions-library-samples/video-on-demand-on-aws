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
 * SSM Parameter Store discovery contract between the core VideoOnDemand stack and its companion
 * stacks (modules and the CMS). CloudFormation outputs are not readable across independently
 * deployed stacks, so every cross-stack value is published as a String parameter under the core
 * stack's namespace: `/<vodStackName>/<Key>`. Producers and consumers import the keys from here
 * instead of repeating string literals.
 */

/** Every discovery key, by the stack that publishes it. */
export const SsmKey = {
  // Published by the core stack (always).
  DynamoDBTable: 'DynamoDBTable',
  SourceBucket: 'SourceBucket',
  DestinationBucket: 'DestinationBucket',
  CloudFrontDomainName: 'CloudFrontDomainName',
  OrchestratorStateMachineArn: 'OrchestratorStateMachineArn',
  // Published by the core stack only when packagingProfile=ON.
  IntermediateBucket: 'IntermediateBucket',
  // Published by the SSAI (MediaTailor) module stack.
  SsaiHlsManifestEndpointPrefix: 'SsaiHlsManifestEndpointPrefix',
} as const;

export type SsmKey = (typeof SsmKey)[keyof typeof SsmKey];

/** Default core stack name, used when `stackName` / `vodStackName` context is not set. */
export const DEFAULT_VOD_STACK_NAME = 'VideoOnDemand';

/**
 * The full parameter name for a discovery key. `vodStackName` may be a CDK token (the core stack
 * publishes under `${AWS::StackName}`). Extensions and modules may publish their own keys under the same
 * namespace (any string key).
 */
export function ssmParameterName(vodStackName: string, key: SsmKey | string): string {
  return `/${vodStackName}/${key}`;
}
