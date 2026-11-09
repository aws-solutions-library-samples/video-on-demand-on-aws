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
 * Synth-time context for the streaming-media WAF module. Reads the same keys (and the same
 * repo-root `.env` UPPER_SNAKE fallbacks) the core stack does, and throws {@link VodContextError}
 * so `cdk synth` fails fast on a bad input.
 */

import {
  ContextReader,
  VodContextError,
  readContextValue,
  coerceCountryCodes,
  coerceCidrList,
  coerceEnum,
  coerceOptionalString,
  coerceStringList,
} from '@vod/contract';

export interface WafContext {
  /** Core stack name (`stackName`); the WAF stack is named `<stackName>-waf` when set. */
  readonly stackName?: string;
  /** ISO 3166-1 alpha-2 country codes for the geo-match allow rule. */
  readonly wafAllowedCountries?: string[];
  /** IPv4 CIDR ranges for the IP-set allow rule (e.g. `203.0.113.0/24`). */
  readonly wafAllowedIps?: string[];
  /**
   * `ON` allows playlist/manifest requests (`*.m3u8`, `*.mpd`) from anyone; segments, keys and every other
   * object stay behind the IP/country allow-lists. Needed with the SSAI module: MediaTailor fetches the
   * origin manifests itself, from AWS addresses, while viewers still fetch the content segments (checked
   * here). Default `OFF`.
   */
  readonly wafAllowManifests: 'OFF' | 'ON';
  /**
   * URI path prefixes allowed from anyone (each `/like/this/`), e.g. `/creatives/` for the SSAI module's ad
   * creatives, which MediaTailor transcodes from AWS addresses. Ads are public by nature; keep content out of
   * these prefixes.
   */
  readonly wafAllowPathPrefixes?: string[];
}

export function parseWafContext(reader: ContextReader): WafContext {
  const wafAllowedCountries = coerceCountryCodes(readContextValue(reader, 'wafAllowedCountries'), 'wafAllowedCountries');
  const wafAllowedIps = coerceCidrList(readContextValue(reader, 'wafAllowedIps'), 'wafAllowedIps');
  if (!(wafAllowedCountries || wafAllowedIps)) {
    throw new VodContextError(
      'the WAF module requires at least one of wafAllowedCountries or wafAllowedIps (an empty WebACL blocks ' +
        'all traffic).',
    );
  }
  const prefixes = coerceStringList(readContextValue(reader, 'wafAllowPathPrefixes'));
  for (const p of prefixes ?? []) {
    if (typeof p !== 'string' || !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*\/$/.test(p)) {
      throw new VodContextError(`'wafAllowPathPrefixes' entries must be URI path prefixes like /creatives/; received ${JSON.stringify(p)}.`);
    }
  }
  return {
    stackName: coerceOptionalString(readContextValue(reader, 'stackName'), 'stackName'),
    wafAllowedCountries,
    wafAllowedIps,
    wafAllowPathPrefixes: prefixes as string[] | undefined,
    wafAllowManifests: coerceEnum(readContextValue(reader, 'wafAllowManifests'), 'wafAllowManifests', ['OFF', 'ON'] as const, 'OFF'),
  };
}
