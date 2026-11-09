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
 * Construct contract for the VOD v7.0.0 stack.
 *
 * This file is the single source of truth for the five constructs the stack is decomposed into.
 * Each construct implementer codes
 * its class against the `I*Construct` interface here; the orchestrator (`lib/vod-stack.ts`) and
 * downstream constructs depend only on these interfaces, not on the concrete classes — which
 * keeps the construct files free of circular imports.
 *
 * Dependency / instantiation order (leaf -> root):
 *   Storage -> Notifications -> Delivery -> MediaConvert -> Workflow.
 *
 * Constructs that depend on other constructs receive them (typed by their `I*Construct`
 * interface) as props rather than raw resources, so they can read exposed members and call
 * grant helpers.
 */

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';

import { VodContext } from '../context';
import { JobTier, JsonObject } from '../asl';
import type { WorkflowExtensionResult } from '../extensions';

/* ------------------------------------------------------------------------------------------------
 * StorageConstruct — 3 buckets + DynamoDB table (+ least-privilege grant helpers).
 * Blueprint: source bucket (EventBridge-enabled, versioned, enforceSSL, RETAIN + 2 tag-filtered
 * archive lifecycle rules), destination bucket (optional expiry), logs bucket, DynamoDB table
 * (PK `guid`, PAY_PER_REQUEST, PITR, RETAIN) + GSI `srcBucket-startTime-index`.
 * ---------------------------------------------------------------------------------------------- */

/** GSI name carried from v6 and asserted by the test plan. */
export const SRC_BUCKET_START_TIME_INDEX = 'srcBucket-startTime-index';

export interface StorageConstructProps {
  /** Validated deploy-time context. Storage reads `destinationRetentionDays`. */
  readonly context: VodContext;
}

export interface IStorageConstruct {
  /** Ingest source bucket. EventBridge-enabled; feeds the S3 -> EventBridge -> Ingest rule. */
  readonly sourceBucket: s3.Bucket;
  /** Transcoded static-CMAF output bucket; the CloudFront (OAC) origin. */
  readonly destinationBucket: s3.Bucket;
  /** Server-access-log bucket for the source + destination buckets. */
  readonly logsBucket: s3.Bucket;
  /** Job-tracking table. PK `guid`; GSI {@link SRC_BUCKET_START_TIME_INDEX}. -> `${DYNAMODB_TABLE}`. */
  readonly table: dynamodb.Table;
  /**
   * Non-origin intermediate mezzanine bucket for the packaging overlay (job1's TS-HLS
   * ladder). Present ONLY when `context.packagingProfile === 'ON'` (undefined otherwise).
   * -> `${INTERMEDIATE_BUCKET}` (when ON).
   */
  readonly intermediateBucket?: s3.Bucket;

  /** Grant read (GetObject/GetObjectVersion/ListBucket) on the source bucket. Ingest probe + MediaConvert service role. */
  grantSourceRead(grantee: iam.IGrantable): iam.Grant;
  /** Grant `s3:PutObjectTagging`/`s3:PutObjectVersionTagging` on source objects. Publish archive tagging (never strips the stack-name tag key). */
  grantSourceTagging(grantee: iam.IGrantable): iam.Grant;
  /** Grant write (PutObject) on the destination bucket. MediaConvert service role output. */
  grantDestinationWrite(grantee: iam.IGrantable): iam.Grant;
  /** Grant `dynamodb:PutItem` on the table. Ingest `Record Ingest`. */
  grantTablePut(grantee: iam.IGrantable): iam.Grant;
  /** Grant `dynamodb:UpdateItem` on the table. Process `Record Job` + Publish `Record Publish`. */
  grantTableUpdate(grantee: iam.IGrantable): iam.Grant;
  /** Grant `s3:PutObject` on the intermediate bucket. Packaging-overlay job1 (ON only; throws if OFF). */
  grantIntermediateWrite(grantee: iam.IGrantable): iam.Grant;
  /** Grant read (GetObject/GetObjectVersion/ListBucket) on the intermediate bucket. Packaging-overlay job2 (ON only; throws if OFF). */
  grantIntermediateRead(grantee: iam.IGrantable): iam.Grant;
}

