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
 * Pure-TypeScript, synth-time context parser + validator for the VOD v7.0.0 stack.
 *
 * This module contains NO CDK resources. It reads deploy-time inputs from CDK context
 * (`cdk deploy -c key=value` or the `context` block in `cdk.json`) and validates them,
 * THROWING on anything invalid so that `cdk synth` fails fast. It replaces the runtime
 * input validation the removed `input-validate` Lambda used to perform.
 *
 * The resolved {@link VodContext} is consumed by `bin/vod.ts` (stack props) and threaded
 * into the workflow ASL via `definitionSubstitutions`. Boolean toggles are deliberately
 * coerced to the literal strings `'true'` / `'false'` because the ASL `Choice` states
 * compare them with `StringEquals` (see ingest/publish `SNS Choice` / `SQS Choice`).
 */

// The context reader, `.env` fallback, error type and generic validators are shared with the
// companion apps, so they live in the contract package; re-exported here so existing imports keep working.
import {
  ContextReader,
  VodContextError,
  readContextValue as raw,
  coerceEnum,
  coerceCountryCodes,
  resolveExtensions,
} from '@vod/contract';
export { ContextReader, VodContextError, contextKeyToEnvVar, withEnvFallback } from '@vod/contract';

import { ActiveExtension, CoreExtension, loadCoreExtensions } from './extensions';

/** S3 archive class applied to the source object after a successful publish. */
export type ArchiveSource = 'NONE' | 'GLACIER' | 'DEEP_ARCHIVE';

/** CloudFront price class (canonical CfnDistribution / `cloudfront.PriceClass` values). */
export type PriceClass = 'PriceClass_100' | 'PriceClass_200' | 'PriceClass_All';

/** Two-job REMUX_ALL packaging overlay (opt-in). `OFF` (default) = single-job CMAF core. */
export type PackagingProfile = 'OFF' | 'ON';

/**
 * SCTE-35 ad-break markers via ESAM (opt-in). `OFF` (default) inserts no markers. `ON` reads a per-asset
 * ESAM SignalProcessingNotification SCC XML sidecar (`<source>.esam.xml`) that accompanies the source
 * media and passes it into the MediaConvert job's `Settings.Esam` so SCTE-35 markers are inserted at the
 * points the XML specifies. Assets with NO sidecar encode normally (graceful skip — no markers). Applies
 * to the GA CMAF core and, when `packagingProfile=ON`, to the REMUX_ALL HLS/CMAF/DASH groups.
 */
export type AdMarkersProfile = 'OFF' | 'ON';

/**
 * MediaConvert per-frame quality metric reports (opt-in QC add-on). `OFF` (default) leaves the pipeline
 * byte-identical. `ON` sets `PerFrameMetrics` (VMAF, QVBR, SHOT_CHANGE) on every encode
 * output so MediaConvert writes a per-output CSV report (e.g. `<output>_PSNR.csv`) to the job destination
 * alongside the media. The toggle is surfaced in the Orchestrator `Load Job Config` ($.config.perFrameMetrics).
 * Applies to the GA CMAF encode and, when `packagingProfile=ON`, to the TS-HLS ladder job1 (the REMUX_ALL
 * passthrough job2 does not encode, so it emits no metrics). Adds encode time and cost — VMAF especially on 4K.
 */
export type PerFrameMetricsProfile = 'OFF' | 'ON';

/**
 * WebVTT/IMSC caption tracks from a per-asset caption sidecar (opt-in). `OFF` (default) adds no captions
 * and leaves the pipeline byte-identical. `ON` makes the Orchestrator detect a per-asset `<source>.vtt`
 * sidecar in the source bucket and, when present, route the Process encode through a captions-enabled
 * variant that adds a `CaptionSelector` (SourceFile = the sidecar) and per-format `CaptionDescriptions`
 * (WebVTT on the HLS/CMAF outputs, IMSC on DASH). Assets with NO sidecar encode normally (graceful skip).
 * Applies to the GA CMAF core and, when `packagingProfile=ON`, to the REMUX_ALL delivery groups —
 * generated directly on the job2 packaging clone (the passthrough does NOT carry a ladder caption
 * rendition through). Composes with `adMarkersProfile=ON` (both sidecar overlays can be active at once).
 */
export type CaptionsProfile = 'OFF' | 'ON';

