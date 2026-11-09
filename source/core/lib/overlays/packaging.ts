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

/** REMUX_ALL multi-format packaging overlay (`packagingProfile=ON`): the `Package DRM` job2 injection. */

import { VodContext } from '../context';
import { buildJobSettings } from '../job-settings';
import { ENCODE_STATE_TIERS, JsonObject } from './types';

/** Per-group destination sub-paths for the REMUX_ALL job2 (Package DRM). Shared by every Package DRM variant. */
export const PACKAGE_GROUP_SUBPATHS: Readonly<Record<string, string>> = {
  'HLS-TS': 'hls/index',
  'CMAF-HLS': 'cmaf/index',
  DASH: 'dash/index',
};
/** The REMUX_ALL job2 input: the tier ladder's multivariant master in the intermediate bucket. */
export const PACKAGE_INPUT_REF = "States.Format('s3://${INTERMEDIATE_BUCKET}/{}/stream.m3u8', $.guid)";

/** The `Package DRM` Task comment (an extension that protects the outputs may replace it). */
export const PACKAGE_JOB_COMMENT =
  'Packaging overlay JOB2: REMUX_ALL passthrough of the tier TS-HLS ladder (input VideoSelector left AUTO, so all mezzanine renditions pass through) into three delivery formats under <guid>/{hls,cmaf,dash}/ (HLS/TS, CMAF-HLS, DASH).';

/** Per-format labels in the packaging success-notification summary (fixed width, so the URLs line up). */
export interface PackageOutputLabels {
  readonly hls: string;
  readonly cmaf: string;
  readonly dash: string;
}

/** The clear-output labels. An extension that encrypts a format relabels it (see {@link packageOutputsSummary}). */
export const PACKAGE_OUTPUT_LABELS: PackageOutputLabels = {
  hls: 'HLS (TS, clear):  ',
  cmaf: 'HLS (CMAF):          ',
  dash: 'DASH:                ',
};

/**
 * The `Build Playback URLs` `outputsSummary.$` intrinsic: every packaged output + the job1 mezzanine, built
 * from $.guid (+ the CLOUDFRONT_DOMAIN / INTERMEDIATE_BUCKET substitutions) so it never self-references the
 * hlsUrl/dashUrl set in the same Parameters block. Newlines are real; ${...} stay as substitutions.
 */
export function packageOutputsSummary(labels: PackageOutputLabels): string {
  return (
    "States.Format('" + labels.hls + " https://${CLOUDFRONT_DOMAIN}/{}/hls/index.m3u8\n" +
    labels.cmaf + ' https://${CLOUDFRONT_DOMAIN}/{}/cmaf/index.m3u8\n' +
    labels.dash + ' https://${CLOUDFRONT_DOMAIN}/{}/dash/index.mpd\n\n' +
    "Mezzanine (job1 TS-HLS ladder): s3://${INTERMEDIATE_BUCKET}/{}/stream.m3u8', $.guid, $.guid, $.guid, $.guid)"
  );
}

/**
 * Inject the packaging overlay into the Process ASL (mutating `states` in place). Each tier encode
 * (`Encode SD|HD|UHD`) already produces that tier's TS-HLS Automated-ABR ladder in the intermediate
 * bucket (the job1 mezzanine — spliced by {@link composeProcessAsl}); here they are re-pointed at a
 * single `Package DRM` job2: a REMUX_ALL passthrough whose input `VideoSelector` is left AUTO, so it
 * passes through EVERY mezzanine rendition regardless of count (verified live), fanned
 * out to three delivery formats under `<guid>/{hls,cmaf,dash}/`. `Package DRM` is a
 * clone of `Encode SD` (same createJob.sync shape, Role/Queue/Tags/Retry/Catch, incl. the SolutionId=SO9674
 * tag the Process role's tag-scoped GetJob/CancelJob requires), retargeted via `buildJobSettings('package')`.
 * The GA `Choose Tier` routing is left intact — the tier now selects the mezzanine ladder — so no
 * always-true arm is added.
 */
