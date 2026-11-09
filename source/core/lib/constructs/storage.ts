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
 * StorageConstruct — the persistent-storage layer of the VOD v7.0.0 stack.
 *
 * Creates the three S3 buckets and the DynamoDB job-tracking table, and exposes the
 * least-privilege grant helpers the workflow / MediaConvert roles consume. This is the leaf of
 * the dependency graph (`Storage -> Notifications -> Delivery -> MediaConvert -> Workflow`), so
 * it depends on nothing but the validated {@link VodContext}.
 *
 * Blueprint:
 *   - Source bucket: `eventBridgeEnabled` (feeds the S3 -> EventBridge -> Ingest rule), versioned,
 *     `enforceSSL`, S3-managed SSE, block-all public access, RETAIN, and two tag-filtered archive
 *     lifecycle rules (tag key = the stack name, matching the Publish `Tag Source` ASL state;
 *     values `GLACIER` / `DEEP_ARCHIVE` transition the source object to that storage class).
 *   - Destination bucket: versioned, `enforceSSL`, S3-managed SSE, block-all public access, RETAIN,
 *     optional output expiry (`context.destinationRetentionDays`). Has a permissive CORS config so
 *     the origin answers CMAF players' OPTIONS preflight; the CloudFront CORS-With-Preflight
 *     response-headers policy (Delivery construct) sets the CORS headers on all responses.
 *   - Logs bucket: S3-managed SSE, RETAIN, ACLs enabled (`OBJECT_WRITER`) because CloudFront
 *     standard (legacy) logging in the Delivery construct writes here via ACLs. Server-access-log
 *     target for the source + destination buckets, so it cannot log to itself (S1 suppressed).
 *   - DynamoDB table: PK `guid`, PAY_PER_REQUEST, point-in-time recovery, RETAIN, plus the
 *     {@link SRC_BUCKET_START_TIME_INDEX} GSI carried from v6.
 */

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';

import {
  IStorageConstruct,
  StorageConstructProps,
  SRC_BUCKET_START_TIME_INDEX,
} from './interfaces';
import { extensionsWith } from '../extensions';

export class StorageConstruct extends Construct implements IStorageConstruct {
  public readonly sourceBucket: s3.Bucket;
  public readonly destinationBucket: s3.Bucket;
  public readonly logsBucket: s3.Bucket;
  public readonly table: dynamodb.Table;
  /** Non-origin mezzanine bucket for the packaging overlay; only created when ON. */
  public readonly intermediateBucket?: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    const { context } = props;

