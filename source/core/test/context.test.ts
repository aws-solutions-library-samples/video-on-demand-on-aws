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
 * Unit tests for the pure-TypeScript synth-time context parser/validator (`lib/context.ts`), which
 * replaces the runtime validation the removed `input-validate` Lambda used to perform. The parser
 * MUST throw (fail `cdk synth` fast) on missing/invalid inputs, and MUST coerce booleans to the
 * literal strings `'true'` / `'false'` the ASL `Choice` states compare with `StringEquals`.
 */

import { parseVodContext, VodContextError, ContextReader, contextKeyToEnvVar, withEnvFallback } from '../lib/context';

/** Build a `ContextReader` backed by a plain map (matches how `app.node.tryGetContext` behaves). */
function reader(values: Record<string, unknown>): ContextReader {
  return { tryGetContext: (key: string) => values[key] };
}

describe('parseVodContext — email (required)', () => {
  test('throws when email is missing', () => {
    expect(() => parseVodContext(reader({}))).toThrow(VodContextError);
    expect(() => parseVodContext(reader({}))).toThrow(/'email' is required/);
  });

  test('throws when email is an empty / whitespace string', () => {
    expect(() => parseVodContext(reader({ email: '   ' }))).toThrow(/'email' is required/);
  });

  test('throws when email is malformed', () => {
    expect(() => parseVodContext(reader({ email: 'not-an-email' }))).toThrow(VodContextError);
    expect(() => parseVodContext(reader({ email: 'not-an-email' }))).toThrow(/not a valid email/);
  });

  test('accepts a well-formed email', () => {
    expect(parseVodContext(reader({ email: 'ops@example.com' })).email).toBe('ops@example.com');
  });
});

describe('parseVodContext — enum validation', () => {
  test('throws on an out-of-allowlist archiveSource', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', archiveSource: 'TAPE' })),
    ).toThrow(/'archiveSource' must be one of/);
  });

  test('throws on an out-of-allowlist priceClass', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', priceClass: 'PriceClass_50' })),
    ).toThrow(/'priceClass' must be one of/);
  });

  test('applies documented defaults (NONE / PriceClass_All) when omitted', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com' }));
    expect(ctx.archiveSource).toBe('NONE');
    expect(ctx.priceClass).toBe('PriceClass_All');
  });

  test('adMarkersProfile defaults OFF, accepts ON, and throws on a bad value', () => {
    expect(parseVodContext(reader({ email: 'ops@example.com' })).adMarkersProfile).toBe('OFF');
    expect(
      parseVodContext(reader({ email: 'ops@example.com', adMarkersProfile: 'ON' })).adMarkersProfile,
    ).toBe('ON');
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', adMarkersProfile: 'YES' })),
    ).toThrow(/'adMarkersProfile' must be one of/);
  });

  test('adMarkersProfile=ON is independent of packaging (no cross-field guard)', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', adMarkersProfile: 'ON' })),
    ).not.toThrow();
  });

  test('perFrameMetrics defaults OFF, accepts ON (standalone, no cross-field guard), throws on a bad value', () => {
    expect(parseVodContext(reader({ email: 'ops@example.com' })).perFrameMetrics).toBe('OFF');
    expect(
      parseVodContext(reader({ email: 'ops@example.com', perFrameMetrics: 'ON' })).perFrameMetrics,
    ).toBe('ON');
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', perFrameMetrics: 'ON' })),
    ).not.toThrow();
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', perFrameMetrics: 'YES' })),
    ).toThrow(/'perFrameMetrics' must be one of/);
  });

  test('captionsProfile defaults OFF, accepts ON, and throws on a bad value', () => {
    expect(parseVodContext(reader({ email: 'ops@example.com' })).captionsProfile).toBe('OFF');
    expect(
      parseVodContext(reader({ email: 'ops@example.com', captionsProfile: 'ON' })).captionsProfile,
    ).toBe('ON');
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', captionsProfile: 'YES' })),
    ).toThrow(/'captionsProfile' must be one of/);
  });

  test('captionsProfile=ON is independent of packaging/ad-markers (no cross-field guard)', () => {
    expect(() =>
      parseVodContext(
        reader({ email: 'ops@example.com', captionsProfile: 'ON', packagingProfile: 'ON', adMarkersProfile: 'ON' }),
      ),
    ).not.toThrow();
  });

  test('thumbnailsProfile defaults ON, accepts OFF (standalone, no cross-field guard), throws on a bad value', () => {
    expect(parseVodContext(reader({ email: 'ops@example.com' })).thumbnailsProfile).toBe('ON');
    expect(
      parseVodContext(reader({ email: 'ops@example.com', thumbnailsProfile: 'OFF' })).thumbnailsProfile,
    ).toBe('OFF');
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', thumbnailsProfile: 'OFF' })),
    ).not.toThrow();
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', thumbnailsProfile: 'YES' })),
    ).toThrow(/'thumbnailsProfile' must be one of/);
  });

  test('accepts valid enum values', () => {
    const ctx = parseVodContext(
      reader({
        email: 'ops@example.com',
        archiveSource: 'GLACIER',
        priceClass: 'PriceClass_All',
      }),
    );
    expect(ctx.archiveSource).toBe('GLACIER');
    expect(ctx.priceClass).toBe('PriceClass_All');
  });
});

