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
 * The shared JSONata variant engine used by the captions + ad-markers overlays: converts the Encode
 * {SD,HD,UHD} / Package DRM Tasks into a runtime `$lookup` over synth-time Settings variants. The
 * sentinels + expression helpers it relies on live in `./jsonata.ts`.
 */

import { VodContext } from '../context';
import { buildJobSettings } from '../job-settings';
import { ESAM_SCC_XML_REF, esamOnExpr } from './ad-markers';
import { CAPTIONS_SOURCE_FILE_REF, captionsOnExpr } from './captions';
import { jsonataExpr, lookupSettingsExpr, SENTINEL_FILE_INPUT, SENTINEL_GUID, SENTINEL_SCC_XML, SENTINEL_SOURCE_FILE, sentinelForDestination } from './jsonata';
import { PACKAGE_GROUP_SUBPATHS, PACKAGE_INPUT_REF } from './packaging';
import { ENCODE_STATE_TIERS, JobProfile, JsonObject } from './types';
import { ActiveExtension, extensionsWith } from '../extensions';

/**
 * Convert a single `createJob.sync` Task from a static `Parameters.Settings` literal to a JSONata
 * `Arguments.Settings` variant lookup (mutates `state` in place). `Role`/`Queue`/`Tags` copy verbatim
 * (synth-time constants, unaffected by query language); `UserMetadata.guid.$` becomes its JSONata
 * equivalent. `ResultPath` becomes an `Output` merging `$states.result` into `$states.input` at the same
 * key, so downstream JSONPath states keep reading `$.jobOutput`/`$.ladderOutput` exactly as before; each
 * `Catch` entry's `ResultPath` becomes the equivalent `Output` using `$states.errorOutput`. `Retry` is
 * untouched (it has no JSONPath/JSONata-specific fields).
 */
function applyVariantLookup(
  state: JsonObject,
  variants: Readonly<Record<string, JsonObject>>,
  replacements: Readonly<Record<string, string>>,
  keyExpr: string,
): void {
  const parameters = state.Parameters as JsonObject;
  const userMetadata = parameters.UserMetadata as JsonObject;
  state.QueryLanguage = 'JSONata';
  state.Arguments = {
    Role: parameters.Role,
    Queue: parameters.Queue,
    UserMetadata: { guid: '{% $states.input.guid %}', workflow: userMetadata.workflow },
    Tags: parameters.Tags,
    Settings: lookupSettingsExpr(variants, replacements, keyExpr),
  };
  delete state.Parameters;

  const resultPath = state.ResultPath as string; // '$.jobOutput' or '$.ladderOutput'
  const resultKey = resultPath.slice(2);
  state.Output = `{% $merge([$states.input, {"${resultKey}": $states.result}]) %}`;
  delete state.ResultPath;

  for (const catcher of state.Catch as JsonObject[]) {
    const catchResultPath = catcher.ResultPath as string; // '$.error'
    const catchKey = catchResultPath.slice(2);
    catcher.Output = `{% $merge([$states.input, {"${catchKey}": $states.errorOutput}]) %}`;
    delete catcher.ResultPath;
  }
}

/** Sentinel->JSONata-expression replacements for a tier encode (job1 mezzanine when packaging, else the
 * single GA job) — see {@link SENTINEL_FILE_INPUT}. Captions never touch this state when packaging=ON
 * (they're regenerated on Package DRM instead — see {@link applyCaptionsAndAdMarkersOverlays}), but the
 * SOURCE_FILE mapping is harmless to include unconditionally since it simply won't appear in that case. */