export function injectPackagingStates(states: JsonObject, context: VodContext): void {
  const encodeSd = states['Encode SD'] as JsonObject | undefined;
  if (!encodeSd) {
    throw new Error("Process ASL is missing 'Encode SD' for the packaging overlay.");
  }
  // Clone the tier encode shape BEFORE re-pointing the tier states below.
  const packageDrm = JSON.parse(JSON.stringify(encodeSd)) as JsonObject;

  // Re-point each tier encode (job1 mezzanine) at the packaging job. Their createJob result goes to
  // $.ladderOutput so it does not clobber $.jobOutput, which is reserved for the final Package DRM job
  // (Build Playback URLs reads $.jobOutput.Job.Id).
  for (const { state } of ENCODE_STATE_TIERS) {
    const encodeState = states[state] as JsonObject | undefined;
    if (!encodeState) {
      throw new Error(`Process ASL is missing the '${state}' state for the packaging overlay.`);
    }
    encodeState.ResultPath = '$.ladderOutput';
    encodeState.Next = 'Package DRM';
  }

  packageDrm.Comment = PACKAGE_JOB_COMMENT;
  (packageDrm.Parameters as JsonObject).Settings = buildJobSettings('package', {
    inputRef: PACKAGE_INPUT_REF,
    groupSubPaths: PACKAGE_GROUP_SUBPATHS,
    extensions: context.extensions,
  });
  packageDrm.ResultPath = '$.jobOutput';
  packageDrm.Next = 'Build Playback URLs';
  states['Package DRM'] = packageDrm;

  // Re-path the playback URLs to the per-format sub-paths (job2 writes each group under <guid>/<fmt>/).
  // process.asl.json stays byte-identical on disk; this mutates only the in-memory ON definition. The
  // recorded HLS URL is the HLS/TS deliverable and DASH the DASH deliverable; the CMAF-HLS deliverable at
  // <guid>/cmaf/ is recorded too (see the Record Job cmafUrl splice below) so the operator console can
  // surface all three packaged formats.
  const buildUrls = states['Build Playback URLs'] as JsonObject | undefined;
  const urlParams = buildUrls?.Parameters as JsonObject | undefined;
  if (urlParams) {
    urlParams['hlsManifest.$'] = "States.Format('{}/hls/index.m3u8', $.guid)";
    urlParams['dashManifest.$'] = "States.Format('{}/dash/index.mpd', $.guid)";
    urlParams['hlsUrl.$'] = "States.Format('https://${CLOUDFRONT_DOMAIN}/{}/hls/index.m3u8', $.guid)";
    urlParams['dashUrl.$'] = "States.Format('https://${CLOUDFRONT_DOMAIN}/{}/dash/index.mpd', $.guid)";
    urlParams['cmafUrl.$'] = "States.Format('https://${CLOUDFRONT_DOMAIN}/{}/cmaf/index.m3u8', $.guid)";
    // Success-notification body listing ALL packaged outputs + the job1 mezzanine (labels: see
    // {@link packageOutputsSummary}).
    urlParams['outputsSummary.$'] = packageOutputsSummary(PACKAGE_OUTPUT_LABELS);
  }

  // Persist the CMAF-HLS URL to the DynamoDB item so the operator console can show it alongside HLS/DASH.
  // The on-disk Record Job UpdateExpression only records hlsUrl/dashUrl (the single-job CMAF core has no
  // separate CMAF deliverable); the packaging overlay adds cmafUrl here (mirrors the per-frame-metrics
  // splice). OFF stays byte-identical.
  const recordJob = states['Record Job'] as JsonObject | undefined;
  const recordParams = recordJob?.Parameters as JsonObject | undefined;
  const recordValues = recordParams?.ExpressionAttributeValues as JsonObject | undefined;
  if (!recordParams || !recordValues || typeof recordParams.UpdateExpression !== 'string') {
    throw new Error("Process ASL 'Record Job' is missing UpdateExpression/ExpressionAttributeValues for the packaging cmafUrl record.");
  }
  recordParams.UpdateExpression = `${recordParams.UpdateExpression}, cmafUrl = :cmaf`;
  recordValues[':cmaf'] = { 'S.$': '$.cmafUrl' };
}
