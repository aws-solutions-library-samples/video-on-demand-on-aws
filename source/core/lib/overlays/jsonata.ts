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
 * JSONata sentinels + expression helpers shared by `../job-settings.ts` (which writes the sentinels) and
 * the variant engine in `./variants.ts` (which replaces them). Kept separate from `./variants.ts` so
 * `buildJobSettings` can use them without an import cycle.
 */

import { JsonObject } from './types';

/**
 * JSONata variant-lookup sentinels (see {@link JobSettingsOptions.jsonata} and
 * {@link lookupSettingsExpr}).
 *
 * The captions/ad-markers overlays used to implement graceful-skip by cloning whole Choice/Pass/Task
 * states per feature combination (`Ad Markers?`/`Captions?` gates + up to 4 `Choose Tier`/`Tier {T}`/
 * `Encode {T}` clones). Instead, a single Encode/Package-DRM Task now carries ALL the Settings variants
 * it might need and picks one at runtime via a JSONata `$lookup(variants, keyExpr)` expression in its
 * `Arguments.Settings` (see {@link applyCaptionsAndAdMarkersOverlays}).
 *
 * The wrinkle: `buildJobSettings` needs to embed a handful of genuinely PER-EXECUTION dynamic values
 * (`FileInput`, each output group's `Destination`, the caption `SourceFile`, the ESAM `SccXml`) inside
 * the variants map. Under JSONPath those are `.$`-suffixed intrinsic-function keys resolved by Step
 * Functions' `Parameters` payload-template processor — but that processor does NOT exist for `Arguments`
 * (JSONata mode), and (critically) it also would NOT recurse into the object `$lookup()` returns even if
 * it did, since `{% %}` evaluation is a single pass over the STATE's own authored fields, not a
 * recursive re-scan of a JSONata expression's result. So a dynamic value can't be pre-baked into the
 * variants-map JSON literal as a `{% %}` string — it must appear as a genuine, UNQUOTED JSONata
 * sub-expression within the SAME outer expression that returns the whole Settings object.
 *
 * `buildJobSettings(profile, { jsonata: true, ... })` therefore writes a plain, well-known SENTINEL
 * string (e.g. {@link SENTINEL_FILE_INPUT}) at each such site instead of a `.$` key. After
 * `JSON.stringify`-ing the variants map (which quotes the sentinels like any other string), the caller
 * ({@link lookupSettingsExpr}) does one text-level pass replacing each quoted sentinel with the bare
 * (unquoted) JSONata expression for that call's actual context (e.g. `$states.input.fileUri`) — turning
 * `"FileInput":"__JSONATA_FILE_INPUT__"` into `"FileInput":$states.input.fileUri` in the final expression
 * text. Plain ASCII markers (not e.g. NUL bytes) are used so the intermediate JSON text stays
 * human-readable when debugging a synthesized template.
 */
export const SENTINEL_FILE_INPUT = '__JSONATA_FILE_INPUT__';
export const SENTINEL_SOURCE_FILE = '__JSONATA_SOURCE_FILE__';
export const SENTINEL_SCC_XML = '__JSONATA_SCC_XML__';
export const SENTINEL_GUID = '__JSONATA_GUID__';
/** One sentinel per distinct output-group sub-path (each needs its own destination-bucket+subPath expression). */
export const sentinelForDestination = (subPath: string): string => `__JSONATA_DEST_${subPath.replace(/[^A-Za-z0-9]/g, '_')}__`;

/** Render a JS string as a single-quoted JSONata string literal (escaping `\` and `'`). */
export function jsonataStringLiteral(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * JSONata equivalent of an ASL `States.Format('template {} {}', ref1, ref2)` intrinsic: `&`-concatenates
 * the literal template fragments (split on `{}`) with the given (already-JSONata, e.g.
 * `$states.input.guid`) reference expressions. Returns the BARE expression text (no `{% %}` wrapper) —
 * callers embed it directly inside a larger JSONata expression (see {@link SENTINEL_FILE_INPUT} doc).
 */
export function jsonataExpr(template: string, ...refs: string[]): string {
  const parts = template.split('{}');
  if (parts.length - 1 !== refs.length) {
    throw new Error(`jsonataExpr: template '${template}' has ${parts.length - 1} placeholders but ${refs.length} refs were given.`);
  }
  const pieces: string[] = [];
  parts.forEach((literal, i) => {
    if (literal !== '') pieces.push(jsonataStringLiteral(literal));
    if (i < refs.length) pieces.push(refs[i]);
  });
  return pieces.join(' & ');
}

/**
 * Build the `{% $lookup(variants, keyExpr) %}` JSONata expression for a Task's `Arguments.Settings`:
 * JSON-serializes the `variants` map (each value a `buildJobSettings(..., { jsonata: true })` object,
 * still carrying the sentinel placeholders), then text-replaces each quoted sentinel in `replacements`
 * with its bare JSONata expression for this call site. See {@link SENTINEL_FILE_INPUT} doc for why this
 * two-step (stringify, then text-substitute) approach is necessary rather than nesting `{% %}` strings.
 */
export function lookupSettingsExpr(variants: Readonly<Record<string, JsonObject>>, replacements: Readonly<Record<string, string>>, keyExpr: string): string {
  let text = `{${Object.entries(variants)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',')}}`;
  for (const [sentinel, expr] of Object.entries(replacements)) {
    text = text.split(JSON.stringify(sentinel)).join(expr);
  }
  return `{% $lookup(${text}, ${keyExpr}) %}`;
}