/**
 * MediaConvert thumbnails/poster overlay. `ON` (default) appends a FRAME_CAPTURE output group to the
 * Process encode job that writes periodic thumbnail JPEGs (the first = the poster) under
 * `<guid>/thumbnails/` in the destination bucket, and records the `thumbnailsPrefix` + `posterUrl` on the
 * DynamoDB item for CMS/EPG consumption. Applies to the GA CMAF encode and, when `packagingProfile=ON`,
 * to the TS-HLS ladder job1 (the REMUX_ALL passthrough job2 does not decode frames). `OFF` leaves the
 * pipeline byte-identical (no poster/thumbnails — set `-c thumbnailsProfile=OFF` to opt out). Standalone —
 * no cross-field dependency. Adds a little encode time; no new IAM.
 */
export type ThumbnailsProfile = 'OFF' | 'ON';

/**
 * Literal-string boolean. ASL `Choice` states use `StringEquals: 'true'`, so booleans are
 * rendered as `'true'` / `'false'` strings rather than JSON booleans.
 */
export type BoolString = 'true' | 'false';

/**
 * The fully-resolved, validated deploy-time inputs for the VOD stack.
 *
 * Every field except the explicitly-optional ones has a default applied by
 * {@link parseVodContext}, so downstream constructs never have to re-derive defaults.
 */
export interface VodContext {
  /** SNS subscription email (required). Replaces the v6 `AdminEmail` CFN parameter. */
  readonly email: string;

  /** Optional explicit stack name (also used as the archive-lifecycle tag key). */
  readonly stackName?: string;

  /** Source-archive class. `NONE` (default) skips archival. -> `${ARCHIVE_SOURCE}`. */
  readonly archiveSource: ArchiveSource;

  /** SNS notifications enabled (default `'true'`). -> `${ENABLE_SNS}`. */
  readonly enableSns: BoolString;

  /** SQS notifications enabled (default `'false'`). -> `${ENABLE_SQS}`. */
  readonly enableSqs: BoolString;

  /** CloudFront price class (default `PriceClass_All` — all edge locations). */
  readonly priceClass: PriceClass;

  /** Optional CloudFront geo-restriction allowlist (ISO 3166-1 alpha-2 country codes). */
  readonly geoRestriction?: string[];

  /** Optional WAFv2 (global / CLOUDFRONT scope) WebACL ARN to associate with the distribution. */
  readonly wafWebAclArn?: string;

  /**
   * Optional custom domain (alternate domain name) for the distribution. Set together with
   * {@link certificateArn}; when both are set the distribution enforces a TLSv1.2_2021 minimum. Omitted
   * (default) = the `*.cloudfront.net` domain, whose TLS policy CloudFront fixes at TLSv1.
   */
  readonly domainName?: string;

  /** ACM certificate ARN (us-east-1) covering {@link domainName}. Required with it. */
  readonly certificateArn?: string;

  /** Optional expiry (in days) for objects in the destination bucket. Omitted = no expiry. */
  readonly destinationRetentionDays?: number;

  /**
   * Optional browser origins allowed to upload to the source bucket (operator-console self-service
   * upload). Omitted (default) = no source-bucket CORS, GA template byte-identical. Set to the
   * console origin(s), e.g. `http://localhost:5174` or the hosted console domain.
   */
  readonly uploadCorsOrigins?: string[];

  /**
   * Opt-in: the two-job REMUX_ALL packaging overlay. `OFF` (default) leaves the single-job CMAF core
   * byte-identical. `ON` routes the Process stage through a TS-HLS ABR ladder job (job1 -> intermediate
   * bucket) then a REMUX_ALL passthrough packaging job (job2 -> destination: HLS/TS, CMAF-HLS and DASH).
   * -> `${INTERMEDIATE_BUCKET}` (only when ON).
   */
  readonly packagingProfile: PackagingProfile;

  /**
   * SCTE-35 ad-break markers via ESAM. `OFF` (default) leaves the pipeline byte-identical. `ON` makes the
   * Orchestrator read a per-asset `<source>.esam.xml` sidecar and, when present, route the Process encode
   * through an ESAM-enabled variant that inserts the SCC XML into the MediaConvert job. Assets without a
   * sidecar take the normal (no-marker) encode path.
   */
  readonly adMarkersProfile: AdMarkersProfile;

  /**
   * MediaConvert per-frame quality metric reports. `OFF` (default) leaves the pipeline byte-identical.
   * `ON` splices `PerFrameMetrics` into each encode output (GA CMAF tiers + the packaging TS-HLS
   * ladder job1) so a per-output CSV lands in the job destination, and surfaces the toggle in the
   * Orchestrator `Load Job Config` ($.config.perFrameMetrics -> `${PER_FRAME_METRICS}`).
   */
  readonly perFrameMetrics: PerFrameMetricsProfile;

