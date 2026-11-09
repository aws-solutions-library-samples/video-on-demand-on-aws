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
 * MediaConvert job-template loader + transform ({@link buildJobSettings}). Lives apart from `./asl.ts`
 * (which re-exports it) so the overlay modules that build job settings (`./overlays/packaging.ts`,
 * `./overlays/variants.ts`) can import it without an import cycle through the composer.
 */

import * as fs from 'fs';
import * as path from 'path';

import { applyEsamToSettings, applyScte35ToGroup } from './overlays/ad-markers';
import { applyCaptionSelector, applyCaptionsToGroup } from './overlays/captions';
import { SENTINEL_FILE_INPUT, sentinelForDestination } from './overlays/jsonata';
import { applyPerFrameMetricsToGroup } from './overlays/metrics';
import { appendFrameCaptureGroup } from './overlays/thumbnails';
import { JobProfile, JobSettingsOptions, JsonObject } from './overlays/types';
import { extensionsWith } from './extensions';

const JOB_TEMPLATES_DIR = path.join(__dirname, 'job-templates');

/**
 * Profile -> template filename. Explicit (NOT `${profile}.json`): `package` maps to `package-drm.json`,
 * so a bare interpolation would look for a nonexistent `package.json` and fail at synth.
 */
const PROFILE_TEMPLATE_FILE: Readonly<Record<JobProfile, string>> = {
  sd: 'sd.json',
  hd: 'hd.json',
  uhd: 'uhd.json',
  'sd-ladder': 'sd-ladder.json',
  'hd-ladder': 'hd-ladder.json',
  'uhd-ladder': 'uhd-ladder.json',
  package: 'package-drm.json',
};

/** Output-group settings keys buildJobSettings knows how to rewrite the `Destination` on. */
const OUTPUT_GROUP_SETTINGS_KEYS = [
  'CmafGroupSettings',
  'HlsGroupSettings',
  'DashIsoGroupSettings',
  'MsSmoothGroupSettings',
] as const;

