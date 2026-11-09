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
 * Shared ASL (Amazon States Language) loader + transform for the VOD v7.0.0 stack.
 *
 * The three state-machine definitions and the three MediaConvert job templates live as raw
 * JSON under `lib/state-machines/*.asl.json` and `lib/job-templates/*.json`. They are read at
 * synth time with `fs.readFileSync` (NOT `import`), so no `resolveJsonModule` is required and
 * the raw text is available for `${...}` `definitionSubstitutions`.
 *
 * Most `${...}` tokens in the ASL are simple scalar substitutions resolved by the CDK
 * `StateMachine` at synth time. Three of them are NOT scalars and must be spliced structurally
 * BEFORE the ASL is stringified, or MediaConvert would receive a string where it expects an
 * object (or a synth-time constant where a per-execution `.$` reference is required):
 *
 *   - `${JOB_SETTINGS_SD|HD|UHD}` (Process Encode states) -> the full tier `Settings` OBJECT.
 *   - `${INPUT_URI}`  (job template Inputs[0].FileInput)  -> `"FileInput.$": "$.fileUri"`.
 *   - `${DESTINATION}` (job template CmafGroupSettings)   -> a per-execution `Destination.$`.
 *
 * This module is the public entry point and owns the compose pipeline (the order overlays are applied
 * in). The job-template transform lives in `./job-settings.ts`; each opt-in overlay's synth-time
 * transform lives in `./overlays/` (one module per overlay, plus the shared JSONata variant engine).
 */

import * as path from 'path';

import { VodContext } from './context';
import { buildJobSettings, readJson } from './job-settings';
import { injectEsamSidecarStates } from './overlays/ad-markers';
import {
  AD_MARKERS_REQUESTED,
  assetMetadataReadState,
  CAPTIONS_REQUESTED,
  READ_ASSET_METADATA,
  sidecarGateState,
} from './overlays/asset-metadata';
import { captionSidecarReadState } from './overlays/captions';
import { injectQualityMetricsRecord } from './overlays/metrics';
import { injectPackagingStates } from './overlays/packaging';
import { injectThumbnailsRecord } from './overlays/thumbnails';
import { ENCODE_STATE_TIERS, JobProfile, JsonObject } from './overlays/types';
import { applyCaptionsAndAdMarkersOverlays } from './overlays/variants';
import { extensionsWith } from './extensions';

// Public surface: the job-settings builder + shared types live in their own modules (to keep the overlay
// modules free of an import cycle through this composer) and are re-exported here.
export { buildJobSettings, readJson } from './job-settings';
export type { CaptionsInjection, EsamInjection, JobProfile, JobSettingsOptions, JobTier, JsonObject } from './overlays/types';

const STATE_MACHINES_DIR = path.join(__dirname, 'state-machines');

/**
 * Load and parse a state-machine ASL definition by name (`ingest` | `process` | `publish`).
 *
 * Returns the raw parsed object; `${...}` tokens are left intact for the CDK `StateMachine`
 * `definitionSubstitutions` to resolve at synth time (except the structural splices handled
 * by {@link composeProcessAsl}).
 */
export function loadAsl(name: string): JsonObject {
  return readJson(path.join(STATE_MACHINES_DIR, `${name}.asl.json`));
}

/**
 * Compose the Process state-machine ASL by splicing each tier's transformed `Settings` OBJECT
 * into the corresponding Encode state's `Parameters.Settings` (replacing the
 * `${JOB_SETTINGS_SD|HD|UHD}` string placeholder). The splice happens BEFORE any
 * `JSON.stringify`, so `Settings` remains a JSON object (never a string) in the rendered ASL.
 *
 * When `context.packagingProfile === 'ON'`, the tier splice above uses each tier's TS-HLS ladder
 * (to the intermediate bucket) and this additionally injects the packaging overlay: each
 * `Encode SD|HD|UHD` (job1 mezzanine) is re-pointed at a single `Package DRM` REMUX_ALL job2,
 * mutating the loaded ASL in memory — `process.asl.json` on disk is never edited. When OFF (default),
 * only the sd/hd/uhd CMAF splice runs, so the rendered ASL is byte-identical to the GA core.
 *
 * Returns the composed Process ASL object, ready to be stringified for
 * `DefinitionBody.fromString(...)` with the remaining scalar `definitionSubstitutions`.
 */