function tierReplacements(packaging: boolean, thumbnails: boolean, extensions: readonly ActiveExtension[]): Record<string, string> {
  const destToken = packaging ? 'INTERMEDIATE_BUCKET' : 'DESTINATION_BUCKET';
  const subPath = packaging ? 'stream' : 'index';
  const replacements: Record<string, string> = {
    [SENTINEL_FILE_INPUT]: '$states.input.fileUri',
    [sentinelForDestination(subPath)]: jsonataExpr(`s3://\${${destToken}}/{}/${subPath}`, '$states.input.guid'),
    [SENTINEL_SCC_XML]: '$states.input.config.esam.esamXml',
    [SENTINEL_SOURCE_FILE]: jsonataExpr('s3://{}/{}.vtt', '$states.input.srcBucket', '$states.input.srcVideo'),
  };
  if (thumbnails) {
    replacements[sentinelForDestination('thumbnails/frame')] = jsonataExpr(
      's3://${DESTINATION_BUCKET}/{}/thumbnails/frame',
      '$states.input.guid',
    );
  }
  for (const extension of extensionsWith(extensions, 'variantReplacements')) {
    Object.assign(replacements, extension.variantReplacements('encode'));
  }
  return replacements;
}

/** Sentinel->JSONata-expression replacements for the Package DRM (job2) Task (only exists when packagingProfile=ON). */
function packageDrmReplacements(extensions: readonly ActiveExtension[]): Record<string, string> {
  const replacements: Record<string, string> = {
    [SENTINEL_FILE_INPUT]: jsonataExpr('s3://${INTERMEDIATE_BUCKET}/{}/stream.m3u8', '$states.input.guid'),
    [SENTINEL_SCC_XML]: '$states.input.config.esam.esamXml',
    [SENTINEL_SOURCE_FILE]: jsonataExpr('s3://{}/{}.vtt', '$states.input.srcBucket', '$states.input.srcVideo'),
    [SENTINEL_GUID]: '$states.input.guid',
  };
  for (const subPath of Object.values(PACKAGE_GROUP_SUBPATHS)) {
    replacements[sentinelForDestination(subPath)] = jsonataExpr(`s3://\${DESTINATION_BUCKET}/{}/${subPath}`, '$states.input.guid');
  }
  for (const extension of extensionsWith(extensions, 'variantReplacements')) {
    Object.assign(replacements, extension.variantReplacements('package'));
  }
  return replacements;
}

/**
 * Which Settings variants a state actually needs, and the JSONata expression picking the right one at
 * runtime. `captionsApply=false` neutralizes captions for this call site (the tier encode when packaging
 * is ON — see {@link applyCaptionsAndAdMarkersOverlays}), collapsing to just the ad-markers axis (or no
 * axis at all, i.e. a single always-'plain' variant, if ad-markers is also off for this call).
 */
function variantPlan(adMarkers: boolean, captions: boolean, captionsApply: boolean): { keys: Array<'esam' | 'captions' | 'both'>; keyExpr: string } {
  const esamOn = esamOnExpr();
  const capOn = captionsOnExpr();
  const useCaptions = captions && captionsApply;
  if (adMarkers && useCaptions) {
    return { keys: ['esam', 'captions', 'both'], keyExpr: `(${esamOn} and ${capOn}) ? 'both' : ${esamOn} ? 'esam' : ${capOn} ? 'captions' : 'plain'` };
  }
  if (adMarkers) return { keys: ['esam'], keyExpr: `${esamOn} ? 'esam' : 'plain'` };
  if (useCaptions) return { keys: ['captions'], keyExpr: `${capOn} ? 'captions' : 'plain'` };
  return { keys: [], keyExpr: "'plain'" };
}