describe('parseVodContext — enableSns / enableSqs boolean coercion', () => {
  test('defaults enableSns to "true" and enableSqs to "false"', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com' }));
    expect(ctx.enableSns).toBe('true');
    expect(ctx.enableSqs).toBe('false');
  });

  test('coerces real booleans to the literal strings "true"/"false"', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com', enableSns: false, enableSqs: true }));
    expect(ctx.enableSns).toBe('false');
    expect(ctx.enableSqs).toBe('true');
  });

  test('coerces case-insensitive string booleans to "true"/"false"', () => {
    const ctx = parseVodContext(
      reader({ email: 'ops@example.com', enableSns: 'FALSE', enableSqs: 'True' }),
    );
    expect(ctx.enableSns).toBe('false');
    expect(ctx.enableSqs).toBe('true');
  });

  test('throws on a non-boolean value', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', enableSns: 'yes' })),
    ).toThrow(/'enableSns' must be a boolean/);
  });
});

describe('parseVodContext — optional edge inputs', () => {
  test('parses a comma-separated geoRestriction into an uppercased list', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com', geoRestriction: 'us,ca' }));
    expect(ctx.geoRestriction).toEqual(['US', 'CA']);
  });

  test('throws on a non ISO-3166 alpha-2 geoRestriction code', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', geoRestriction: ['USA'] })),
    ).toThrow(/'geoRestriction' must be a list of ISO 3166-1 alpha-2/);
  });

  test('throws on a non-WAFv2 wafWebAclArn', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', wafWebAclArn: 'arn:aws:s3:::bucket' })),
    ).toThrow(/'wafWebAclArn' must be a WAFv2 WebACL ARN/);
  });

  test('throws on a non-positive-integer destinationRetentionDays', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', destinationRetentionDays: 0 })),
    ).toThrow(/'destinationRetentionDays' must be a positive integer/);
  });

  test('leaves optional edge inputs undefined when omitted', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com' }));
    expect(ctx.geoRestriction).toBeUndefined();
    expect(ctx.wafWebAclArn).toBeUndefined();
    expect(ctx.destinationRetentionDays).toBeUndefined();
    expect(ctx.stackName).toBeUndefined();
  });
});