  /**
   * WebVTT/IMSC captions from a per-asset `<source>.vtt` sidecar. `OFF` (default) = byte-identical (no
   * `CaptionSelector`/`CaptionDescriptions`). `ON` detects the sidecar in the Orchestrator and, when
   * present, adds caption tracks to the encode (graceful skip when absent). Independent of
   * `packagingProfile`/`adMarkersProfile`. -> the informational `${CAPTIONS_PROFILE}` Load Job Config toggle.
   */
  readonly captionsProfile: CaptionsProfile;

  /**
   * MediaConvert thumbnails/poster overlay. `ON` (default) appends a FRAME_CAPTURE output group to the
   * Process encode job (poster + periodic thumbnail JPEGs under `<guid>/thumbnails/`) and records
   * `thumbnailsPrefix`/`posterUrl` on the DynamoDB item. `OFF` leaves the pipeline byte-identical.
   */
  readonly thumbnailsProfile: ThumbnailsProfile;

  /**
   * The enabled extensions (see `./extensions.ts`), in name order. Empty in the core distribution. Each
   * one parsed its own context keys; the compose pipeline and constructs call their hooks.
   */
  readonly extensions: readonly ActiveExtension[];
}

// RFC-ish email: non-space/@ local part, an @, a domain, a dot, and a TLD.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ARCHIVE_SOURCE_VALUES: readonly ArchiveSource[] = ['NONE', 'GLACIER', 'DEEP_ARCHIVE'];
const PRICE_CLASS_VALUES: readonly PriceClass[] = ['PriceClass_100', 'PriceClass_200', 'PriceClass_All'];
const PACKAGING_PROFILE_VALUES: readonly PackagingProfile[] = ['OFF', 'ON'];
const AD_MARKERS_PROFILE_VALUES: readonly AdMarkersProfile[] = ['OFF', 'ON'];
const PER_FRAME_METRICS_VALUES: readonly PerFrameMetricsProfile[] = ['OFF', 'ON'];
const CAPTIONS_PROFILE_VALUES: readonly CaptionsProfile[] = ['OFF', 'ON'];
const THUMBNAILS_PROFILE_VALUES: readonly ThumbnailsProfile[] = ['OFF', 'ON'];



/**
 * Coerce a context value to a {@link BoolString}. Accepts real booleans (from `cdk.json`)
 * and the strings `'true'` / `'false'` (case-insensitive, from `-c key=value`). Throws on
 * anything else.
 */
function coerceBool(value: unknown, key: string, defaultValue: BoolString): BoolString {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return 'true';
    }
    if (normalized === 'false') {
      return 'false';
    }
  }
  throw new VodContextError(`'${key}' must be a boolean ('true' or 'false'); received ${JSON.stringify(value)}.`);
}





