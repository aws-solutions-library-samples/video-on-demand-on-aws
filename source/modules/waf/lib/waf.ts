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
 * WafConstruct — the streaming-media WAFv2 WebACL for the delivery-protection overlay
 * module.
 *
 * Builds a CLOUDFRONT-scope WebACL with `DefaultAction = Block` and up to two allow rules (allow if
 * EITHER matches):
 *   - `allow-ips`      (priority 0, only when `wafAllowedIps` is set): allow requests whose source IP is
 *                      in an IPv4 `CfnIPSet`. Lets trusted IPs (e.g. an office range) through regardless
 *                      of country.
 *   - `allow-countries`(priority 1, only when `wafAllowedCountries` is set): allow requests whose viewer
 *                      country is in the allow-list (WAF geo-match) — the geo-restriction.
 *   - `allow-manifests`(priority 2, only when `wafAllowManifests=ON`): allow `*.m3u8` / `*.mpd` from anyone,
 *                      so MediaTailor (SSAI) can fetch the origin manifests from AWS addresses. Segments
 *                      and keys stay gated, so a manifest alone cannot be played from outside the lists.
 *   - `allow-paths`    (priority 3, only when `wafAllowPathPrefixes` is set): allow URI paths starting with
 *                      any listed prefix (e.g. `/creatives/` for SSAI ad creatives MediaTailor transcodes).
 *
 * A CLOUDFRONT-scope WebACL can only exist in us-east-1, so this construct is instantiated by the
 * separate us-east-1 `StreamingMediaWafStack` (see `lib/waf-stack.ts`), NOT the core VOD stack. The
 * operator feeds {@link webAclArn} back into the core stack's `wafWebAclArn` context (two-step deploy,
 * see `deploy.sh`) — which keeps the core-stack 0-Lambda invariant intact (a CDK cross-region
 * reference would inject a Lambda-backed custom resource into the consuming stack).
 *
 * IPv6 allow-lists are not supported (the context validator accepts IPv4 CIDRs only).
 */

import { Construct } from 'constructs';
import { Aws } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

import { WafContext } from './context';

export interface WafConstructProps {
  /** Validated module context. Reads `wafAllowedCountries` + `wafAllowedIps` (at least one set). */
  readonly context: WafContext;
}

export class WafConstruct extends Construct {
  /** The CLOUDFRONT-scope WebACL ARN to associate with the distribution (`wafWebAclArn`). */
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    super(scope, id);

    const { wafAllowedCountries, wafAllowedIps, wafAllowManifests, wafAllowPathPrefixes } = props.context;
    if ((!wafAllowedCountries || wafAllowedCountries.length === 0) && (!wafAllowedIps || wafAllowedIps.length === 0)) {
      // Guarded in context.ts (at least one allow-list is required); assert for safety.
      throw new Error('WafConstruct requires at least one of wafAllowedCountries / wafAllowedIps.');
    }

    const rules: wafv2.CfnWebACL.RuleProperty[] = [];

    // allow-ips (priority 0): allow trusted source IPs regardless of country.
    if (wafAllowedIps && wafAllowedIps.length > 0) {
      const ipSet = new wafv2.CfnIPSet(this, 'AllowIpSet', {
        name: `${Aws.STACK_NAME}-allow-ips`,
        description: 'Streaming-media WAF - allowed source IPv4 CIDRs for delivery protection.',
        scope: 'CLOUDFRONT',
        ipAddressVersion: 'IPV4',
        addresses: wafAllowedIps,
      });
      rules.push({
        name: 'allow-ips',
        priority: 0,
        action: { allow: {} },
        statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: `${Aws.STACK_NAME}-allow-ips`,
        },
      });
    }

    // allow-countries (priority 1): the geo-restriction allow-list.
    if (wafAllowedCountries && wafAllowedCountries.length > 0) {
      rules.push({
        name: 'allow-countries',
        priority: 1,
        action: { allow: {} },
        statement: { geoMatchStatement: { countryCodes: wafAllowedCountries } },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: `${Aws.STACK_NAME}-allow-countries`,
        },
      });
    }

    // allow-manifests (priority 2): playlists/manifests from anyone (SSAI origin fetches); media stays gated.
    if (wafAllowManifests === 'ON') {
      const uriEndsWith = (suffix: string): wafv2.CfnWebACL.StatementProperty => ({
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'ENDS_WITH',
          searchString: suffix,
          textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
        },
      });
      rules.push({
        name: 'allow-manifests',
        priority: 2,
        action: { allow: {} },
        statement: { orStatement: { statements: [uriEndsWith('.m3u8'), uriEndsWith('.mpd')] } },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: `${Aws.STACK_NAME}-allow-manifests`,
        },
      });
    }

    // allow-paths (priority 3): public path prefixes (e.g. SSAI ad creatives); everything else stays gated.
    if (wafAllowPathPrefixes && wafAllowPathPrefixes.length > 0) {
      const startsWith = (prefix: string): wafv2.CfnWebACL.StatementProperty => ({
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'STARTS_WITH',
          searchString: prefix,
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      });
      rules.push({
        name: 'allow-paths',
        priority: 3,
        action: { allow: {} },
        statement:
          wafAllowPathPrefixes.length === 1
            ? startsWith(wafAllowPathPrefixes[0])
            : { orStatement: { statements: wafAllowPathPrefixes.map(startsWith) } },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: `${Aws.STACK_NAME}-allow-paths`,
        },
      });
    }

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${Aws.STACK_NAME}-streaming-media`,
      description:
        wafAllowManifests === 'ON'
          ? 'Streaming-media WebACL for delivery protection - default BLOCK, allow by IP or country, manifests allowed for SSAI.'
          : 'Streaming-media WebACL for delivery protection - default BLOCK, allow by IP or country.',
      scope: 'CLOUDFRONT',
      defaultAction: { block: {} },
      rules,
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: `${Aws.STACK_NAME}-streaming-media`,
      },
    });

    this.webAclArn = webAcl.attrArn;
  }
}