/** Read + parse a JSON file, throwing a contextual error if it is missing or malformed. */
export function readJson(filePath: string): JsonObject {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Unable to read ASL/job-template file at ${filePath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as JsonObject;
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Read a job-template profile and transform its per-execution runtime placeholders into ASL
 * intrinsic (`.$`) keys, returning the resulting MediaConvert `Settings` object.
 *
 * With default {@link JobSettingsOptions} this reproduces the GA single-job behavior exactly:
 * `Inputs[0].FileInput` -> `"FileInput.$": "$.fileUri"`, and the single output group's `Destination`
 * -> `"Destination.$": "States.Format('s3://${DESTINATION_BUCKET}/{}/index', $.guid)"`.
 *
 * For multi-group templates (the `package` profile) it rewrites the `Destination` on EVERY output
 * group (each to a per-group sub-path from {@link JobSettingsOptions.groupSubPaths}). The `${...BUCKET}`
 * token inside each intrinsic remains a scalar substitution resolved at stringify. Extensions in
 * {@link JobSettingsOptions.extensions} then adjust each group and the whole Settings.
 */
export function buildJobSettings(profile: JobProfile, opts: JobSettingsOptions = {}): JsonObject {
  const inputRef = opts.inputRef ?? '$.fileUri';
  const destBucketToken = opts.destBucketToken ?? 'DESTINATION_BUCKET';
  const file = PROFILE_TEMPLATE_FILE[profile];
  const settings = readJson(path.join(JOB_TEMPLATES_DIR, file));

  const inputs = settings.Inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error(`Job template '${file}' is missing Inputs[0].`);
  }
  const input = inputs[0] as JsonObject;
  delete input.FileInput; // was '${INPUT_URI}'
  if (opts.jsonata) {
    input.FileInput = SENTINEL_FILE_INPUT;
  } else {
    input['FileInput.$'] = inputRef;
  }

  // Captions (mode 'captions' only): declare a single input CaptionSelector reading the sidecar file by
  // s3:// URI (a `.$` intrinsic like FileInput, or the SENTINEL_SOURCE_FILE placeholder in JSONata mode).
  // The per-group caption outputs are appended in the loop.
  if (opts.captions) {
    applyCaptionSelector(input, opts.captions, Boolean(opts.jsonata));
  }

  const outputGroups = settings.OutputGroups;
  if (!Array.isArray(outputGroups) || outputGroups.length === 0) {
    throw new Error(`Job template '${file}' is missing OutputGroups[0].`);
  }

  // Rewrite Destination on EVERY output group (single-group templates loop once -> byte-identical).
  for (const group of outputGroups as JsonObject[]) {
    const groupName = typeof group.Name === 'string' ? group.Name : undefined;
    const outputGroupSettings = group.OutputGroupSettings as JsonObject | undefined;
    const groupKey = OUTPUT_GROUP_SETTINGS_KEYS.find((k) => outputGroupSettings?.[k]);
    const groupSettings = groupKey ? (outputGroupSettings?.[groupKey] as JsonObject) : undefined;
    if (!groupSettings) {
      throw new Error(
        `Job template '${file}' output group '${groupName ?? '?'}' is missing a recognized OutputGroupSettings.<${OUTPUT_GROUP_SETTINGS_KEYS.join('|')}>.`,
      );
    }
    const subPath = (groupName && opts.groupSubPaths?.[groupName]) || opts.destSubPath || 'index';
    delete groupSettings.Destination; // was '${DESTINATION}'
    if (opts.jsonata) {
      groupSettings.Destination = sentinelForDestination(subPath);
    } else {
      groupSettings['Destination.$'] = `States.Format('s3://\${${destBucketToken}}/{}/${subPath}', $.guid)`;
    }

    // SCTE-35 ad markers (ESAM): set the per-output container SCTE-35 fields on this group. The root
    // Settings.Esam block (mode 'esam' only) is added once after the loop.
    if (opts.esam) {
      applyScte35ToGroup(group, groupKey!);
    }

    // Per-frame quality metrics: set PerFrameMetrics on each encoded video output (no-op on PASSTHROUGH).
    if (opts.perFrameMetrics) {
      applyPerFrameMetricsToGroup(group);
    }

    // Captions (mode 'captions' only): append a WebVTT (HLS/CMAF) or IMSC (DASH) caption output.
    if (opts.captions) {
      applyCaptionsToGroup(group, groupKey!);
    }

    // Extensions: per-group adjustments, after the core rewrites above.
    for (const extension of extensionsWith(opts.extensions, 'outputGroup')) {
      extension.outputGroup(profile, groupKey!, groupSettings, opts);
    }
  }

  // ESAM (mode 'esam' only): inject the SignalProcessingNotification SCC XML at the Settings root as a
  // `.$` intrinsic (MediaConvert takes the ESAM document inline as a string). ResponseSignalPreroll=0
  // removes MediaConvert's default 4s preroll so the marker is not placed one segment early.
  if (opts.esam) {
    applyEsamToSettings(settings, opts.esam, Boolean(opts.jsonata));
  }

  // Thumbnails/poster overlay: append a FRAME_CAPTURE group LAST — after the per-group destination
  // rewrite and the per-output (ESAM/PerFrameMetrics) loops above — so those never see it and its
  // FILE_GROUP_SETTINGS destination stays pinned to the DESTINATION bucket (not the intermediate bucket,
  // even when this rides the packaging ladder job1).
  if (opts.thumbnails) {
    appendFrameCaptureGroup(settings, Boolean(opts.jsonata));
  }

  // Extensions: whole-Settings adjustments LAST (e.g. an appended output group), for the same reason.
  for (const extension of extensionsWith(opts.extensions, 'jobSettings')) {
    extension.jobSettings(profile, settings, opts);
  }

  return settings;
}
