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
 * VideoOnDemand — the VOD v7.0.0 GA stack orchestrator.
 *
 * This is a thin orchestrator. All resources live in the five constructs under `lib/constructs/`,
 * each coded against its `I*Construct` interface in `lib/constructs/interfaces.ts`. The stack:
 *
 *   1. Parses + validates the deploy-time CDK context (`lib/context.ts`), which throws so
 *      `cdk synth` fails fast (replacing the removed `input-validate` Lambda's runtime validation).
 *   2. Instantiates the constructs in dependency order (leaf -> root):
 *        Storage -> Notifications -> Delivery -> MediaConvert -> Workflow.
 *      Each downstream construct receives the upstream constructs (typed by interface) so the
 *      Workflow construct can read `table.tableName`, `topic.topicArn`, `queue.queueUrl`,
 *      `destinationBucket.bucketName`, `distributionDomainName`, `media.roleArn`/`queueArn`, and
 *      the Process/Publish state-machine ARNs, and wire them into the ASL `definitionSubstitutions`.
 *   3. Wires the observability baseline (per-state-machine `ExecutionsFailed` alarms -> SNS, one
 *      dashboard) once the state machines exist.
 *   4. Sets the CloudFormation template description, the `SolutionId` tag, the CfnOutputs, and the
 *      surviving stack-scoped cdk-nag suppressions (CFR1/CFR2 when geo/WAF are off, CFR4 on the default certificate).
 *
 * There are NO CfnParameters/Conditions/Mappings, NO solution-authored Lambdas, NO custom
 * resources, and NO MediaPackage in this stack.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { SsmKey, ssmParameterName } from '@vod/contract';

import { parseVodContext, withEnvFallback } from './context';
import { StorageConstruct } from './constructs/storage';
import { NotificationsConstruct } from './constructs/notifications';
import { DeliveryConstruct } from './constructs/delivery';
import { MediaConvertConstruct } from './constructs/media';
import { WorkflowConstruct } from './constructs/workflow';

/** AWS Solutions Library Guidance identifier for anonymized operational metrics + resource tagging. */
const SOLUTION_ID = 'SO9674';

/**
 * Read the solution version from the CDK app's `package.json` (single source of truth). Read via
 * `fs` rather than a JSON import so no `resolveJsonModule` is required and the value tracks the
 * package version bumped at release time (replaces the v6 build-time `%%VERSION%%` token).
 */
function readSolutionVersion(): string {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
  if (!pkg.version) {
    throw new Error(`Unable to read the solution version from ${pkgPath}.`);
  }
  return pkg.version;
}

export class VideoOnDemand extends cdk.Stack {
  public readonly storage: StorageConstruct;
  public readonly notifications: NotificationsConstruct;
  public readonly delivery: DeliveryConstruct;
  public readonly media: MediaConvertConstruct;
  public readonly workflow: WorkflowConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Parse + validate deploy-time context. Throws (fails synth fast) on missing/invalid inputs.
    // `withEnvFallback` sources any unset key from the repo-root `.env` file that `bin/vod.ts`
    // loaded into `process.env`; explicit `-c`/cdk.json context still wins.
    const context = parseVodContext(withEnvFallback(this.node));

    // CloudFormation template description (CMAF-only GA: no MediaPackage). Version from package.json.
    this.templateOptions.description =
      `(${SOLUTION_ID}) Video on Demand on AWS - serverless video ingest, transcode, and delivery ` +
      'workflow using AWS Step Functions, AWS Elemental MediaConvert, Amazon S3, Amazon CloudFront, ' +
      `and Amazon DynamoDB. Version ${readSolutionVersion()}`;

    // Tag every taggable resource with the solution id (also satisfies the Process role's
    // aws:ResourceTag/SolutionId=SO9674 condition on the MediaConvert jobs it manages).
    cdk.Tags.of(this).add('SolutionId', SOLUTION_ID);

    // ------------------------------------------------------------------------------------------
    // Constructs, in dependency order (leaf -> root).
    // ------------------------------------------------------------------------------------------
    this.storage = new StorageConstruct(this, 'Storage', { context });
    this.notifications = new NotificationsConstruct(this, 'Notifications', { context });
    this.delivery = new DeliveryConstruct(this, 'Delivery', { context, storage: this.storage });
    this.media = new MediaConvertConstruct(this, 'MediaConvert', { storage: this.storage, context });
    this.workflow = new WorkflowConstruct(this, 'Workflow', {
      context,
      storage: this.storage,
      notifications: this.notifications,
      delivery: this.delivery,
      media: this.media,
    });

    // Observability baseline: wired after the state machines exist (Notifications is built before
    // Workflow because Workflow needs the topic/queue for its ASL substitutions). The Orchestrator
    // is first — its ExecutionsFailed alarm is the primary end-to-end (per-asset) failure signal.
    this.notifications.addWorkflowObservability([
      this.workflow.orchestratorSm,
      this.workflow.ingestSm,
      this.workflow.processSm,
      this.workflow.publishSm,
      // Extensions' own state machines: a failed-executions alarm + dashboard row each.
      ...this.workflow.extensionResults.flatMap((r) => r.stateMachines ?? []),
    ]);

    // The MediaConvert service role reads the source bucket and writes the destination bucket via
    // object-key wildcards (source/*, destination/*) that the S3 object APIs mandate — the transcode
    // output keys are runtime-generated per-GUID prefixes. The role is otherwise least-privilege
    // (read source, write destination only, no bucket-level writes/deletes). The MediaConvert
    // construct defers this documented IAM5 suppression to the stack's central nag gate.
    NagSuppressions.addResourceSuppressions(
      this.media.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'The MediaConvert service role is least-privilege: s3:GetObject/GetObjectVersion/ListBucket ' +
            'on the source bucket and s3:PutObject on the destination bucket only. The object-key wildcards ' +
            '(source/*, destination/*) are required by the S3 object APIs because the transcode input/output ' +
            'object keys are runtime-generated (per-GUID prefixes) and not known at synth time.',
        },
      ],
      true, // applyToChildren -> covers the role's DefaultPolicy
    );

    // ------------------------------------------------------------------------------------------
    // Outputs.
    // ------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'SourceBucket', {
      description: 'Ingest source S3 bucket. Upload source videos (or metadata files) here to start the workflow.',
      value: this.storage.sourceBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'DestinationBucket', {
      description: 'Transcoded static-CMAF output S3 bucket (the CloudFront origin).',
      value: this.storage.destinationBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      description: 'CloudFront domain name that serves the packaged CMAF output.',
      value: this.delivery.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'DynamoDBTable', {
      description: 'DynamoDB job-tracking table (keyed by guid).',
      value: this.storage.table.tableName,
    });
    new cdk.CfnOutput(this, 'OrchestratorStateMachineArn', {
      description: 'Orchestrator state machine ARN. The single per-asset execution (start it to reprocess a guid).',
      value: this.workflow.orchestratorSmArn,
    });
    new cdk.CfnOutput(this, 'IngestStateMachineArn', {
      description: 'Ingest stage state machine ARN.',
      value: this.workflow.ingestSmArn,
    });
    new cdk.CfnOutput(this, 'ProcessStateMachineArn', {
      description: 'Process (transcode) state machine ARN.',
      value: this.workflow.processSmArn,
    });
    new cdk.CfnOutput(this, 'PublishStateMachineArn', {
      description: 'Publish stage state machine ARN.',
      value: this.workflow.publishSmArn,
    });
    for (const result of this.workflow.extensionResults) {
      for (const [outputId, output] of Object.entries(result.outputs ?? {})) {
        new cdk.CfnOutput(this, outputId, output);
      }
    }

    // ------------------------------------------------------------------------------------------
    // Cross-stack discovery via SSM Parameter Store. CfnOutputs are not readable from another
    // stack; these `/${AWS::StackName}/...` String parameters let a separate console/frontend stack
    // resolve the core resources at deploy time (StringParameter.valueForStringParameter). Native
    // SSM parameters (no Lambda), so the zero-Lambda invariant holds.
    // ------------------------------------------------------------------------------------------
    const ssmParams: Record<string, string> = {
      [SsmKey.DynamoDBTable]: this.storage.table.tableName,
      [SsmKey.SourceBucket]: this.storage.sourceBucket.bucketName,
      [SsmKey.DestinationBucket]: this.storage.destinationBucket.bucketName,
      [SsmKey.CloudFrontDomainName]: this.delivery.distributionDomainName,
      [SsmKey.OrchestratorStateMachineArn]: this.workflow.orchestratorSmArn,
    };
    // CMS quality-metrics rescue Lambda (companion stack): the intermediate/mezzanine bucket only exists when
    // packagingProfile=ON. Published the same optional way as SsaiHlsManifestEndpointPrefix - simply
    // absent when packaging is off, which the companion resolves tolerantly (StringParameter.valueFromLookup).
    if (this.storage.intermediateBucket) {
      ssmParams[SsmKey.IntermediateBucket] = this.storage.intermediateBucket.bucketName;
    }
    // Extensions' discovery params, under the same namespace.
    for (const result of this.workflow.extensionResults) {
      Object.assign(ssmParams, result.ssmParams ?? {});
    }
    for (const [key, value] of Object.entries(ssmParams)) {
      new ssm.StringParameter(this, `${key}Param`, {
        parameterName: ssmParameterName(cdk.Aws.STACK_NAME, key),
        stringValue: value,
        // The name is a hierarchical (leading-slash) path whose stack-name segment is an unresolved
        // token, so CDK cannot auto-detect the name style; declare it explicitly.
        simpleName: false,
      });
    }

    // ------------------------------------------------------------------------------------------
    // Stack-scoped cdk-nag suppressions — the only ones that survive the v6 -> v7 rewrite.
    // (Dead CFR7 + the W76 "testest" suppression are removed; SF1/SF2 are satisfied by the
    // Workflow construct's logging + tracing; CFR4 is also scoped to the distribution in Delivery.)
    // ------------------------------------------------------------------------------------------
    const stackSuppressions: { id: string; reason: string }[] = [];
    if (!context.geoRestriction || context.geoRestriction.length === 0) {
      stackSuppressions.push({
        id: 'AwsSolutions-CFR1',
        reason:
          'Geo-restriction is intentionally off by default for this deploy-and-go guidance so content ' +
          'is globally reachable. Operators can enable an allowlist via the `geoRestriction` context input.',
      });
    }
    if (!context.wafWebAclArn) {
      stackSuppressions.push({
        id: 'AwsSolutions-CFR2',
        reason:
          'AWS WAF integration is intentionally off by default (it is an account/region-scoped, cost-bearing ' +
          'add-on) so the stack deploys with no external dependency. Operators can associate a WebACL via the ' +
          '`wafWebAclArn` context input, which sets the distribution `WebACLId`.',
      });
    }
    if (!context.certificateArn) {
      stackSuppressions.push({
        id: 'AwsSolutions-CFR4',
        reason:
          'The distribution uses the default *.cloudfront.net certificate, for which CloudFront enforces a ' +
          'TLSv1 security policy regardless of MinimumProtocolVersion; set the domainName + certificateArn context ' +
          'keys to serve a custom domain with a TLSv1.2_2021 minimum. (Also scoped to the distribution in the Delivery construct.)',
      });
    }
    NagSuppressions.addStackSuppressions(this, stackSuppressions);
  }
}
