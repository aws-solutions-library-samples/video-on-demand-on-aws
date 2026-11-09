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
 * MediaConvertConstruct for the VOD v7.0.0 stack.
 *
 * Replaces the v6 deploy-time custom resource that created MediaConvert templates/presets and
 * fetched the account endpoint. In the native, near-zero-Lambda GA stack the Process state
 * machine submits jobs with the optimized `mediaconvert:createJob.sync` integration, so all this
 * construct needs to provide is:
 *
 *   - a least-privilege MediaConvert service role (`assumedBy mediaconvert.amazonaws.com`) that the
 *     Process role passes to the service (`iam:PassRole`) — S3 read on the source bucket, S3 write
 *     on the destination bucket;
 *   - the account **Default** on-demand queue ARN (jobs run on the always-present Default queue);
 *   - a harmless account endpoint URL (the `.sync` integration resolves the real endpoint itself);
 *   - the three transformed per-tier `Settings` objects (from `asl.buildJobSettings`).
 */

import { Construct } from 'constructs';
import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import { buildJobSettings, JobTier, JsonObject } from '../asl';
import { IMediaConvertConstruct, MediaConvertConstructProps } from './interfaces';
import { extensionsWith } from '../extensions';

/** MediaConvert quality tiers, in ascending resolution order. */
const JOB_TIERS: readonly JobTier[] = ['sd', 'hd', 'uhd'];

export class MediaConvertConstruct extends Construct implements IMediaConvertConstruct {
  /** MediaConvert service role (`assumedBy mediaconvert.amazonaws.com`); PassRole target of the Process role. */
  public readonly role: iam.Role;
  /** `role.roleArn`. -> `${MEDIACONVERT_ROLE_ARN}`. */
  public readonly roleArn: string;
  /** Account Default on-demand queue ARN. -> `${MEDIACONVERT_QUEUE_ARN}`. */
  public readonly queueArn: string;
  /** MediaConvert account endpoint (region URL). Documentation/substitution convenience only. */
  public readonly endpoint: string;
  /** The three transformed per-tier MediaConvert `Settings` objects (from `asl.buildJobSettings`). */
  public readonly jobSettings: Readonly<Record<JobTier, JsonObject>>;

  constructor(scope: Construct, id: string, props: MediaConvertConstructProps) {
    super(scope, id);

    const { storage, context } = props;

    // Least-privilege MediaConvert service role. MediaConvert assumes this role to read the source
    // asset and write the transcoded static-CMAF outputs; the Process state machine passes it via
    // iam:PassRole (scoped to mediaconvert.amazonaws.com in the Process role).
    // Confused-deputy guard (per the MediaConvert docs): MediaConvert assumes the role only for jobs on
    // this account's queues in this Region.
    this.role = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': Stack.of(this).account },
          ArnLike: {
            'aws:SourceArn': Stack.of(this).formatArn({ service: 'mediaconvert', resource: 'queues', resourceName: '*' }),
          },
        },
      }),
      description: 'VOD MediaConvert service role: S3 read on source, S3 write on destination.',
    });

    // s3:GetObject/GetObjectVersion + s3:ListBucket on the source bucket (versioned).
    storage.grantSourceRead(this.role);
    // s3:PutObject on the destination bucket/* only.
    storage.grantDestinationWrite(this.role);

    this.roleArn = this.role.roleArn;

    // The account Default on-demand queue always exists; jobs are submitted to it. Built from
    // stack intrinsics so it resolves correctly across partitions/regions/accounts at deploy time.
    const stack = Stack.of(this);

    // Two-job packaging overlay (ON only): job1 writes the TS-HLS ladder to the intermediate
    // bucket and job2 (REMUX_ALL) reads it.
    if (context.packagingProfile === 'ON') {
      storage.grantIntermediateWrite(this.role); // job1 -> intermediate mezzanine
      storage.grantIntermediateRead(this.role); // job2 <- intermediate mezzanine
    }
    // Extensions: whatever their job-settings hooks make MediaConvert read or write.
    for (const extension of extensionsWith(context.extensions, 'mediaConvertRole')) {
      extension.mediaConvertRole(this.role, storage);
    }

    this.queueArn = `arn:${stack.partition}:mediaconvert:${stack.region}:${stack.account}:queues/Default`;

    // Regional service endpoint. The optimized createJob.sync integration resolves the real
    // account-specific endpoint automatically, so this is only exposed for the
    // `${MEDIACONVERT_ENDPOINT}` documentation substitution and is never used as a Task parameter.
    this.endpoint = `https://mediaconvert.${stack.region}.amazonaws.com`;

    // Transform the three tier job templates once at synth time (runtime ${INPUT_URI}/${DESTINATION}
    // placeholders already rewritten to .$ intrinsics by buildJobSettings).
    this.jobSettings = JOB_TIERS.reduce((acc, tier) => {
      acc[tier] = buildJobSettings(tier);
      return acc;
    }, {} as Record<JobTier, JsonObject>);
  }
}
