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
 * Shared types for the ASL loader/composer (`../asl.ts`), `../job-settings.ts`, and the per-overlay
 * modules in this directory. Imports only types, so every module can depend on it without a cycle.
 * Re-exported from `../asl.ts`, which stays the public entry point.
 */

import type { ActiveExtension } from '../extensions';

/** A parsed JSON document (ASL definition or job-template settings). */
export type JsonObject = Record<string, unknown>;

/** MediaConvert quality tier. `AUTO` is resolved to one of these by the Process `Choice`. */
export type JobTier = 'sd' | 'hd' | 'uhd';

/**
 * A job profile whose template lives under `job-templates/`. Extends the GA tiers with the
 * packaging overlay profiles: the per-tier TS-HLS ABR ladders (`sd-ladder`/`hd-ladder`/`uhd-ladder`,
 * the job1 mezzanine — one per quality tier, Automated ABR to the intermediate bucket) and `package`
 * (job2 REMUX_ALL).
 */
export type JobProfile = JobTier | 'sd-ladder' | 'hd-ladder' | 'uhd-ladder' | 'package';

/**
 * ESAM SCTE-35 ad-marker injection for {@link buildJobSettings}.
 *
 * MediaConvert takes the ESAM SignalProcessingNotification document INLINE as a string (not an S3
 * reference), so `sccXmlRef` is an ASL `.$` path resolving to the sidecar XML body at runtime — spliced
 * as a `"SccXml.$"` intrinsic exactly like `FileInput.$`. When present, add the `Settings.Esam` block and
 * set each VIDEO output's container SCTE-35 fields:
 *  - CMAF (`CmfcSettings`) and DASH (`MpdSettings`): `Scte35Esam=INSERT` + `Scte35Source=NONE`.
 *  - HLS/TS (`M3u8Settings`): NO `Scte35Esam` field (Step Functions rejects it); `Scte35Source=PASSTHROUGH`
 *    + the group's `AdMarkers=[ELEMENTAL_SCTE35]` surface the markers in the HLS manifest.
 *
 * Applied to the single GA CMAF encode AND, in the REMUX_ALL overlay, to BOTH the ladder job1 (which
 * conditions IDR frames) and the passthrough job2 (which writes the SCTE-35 into the delivery manifests —
 * verified live: ESAM on the REMUX_ALL passthrough job emits `#EXT-OATCLS-SCTE35` / `#EXT-X-CUE-OUT`).
 */
export interface EsamInjection {
  /** ASL `.$` path resolving to the SCC XML body at runtime. */
  readonly sccXmlRef: string;
}

/**
 * File-based caption injection for {@link buildJobSettings} (WebVTT/IMSC from a per-asset sidecar).
 *
 * When present, add a single input `CaptionSelector` ("Captions Selector 1") whose
 * `SourceSettings.FileSourceSettings.SourceFile` is spliced as a `"SourceFile.$"` intrinsic (exactly like
 * `FileInput.$`) resolving to the sidecar s3:// URI at runtime, and append one caption `Output` per group
 * with the per-format `DestinationType`: WEBVTT for HLS (`M3U8`) + CMAF (`CMFC`), IMSC for DASH (`MPD`).
 * CMAF supports only WEBVTT + IMSC. Applied to the single GA CMAF encode AND, in the REMUX_ALL overlay,
 * to the job2 packaging clone (which sources the sidecar directly — the passthrough does NOT carry a
 * caption rendition through from the ladder).
 */
export interface CaptionsInjection {
  /** ASL `.$` intrinsic resolving to the sidecar s3:// URI at runtime (the CaptionSelector SourceFile). */
  readonly sourceFileRef: string;
}

/** Options for {@link buildJobSettings} (defaults reproduce the GA single-job sd/hd/uhd behavior). */
export interface JobSettingsOptions {
  /** The `FileInput.$` intrinsic value. Default `'$.fileUri'` (the source upload). */
  readonly inputRef?: string;
  /** The CFN token whose value is the destination bucket. Default `'DESTINATION_BUCKET'`. */
  readonly destBucketToken?: string;
  /** The base name under `<guid>/` for a single-group template. Default `'index'`. */
  readonly destSubPath?: string;
  /**
   * Per-output-group destination sub-path, keyed by the group's `Name` (multi-group templates like the
   * `package` profile). Falls back to {@link destSubPath} for any group not listed.
   */
  readonly groupSubPaths?: Readonly<Record<string, string>>;
  /** SCTE-35 ad-marker injection (ESAM). Omitted => no markers (byte-identical to the GA templates). */
  readonly esam?: EsamInjection;

  /** WebVTT/IMSC captions from a sidecar. Omitted => no CaptionSelector/CaptionDescriptions (byte-identical). */
  readonly captions?: CaptionsInjection;

  /**
   * When true, set `PerFrameMetrics` on every encode output's codec settings so MediaConvert
   * writes per-output quality-metric CSV reports. No effect on passthrough (REMUX_ALL job2) or
   * audio-only outputs (they carry no encoding codec settings). Omitted => byte-identical templates.
   */
  readonly perFrameMetrics?: boolean;

  /**
   * When true, append a FRAME_CAPTURE output group (poster + periodic thumbnail JPEGs) writing to
   * `<guid>/thumbnails/` in the DESTINATION bucket. Appended AFTER the per-group destination-rewrite and
   * per-output loops, so those never touch it and its FILE_GROUP_SETTINGS destination stays pinned to the
   * destination bucket even when this rides the packaging ladder job1. Omitted => byte-identical templates.
   */
  readonly thumbnails?: boolean;

  /**
   * When true, emit JSONata-mode placeholders (bare keys + sentinels like {@link SENTINEL_FILE_INPUT})
   * instead of JSONPath `.$`-suffixed intrinsic keys, for a Settings object that will be embedded in a
   * JSONata `Arguments.Settings` variant lookup (see {@link lookupSettingsExpr}). Omitted/false =>
   * today's JSONPath `Parameters`-payload-template output (byte-identical to the pre-JSONata behavior).
   */
  readonly jsonata?: boolean;

  /**
   * The enabled extensions (`context.extensions`), whose {@link ActiveExtension.outputGroup} and
   * {@link ActiveExtension.jobSettings} hooks run on these Settings. Omitted => core-only settings.
   */
  readonly extensions?: readonly ActiveExtension[];
}

/**
 * Maps each Process-workflow Encode state name to its tier. The `Parameters.Settings` string
 * placeholder in each of these states is replaced with the corresponding transformed
 * `Settings` object by {@link composeProcessAsl}.
 */
export const ENCODE_STATE_TIERS: ReadonlyArray<{ readonly state: string; readonly tier: JobTier }> = [
  { state: 'Encode SD', tier: 'sd' },
  { state: 'Encode HD', tier: 'hd' },
  { state: 'Encode UHD', tier: 'uhd' },
];
