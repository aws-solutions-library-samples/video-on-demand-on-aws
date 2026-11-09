/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import type { JsonObject } from './types';

/**
 * Per-asset metadata sidecar (`<source>.json`, schema `vod-asset-metadata/1`, written by the operator CMS).
 * When a sidecar overlay (captions / ad markers) is ON, the Orchestrator reads it before the sidecar reads
 * (raw body into `$.assetMetaRead.body`), so the per-asset toggles decide whether a sidecar is used. Without
 * this, a stale `<source>.vtt` / `<source>.esam.xml` left by an earlier upload of the same key would be
 * picked up by a later upload that turned the feature off.
 *
 * Rules (per toggle): `.json` present with the flag explicitly `false` -> skip that sidecar read;
 * otherwise (flag `true`, flag absent, malformed JSON, or no `.json` at all) -> fall back to the
 * sidecar-presence check.
 *
 * The body is NOT parsed with `States.StringToJson` / `$parse`: a malformed file would raise
 * `States.Runtime`, which no Catch handles, aborting the execution without an `Error` record. The gates
 * instead regex-test the raw text for `"<flag>": false`, which cannot throw on any string.
 */
export const READ_ASSET_METADATA = 'Read Asset Metadata';
export const CAPTIONS_REQUESTED = 'Captions Requested?';
export const AD_MARKERS_REQUESTED = 'Ad Markers Requested?';

/** The Orchestrator `Read Asset Metadata` state: s3:getObject of `<source>.json`, raw body into `$.assetMetaRead.body`. */
export function assetMetadataReadState(next: string): JsonObject {
  return {
    Type: 'Task',
    Comment:
      'Sidecar overlays: read the per-asset metadata sidecar (<source>.json, written by the operator CMS) as raw text into $.assetMetaRead.body so its captions/adMarkers flags gate the sidecar reads that follow (a flag set to false skips that sidecar even if a stale file from an earlier upload of the same key exists). A missing .json (NoSuchKey) is a graceful skip: the sidecar reads fall back to file presence. Any other S3 error routes to Set Ingest Error.',
    Resource: 'arn:aws:states:::aws-sdk:s3:getObject',
    Parameters: {
      'Bucket.$': '$.srcBucket',
      'Key.$': "States.Format('{}.json', $.srcVideo)",
    },
    ResultSelector: {
      'body.$': '$.Body',
    },
    ResultPath: '$.assetMetaRead',
    TimeoutSeconds: 15,
    Retry: [
      {
        ErrorEquals: ['S3.SdkClientException', 'S3.InternalServerError'],
        IntervalSeconds: 2,
        BackoffRate: 2,
        MaxAttempts: 3,
      },
    ],
    Catch: [
      {
        ErrorEquals: ['S3.NoSuchKey', 'S3.NoSuchKeyException'], // gitleaks:allow -- AWS S3 SDK error code strings, not a secret
        ResultPath: '$.assetMetaSkip',
        Next: next,
      },
      {
        ErrorEquals: ['States.ALL'],
        ResultPath: '$.error',
        Next: 'Set Ingest Error',
      },
    ],
    Next: next,
  };
}

/**
 * A Choice gate in front of a sidecar read: when the metadata body sets `"<flag>": false`, go to `skipTo`;
 * otherwise go to `readState` (the existing presence-based sidecar read). A JSONata Choice (the rest of the
 * Orchestrator stays JSONPath); the `$exists` guard keeps `$contains` on a string, so it cannot throw.
 */
export function sidecarGateState(flag: 'captions' | 'adMarkers', readState: string, skipTo: string): JsonObject {
  const body = '$states.input.assetMetaRead.body';
  return {
    Type: 'Choice',
    QueryLanguage: 'JSONata',
    Comment: `Sidecar overlays: skip ${readState} when the asset metadata sets ${flag}=false (the operator turned it off for this upload); otherwise read the sidecar as before.`,
    Choices: [
      {
        Condition: `{% $exists(${body}) and $contains(${body}, /"${flag}"\\s*:\\s*false/) %}`,
        Next: skipTo,
      },
    ],
    Default: readState,
  };
}