/* ------------------------------------------------------------------------------------------------
 * NotificationsConstruct — SNS topic (+ email sub) + SQS queue + DLQ, plus the observability
 * baseline (ExecutionsFailed alarms per state machine -> SNS, one CloudWatch dashboard).
 * ---------------------------------------------------------------------------------------------- */

export interface NotificationsConstructProps {
  /** Validated deploy-time context. Notifications reads `email` (topic subscription). */
  readonly context: VodContext;
}

export interface INotificationsConstruct {
  /** Notification topic (aws/sns KMS, email subscription). -> `${SNS_TOPIC_ARN}`. */
  readonly topic: sns.Topic;
  /** Results queue (SQS-managed SSE) with a dead-letter queue. */
  readonly queue: sqs.Queue;
  /** Convenience: `queue.queueArn`. */
  readonly queueArn: string;
  /** Convenience: `queue.queueUrl`. -> `${SQS_QUEUE_URL}`. */
  readonly queueUrl: string;

  /**
   * Wire the observability baseline for the workflow: one `ExecutionsFailed` CloudWatch alarm
   * per state machine (action -> this topic) and a single workflow dashboard.
   *
   * Called by the orchestrator AFTER {@link IWorkflowConstruct} is built, because Notifications
   * is instantiated before Workflow (Workflow needs `topic`/`queue` for its ASL substitutions),
   * so the state machines do not yet exist at Notifications construction time.
   */
  addWorkflowObservability(stateMachines: readonly sfn.IStateMachine[]): void;
}

/* ------------------------------------------------------------------------------------------------
 * DeliveryConstruct — CloudFrontToS3 over the destination bucket (OAC default), managed
 * CachingOptimized cache policy + managed CORS/SecurityHeaders response policy, HTTP2_AND_3 +
 * IPv6; optional geo-restriction / WAF from context.
 * ---------------------------------------------------------------------------------------------- */

export interface DeliveryConstructProps {
  /** Validated deploy-time context. Delivery reads `priceClass`, `geoRestriction`, `wafWebAclArn`. */
  readonly context: VodContext;
  /** Storage construct; Delivery uses `storage.destinationBucket` as the origin (and `logsBucket` for CF logs). */
  readonly storage: IStorageConstruct;
}

export interface IDeliveryConstruct {
  /** The CloudFront distribution fronting the destination bucket. */
  readonly distribution: cloudfront.Distribution;
  /** `distribution.distributionDomainName`. -> `${CLOUDFRONT_DOMAIN}`. */
  readonly distributionDomainName: string;
}

/* ------------------------------------------------------------------------------------------------
 * MediaConvertConstruct — MediaConvert service role (least-privilege S3), the account Default
 * on-demand queue ARN, the account endpoint, and the transformed per-tier job Settings objects.
 * Replaces the v6 deploy-time custom resource.
 * ---------------------------------------------------------------------------------------------- */

export interface MediaConvertConstructProps {
  /** Storage construct; MediaConvert grants the service role read on source + write on destination. */
  readonly storage: IStorageConstruct;
  /**
   * Validated deploy-time context. MediaConvert reads `packagingProfile` to grant the service role
   * intermediate-bucket read/write for the two-job overlay, and runs the extensions' role hooks.
   */
  readonly context: VodContext;
}

