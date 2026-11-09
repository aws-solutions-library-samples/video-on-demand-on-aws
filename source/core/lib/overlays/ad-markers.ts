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
 * SCTE-35 ad-markers overlay (`adMarkersProfile=ON`): the ESAM job-settings splice, the JSONata runtime
 * flag expression, and the Orchestrator `Read ESAM Sidecar` states.
 */

import { SENTINEL_SCC_XML } from './jsonata';
import { EsamInjection, JsonObject } from './types';

/** Runtime `.$` path for the ESAM sidecar body (set by the Orchestrator, threaded via $.config). Used
 * as an inert placeholder value in JSONata-mode `buildJobSettings` calls (see {@link SENTINEL_SCC_XML}). */
export const ESAM_SCC_XML_REF = '$.config.esam.esamXml';
const ESAM_ENABLED_JSONATA_REF = '$states.input.config.esam.esamEnabled';

/** `true` when the Orchestrator found an ESAM sidecar ($exists guards a missing $.config.esam — the
 * graceful-skip path never creates it). JSONata equivalent of the old `Ad Markers?` Choice condition. */
export function esamOnExpr(): string {
  return `($exists(${ESAM_ENABLED_JSONATA_REF}) and ${ESAM_ENABLED_JSONATA_REF} = 'true')`;
}

/**
 * Inject SCTE-35 ad markers (from the job-level ESAM block) into a single output group (mutating it in
 * place). Markers ride the VIDEO output(s); audio outputs are left untouched. See {@link EsamInjection}.
 */
export function applyScte35ToGroup(group: JsonObject, groupKey: string): void {
  if (groupKey === 'HlsGroupSettings') {
    const outputGroupSettings = group.OutputGroupSettings as JsonObject;
    (outputGroupSettings.HlsGroupSettings as JsonObject).AdMarkers = ['ELEMENTAL_SCTE35'];
  }

  const outputs = Array.isArray(group.Outputs) ? (group.Outputs as JsonObject[]) : [];
  for (const output of outputs) {
    if (!output.VideoDescription) {
      continue; // SCTE-35 rides the video output; audio-only outputs carry no markers.
    }
    const containerSettings = output.ContainerSettings as JsonObject | undefined;
    if (!containerSettings) {
      continue;
    }
    if (containerSettings.CmfcSettings) {
      // CMAF (fMP4): Scte35Esam INSERT writes SCTE-35 into the segments at the ESAM insertion points.
      const cmfc = containerSettings.CmfcSettings as JsonObject;
      cmfc.Scte35Esam = 'INSERT';
      cmfc.Scte35Source = 'NONE';
    } else if (containerSettings.M3u8Settings) {
      // MPEG-TS/HLS: M3u8Settings has NO Scte35Esam field (Step Functions rejects it). ESAM markers
      // surface in the HLS manifest via Scte35Source=PASSTHROUGH + the group's AdMarkers (the AWS
      // "Apple HLS" ESAM example). Verified live on the REMUX_ALL passthrough job2.
      const m3u8 = containerSettings.M3u8Settings as JsonObject;
      m3u8.Scte35Source = 'PASSTHROUGH';
    } else if (containerSettings.Container === 'MPD') {
      // DASH: Scte35Esam INSERT conditions segments (DASH MPD manifest markers are NOT written by
      // MediaConvert — a documented limitation needing the deferred conditioning Lambda).
      const mpd = (containerSettings.MpdSettings as JsonObject | undefined) ?? {};
      mpd.Scte35Esam = 'INSERT';
      mpd.Scte35Source = 'NONE';
      containerSettings.MpdSettings = mpd;
    }
  }
}

/**
 * Add the root `Settings.Esam` block (mutating `settings` in place): the SignalProcessingNotification SCC
 * XML as a `.$` intrinsic (MediaConvert takes the ESAM document inline as a string), or the
 * {@link SENTINEL_SCC_XML} placeholder in JSONata mode. ResponseSignalPreroll=0 removes MediaConvert's
 * default 4s preroll so the marker is not placed one segment early.
 */
export function applyEsamToSettings(settings: JsonObject, esam: EsamInjection, jsonataMode: boolean): void {
  settings.Esam = {
    ResponseSignalPreroll: 0,
    SignalProcessingNotification: jsonataMode ? { SccXml: SENTINEL_SCC_XML } : { 'SccXml.$': esam.sccXmlRef },
  };
}

/** Deep-clone a state object so a variant can be mutated without touching the original. */
function cloneState(state: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(state)) as JsonObject;
}

/**
 * Add the Orchestrator ad-markers states (mutating `states` in place): a `Read ESAM Sidecar`
 * s3:getObject (the caller points the preceding state's `Next` at it) and a cloned
 * `Record Started (Ad Markers)` that the sidecar-present path flows to. See {@link composeOrchestratorAsl}.
 */
export function injectEsamSidecarStates(states: JsonObject): void {
  // Clone Record Started into a variant that also persists the raw ESAM XML to the DynamoDB item (for the
  // operator console). Only the sidecar-present path reaches it, so `$.config.esam.esamXml` is guaranteed.
  const recordStarted = states['Record Started'] as JsonObject | undefined;
  const recordStartedItem = ((recordStarted?.Parameters as JsonObject | undefined)?.Item) as JsonObject | undefined;
  if (!recordStartedItem) {
    throw new Error("Orchestrator ASL 'Record Started' is missing Parameters.Item for the ad-markers overlay.");
  }
  const recordStartedAdMarkers = cloneState(recordStarted as JsonObject);
  ((recordStartedAdMarkers.Parameters as JsonObject).Item as JsonObject).adMarkersEsamXml = {
    'S.$': ESAM_SCC_XML_REF,
  };
  recordStartedAdMarkers.Comment =
    'Record Started variant for the ad-markers overlay: same as Record Started, plus it persists the raw ESAM SCC XML (adMarkersEsamXml) so the operator console can list the authored ad breaks per asset. Reached only when a sidecar was found.';
  states['Record Started (Ad Markers)'] = recordStartedAdMarkers;
  states['Read ESAM Sidecar'] = {
    Type: 'Task',
    Comment:
      'Ad-markers overlay: read the per-asset ESAM SCC XML sidecar (<source>.esam.xml) that accompanies the source media, stashing the XML body + an esamEnabled flag under $.config.esam (threaded to Process via the config object). A missing sidecar (NoSuchKey) is a graceful skip to Record Started so the asset encodes normally with no markers; any other S3 error routes to Set Ingest Error. NOTE: the exact S3 SDK error names are a live-verification item.',
    Resource: 'arn:aws:states:::aws-sdk:s3:getObject',
    Parameters: {
      'Bucket.$': '$.srcBucket',
      'Key.$': "States.Format('{}.esam.xml', $.srcVideo)",
    },
    ResultSelector: {
      'esamXml.$': '$.Body',
      esamEnabled: 'true',
    },
    ResultPath: '$.config.esam',
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
        ResultPath: '$.esamSkip',
        Next: 'Record Started',
      },
      {
        ErrorEquals: ['States.ALL'],
        ResultPath: '$.error',
        Next: 'Set Ingest Error',
      },
    ],
    Next: 'Record Started (Ad Markers)',
  };
}
