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

/** Thumbnails/poster overlay (`thumbnailsProfile`, default ON): the FRAME_CAPTURE group + the DynamoDB record. */

import { sentinelForDestination } from './jsonata';
import { JsonObject } from './types';

/**
 * FRAME_CAPTURE defaults for the thumbnails/poster overlay: one JPEG every 5s (1/5 fps), capped at 500
 * captures, 640px wide (aspect preserved), quality 80. The first capture is the poster. Tune here.
 */
export const FRAME_CAPTURE_DEFAULTS = {
  width: 640,
  framerateNumerator: 1,
  framerateDenominator: 5,
  maxCaptures: 500,
  quality: 80,
} as const;

/**
 * Append a FRAME_CAPTURE output group (mutating `settings` in place): poster + periodic thumbnail JPEGs
 * written to `s3://<destination-bucket>/<guid>/thumbnails/` (the CloudFront-served bucket), regardless of
 * where the encode's other groups write. The first capture (`frame.0000000.jpg`) is the poster; captures
 * continue at {@link FRAME_CAPTURE_DEFAULTS} cadence up to `MaxCaptures`. The destination is a fixed
 * `${DESTINATION_BUCKET}` intrinsic (not derived from the caller's `destBucketToken`), so it lands in the
 * served bucket even on the packaging ladder job1 (which targets the intermediate bucket). No audio; a
 * `RAW` container. Called only when {@link JobSettingsOptions.thumbnails} is set. `jsonataMode` mirrors
 * {@link JobSettingsOptions.jsonata} — see {@link SENTINEL_FILE_INPUT} doc for why the Destination is a
 * sentinel (via {@link sentinelForDestination}) rather than a `.$` intrinsic in that mode.
 */
export function appendFrameCaptureGroup(settings: JsonObject, jsonataMode: boolean): void {
  const groups = settings.OutputGroups;
  if (!Array.isArray(groups)) {
    throw new Error('Job template Settings.OutputGroups is missing or not an array; cannot append the FRAME_CAPTURE group.');
  }
  groups.push({
    Name: 'Thumbnails',
    OutputGroupSettings: {
      Type: 'FILE_GROUP_SETTINGS',
      FileGroupSettings: {
        // Base filename 'frame' (NOT a trailing slash): a slash-terminated Destination makes MediaConvert
        // prepend the SOURCE basename, which is not derivable from $.guid — so files would not match the
        // recorded posterUrl. With an explicit base and no NameModifier the outputs are deterministically
        // '<guid>/thumbnails/frame.0000000.jpg', '...0000001.jpg', ... (poster = the first).
        ...(jsonataMode
          ? { Destination: sentinelForDestination('thumbnails/frame') }
          : { 'Destination.$': "States.Format('s3://${DESTINATION_BUCKET}/{}/thumbnails/frame', $.guid)" }),
      },
    },
    Outputs: [
      {
        ContainerSettings: { Container: 'RAW' },
        VideoDescription: {
          Width: FRAME_CAPTURE_DEFAULTS.width,
          ScalingBehavior: 'DEFAULT',
          CodecSettings: {
            Codec: 'FRAME_CAPTURE',
            FrameCaptureSettings: {
              FramerateNumerator: FRAME_CAPTURE_DEFAULTS.framerateNumerator,
              FramerateDenominator: FRAME_CAPTURE_DEFAULTS.framerateDenominator,
              MaxCaptures: FRAME_CAPTURE_DEFAULTS.maxCaptures,
              Quality: FRAME_CAPTURE_DEFAULTS.quality,
            },
          },
        },
      },
    ],
  });
}

/**
 * Persist the thumbnails/poster descriptor to the DynamoDB item (mutating `states` in place): add
 * `thumbnailsPrefix` (the CloudFront URL prefix under `<guid>/thumbnails/`) and `posterUrl` (the first
 * capture, `frame.0000000.jpg`) to `Record Job`, deriving both in `Build Playback URLs` from `$.guid` +
 * the fixed `${CLOUDFRONT_DOMAIN}` substitution. CloudFront URLs (not S3 URIs) because these are
 * consumer-facing for the CMS/EPG. The naming is the same deterministic contract the FRAME_CAPTURE group
 * writes (Destination base `<guid>/thumbnails/frame`, no NameModifier). `process.asl.json` on disk is never edited.
 */
export function injectThumbnailsRecord(states: JsonObject): void {
  const buildUrls = states['Build Playback URLs'] as JsonObject | undefined;
  const urlParams = buildUrls?.Parameters as JsonObject | undefined;
  if (!urlParams) {
    throw new Error("Process ASL 'Build Playback URLs' is missing Parameters for the thumbnails record.");
  }
  urlParams['thumbnailsPrefix.$'] = "States.Format('https://${CLOUDFRONT_DOMAIN}/{}/thumbnails/', $.guid)";
  urlParams['posterUrl.$'] = "States.Format('https://${CLOUDFRONT_DOMAIN}/{}/thumbnails/frame.0000000.jpg', $.guid)";

  const recordJob = states['Record Job'] as JsonObject | undefined;
  const params = recordJob?.Parameters as JsonObject | undefined;
  const values = params?.ExpressionAttributeValues as JsonObject | undefined;
  if (!params || !values || typeof params.UpdateExpression !== 'string') {
    throw new Error("Process ASL 'Record Job' is missing UpdateExpression/ExpressionAttributeValues for the thumbnails record.");
  }
  params.UpdateExpression = `${params.UpdateExpression}, thumbnailsPrefix = :tp, posterUrl = :pu`;
  values[':tp'] = { 'S.$': '$.thumbnailsPrefix' };
  values[':pu'] = { 'S.$': '$.posterUrl' };
}