/**
 * Apply the captions/ad-markers overlays to the (already tier-spliced, already packaging-injected)
 * Process ASL as JSONata variant lookups on the EXISTING singular Encode {SD,HD,UHD} and Package DRM
 * Tasks, instead of Choice-routed state clones. `Choose Tier`/`Tier {SD,HD,UHD}` are left completely
 * alone — tier selection is a genuine per-asset choice (resolution ceiling), not a pass-through flag, and
 * stays singular regardless of which overlays are ON (there's nothing left for a Choice/clone to route
 * between: the Ad Markers?/Captions? gates and the Choose-Tier/Tier/Encode/Package-DRM clones they used
 * to drive are gone). See {@link SENTINEL_FILE_INPUT} for why a sentinel/text-substitution technique is
 * needed to embed per-execution-dynamic values (FileInput/Destination/SourceFile/SccXml) inside the
 * variants map, and the `aws-step-functions` AWS skill for the underlying JSONata mechanics this relies
 * on (`Arguments` replaces `Parameters`, `Output` replaces `ResultPath` — including inside `Catch`).
 *
 * Captions are produced directly on the tier encode when NOT packaging (the GA CMAF single job); when
 * packaging, they're generated on Package DRM instead (a REMUX_ALL passthrough job2 does NOT carry a
 * caption rendition through from its ladder input — verified live), which is why the
 * tier-encode variant plan passes `captionsApply=false` when packaging (captions never affect job1's
 * Settings in that case) while Package DRM's variant plan always passes `captionsApply=true`.
 *
 * Only called when `adMarkersProfile=ON` or `captionsProfile=ON`; when both are OFF the Process ASL is
 * untouched (byte-identical to the GA core), exactly as before. `process.asl.json` on disk is never edited.
 */
export function applyCaptionsAndAdMarkersOverlays(states: JsonObject, context: VodContext): void {
  const packaging = context.packagingProfile === 'ON';
  const perFrameMetrics = context.perFrameMetrics === 'ON';
  const thumbnails = context.thumbnailsProfile === 'ON';
  const extensions = context.extensions;
  const adMarkers = context.adMarkersProfile === 'ON';
  const captions = context.captionsProfile === 'ON';

  for (const { state, tier } of ENCODE_STATE_TIERS) {
    const encodeState = states[state] as JsonObject;
    const plan = variantPlan(adMarkers, captions, /* captionsApply */ !packaging);
    const buildVariant = (esamOn: boolean, captionsOn: boolean) =>
      packaging
        ? buildJobSettings(`${tier}-ladder` as JobProfile, {
            destBucketToken: 'INTERMEDIATE_BUCKET',
            destSubPath: 'stream',
            perFrameMetrics,
            thumbnails,
            extensions,
            jsonata: true,
            esam: esamOn ? { sccXmlRef: ESAM_SCC_XML_REF } : undefined,
          })
        : buildJobSettings(tier, {
            perFrameMetrics,
            thumbnails,
            extensions,
            jsonata: true,
            esam: esamOn ? { sccXmlRef: ESAM_SCC_XML_REF } : undefined,
            captions: captionsOn ? { sourceFileRef: CAPTIONS_SOURCE_FILE_REF } : undefined,
          });
    const variants: Record<string, JsonObject> = { plain: buildVariant(false, false) };
    for (const key of plan.keys) {
      variants[key] = buildVariant(key === 'esam' || key === 'both', key === 'captions' || key === 'both');
    }
    applyVariantLookup(encodeState, variants, tierReplacements(packaging, thumbnails, extensions), plan.keyExpr);
  }

  if (packaging) {
    const packageDrm = states['Package DRM'] as JsonObject;
    const plan = variantPlan(adMarkers, captions, /* captionsApply */ true);
    const buildVariant = (esamOn: boolean, captionsOn: boolean) =>
      buildJobSettings('package', {
        inputRef: PACKAGE_INPUT_REF,
        groupSubPaths: PACKAGE_GROUP_SUBPATHS,
        extensions,
        jsonata: true,
        esam: esamOn ? { sccXmlRef: ESAM_SCC_XML_REF } : undefined,
        captions: captionsOn ? { sourceFileRef: CAPTIONS_SOURCE_FILE_REF } : undefined,
      });
    const variants: Record<string, JsonObject> = { plain: buildVariant(false, false) };
    for (const key of plan.keys) {
      variants[key] = buildVariant(key === 'esam' || key === 'both', key === 'captions' || key === 'both');
    }
    applyVariantLookup(packageDrm, variants, packageDrmReplacements(extensions), plan.keyExpr);
  }
}