describe('parseVodContext — packaging overlay (packagingProfile)', () => {
  test('defaults packagingProfile to OFF', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com' }));
    expect(ctx.packagingProfile).toBe('OFF');
  });

  test('accepts packagingProfile=ON and rejects any other value', () => {
    expect(parseVodContext(reader({ email: 'ops@example.com', packagingProfile: 'ON' })).packagingProfile).toBe('ON');
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', packagingProfile: 'on' })),
    ).toThrow(/'packagingProfile' must be one of/);
  });
});

describe('contextKeyToEnvVar', () => {
  it.each([
    ['email', 'EMAIL'],
    ['stackName', 'STACK_NAME'],
    ['packagingProfile', 'PACKAGING_PROFILE'],
    ['thumbnailsProfile', 'THUMBNAILS_PROFILE'],
    ['wafWebAclArn', 'WAF_WEB_ACL_ARN'],
    ['captionsProfile', 'CAPTIONS_PROFILE'],
    ['wafAllowedCountries', 'WAF_ALLOWED_COUNTRIES'],
    ['wafAllowedIps', 'WAF_ALLOWED_IPS'],
    ['destinationRetentionDays', 'DESTINATION_RETENTION_DAYS'],
    ['uploadCorsOrigins', 'UPLOAD_CORS_ORIGINS'],
  ])('maps %s -> %s', (key, envVar) => {
    expect(contextKeyToEnvVar(key)).toBe(envVar);
  });
});

describe('withEnvFallback', () => {
  const base = (values: Record<string, unknown>): ContextReader => ({
    tryGetContext: (key: string) => values[key],
  });

  it('sources unset context keys from the UPPER_SNAKE env var (.env)', () => {
    const ctx = parseVodContext(
      withEnvFallback(base({}), { EMAIL: 'ops@example.com', PACKAGING_PROFILE: 'ON' }),
    );
    expect(ctx.email).toBe('ops@example.com');
    expect(ctx.packagingProfile).toBe('ON');
  });

  it('lets explicit -c/cdk.json context win over .env', () => {
    const ctx = parseVodContext(
      withEnvFallback(base({ email: 'cli@example.com' }), { EMAIL: 'env@example.com' }),
    );
    expect(ctx.email).toBe('cli@example.com');
  });

  it('still throws when a required key is absent from both context and env', () => {
    expect(() => parseVodContext(withEnvFallback(base({}), {}))).toThrow(/'email' is required/);
  });
});

describe('parseVodContext — custom domain (domainName + certificateArn)', () => {
  const certificateArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

  test('defaults to neither', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com' }));
    expect(ctx.domainName).toBeUndefined();
    expect(ctx.certificateArn).toBeUndefined();
  });

  test('accepts the pair and lowercases the domain', () => {
    const ctx = parseVodContext(reader({ email: 'ops@example.com', domainName: 'Video.Example.com', certificateArn }));
    expect(ctx.domainName).toBe('video.example.com');
    expect(ctx.certificateArn).toBe(certificateArn);
  });

  test('requires both or neither', () => {
    expect(() => parseVodContext(reader({ email: 'ops@example.com', domainName: 'video.example.com' }))).toThrow(
      /must be set together/,
    );
    expect(() => parseVodContext(reader({ email: 'ops@example.com', certificateArn }))).toThrow(/must be set together/);
  });

  test('rejects a malformed domain or a certificate outside us-east-1', () => {
    expect(() =>
      parseVodContext(reader({ email: 'ops@example.com', domainName: 'https://video.example.com', certificateArn })),
    ).toThrow(VodContextError);
    expect(() =>
      parseVodContext(
        reader({ email: 'ops@example.com', domainName: 'video.example.com', certificateArn: certificateArn.replace('us-east-1', 'eu-west-1') }),
      ),
    ).toThrow(/us-east-1/);
  });

  test('reads DOMAIN_NAME / CERTIFICATE_ARN from .env', () => {
    expect(contextKeyToEnvVar('domainName')).toBe('DOMAIN_NAME');
    expect(contextKeyToEnvVar('certificateArn')).toBe('CERTIFICATE_ARN');
  });
});