export interface IMediaConvertConstruct {
  /** MediaConvert service role (`assumedBy mediaconvert.amazonaws.com`), PassRole target of the Process role. */
  readonly role: iam.Role;
  /** `role.roleArn`. -> `${MEDIACONVERT_ROLE_ARN}`. */
  readonly roleArn: string;
  /** Account Default on-demand queue ARN. -> `${MEDIACONVERT_QUEUE_ARN}`. */
  readonly queueArn: string;
  /**
   * MediaConvert account endpoint (region URL). Exposed for `${MEDIACONVERT_ENDPOINT}` only;
   * the optimized `createJob.sync` integration resolves the endpoint automatically, so it is a
   * documentation/substitution convenience and is not passed as a Task parameter.
   */
  readonly endpoint: string;
  /**
   * The three transformed per-tier MediaConvert `Settings` objects (from `asl.buildJobSettings`):
   * runtime `${INPUT_URI}`/`${DESTINATION}` already rewritten to `.$` intrinsics. Exposed for
   * introspection/tests and blueprint alignment; the Process ASL splice is produced by
   * `asl.composeProcessAsl()`, which yields equivalent objects.
   */
  readonly jobSettings: Readonly<Record<JobTier, JsonObject>>;
}

/* ------------------------------------------------------------------------------------------------
 * WorkflowConstruct — the heart. Four sfn.StateMachine built from raw ASL via
 * DefinitionBody.fromString(JSON.stringify(asl)) + definitionSubstitutions: three stage machines
 * (built Publish -> Process -> Ingest, no cycle) plus an Orchestrator built last that runs them as
 * startExecution.sync:2 child executions. Four explicit least-privilege roles, logging (level ALL)
 * + tracing on all four, and the S3 -> EventBridge rule (source-bucket filtered) -> Orchestrator SM
 * with an SQS DLQ + invocation role. No Lambdas.
 * ---------------------------------------------------------------------------------------------- */

export interface WorkflowConstructProps {
  /** Validated deploy-time context. Workflow reads `archiveSource`/`enableSns`/`enableSqs` for substitutions. */
  readonly context: VodContext;
  /** Storage construct (source/destination buckets + table; grant helpers for the SM roles + EventBridge rule source). */
  readonly storage: IStorageConstruct;
  /** Notifications construct (topic + queue for SNS/SQS substitutions and grants). */
  readonly notifications: INotificationsConstruct;
  /** Delivery construct (distribution domain for the playback-URL substitution). */
  readonly delivery: IDeliveryConstruct;
  /** MediaConvert construct (role ARN, queue ARN, endpoint; PassRole target). */
  readonly media: IMediaConvertConstruct;
}

export interface IWorkflowConstruct {
  /** Orchestrator state machine (name ends `-orchestrator`); target of the S3 -> EventBridge rule, and the single per-asset execution. */
  readonly orchestratorSm: sfn.StateMachine;
  /** Ingest stage state machine (name ends `-ingest`); run by the Orchestrator via `startExecution.sync:2`. */
  readonly ingestSm: sfn.StateMachine;
  /** Process stage state machine (name ends `-process`); run by the Orchestrator via `startExecution.sync:2`. */
  readonly processSm: sfn.StateMachine;
  /** Publish stage state machine (name ends `-publish`); run by the Orchestrator via `startExecution.sync:2`. */
  readonly publishSm: sfn.StateMachine;

  /** `orchestratorSm.stateMachineArn`. -> `${INGEST|PROCESS|PUBLISH_STATE_MACHINE_ARN}` are referenced by it. */
  readonly orchestratorSmArn: string;
  /** `ingestSm.stateMachineArn`. -> `${INGEST_STATE_MACHINE_ARN}` (on Orchestrator). */
  readonly ingestSmArn: string;
  /** `processSm.stateMachineArn`. -> `${PROCESS_STATE_MACHINE_ARN}` (on Orchestrator). */
  readonly processSmArn: string;
  /** `publishSm.stateMachineArn`. -> `${PUBLISH_STATE_MACHINE_ARN}` (on Orchestrator). */
  readonly publishSmArn: string;
  /** What the extensions' `workflow` hooks contributed (state machines, outputs, SSM params), in name order. */
  readonly extensionResults: readonly WorkflowExtensionResult[];
}
