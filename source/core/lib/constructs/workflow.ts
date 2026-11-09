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
 * WorkflowConstruct — the heart of the VOD v7.0.0 stack.
 *
 * Builds the four native-integration Step Functions state machines from the raw ASL definitions
 * under `lib/state-machines/*.asl.json`:
 *   - a single **Orchestrator** state machine (the per-asset source of truth), and
 *   - three stage state machines it invokes as child executions: **Ingest**, **Process**, **Publish**.
 *
 * Because the definitions are supplied as strings (`DefinitionBody.fromString`), CDK does NOT parse
 * them to derive an execution role (no auto-IAM) — so this construct authors four explicit
 * least-privilege roles that carry EXACTLY the permissions each state machine's Tasks need at
 * runtime, plus the CloudWatch-Logs vended-delivery and X-Ray statements that the `StateMachine`
 * construct adds automatically once logging + tracing are enabled.
 *
 * The stage machines are built first (Publish -> Process -> Ingest) and the Orchestrator last, so
 * the Orchestrator's `states:startExecution.sync:2` tasks can reference the (already-created) child
 * ARNs. The three stages no longer chain to each other (the v6 Ingest->Process->Publish
 * `startExecution.sync` handoffs are gone); the Orchestrator is the sole chainer, which yields ONE
 * execution ARN per asset, a single Catch, and a single centralized failure record + notification.
 *
 * The Orchestrator is driven by an S3 -> EventBridge rule (default bus, detail-type "Object
 * Created", filtered to the source bucket) whose target is the Orchestrator state machine, with a
 * dedicated SQS dead-letter queue and an explicit EventBridge invocation role granting
 * `states:StartExecution`.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { NagSuppressions } from 'cdk-nag';

import { loadAsl, composeProcessAsl, composeOrchestratorAsl } from '../asl';
import { extensionsWith, WorkflowExtensionResult } from '../extensions';
import { IWorkflowConstruct, WorkflowConstructProps } from './interfaces';

/**
 * Managed EventBridge rules that the Step Functions `.sync` service-integration patterns rely on
 * to receive completion events. Step Functions creates/updates them lazily, so the state-machine
 * role needs `events:PutRule`/`events:PutTargets`/`events:DescribeRule` on each.
 */
const MEDIACONVERT_SYNC_RULE = 'StepFunctionsGetEventsForMediaConvertJobRule';
const NESTED_EXECUTION_SYNC_RULE = 'StepFunctionsGetEventsForStepFunctionsExecutionRule';

/** Actions Step Functions needs on a managed `.sync` EventBridge rule. */
const SYNC_RULE_ACTIONS = ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'];

/** Actions Step Functions needs on the executions of a downstream `.sync` state machine. */
const NESTED_EXECUTION_ACTIONS = ['states:DescribeExecution', 'states:StopExecution'];

export class WorkflowConstruct extends Construct implements IWorkflowConstruct {
  public readonly orchestratorSm: sfn.StateMachine;
  public readonly ingestSm: sfn.StateMachine;
  public readonly processSm: sfn.StateMachine;
  public readonly publishSm: sfn.StateMachine;

  public readonly orchestratorSmArn: string;
  public readonly ingestSmArn: string;
  public readonly processSmArn: string;
  public readonly publishSmArn: string;
  public readonly extensionResults: readonly WorkflowExtensionResult[];

  constructor(scope: Construct, id: string, props: WorkflowConstructProps) {
    super(scope, id);

    const { context, storage, notifications, delivery, media } = props;
    const stack = cdk.Stack.of(this);

    // --------------------------------------------------------------------------------------------
    // Publish stage state machine (leaf — invoked by the Orchestrator; no child of its own).
    // --------------------------------------------------------------------------------------------
    const publishRole = new iam.Role(this, 'PublishStateMachineRole', {
      assumedBy: this.stateMachinePrincipal('publish'),
      description: 'Execution role for the VOD Publish stage state machine (native integrations).',
    });
    // Tag Source: native s3:putObjectTagging on the source object (Glacier/Deep Archive opt-in).
    storage.grantSourceTagging(publishRole);
    // Record Publish: dynamodb:updateItem.
    storage.grantTableUpdate(publishRole);
    // Notify Success: native sns:publish (+ aws/sns KMS).
    notifications.topic.grantPublish(publishRole);
    this.grantManagedKeyUsage(publishRole, 'sns');
    // Send SQS Message: native sqs:sendMessage (+ aws/sqs KMS for the KMS_MANAGED queue).
    notifications.queue.grantSendMessages(publishRole);
    this.grantManagedKeyUsage(publishRole, 'sqs');

    this.publishSm = new sfn.StateMachine(this, 'PublishStateMachine', {
      stateMachineName: `${cdk.Aws.STACK_NAME}-publish`,
      role: publishRole,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(loadAsl('publish'))),
      definitionSubstitutions: {
        STACK_NAME: cdk.Aws.STACK_NAME,
        DYNAMODB_TABLE: storage.table.tableName,
        SNS_TOPIC_ARN: notifications.topic.topicArn,
        SQS_QUEUE_URL: notifications.queueUrl,
      },
      logs: this.buildLogging('Publish'),
      tracingEnabled: true,
    });
    this.publishSmArn = this.publishSm.stateMachineArn;
    this.suppressRoleIam5(
      publishRole,
      [
        'kms:GenerateDataKey/kms:Decrypt on the aws/sns and aws/sqs AWS-managed keys: their key ARNs are unknown at synth, so the statements are scoped to account keys constrained by a kms:ViaService (sns/sqs) condition.',
        's3:PutObjectTagging is scoped to source-bucket objects (source/*), an object-key wildcard mandated by the S3 tagging API.',
        'logs:*LogDelivery/PutResourcePolicy/Describe* (vended log delivery) and xray:Put*/Get* are added automatically by the aws-stepfunctions StateMachine construct once logging + tracing are enabled and require resource "*" per those APIs.',
      ],
    );

    // --------------------------------------------------------------------------------------------
    // Process stage state machine (invoked by the Orchestrator; no child of its own).
    // --------------------------------------------------------------------------------------------
    const processRole = new iam.Role(this, 'ProcessStateMachineRole', {
      assumedBy: this.stateMachinePrincipal('process'),
      description: 'Execution role for the VOD Process stage state machine (native integrations).',
    });
    // Encode {SD,HD,UHD}: mediaconvert:createJob.sync.
    processRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        // CreateJob with Tags atomically calls TagResource on the new job, so both are required.
        actions: ['mediaconvert:CreateJob', 'mediaconvert:TagResource'],
        // CreateJob references queue/preset/template sub-resources not known at synth; the created
        // job id is also runtime-generated. Scoped to this account's MediaConvert resources.
        resources: [stack.formatArn({ service: 'mediaconvert', resource: '*' })],
      }),
    );
    processRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        // createJob.sync polls GetJob for completion and CancelJob on abort/timeout.
        actions: ['mediaconvert:GetJob', 'mediaconvert:CancelJob'],
        resources: [stack.formatArn({ service: 'mediaconvert', resource: 'jobs', resourceName: '*' })],
        // The ASL tags every job with SolutionId=SO9674; constrain to solution-owned jobs.
        conditions: { StringEquals: { 'aws:ResourceTag/SolutionId': 'SO9674' } },
      }),
    );
    // createJob.sync passes the MediaConvert service role to MediaConvert.
    processRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [media.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'mediaconvert.amazonaws.com' } },
      }),
    );
    // Managed EventBridge rule for createJob.sync.
    this.grantSyncRule(processRole, MEDIACONVERT_SYNC_RULE);
    // Record Job: dynamodb:updateItem.
    storage.grantTableUpdate(processRole);

    // Extensions may register Process substitutions (for tokens their settings/ASL hooks emitted) and may
    // turn Process execution-data logging off (e.g. when a deploy-resolved secret is in the definition).
    const processExtensionSubstitutions = Object.assign(
      {},
      ...extensionsWith(context.extensions, 'processSubstitutions').map((e) => e.processSubstitutions(this, storage)),
    ) as Record<string, string>;
    const processExecutionData = extensionsWith(context.extensions, 'processExecutionDataLogging').every((e) =>
      e.processExecutionDataLogging(),
    );

    this.processSm = new sfn.StateMachine(this, 'ProcessStateMachine', {
      stateMachineName: `${cdk.Aws.STACK_NAME}-process`,
      role: processRole,
      // composeProcessAsl(context) splices each tier's Settings OBJECT into the Encode states before
      // stringify, so MediaConvert receives an object (not a string). JOB_SETTINGS_* remain only in
      // Comment fields and are deliberately NOT registered as substitutions. When
      // context.packagingProfile === 'ON' it also injects the two-job packaging overlay states
      // (which reference ${INTERMEDIATE_BUCKET}); OFF renders byte-identical to the GA core.
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(composeProcessAsl(context))),
      definitionSubstitutions: {
        STACK_NAME: cdk.Aws.STACK_NAME,
        DYNAMODB_TABLE: storage.table.tableName,
        DESTINATION_BUCKET: storage.destinationBucket.bucketName,
        CLOUDFRONT_DOMAIN: delivery.distributionDomainName,
        MEDIACONVERT_ROLE_ARN: media.roleArn,
        MEDIACONVERT_QUEUE_ARN: media.queueArn,
        MEDIACONVERT_ENDPOINT: media.endpoint,
        // Intermediate mezzanine bucket for the packaging overlay (only referenced/registered when ON).
        ...(context.packagingProfile === 'ON' && storage.intermediateBucket
          ? { INTERMEDIATE_BUCKET: storage.intermediateBucket.bucketName }
          : {}),
        ...processExtensionSubstitutions,
      },
      // Full observability unless an extension keeps execution data out of the logs. Level ALL either way.
      logs: this.buildLogging('Process', processExecutionData),
      tracingEnabled: true,
    });
    this.processSmArn = this.processSm.stateMachineArn;
    this.suppressRoleIam5(
      processRole,
      [
        'mediaconvert:CreateJob/TagResource are scoped to this account/region MediaConvert resources (arn:...:mediaconvert:...:*) because CreateJob references queue/preset/template sub-resources not known at synth and TagResource targets the runtime-generated job id (CreateJob with Tags calls TagResource atomically).',
        'mediaconvert:GetJob/CancelJob are scoped to jobs/* (job ids are runtime-generated) and further constrained by the aws:ResourceTag/SolutionId=SO9674 resource-tag condition.',
        'logs vended-delivery (logs:*LogDelivery/PutResourcePolicy/Describe*) and xray:Put*/Get* are auto-added by the StateMachine construct and require resource "*".',
      ],
    );

    // --------------------------------------------------------------------------------------------
    // Ingest stage state machine (invoked by the Orchestrator; no child of its own).
    // --------------------------------------------------------------------------------------------
    const ingestRole = new iam.Role(this, 'IngestStateMachineRole', {
      assumedBy: this.stateMachinePrincipal('ingest'),
      description: 'Execution role for the VOD Ingest stage state machine (native integrations).',
    });
    // Probe: MediaConvert Probe supports no resource-level permissions, so resource must be "*".
    ingestRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['mediaconvert:Probe'],
        resources: ['*'],
      }),
    );
    // Probe reads the source object with the caller's credentials.
    storage.grantSourceRead(ingestRole);
    // Record Ingest: dynamodb:updateItem (attaches the probe result to the orchestrator's item).
    storage.grantTableUpdate(ingestRole);
    // Notify Ingest: native sns:publish (+ aws/sns KMS).
    notifications.topic.grantPublish(ingestRole);
    this.grantManagedKeyUsage(ingestRole, 'sns');

    this.ingestSm = new sfn.StateMachine(this, 'IngestStateMachine', {
      stateMachineName: `${cdk.Aws.STACK_NAME}-ingest`,
      role: ingestRole,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(loadAsl('ingest'))),
      definitionSubstitutions: {
        STACK_NAME: cdk.Aws.STACK_NAME,
        DYNAMODB_TABLE: storage.table.tableName,
        SNS_TOPIC_ARN: notifications.topic.topicArn,
      },
      logs: this.buildLogging('Ingest'),
      tracingEnabled: true,
    });
    this.ingestSmArn = this.ingestSm.stateMachineArn;
    this.suppressRoleIam5(
      ingestRole,
      [
        'mediaconvert:Probe requires resource "*" — the Probe API supports no resource-level permissions.',
        'kms:GenerateDataKey/kms:Decrypt on the aws/sns AWS-managed key: its ARN is unknown at synth, so scoped to account keys constrained by kms:ViaService=sns.',
        's3:GetObject is scoped to source-bucket objects (source/*), an object-key wildcard mandated by the S3 read API.',
        'logs vended-delivery (logs:*LogDelivery/PutResourcePolicy/Describe*) and xray:Put*/Get* are auto-added by the StateMachine construct and require resource "*".',
      ],
    );

    // --------------------------------------------------------------------------------------------
    // Orchestrator state machine (the per-asset source of truth; built last so it can reference
    // the three child ARNs). Runs Ingest/Process/Publish as startExecution.sync:2 child executions,
    // creates the DynamoDB item up front, and owns the single Error record + failure notification.
    // --------------------------------------------------------------------------------------------
    const orchestratorRole = new iam.Role(this, 'OrchestratorStateMachineRole', {
      assumedBy: this.stateMachinePrincipal('orchestrator'),
      description: 'Execution role for the VOD Orchestrator state machine (native integrations).',
    });
    // Record Started: dynamodb:putItem. Record Failure: dynamodb:updateItem.
    storage.grantTablePut(orchestratorRole);
    storage.grantTableUpdate(orchestratorRole);
    // Notify Failure: native sns:publish (+ aws/sns KMS).
    notifications.topic.grantPublish(orchestratorRole);
    this.grantManagedKeyUsage(orchestratorRole, 'sns');
    // Managed EventBridge rule for the nested startExecution.sync:2 completion events.
    this.grantSyncRule(orchestratorRole, NESTED_EXECUTION_SYNC_RULE);
    // Ad-markers overlay: Read ESAM Sidecar (s3:getObject) reads the per-asset <source>.esam.xml.
    const adMarkersEnabled = context.adMarkersProfile === 'ON';
    const captionsEnabled = context.captionsProfile === 'ON';
    // Both sidecar overlays read per-asset companions in the source bucket from the Orchestrator:
    // <source>.json (the metadata whose flags gate the sidecar reads), then ad-markers GETs
    // <source>.esam.xml and captions HEADs <source>.vtt. Either needs source/* read.
    if (adMarkersEnabled || captionsEnabled) {
      storage.grantSourceRead(orchestratorRole);
    }
    // Extensions: their own state machines/roles in this scope, plus the Orchestrator grants and
    // substitutions for the states their orchestratorAsl hooks injected.
    this.extensionResults = extensionsWith(context.extensions, 'workflow').map((e) =>
      e.workflow({
        scope: this,
        context,
        storage,
        orchestratorRole,
        buildLogging: (name, includeExecutionData) => this.buildLogging(name, includeExecutionData),
      }),
    );
    // Run each stage as a child: StartExecution + Describe/StopExecution on its executions.
    for (const childSm of [this.ingestSm, this.processSm, this.publishSm]) {
      childSm.grantStartExecution(orchestratorRole);
      childSm.grantExecution(orchestratorRole, ...NESTED_EXECUTION_ACTIONS);
    }

    this.orchestratorSm = new sfn.StateMachine(this, 'OrchestratorStateMachine', {
      stateMachineName: `${cdk.Aws.STACK_NAME}-orchestrator`,
      role: orchestratorRole,
      // composeOrchestratorAsl(context) injects the Read ESAM Sidecar (s3:getObject) state when
      // adMarkersProfile=ON; OFF renders byte-identical to the on-disk orchestrator ASL.
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(composeOrchestratorAsl(context))),
      definitionSubstitutions: {
        STACK_NAME: cdk.Aws.STACK_NAME,
        ARCHIVE_SOURCE: context.archiveSource,
        ENABLE_SNS: context.enableSns,
        ENABLE_SQS: context.enableSqs,
        DYNAMODB_TABLE: storage.table.tableName,
        SNS_TOPIC_ARN: notifications.topic.topicArn,
        INGEST_STATE_MACHINE_ARN: this.ingestSm.stateMachineArn,
        PROCESS_STATE_MACHINE_ARN: this.processSm.stateMachineArn,
        PUBLISH_STATE_MACHINE_ARN: this.publishSm.stateMachineArn,
        // Per-frame-metrics overlay (perFrameMetrics=ON): surface the QC toggle in Load Job Config's
        // $.config block. Registered exactly when composeOrchestratorAsl injected the token; OFF leaves
        // the orchestrator definition byte-identical (no token, no substitution).
        ...(context.perFrameMetrics === 'ON' ? { PER_FRAME_METRICS: context.perFrameMetrics } : {}),
        // Captions overlay (captionsProfile=ON): surface the toggle in Load Job Config's $.config block.
        // Registered exactly when composeOrchestratorAsl injected the ${CAPTIONS_PROFILE} token; OFF leaves
        // the orchestrator definition byte-identical.
        ...(captionsEnabled ? { CAPTIONS_PROFILE: context.captionsProfile } : {}),
        // Extensions: registered exactly when their orchestratorAsl hooks injected the tokens.
        ...Object.assign({}, ...this.extensionResults.map((r) => r.orchestratorSubstitutions ?? {})),
      },
      logs: this.buildLogging('Orchestrator'),
      tracingEnabled: true,
    });
    this.orchestratorSmArn = this.orchestratorSm.stateMachineArn;
    this.suppressRoleIam5(
      orchestratorRole,
      [
        'kms:GenerateDataKey/kms:Decrypt on the aws/sns AWS-managed key: its ARN is unknown at synth, so scoped to account keys constrained by kms:ViaService=sns.',
        'states:DescribeExecution/StopExecution target the Ingest/Process/Publish child executions (execution:<name>:*), a runtime execution-id wildcard required by startExecution.sync:2.',
        'logs vended-delivery (logs:*LogDelivery/PutResourcePolicy/Describe*) and xray:Put*/Get* are auto-added by the StateMachine construct and require resource "*".',
        ...(adMarkersEnabled
          ? [
              's3:GetObject is scoped to source-bucket objects (source/*) for the asset-metadata and ESAM sidecar reads (adMarkersProfile=ON); the object-key wildcard is mandated by the S3 read API.',
            ]
          : []),
        ...(captionsEnabled
          ? [
              's3:GetObject/s3:HeadObject is scoped to source-bucket objects (source/*) for the asset-metadata and caption sidecar reads (captionsProfile=ON); the object-key wildcard is mandated by the S3 read API.',
            ]
          : []),
      ],
    );

    // --------------------------------------------------------------------------------------------
    // S3 -> EventBridge -> Orchestrator rule (default bus), with an SQS DLQ + explicit invocation role.
    // --------------------------------------------------------------------------------------------
    const orchestratorRuleDlq = new sqs.Queue(this, 'OrchestratorRuleDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    NagSuppressions.addResourceSuppressions(orchestratorRuleDlq, [
      {
        id: 'AwsSolutions-SQS3',
        reason:
          'This queue is itself the dead-letter queue for the S3 -> EventBridge -> Orchestrator rule target; a dead-letter queue does not require its own dead-letter queue.',
      },
    ]);

    const orchestratorRuleRole = new iam.Role(this, 'OrchestratorRuleRole', {
      // Confused-deputy guard: only EventBridge rules in this account. The rule's name is generated, and
      // naming it here would be circular (the rule's target references this role), so any rule ARN.
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'events', resource: 'rule', resourceName: '*' }) },
        },
      }),
      description: 'EventBridge invocation role that starts the VOD Orchestrator state machine.',
    });

    const orchestratorRule = new events.Rule(this, 'OrchestratorRule', {
      description: 'Starts the VOD Orchestrator state machine when a source video is created in the source bucket.',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [storage.sourceBucket.bucketName] },
          // Exclude per-asset sidecar companion files from triggering a workflow: the ad-markers ESAM
          // sidecar (<source>.esam.xml), the operator-console metadata sidecar (<source>.json), and, when
          // captionsProfile=ON, the caption sidecar (<source>.vtt). They accompany the source video and are
          // read by the workflow (or reserved for it), not media objects of their own. This also fixes the
          // previously-missing object-key filter (the rule matched every source object). NOTE: EventBridge
          // anything-but + suffix (and a multi-value suffix list) support is a live-verification item.
          object: {
            key: [
              {
                'anything-but': {
                  suffix: captionsEnabled ? ['.esam.xml', '.json', '.vtt'] : ['.esam.xml', '.json'],
                },
              },
            ],
          },
        },
      },
    });
    // Default target input = the entire EventBridge event, which the Orchestrator ASL reads via
    // $.detail.bucket.name / $.detail.object.key. SfnStateMachine grants states:StartExecution
    // on the Orchestrator state machine to the supplied invocation role.
    orchestratorRule.addTarget(
      new targets.SfnStateMachine(this.orchestratorSm, {
        deadLetterQueue: orchestratorRuleDlq,
        role: orchestratorRuleRole,
      }),
    );
  }

  /**
   * The `states.amazonaws.com` principal for one stage's execution role, with the confused-deputy guard
   * Step Functions documents: only this account, and only the state machine named `<stack>-<stage>`. The
   * ARN is built from the fixed name (not the state machine's token), so there is no role <-> state
   * machine dependency cycle.
   */
  private stateMachinePrincipal(stage: string): iam.ServicePrincipal {
    return new iam.ServicePrincipal('states.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
        ArnLike: {
          'aws:SourceArn': cdk.Stack.of(this).formatArn({
            service: 'states',
            resource: 'stateMachine',
            resourceName: `${cdk.Aws.STACK_NAME}-${stage}`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        },
      },
    });
  }

  /**
   * Build the level-ALL CloudWatch logging configuration for a state machine. `includeExecutionData`
   * defaults to true (full observability); it is set false only for the Process SM when an extension
   * asks for it (see {@link ActiveExtension.processExecutionDataLogging}).
   */
  private buildLogging(name: string, includeExecutionData = true): sfn.LogOptions {
    const logGroup = new logs.LogGroup(this, `${name}LogGroup`, {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    return {
      destination: logGroup,
      level: sfn.LogLevel.ALL,
      includeExecutionData,
    };
  }

  /**
   * Grant a state-machine role the events actions Step Functions needs on a managed `.sync`
   * EventBridge rule (`StepFunctionsGetEventsFor...Rule`) on the default bus.
   */
  private grantSyncRule(role: iam.Role, ruleName: string): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: SYNC_RULE_ACTIONS,
        resources: [
          cdk.Stack.of(this).formatArn({ service: 'events', resource: 'rule', resourceName: ruleName }),
        ],
      }),
    );
  }

  /**
   * Grant a state-machine role usage of the AWS-managed `aws/sns` or `aws/sqs` KMS key. The
   * managed-key ARN is not known at synth, so the statement is scoped to this account's keys and
   * constrained by a `kms:ViaService` condition to the specific service.
   */
  private grantManagedKeyUsage(role: iam.Role, service: 'sns' | 'sqs'): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: [
          cdk.Stack.of(this).formatArn({ service: 'kms', resource: 'key', resourceName: '*' }),
        ],
        conditions: {
          StringEquals: { 'kms:ViaService': `${service}.${cdk.Aws.REGION}.amazonaws.com` },
        },
      }),
    );
  }

  /**
   * Add a reasoned AwsSolutions-IAM5 suppression to a state-machine role (and its default policy).
   * Every wildcard on these roles is API-mandated or references an ARN not known at synth; the
   * enumerated reasons document each one.
   */
  private suppressRoleIam5(role: iam.Role, reasons: readonly string[]): void {
    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: reasons.join(' '),
        },
      ],
      true,
    );
  }
}
