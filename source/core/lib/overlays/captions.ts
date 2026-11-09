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
 * Captions/subtitles overlay (`captionsProfile=ON`): the input CaptionSelector + per-group caption outputs,
 * the JSONata runtime flag expression, and the Orchestrator `Read Caption Sidecar` state.
 */

import { SENTINEL_SOURCE_FILE } from './jsonata';
import { CaptionsInjection, JsonObject } from './types';

/**
 * The caption `SourceFile` s3:// URI, derived from the per-execution source identity. Uniform for job1
 * (GA CMAF / ladder, whose FileInput is the source video) and — should the job2-direct fallback be used —
 * for job2 too, because $.srcBucket/$.srcVideo are in scope in every Process state, so the selector
 * always points at the ABSOLUTE source-bucket sidecar, never the (intermediate) ladder input.
 */
export const CAPTIONS_SOURCE_FILE_REF = "States.Format('s3://{}/{}.vtt', $.srcBucket, $.srcVideo)";
/** The input CaptionSelector name referenced by every CaptionDescription. */
const CAPTION_SELECTOR_NAME = 'Captions Selector 1';
const CAPTIONS_ENABLED_JSONATA_REF = '$states.input.config.captions.captionsEnabled';

/** `true` when the Orchestrator found a caption sidecar. JSONata equivalent of the old `Captions?` Choice condition. */
export function captionsOnExpr(): string {
  return `($exists(${CAPTIONS_ENABLED_JSONATA_REF}) and ${CAPTIONS_ENABLED_JSONATA_REF} = 'true')`;
}

/**
 * Declare a single input CaptionSelector reading the sidecar file by s3:// URI (mutating `input` in
 * place): a `.$` intrinsic like FileInput, or the {@link SENTINEL_SOURCE_FILE} placeholder in JSONata
 * mode. The per-group caption outputs are appended by {@link applyCaptionsToGroup}.
 */
export function applyCaptionSelector(input: JsonObject, captions: CaptionsInjection, jsonataMode: boolean): void {
  const selectors = (input.CaptionSelectors as JsonObject | undefined) ?? {};
  selectors[CAPTION_SELECTOR_NAME] = {
    SourceSettings: {
      SourceType: 'WEBVTT',
      FileSourceSettings: jsonataMode ? { SourceFile: SENTINEL_SOURCE_FILE } : { 'SourceFile.$': captions.sourceFileRef },
    },
  };
  input.CaptionSelectors = selectors;
}

/**
 * Append a file-source caption rendition to a single output group (mutating it in place). Adds a
 * caption-only `Output` whose `CaptionDescriptions` reference the input CaptionSelector, with the
 * per-format `DestinationType`: WEBVTT for HLS (`M3U8`) + CMAF (`CMFC`), IMSC for DASH (`MPD`). CMAF
 * supports only WEBVTT + IMSC (DASH IMSC produces IMSC1 fMP4 timed text). Idempotent: skips a group that
 * already carries the `_captions` output. See {@link CaptionsInjection}.
 */
export function applyCaptionsToGroup(group: JsonObject, groupKey: string): void {
  const outputs = Array.isArray(group.Outputs) ? (group.Outputs as JsonObject[]) : [];
  if (outputs.some((o) => o.NameModifier === '_captions')) {
    return; // already spliced (guard against a group being transformed twice).
  }
  const container = groupKey === 'HlsGroupSettings' ? 'M3U8' : groupKey === 'CmafGroupSettings' ? 'CMFC' : 'MPD';
  const destinationType = groupKey === 'DashIsoGroupSettings' ? 'IMSC' : 'WEBVTT';
  outputs.push({
    NameModifier: '_captions',
    ContainerSettings: { Container: container },
    CaptionDescriptions: [
      {
        CaptionSelectorName: CAPTION_SELECTOR_NAME,
        LanguageCode: 'ENG',
        LanguageDescription: 'English',
        DestinationSettings: { DestinationType: destinationType },
      },
    ],
  });
  group.Outputs = outputs;
}

/**
 * The Orchestrator `Read Caption Sidecar` state: an s3:headObject presence check for the per-asset
 * `<source>.vtt` sidecar. Both its success and its NoSuchKey graceful skip flow to `next` (the ESAM read
 * when ad-markers is also ON, else `Record Started`). See {@link composeOrchestratorAsl}.
 */
export function captionSidecarReadState(next: string): JsonObject {
  return {
    Type: 'Task',
    Comment:
      'Captions overlay: detect the per-asset <source>.vtt caption sidecar (a HEAD — the body is not needed; MediaConvert reads the file itself by URI in Process). On success set $.config.captions.captionsEnabled=true so Process adds caption tracks; a missing sidecar (NoSuchKey/NotFound) is a graceful skip (Process Captions? Default = no captions). Any other S3 error routes to Set Ingest Error. NOTE: the exact S3 SDK error names + headObject support are a live-verification item.',
    Resource: 'arn:aws:states:::aws-sdk:s3:headObject',
    Parameters: {
      'Bucket.$': '$.srcBucket',
      'Key.$': "States.Format('{}.vtt', $.srcVideo)",
    },
    ResultSelector: { captionsEnabled: 'true' },
    ResultPath: '$.config.captions',
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
        ErrorEquals: ['S3.NoSuchKey', 'S3.NoSuchKeyException', 'S3.NotFound'], // gitleaks:allow -- AWS S3 SDK error code strings, not a secret
        ResultPath: '$.captionsSkip',
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