/** Validate the optional WAFv2 WebACL ARN. */
function coerceWafWebAclArn(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^arn:aws[\w-]*:wafv2:/.test(value)) {
    throw new VodContextError(
      `'wafWebAclArn' must be a WAFv2 WebACL ARN (arn:aws:wafv2:...); received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Validate the optional custom domain + ACM certificate pair. Both or neither: a domain without a
 * certificate cannot serve HTTPS, and a certificate without a domain is unused. CloudFront requires the
 * certificate in us-east-1.
 */
function coerceCustomDomain(
  domainValue: unknown,
  certValue: unknown,
): { domainName?: string; certificateArn?: string } {
  if (domainValue === undefined && certValue === undefined) {
    return {};
  }
  if (domainValue === undefined || certValue === undefined) {
    throw new VodContextError("'domainName' and 'certificateArn' must be set together (or neither).");
  }
  if (
    typeof domainValue !== 'string' ||
    !/^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domainValue)
  ) {
    throw new VodContextError(
      `'domainName' must be a fully qualified domain name (e.g. video.example.com); received ${JSON.stringify(domainValue)}.`,
    );
  }
  if (typeof certValue !== 'string' || !/^arn:aws[\w-]*:acm:us-east-1:\d{12}:certificate\/[\w-]+$/.test(certValue)) {
    throw new VodContextError(
      `'certificateArn' must be an ACM certificate ARN in us-east-1 (arn:aws:acm:us-east-1:<account>:certificate/<id>); received ${JSON.stringify(certValue)}.`,
    );
  }
  return { domainName: domainValue.toLowerCase(), certificateArn: certValue };
}

/** Validate the optional destination retention (positive integer number of days). */
function coerceRetentionDays(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(num) || num <= 0) {
    throw new VodContextError(
      `'destinationRetentionDays' must be a positive integer number of days; received ${JSON.stringify(value)}.`,
    );
  }
  return num;
}

/**
 * Normalize the optional list of browser origins allowed to upload to the source bucket (console
 * self-service upload). Accepts a JSON array or a comma-separated string; each must be a bare
 * `http(s)://host[:port]` origin (no path). Omitted = no source-bucket CORS (GA byte-identical).
 */
function coerceUploadCorsOrigins(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const list: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
  const origins = list.map((e) => (typeof e === 'string' ? e.trim() : e)).filter((e) => e !== '');
  if (origins.length === 0) {
    return undefined;
  }
  for (const o of origins) {
    // '*' is the permissive wildcard (allow any origin); otherwise require a bare http(s) origin.
    if (o === '*') {
      continue;
    }
    if (typeof o !== 'string' || !/^https?:\/\/[^/]+$/.test(o)) {
      throw new VodContextError(
        `'uploadCorsOrigins' must be '*' or a list of http(s)://host[:port] origins with no path; received ${JSON.stringify(o)}.`,
      );
    }
  }
  return origins as string[];
}



/** The core inputs, before the extensions are activated (what {@link CoreExtension.activate} receives). */
export type CoreContext = Omit<VodContext, 'extensions'>;

/**
 * Parse and validate the VOD deploy-time context from any {@link ContextReader}
 * (typically `app.node`), then activate each enabled extension: those of `available` (default: installed
 * under `source/core/extensions/`) named in the `vodExtensions` list, each of which parses its own keys. Throws {@link VodContextError} on the first
 * invalid value so that `cdk synth` fails fast with an actionable message.
 */
export function parseVodContext(reader: ContextReader, available: readonly CoreExtension[] = loadCoreExtensions()): VodContext {
  const emailRaw = raw(reader, 'email');
  if (emailRaw === undefined) {
    throw new VodContextError(
      "'email' is required (subscribes to the SNS notification topic). Pass it with -c email=you@example.com.",
    );
  }
  if (typeof emailRaw !== 'string' || !EMAIL_REGEX.test(emailRaw)) {
    throw new VodContextError(`'email' is not a valid email address; received ${JSON.stringify(emailRaw)}.`);
  }

  const stackNameRaw = raw(reader, 'stackName');
  if (stackNameRaw !== undefined && typeof stackNameRaw !== 'string') {
    throw new VodContextError(`'stackName' must be a string; received ${JSON.stringify(stackNameRaw)}.`);
  }

  const packagingProfile = coerceEnum(
    raw(reader, 'packagingProfile'),
    'packagingProfile',
    PACKAGING_PROFILE_VALUES,
    'OFF',
  );
  const adMarkersProfile = coerceEnum(raw(reader, 'adMarkersProfile'), 'adMarkersProfile', AD_MARKERS_PROFILE_VALUES, 'OFF');

  const core: CoreContext = {
    email: emailRaw,
    stackName: stackNameRaw as string | undefined,
    archiveSource: coerceEnum(raw(reader, 'archiveSource'), 'archiveSource', ARCHIVE_SOURCE_VALUES, 'NONE'),
    enableSns: coerceBool(raw(reader, 'enableSns'), 'enableSns', 'true'),
    enableSqs: coerceBool(raw(reader, 'enableSqs'), 'enableSqs', 'false'),
    priceClass: coerceEnum(raw(reader, 'priceClass'), 'priceClass', PRICE_CLASS_VALUES, 'PriceClass_All'),
    geoRestriction: coerceCountryCodes(raw(reader, 'geoRestriction'), 'geoRestriction'),
    wafWebAclArn: coerceWafWebAclArn(raw(reader, 'wafWebAclArn')),
    ...coerceCustomDomain(raw(reader, 'domainName'), raw(reader, 'certificateArn')),
    destinationRetentionDays: coerceRetentionDays(raw(reader, 'destinationRetentionDays')),
    uploadCorsOrigins: coerceUploadCorsOrigins(raw(reader, 'uploadCorsOrigins')),
    packagingProfile,
    adMarkersProfile,
    perFrameMetrics: coerceEnum(
      raw(reader, 'perFrameMetrics'),
      'perFrameMetrics',
      PER_FRAME_METRICS_VALUES,
      'OFF',
    ),
    captionsProfile: coerceEnum(
      raw(reader, 'captionsProfile'),
      'captionsProfile',
      CAPTIONS_PROFILE_VALUES,
      'OFF',
    ),
    thumbnailsProfile: coerceEnum(
      raw(reader, 'thumbnailsProfile'),
      'thumbnailsProfile',
      THUMBNAILS_PROFILE_VALUES,
      'ON',
    ),
  };
  const extensions = resolveExtensions(reader, available)
    .map((extension) => extension.activate(reader, core))
    .filter((active): active is ActiveExtension => active !== undefined);
  return { ...core, extensions };
}
