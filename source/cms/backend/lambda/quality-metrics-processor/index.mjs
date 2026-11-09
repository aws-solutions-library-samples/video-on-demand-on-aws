/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                                *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at http://www.apache.org/licenses/LICENSE-2.0                  *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * Quality-metrics rescue Lambda. Triggered by MediaConvert's native `Job State Change` EventBridge
 * event (COMPLETE, filtered to this stack's jobs via `detail.userMetadata.workflow`) - no GA-core changes
 * needed, MediaConvert emits this automatically. `userMetadata.workflow` alone can't tell a packaging-mode
 * ladder job1 (writes per-frame-metrics CSVs to the private, 1-day-TTL intermediate bucket) apart from a
 * packaging job2 or a GA-mode single job (CSVs already durable in the destination bucket, nothing to
 * rescue) - all three share the same `workflow` value. So this Lambda calls `GetJob` and inspects the job's
 * own `Settings` to self-determine relevance: does any output have `PerFrameMetrics` set, and does any
 * output group's Destination point at the intermediate bucket? Only then does it do any S3 work. One
 * invocation per completed job; by the time a job reaches COMPLETE every one of its outputs (including the
 * per-frame-metrics CSVs) is guaranteed present, so there is no need to poll/wait for stragglers.
 */
import { MediaConvertClient, GetJobCommand, DescribeEndpointsCommand } from '@aws-sdk/client-mediaconvert';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION;
const INTERMEDIATE_BUCKET = process.env.INTERMEDIATE_BUCKET || '';
const DESTINATION_BUCKET = process.env.DESTINATION_BUCKET;

const s3 = new S3Client({ region: REGION });
const mcBase = new MediaConvertClient({ region: REGION });
let mcClient; // account-specific endpoint, resolved once per warm Lambda

async function mediaConvert() {
  if (mcClient) return mcClient;
  const { Endpoints } = await mcBase.send(new DescribeEndpointsCommand({}));
  const endpoint = Endpoints?.[0]?.Url;
  mcClient = endpoint ? new MediaConvertClient({ region: REGION, endpoint }) : mcBase;
  return mcClient;
}

// The known MediaConvert `FrameMetricType` values (source/core/lib/asl.ts's `PER_FRAME_METRIC_TYPES`).
const METRIC_TYPES = ['PSNR', 'PSNR_HVS', 'SSIM', 'MS_SSIM', 'VMAF', 'QVBR', 'SHOT_CHANGE'];
const METRIC_SUFFIX = new RegExp(`_(${METRIC_TYPES.join('|')})\\.csv$`);

/** Same CSV shape as MediaConvert's per-frame-metrics reports: a `Display_ID,Value` header, one row per
 * frame, then three trailing summary lines that are NOT CSV rows. */
function parseQualityMetricsCsv(text) {
  const series = [];
  let average = null;
  let min = null;
  let max = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const summary = line.match(/^(Average|Min|Max):\s*([\d.eE+-]+)/i);
    if (summary) {
      const value = Number(summary[2]);
      const label = summary[1].toLowerCase();
      if (label === 'average') average = value;
      else if (label === 'min') min = value;
      else if (label === 'max') max = value;
      continue;
    }
    const row = line.match(/^(-?\d+)\s*,\s*(-?[\d.eE+-]+)\s*$/);
    if (row) series.push({ frame: Number(row[1]), value: Number(row[2]) });
  }
  return { series, average, min, max };
}

/** Does this job have PerFrameMetrics on any output AND write to the intermediate bucket? Group-settings
 * field names vary by output-group type (FileGroupSettings/HlsGroupSettings/...), so rather than enumerate
 * every type, just check the serialized group for the bucket URI - simpler and robust to type. */
function isRescuableJob(settings) {
  if (!INTERMEDIATE_BUCKET) return false; // packagingProfile=OFF on the main stack - nothing to rescue
  const groups = settings?.OutputGroups ?? [];
  return groups.some((group) => {
    const hasMetrics = (group.Outputs ?? []).some((output) => {
      const codecSettings = output?.VideoDescription?.CodecSettings ?? {};
      return Object.values(codecSettings).some((s) => Array.isArray(s?.PerFrameMetrics) && s.PerFrameMetrics.length > 0);
    });
    return hasMetrics && JSON.stringify(group.OutputGroupSettings ?? {}).includes(`s3://${INTERMEDIATE_BUCKET}/`);
  });
}

export const handler = async (event) => {
  const jobId = event.detail?.jobId;
  if (!jobId) return;

  const mc = await mediaConvert();
  const { Job: job } = await mc.send(new GetJobCommand({ Id: jobId }));
  const guid = job?.UserMetadata?.guid;
  if (!guid || !isRescuableJob(job?.Settings)) return;

  const prefix = `${guid}/`;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: INTERMEDIATE_BUCKET, Prefix: prefix }));
  const matches = (listed.Contents ?? []).filter((obj) => METRIC_SUFFIX.test(obj.Key));

  for (const obj of matches) {
    const csv = await s3.send(new GetObjectCommand({ Bucket: INTERMEDIATE_BUCKET, Key: obj.Key }));
    const text = await csv.Body.transformToString();
    const parsed = parseQualityMetricsCsv(text);
    await s3.send(
      new PutObjectCommand({
        Bucket: DESTINATION_BUCKET,
        Key: obj.Key.replace(/\.csv$/, '.json'),
        Body: JSON.stringify(parsed),
        ContentType: 'application/json',
      }),
    );
  }
};