    /**
     * Access-log bucket for the source + destination buckets AND the CloudFront distribution.
     *
     * ACLs are enabled (`OBJECT_WRITER`) because CloudFront standard logging delivers logs via the
     * awslogsdelivery account using bucket ACLs; the destination bucket's OAC origin does not need
     * ACLs, but this shared log sink does. RETAIN so historical logs survive a stack teardown.
     */
    this.logsBucket = new s3.Bucket(this, 'LogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The log sink is itself the server-access-log target, so it does not (and cannot) log to
    // itself. This is the only storage-layer nag suppression; source/destination satisfy S1 via
    // `serverAccessLogsBucket` and all three satisfy S10 via `enforceSSL`.
    NagSuppressions.addResourceSuppressions(this.logsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This is the access-log destination bucket for the source/destination buckets and the CloudFront distribution; it must not log to itself.',
      },
    ]);

    /**
     * Ingest source bucket. `eventBridgeEnabled` emits `Object Created` to the default event bus,
     * which the Workflow construct's rule filters on to start the Ingest state machine.
     * The two tag-filtered lifecycle rules key on the stack name (the tag key the Publish
     * `Tag Source` ASL state writes) and transition the source object to the selected archive class.
     */
    // Optional CORS for browser uploads (CMS self-service upload). Default OFF (undefined) keeps the
    // source bucket byte-identical to the GA template; setting `uploadCorsOrigins` to the console
    // origin(s) allows Amplify Storage direct PUT/multipart uploads. '*' (any origin) is accepted as the
    // simple starting point; uploads still need the caller's own Cognito credentials and prefix, so narrow
    // it to the CMS origin for production.
    const sourceCors: s3.CorsRule[] | undefined =
      context.uploadCorsOrigins && context.uploadCorsOrigins.length > 0
        ? [
            {
              // GET + DELETE are required for Amplify multipart uploads (ListParts is a GET,
              // AbortMultipartUpload is a DELETE); PUT/POST/HEAD cover single-part PUT, Create/
              // UploadPart/Complete, and preflight. Without GET the browser blocks the ListParts
              // preflight ("No Access-Control-Allow-Origin").
              allowedMethods: [
                s3.HttpMethods.GET,
                s3.HttpMethods.PUT,
                s3.HttpMethods.POST,
                s3.HttpMethods.HEAD,
                s3.HttpMethods.DELETE,
              ],
              allowedOrigins: context.uploadCorsOrigins,
              allowedHeaders: ['*'],
              exposedHeaders: ['ETag'],
              maxAge: 3000,
            },
          ]
        : undefined;

    this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'source-bucket-logs/',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: sourceCors,
      lifecycleRules: [
        {
          id: `${cdk.Aws.STACK_NAME}-source-archive-glacier`,
          tagFilters: { [cdk.Aws.STACK_NAME]: 'GLACIER' },
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(1),
            },
          ],
        },
        {
          id: `${cdk.Aws.STACK_NAME}-source-archive-deep-archive`,
          tagFilters: { [cdk.Aws.STACK_NAME]: 'DEEP_ARCHIVE' },
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(1),
            },
          ],
        },
      ],
    });

    // Enable EventBridge notifications via the NATIVE CloudFormation property rather than the
    // high-level `eventBridgeEnabled: true` prop. The high-level prop routes through a
    // `Custom::S3BucketNotifications` custom resource backed by a `BucketNotificationsHandler`
    // Lambda, which would break the stack's zero-Lambda invariant. The L1 escape hatch sets
    // `NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled` directly (no Lambda),
    // which is all the Workflow construct's S3 -> EventBridge -> Ingest rule needs.
    const cfnSourceBucket = this.sourceBucket.node.defaultChild as s3.CfnBucket;
    cfnSourceBucket.notificationConfiguration = {
      eventBridgeConfiguration: { eventBridgeEnabled: true },
    };

    /**
     * Transcoded static-CMAF output bucket; the CloudFront (OAC) origin. Optional retention rule
     * expires outputs after `destinationRetentionDays` when provided (omitted = keep forever).
     */
    const destinationLifecycleRules: s3.LifecycleRule[] = [];
    if (context.destinationRetentionDays !== undefined) {
      destinationLifecycleRules.push({
        id: `${cdk.Aws.STACK_NAME}-destination-expiry`,
        expiration: cdk.Duration.days(context.destinationRetentionDays),
      });
    }

    this.destinationBucket = new s3.Bucket(this, 'DestinationBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'destination-bucket-logs/',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: destinationLifecycleRules.length > 0 ? destinationLifecycleRules : undefined,
      // CORS so the origin answers CMAF players' cross-origin OPTIONS preflight. CloudFront forwards
      // OPTIONS + the CORS request headers (Managed CORS-S3Origin origin-request policy) to S3, which
      // returns the preflight response; the CloudFront CORS-With-Preflight response-headers policy
      // then ensures the CORS headers on all responses. All origins are allowed uniformly, so the
      // preflight response is identical for every viewer and safe to cache.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 86400,
        },
      ],
    });

    /**
     * Job-tracking table. Named for the stack (carried from v6; also the `workflowName` written by
     * the ASL). PK `guid`; PAY_PER_REQUEST; point-in-time recovery (satisfies AwsSolutions-DDB3);
     * RETAIN. The GSI matches the query pattern (`srcBucket` + `startTime`) carried from v6.
     */
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: cdk.Aws.STACK_NAME,
      partitionKey: { name: 'guid', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: SRC_BUCKET_START_TIME_INDEX,
      partitionKey: { name: 'srcBucket', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startTime', type: dynamodb.AttributeType.STRING },
    });

    /**
     * Intermediate mezzanine bucket for the two-job packaging overlay (only when ON). Job1's
     * TS-HLS ABR ladder lands here (clear, full-resolution) and job2 (REMUX_ALL) re-ingests it. It is
     * a **dedicated non-origin** bucket - NOT the CloudFront-origin destination bucket - so the clear
     * renditions are never reachable via the CDN. Same block-public/enforceSSL/SSE/RETAIN hardening as
     * the other buckets, server-access-logged to the shared logs bucket (satisfies AwsSolutions-S1), a
     * short ~1-day expiry (the mezzanine is throwaway once job2 completes), and deliberately:
     *   - NO EventBridge notification (a mezzanine write must not recursively re-trigger the workflow), and
     *   - NO `autoDeleteObjects` (it injects a Custom Resource Lambda, breaking the zero-Lambda invariant).
     */
    if (context.packagingProfile === 'ON') {
      this.intermediateBucket = new s3.Bucket(this, 'IntermediateBucket', {
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        serverAccessLogsBucket: this.logsBucket,
        serverAccessLogsPrefix: 'intermediate-bucket-logs/',
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            id: `${cdk.Aws.STACK_NAME}-intermediate-expiry`,
            expiration: cdk.Duration.days(1),
          },
        ],
      });
    }

    // Extensions: extra buckets in this scope (hardened like the intermediate bucket, logging to logsBucket).
    for (const extension of extensionsWith(context.extensions, 'storage')) {
      extension.storage(this, this.logsBucket);
    }
  }

  /**
   * Grant read on the source bucket: `s3:GetObject`/`s3:GetObjectVersion` on objects +
   * `s3:ListBucket` on the bucket. Consumed by the Ingest state-machine role (MediaConvert Probe
   * reads the source) and the MediaConvert service role (transcode input).
   */
  public grantSourceRead(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resourceArns: [this.sourceBucket.bucketArn, this.sourceBucket.arnForObjects('*')],
    });
  }

  /**
   * Grant object tagging on the source bucket (`s3:PutObjectTagging`/`s3:PutObjectVersionTagging`).
   * Consumed by the Publish state-machine role (`Tag Source` writes the stack-name archive tag; it
   * never strips the key). Object-scoped only — no bucket-level or delete permissions.
   */
  public grantSourceTagging(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
      resourceArns: [this.sourceBucket.arnForObjects('*')],
    });
  }

  /**
   * Grant `s3:PutObject` on the destination bucket objects. Consumed by the MediaConvert service
   * role to write the CMAF output. Least-privilege replacement for v6's broad S3 policy.
   */
  public grantDestinationWrite(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['s3:PutObject'],
      resourceArns: [this.destinationBucket.arnForObjects('*')],
    });
  }

  /** Grant `dynamodb:PutItem` on the table. Consumed by the Ingest role (`Record Ingest`). */
  public grantTablePut(grantee: iam.IGrantable): iam.Grant {
    return this.table.grant(grantee, 'dynamodb:PutItem');
  }

  /**
   * Grant `dynamodb:UpdateItem` on the table. Consumed by the Process (`Record Job`) and Publish
   * (`Record Publish`) roles.
   */
  public grantTableUpdate(grantee: iam.IGrantable): iam.Grant {
    return this.table.grant(grantee, 'dynamodb:UpdateItem');
  }

  /**
   * Grant `s3:PutObject` on the intermediate bucket objects. Consumed by the MediaConvert service
   * role for the packaging-overlay job1 (TS-HLS ladder). Only valid when `packagingProfile=ON`.
   */
  public grantIntermediateWrite(grantee: iam.IGrantable): iam.Grant {
    if (!this.intermediateBucket) {
      throw new Error('grantIntermediateWrite requires packagingProfile=ON (no intermediate bucket).');
    }
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['s3:PutObject'],
      resourceArns: [this.intermediateBucket.arnForObjects('*')],
    });
  }

  /**
   * Grant read (`s3:GetObject`/`s3:GetObjectVersion` + `s3:ListBucket`) on the intermediate bucket.
   * Consumed by the MediaConvert service role for the packaging-overlay job2 (REMUX_ALL) reading the
   * job1 HLS master + variants + segments. Only valid when `packagingProfile=ON`.
   */
  public grantIntermediateRead(grantee: iam.IGrantable): iam.Grant {
    if (!this.intermediateBucket) {
      throw new Error('grantIntermediateRead requires packagingProfile=ON (no intermediate bucket).');
    }
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resourceArns: [this.intermediateBucket.bucketArn, this.intermediateBucket.arnForObjects('*')],
    });
  }
}