export function composeProcessAsl(context: VodContext): JsonObject {
  const asl = loadAsl('process');
  const states = asl.States as JsonObject | undefined;
  if (!states) {
    throw new Error("Process ASL is missing the top-level 'States' object.");
  }

  const packaging = context.packagingProfile === 'ON';
  const perFrameMetrics = context.perFrameMetrics === 'ON';
  const thumbnails = context.thumbnailsProfile === 'ON';
  const extensions = context.extensions;
  for (const { state, tier } of ENCODE_STATE_TIERS) {
    const encodeState = states[state] as JsonObject | undefined;
    if (!encodeState) {
      throw new Error(`Process ASL is missing the '${state}' state.`);
    }
    const parameters = encodeState.Parameters as JsonObject | undefined;
    if (!parameters || !('Settings' in parameters)) {
      throw new Error(`Process ASL state '${state}' is missing Parameters.Settings.`);
    }
    // Replace the '${JOB_SETTINGS_*}' string node with the transformed Settings OBJECT. When the
    // packaging overlay is ON, each tier encode becomes that tier's TS-HLS Automated-ABR ladder (job1
    // mezzanine) writing to the intermediate bucket; job2 (Package DRM) then REMUX_ALL-repackages it.
    // When OFF, the tier encode is the GA single CMAF deliverable to the destination bucket.
    parameters.Settings = packaging
      ? buildJobSettings(`${tier}-ladder` as JobProfile, {
          destBucketToken: 'INTERMEDIATE_BUCKET',
          destSubPath: 'stream',
          perFrameMetrics,
          thumbnails,
          extensions,
        })
      : buildJobSettings(tier, { perFrameMetrics, thumbnails, extensions });
  }

  if (packaging) {
    injectPackagingStates(states, context);
  }

  // Extensions: Process ASL adjustments after the packaging injection (so 'Package DRM' exists) and before
  // the variant lookups below (which keep each converted Task's other fields).
  for (const extension of extensionsWith(extensions, 'processAsl')) {
    extension.processAsl(states);
  }

  // Ad-markers (ESAM) / captions (WebVTT/IMSC) overlays: instead of Choice-routed state clones, convert
  // the (already tier-spliced, already packaging-injected) Encode {SD,HD,UHD} + Package DRM Tasks to a
  // JSONata variant lookup that reads the flags at runtime (see applyCaptionsAndAdMarkersOverlays). Runs
  // AFTER the packaging injection so 'Package DRM' already exists to convert. When BOTH overlays are OFF
  // this is skipped entirely and the Process ASL stays byte-identical to the GA core.
  if (context.adMarkersProfile === 'ON' || context.captionsProfile === 'ON') {
    applyCaptionsAndAdMarkersOverlays(states, context);
  }

  // Per-frame-metrics overlay: persist the metric list + report S3 prefix to the DynamoDB item so the
  // operator console can show which quality reports were generated (and where). Runs last so it mutates
  // the single shared Build Playback URLs + Record Job pair both branches converge on. OFF = byte-identical.
  if (perFrameMetrics) {
    injectQualityMetricsRecord(states, context);
  }

  // Thumbnails overlay: persist the thumbnails prefix + poster URL to the DynamoDB item so the CMS/EPG can
  // show a poster and scrub thumbnails. Runs last (like the per-frame-metrics record) so it mutates the
  // single shared Build Playback URLs + Record Job pair both branches converge on. OFF = byte-identical.
  if (thumbnails) {
    injectThumbnailsRecord(states);
  }

  return asl;
}

/**
 * Compose the Orchestrator ASL. When `adMarkersProfile=ON`, inject a `Read ESAM Sidecar` s3:getObject
 * after `Load Job Config` (the seam the on-disk `Load Job Config` comment anticipates) that reads the
 * per-asset `<source>.esam.xml` sidecar into `$.config.esam` (with an `esamEnabled` flag) so the Process
 * stage can insert SCTE-35 markers. A missing sidecar (NoSuchKey) is a graceful skip straight to
 * `Record Started`; any other S3 error routes to the existing `Set Ingest Error` failure path.
 *
 * On the sidecar-present path the read flows to a cloned `Record Started (Ad Markers)` whose putItem adds
 * an `adMarkersEsamXml` attribute (the raw SCC XML from `$.config.esam.esamXml`) so the VOD Operator
 * Console can display the authored ad breaks per asset without needing S3 access. The graceful-skip path
 * keeps the original `Record Started` (no attribute).
 *
 * When either sidecar overlay (ad markers / captions) is ON, a `Read Asset Metadata` s3:getObject of the
 * per-asset `<source>.json` runs first, and a Choice gate in front of each sidecar read skips it when the
 * metadata sets that flag (`captions` / `adMarkers`) to `false`. With no `.json`, or the flag absent or
 * `true`, the read falls back to sidecar presence. See `./overlays/asset-metadata.ts`.
 *
 * When `perFrameMetrics=ON`, additionally add `perFrameMetrics: "${PER_FRAME_METRICS}"` to the
 * `Load Job Config` $.config block (alongside archiveSource/enableSns/enableSqs) so the running workflow
 * records the QC mode it was deployed with.
 *
 * Extensions with an `orchestratorAsl` hook adjust the states first (see `./extensions.ts`).
 *
 * When every overlay is OFF the Orchestrator ASL is returned byte-identical. `orchestrator.asl.json` on
 * disk is never edited.
 */
