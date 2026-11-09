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

/** Per-frame quality metrics overlay (`perFrameMetrics=ON`): the job-settings splice + the DynamoDB record. */

import { VodContext } from '../context';
import { JsonObject } from './types';

/**
 * MediaConvert per-frame quality metrics (opt-in QC add-on). When `perFrameMetrics` is set on
 * {@link JobSettingsOptions}, this list is written to each encode output's codec-settings
 * `PerFrameMetrics` (a `FrameMetricType[]`), and MediaConvert emits one CSV per output + metric
 * (e.g. `<output>_VMAF.csv`) alongside the media. VMAF adds notable encode time (up to ~2x on 4K).
 * QVBR is a per-frame QVBR quality level (1-10) and is only valid because our encodes use QVBR rate
 * control; SHOT_CHANGE flags scene changes per frame. Valid FrameMetricType values (choose here):
 * PSNR | PSNR_HVS | SSIM | MS_SSIM | VMAF | QVBR | SHOT_CHANGE.
 */
export const PER_FRAME_METRIC_TYPES = ['VMAF', 'QVBR', 'SHOT_CHANGE'] as const;

/**
 * Enable per-frame quality metrics on a single output group (mutating it in place): set
 * `PerFrameMetrics` on each VIDEO output's codec-settings block (e.g. `H264Settings`). Audio outputs
 * and PASSTHROUGH video (no codec-settings block — the REMUX_ALL job2) are skipped. See
 * {@link PER_FRAME_METRIC_TYPES}.
 */
export function applyPerFrameMetricsToGroup(group: JsonObject): void {
  const outputs = Array.isArray(group.Outputs) ? (group.Outputs as JsonObject[]) : [];
  for (const output of outputs) {
    const videoDescription = output.VideoDescription as JsonObject | undefined;
    const codecSettings = videoDescription?.CodecSettings as JsonObject | undefined;
    if (!codecSettings) {
      continue; // audio-only output: no per-frame metrics.
    }
    // The codec-specific block (e.g. H264Settings) carries PerFrameMetrics; PASSTHROUGH video has none.
    const codecKey = Object.keys(codecSettings).find((k) => k.endsWith('Settings'));
    if (!codecKey) {
      continue; // PASSTHROUGH (no re-encode): metrics not applicable.
    }
    (codecSettings[codecKey] as JsonObject).PerFrameMetrics = [...PER_FRAME_METRIC_TYPES];
  }
}

/**
 * Persist the per-frame quality-metrics descriptor to the DynamoDB item (mutating `states` in place):
 * add `qualityMetrics` (the comma-joined metric list) and `qualityMetricsPrefix` (the S3 URI prefix under
 * which MediaConvert wrote the CSV reports) to `Record Job`, deriving the prefix in `Build Playback URLs`.
 *
 * The CSVs land next to the encode outputs: the intermediate bucket (packaging ON, ladder job1) or the
 * destination bucket (GA CMAF). The operator console reads these two attributes (it never touches S3) to
 * show a "Quality metrics" section per asset. Only encode jobs emit metrics, so nothing extra is needed on
 * the REMUX_ALL passthrough job2. `process.asl.json` on disk is never edited.
 */
export function injectQualityMetricsRecord(states: JsonObject, context: VodContext): void {
  const bucketToken = context.packagingProfile === 'ON' ? 'INTERMEDIATE_BUCKET' : 'DESTINATION_BUCKET';

  const buildUrls = states['Build Playback URLs'] as JsonObject | undefined;
  const urlParams = buildUrls?.Parameters as JsonObject | undefined;
  if (!urlParams) {
    throw new Error("Process ASL 'Build Playback URLs' is missing Parameters for the per-frame-metrics record.");
  }
  urlParams['qualityMetricsPrefix.$'] = `States.Format('s3://\${${bucketToken}}/{}/', $.guid)`;

  const recordJob = states['Record Job'] as JsonObject | undefined;
  const params = recordJob?.Parameters as JsonObject | undefined;
  const values = params?.ExpressionAttributeValues as JsonObject | undefined;
  if (!params || !values || typeof params.UpdateExpression !== 'string') {
    throw new Error("Process ASL 'Record Job' is missing UpdateExpression/ExpressionAttributeValues for the per-frame-metrics record.");
  }
  params.UpdateExpression = `${params.UpdateExpression}, qualityMetrics = :qm, qualityMetricsPrefix = :qmp`;
  values[':qm'] = { S: PER_FRAME_METRIC_TYPES.join(',') };
  values[':qmp'] = { 'S.$': '$.qualityMetricsPrefix' };
}
