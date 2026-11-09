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
 * Assertions for the streaming-media WAF module stack (`StreamingMediaWafStack`):
 * a CLOUDFRONT-scope WebACL (default BLOCK) with an IP-set allow rule and a geo-match allow rule, an
 * IPv4 IP set, and a clean cdk-nag gate. This stack is separate from (and never part of) the main GA
 * transcoding stack.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { parseWafContext } from '../lib/context';
import { StreamingMediaWafStack } from '../lib/waf-stack';

let cached: { template: Template; annotations: Annotations } | undefined;
function synth(): { template: Template; annotations: Annotations } {
  if (!cached) {
    const app = new cdk.App();
    const context = parseWafContext({
      tryGetContext: (key: string) =>
        ({
          wafAllowedCountries: 'US,CA',
          wafAllowedIps: '203.0.113.0/24',
        } as Record<string, unknown>)[key],
    });
    const stack = new StreamingMediaWafStack(app, 'StreamingMediaWaf', {
      env: { account: '123456789012', region: 'us-east-1' },
      context,
    });
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cached = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cached;
}

describe('StreamingMediaWafStack — WebACL', () => {
  test('creates one CLOUDFRONT-scope WebACL that blocks by default', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties(
      'AWS::WAFv2::WebACL',
      Match.objectLike({ Scope: 'CLOUDFRONT', DefaultAction: { Block: {} } }),
    );
  });

  test('has an allow-by-country rule with the configured codes', () => {
    synth().template.hasResourceProperties(
      'AWS::WAFv2::WebACL',
      Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'allow-countries',
            Action: { Allow: {} },
            Statement: { GeoMatchStatement: { CountryCodes: ['US', 'CA'] } },
          }),
        ]),
      }),
    );
  });

  test('has an allow-by-IP rule referencing a CLOUDFRONT-scope IPv4 IP set', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::WAFv2::IPSet', 1);
    template.hasResourceProperties(
      'AWS::WAFv2::IPSet',
      Match.objectLike({ Scope: 'CLOUDFRONT', IPAddressVersion: 'IPV4', Addresses: ['203.0.113.0/24'] }),
    );
    template.hasResourceProperties(
      'AWS::WAFv2::WebACL',
      Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({ Name: 'allow-ips', Action: { Allow: {} } }),
        ]),
      }),
    );
  });

  test('emits the WebAclArn output', () => {
    synth().template.hasOutput('WebAclArn', {});
  });
});

describe('parseWafContext', () => {
  const reader = (ctx: Record<string, unknown>) => ({ tryGetContext: (k: string) => ctx[k] });

  test('accepts countries and/or IPv4 CIDRs (countries upper-cased)', () => {
    const ctx = parseWafContext(reader({ wafAllowedCountries: 'us,ca', wafAllowedIps: '203.0.113.0/24' }));
    expect(ctx.wafAllowedCountries).toEqual(['US', 'CA']);
    expect(ctx.wafAllowedIps).toEqual(['203.0.113.0/24']);
  });

  test('rejects a non-ISO wafAllowedCountries code', () => {
    expect(() => parseWafContext(reader({ wafAllowedCountries: ['USA'] }))).toThrow(
      /'wafAllowedCountries' must be a list of ISO 3166-1 alpha-2/,
    );
  });

  test('rejects a malformed wafAllowedIps CIDR', () => {
    expect(() => parseWafContext(reader({ wafAllowedIps: '203.0.113.0' }))).toThrow(
      /'wafAllowedIps' must be a list of IPv4 CIDR ranges/,
    );
    expect(() => parseWafContext(reader({ wafAllowedIps: '999.0.0.0/24' }))).toThrow(
      /'wafAllowedIps' must be a list of IPv4 CIDR ranges/,
    );
  });

  test('throws when no allow-list is provided (an empty WebACL blocks everything)', () => {
    expect(() => parseWafContext(reader({}))).toThrow(/at least one of wafAllowedCountries or wafAllowedIps/);
  });
});