export function composeOrchestratorAsl(context: VodContext): JsonObject {
  const asl = loadAsl('orchestrator');
  const adMarkers = context.adMarkersProfile === 'ON';
  const perFrameMetrics = context.perFrameMetrics === 'ON';
  const captions = context.captionsProfile === 'ON';
  const orchestratorExtensions = extensionsWith(context.extensions, 'orchestratorAsl');
  if (!adMarkers && !perFrameMetrics && !captions && orchestratorExtensions.length === 0) {
    return asl;
  }
  const states = asl.States as JsonObject | undefined;
  if (!states) {
    throw new Error("Orchestrator ASL is missing the top-level 'States' object.");
  }

  // Extensions: independent of the sidecar overlays below, so applied first and the early returns below
  // still hold.
  for (const extension of orchestratorExtensions) {
    extension.orchestratorAsl(states);
  }

  // Per-frame metrics: surface the deploy-time toggle in the $.config block that Load Job Config
  // assembles (alongside archiveSource/enableSns/enableSqs), resolved via the ${PER_FRAME_METRICS}
  // substitution. The value is informational (the metrics splice itself is synth-time, in the Process
  // encode Settings), so the running workflow records which QC mode it was deployed with.
  if (perFrameMetrics) {
    const loadJobConfig = states['Load Job Config'] as JsonObject | undefined;
    const params = loadJobConfig?.Parameters as JsonObject | undefined;
    if (!params) {
      throw new Error("Orchestrator ASL 'Load Job Config' is missing Parameters for the per-frame-metrics toggle.");
    }
    params.perFrameMetrics = '${PER_FRAME_METRICS}';
  }

  const loadJobConfig = states['Load Job Config'] as JsonObject | undefined;
  const loadParams = loadJobConfig?.Parameters as JsonObject | undefined;
  if (!loadJobConfig || !loadParams) {
    throw new Error("Orchestrator ASL 'Load Job Config' is missing Parameters for the sidecar overlays.");
  }

  // Captions toggle in $.config (informational; the caption splice itself is synth-time in the Process
  // encode Settings), resolved via the ${CAPTIONS_PROFILE} substitution — mirrors the perFrameMetrics toggle.
  if (captions) {
    loadParams.captionsProfile = '${CAPTIONS_PROFILE}';
  }

  if (!adMarkers && !captions) {
    return asl; // perFrameMetrics-only: the toggle above is all that changes; no sidecar reads.
  }
  if (loadJobConfig.Next !== 'Record Started') {
    throw new Error("Orchestrator ASL 'Load Job Config' must flow to 'Record Started' for the sidecar overlays.");
  }

  // Build the sidecar read chain between Load Job Config and Record Started:
  //   Load Job Config -> Read Asset Metadata
  //     -> [Captions Requested? -> Read Caption Sidecar ->] [Ad Markers Requested? -> Read ESAM Sidecar ->]
  //     Record Started[ (Ad Markers)].
  // The per-asset <source>.json is read first so its captions/adMarkers flags gate each sidecar read (a
  // flag set to false skips that read, so a stale sidecar from an earlier upload of the same key is
  // ignored). Captions next (a HEAD — presence only), then ESAM (a GET that inlines the XML). Each read's
  // SUCCESS and its NoSuchKey graceful-skip flow to the same next step, so a missing caption sidecar never
  // drops the later ESAM read (and vice-versa). Both overlays therefore coexist.
  const afterCaptions = adMarkers ? AD_MARKERS_REQUESTED : 'Record Started';
  const firstGate = captions ? CAPTIONS_REQUESTED : AD_MARKERS_REQUESTED;
  loadJobConfig.Next = READ_ASSET_METADATA;
  states[READ_ASSET_METADATA] = assetMetadataReadState(firstGate);

  if (captions) {
    states[CAPTIONS_REQUESTED] = sidecarGateState('captions', 'Read Caption Sidecar', afterCaptions);
    states['Read Caption Sidecar'] = captionSidecarReadState(afterCaptions);
  }

  if (!adMarkers) {
    return asl;
  }

  states[AD_MARKERS_REQUESTED] = sidecarGateState('adMarkers', 'Read ESAM Sidecar', 'Record Started');
  injectEsamSidecarStates(states);
  return asl;
}