describe('StreamingMediaWafStack — cdk-nag', () => {
  test('has zero unsuppressed AwsSolutions-* errors', () => {
    const errors = synth().annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
  });

  test('has zero unsuppressed AwsSolutions-* warnings', () => {
    const warnings = synth().annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(warnings.map((w) => JSON.stringify(w.entry.data))).toEqual([]);
  });
});

describe('StreamingMediaWafStack — wafAllowManifests (SSAI)', () => {
  const build = (allowManifests?: string) => {
    const app = new cdk.App();
    const context = parseWafContext({
      tryGetContext: (key: string) =>
        ({ wafAllowedIps: '203.0.113.0/24', wafAllowManifests: allowManifests } as Record<string, unknown>)[key],
    });
    const stack = new StreamingMediaWafStack(app, 'StreamingMediaWaf', { env: { account: '123456789012', region: 'us-east-1' }, context });
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    return { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  };
  const ruleNames = (t: Template) =>
    (Object.values(t.findResources('AWS::WAFv2::WebACL'))[0].Properties.Rules as Array<{ Name: string }>).map((r) => r.Name);

  test('default OFF: no manifest rule (everything is behind the allow-lists)', () => {
    expect(ruleNames(build().template)).toEqual(['allow-ips']);
  });

  test('ON: allows only URIs ending .m3u8 / .mpd (case-insensitive); the default action still blocks', () => {
    const { template, annotations } = build('ON');
    expect(ruleNames(template)).toEqual(['allow-ips', 'allow-manifests']);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      DefaultAction: { Block: {} },
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'allow-manifests',
          Action: { Allow: {} },
          Statement: {
            OrStatement: {
              Statements: ['.m3u8', '.mpd'].map((suffix) => ({
                ByteMatchStatement: {
                  FieldToMatch: { UriPath: {} },
                  PositionalConstraint: 'ENDS_WITH',
                  SearchString: suffix,
                  TextTransformations: [{ Priority: 0, Type: 'LOWERCASE' }],
                },
              })),
            },
          },
        }),
      ]),
    });
    expect(annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toEqual([]);
  });

  test('rejects a value other than OFF/ON', () => {
    expect(() => build('yes')).toThrow(/'wafAllowManifests' must be one of OFF \| ON/);
  });
});

describe('StreamingMediaWafStack — wafAllowPathPrefixes (SSAI ad creatives)', () => {
  const build = (prefixes?: string) => {
    const app = new cdk.App();
    const context = parseWafContext({
      tryGetContext: (key: string) =>
        ({ wafAllowedIps: '203.0.113.0/24', wafAllowPathPrefixes: prefixes } as Record<string, unknown>)[key],
    });
    return Template.fromStack(new StreamingMediaWafStack(app, 'StreamingMediaWaf', { env: { account: '123456789012', region: 'us-east-1' }, context }));
  };

  test('a single prefix becomes a STARTS_WITH allow rule (no rule when unset)', () => {
    const rules = (t: Template) => Object.values(t.findResources('AWS::WAFv2::WebACL'))[0].Properties.Rules as Array<Record<string, any>>;
    expect(rules(build()).map((r) => r.Name)).toEqual(['allow-ips']);
    const rule = rules(build('/creatives/')).find((r) => r.Name === 'allow-paths')!;
    expect(rule.Statement.ByteMatchStatement).toMatchObject({ FieldToMatch: { UriPath: {} }, PositionalConstraint: 'STARTS_WITH', SearchString: '/creatives/' });
    expect(rule.Action).toEqual({ Allow: {} });
  });

  test('several prefixes are OR-ed', () => {
    const rule = (Object.values(build('/creatives/,/promos/').findResources('AWS::WAFv2::WebACL'))[0].Properties.Rules as Array<Record<string, any>>).find((r) => r.Name === 'allow-paths')!;
    expect(rule.Statement.OrStatement.Statements).toHaveLength(2);
  });

  test.each(['creatives/', '/creatives', '/', '/a b/'])('rejects %s', (bad) => {
    expect(() => build(bad)).toThrow(/wafAllowPathPrefixes/);
  });
});
