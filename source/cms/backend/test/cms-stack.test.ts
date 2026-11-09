/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SsmKey, ssmParameterName } from '@vod/contract';
import { CmsStack } from '../lib/cms-stack';
import { CmsExtension, loadCmsExtensions } from '../lib/extensions';

const VOD = 'VideoOnDemand';

function synth(packagingProfile: 'OFF' | 'ON'): { stack: CmsStack; template: Template } {
  const app = new cdk.App();
  const stack = new CmsStack(app, `${VOD}-cms`, {
    env: { account: '123456789012', region: 'us-east-1' },
    appName: 'vod-cms',
    environment: 'dev',
    vodStackName: VOD,
    packagingProfile,
  });
  cdk.Aspects.of(app).add(new AwsSolutionsChecks());
  return { stack, template: Template.fromStack(stack) };
}

/** SSM parameter names the stack resolves at deploy time (CloudFormation SSM-typed parameters). */
function ssmReads(template: Template): string[] {
  const params = template.toJSON().Parameters ?? {};
  return Object.values(params as Record<string, { Type: string; Default?: string }>)
    .filter((p) => p.Type.startsWith('AWS::SSM::Parameter::Value'))
    .map((p) => p.Default as string)
    .filter((name) => !name.startsWith('/cdk-bootstrap/'))
    .sort();
}

describe.each(['OFF', 'ON'] as const)('CmsStack (packagingProfile=%s)', (packagingProfile) => {
  const { stack, template } = synth(packagingProfile);

  test('cdk-nag reports no unsuppressed findings', () => {
    expect(Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toEqual([]);
  });

  test('reads only contract discovery params from the VOD stack', () => {
    const expected = [
      SsmKey.SourceBucket,
      SsmKey.DestinationBucket,
      SsmKey.DynamoDBTable,
      SsmKey.OrchestratorStateMachineArn,
      SsmKey.CloudFrontDomainName, // the media CDN, for the site's Content-Security-Policy
      ...(packagingProfile === 'ON' ? [SsmKey.IntermediateBucket] : []),
    ].map((k) => ssmParameterName(VOD, k));
    expect(ssmReads(template)).toEqual(expected.sort());
  });

  test('the quality-metrics rescue Lambda exists only with packaging ON', () => {
    template.resourceCountIs('AWS::Events::Rule', packagingProfile === 'ON' ? 1 : 0);
  });
});

test('the assets Lambda (unbundled, cannot import @vod/contract) uses contract key names', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'assets', 'index.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const names = ['), src.indexOf('].map('));
  const names = [...block.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(Object.values(SsmKey)).toContain(name);
  }
});

describe('extension seam', () => {
  const fake: CmsExtension = {
    id: 'fake',
    contextKeys: ['fakeOn'],
    activate: (node) =>
      node.tryGetContext('fakeOn') === 'true'
        ? {
            handlerEnvironment: { FAKE_FLAG: 'on' },
            extendApi: ({ stack, handler }) => {
              handler.addEnvironment('FAKE_STACK', stack.stackName);
            },
            addAssetRoutes: ({ asset, integration, authOpts }) => {
              asset.addResource('fake').addMethod('GET', integration, authOpts);
            },
            requestValidationNotes: ['FAKE NOTE.'],
          }
        : undefined,
  };
  const build = (fakeOn: boolean) => {
    const app = new cdk.App({ context: fakeOn ? { vodExtensions: 'fake', fakeOn: 'true' } : {} });
    const stack = new CmsStack(app, `${VOD}-cms`, {
      env: { account: '123456789012', region: 'us-east-1' },
      appName: 'vod-cms',
      environment: 'dev',
      vodStackName: VOD,
      packagingProfile: 'OFF',
      extensions: [fake],
    });
    cdk.Aspects.of(app).add(new AwsSolutionsChecks());
    return { stack, template: Template.fromStack(stack) };
  };

  test.each([false, true])('an extension contributes env, routes and nag notes only when active (on=%s)', (on) => {
    const { stack, template } = build(on);
    expect(Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toEqual([]);
    const paths = Object.values(template.findResources('AWS::ApiGateway::Resource')).map((r) => r.Properties.PathPart);
    expect(paths.includes('fake')).toBe(on);
    const vars = Object.values(template.findResources('AWS::Lambda::Function')).map(
      (f) => (f.Properties.Environment?.Variables ?? {}) as Record<string, unknown>,
    );
    expect(vars.some((v) => v.FAKE_FLAG === 'on' && 'FAKE_STACK' in v)).toBe(on);
    // The API loads (and reports on /config) only the active extensions; none = no CMS_EXTENSIONS at all.
    expect(vars.some((v) => v.CMS_EXTENSIONS === 'fake')).toBe(on);
    expect(vars.some((v) => 'CMS_EXTENSIONS' in v)).toBe(on);
    // cdk-nag stores suppression reasons base64-encoded in the resource metadata.
    const apig2 = Object.values(template.toJSON().Resources as Record<string, { Metadata?: { cdk_nag?: { rules_to_suppress?: Array<{ id: string; reason: string }> } } }>)
      .flatMap((r) => r.Metadata?.cdk_nag?.rules_to_suppress ?? [])
      .filter((rule) => rule.id === 'AwsSolutions-APIG2')
      .map((rule) => Buffer.from(rule.reason, 'base64').toString('utf8'));
    expect(apig2.length).toBeGreaterThan(0);
    expect(apig2.every((reason) => reason.endsWith(' FAKE NOTE.'))).toBe(on);
  });

  test('an installed extension is only enabled through vodExtensions', () => {
    const synthWith = (context: Record<string, string>) =>
      new CmsStack(new cdk.App({ context }), `${VOD}-cms`, { appName: 'vod-cms', environment: 'dev', vodStackName: VOD, packagingProfile: 'OFF', extensions: [fake] });
    expect(() => synthWith({ fakeOn: 'true' })).toThrow(/'fakeOn' is set but extension 'fake' is not enabled/);
    expect(() => synthWith({ vodExtensions: 'fake,missing' })).toThrow(/'missing', which is not installed/);
    // Listed but its own keys leave it off: enabled, not active, so no CMS_EXTENSIONS.
    const vars = Object.values(Template.fromStack(synthWith({ vodExtensions: 'fake' })).findResources('AWS::Lambda::Function')).map(
      (f) => (f.Properties.Environment?.Variables ?? {}) as Record<string, unknown>,
    );
    expect(vars.some((v) => 'CMS_EXTENSIONS' in v)).toBe(false);
  });

  test('no extensions = the base API routes only', () => {
    const app = new cdk.App();
    const stack = new CmsStack(app, `${VOD}-cms`, { appName: 'vod-cms', environment: 'dev', vodStackName: VOD, packagingProfile: 'OFF', extensions: [] });
    const paths = Object.values(Template.fromStack(stack).findResources('AWS::ApiGateway::Resource')).map((r) => r.Properties.PathPart).sort();
    expect(paths).toEqual(['abr-bitrates', 'assets', 'config', 'poster', 'quality-metrics', 'redrive', 'thumbnails', '{guid}'].sort());
  });
});

test('loadCmsExtensions: a missing directory means no extensions', () => {
  expect(loadCmsExtensions(path.join(__dirname, 'no-such-dir'))).toEqual([]);
});

describe('CmsStack security controls', () => {
  const build = (environment: string, context: Record<string, string> = {}) => {
    const app = new cdk.App({ context });
    const stack = new CmsStack(app, `${VOD}-cms`, { appName: 'vod-cms', environment, vodStackName: VOD, packagingProfile: 'OFF', extensions: [] });
    return Template.fromStack(stack);
  };
  const t = build('prod');
  const json = JSON.stringify(t.toJSON());

  test('the site sends a Content-Security-Policy that locks scripts and framing', () => {
    const policy = Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0].Properties.ResponseHeadersPolicyConfig
      .SecurityHeadersConfig.ContentSecurityPolicy;
    expect(policy.Override).toBe(true);
    const csp = JSON.stringify(policy.ContentSecurityPolicy);
    for (const directive of ["script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", 'connect-src', 'cognito-idp.']) {
      expect(csp).toContain(directive);
    }
  });

  test('the web app client is SRP-only with OAuth disabled (no implicit grant, no callback URLs)', () => {
    const client = Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0].Properties;
    expect(client.ExplicitAuthFlows).toEqual(['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']);
    expect(client.AllowedOAuthFlows).toBeUndefined();
    expect(client.AllowedOAuthFlowsUserPoolClient).toBeFalsy();
    expect(client.CallbackURLs).toBeUndefined();
  });

  test('the API stage has AWS X-Ray tracing enabled', () => {
    t.hasResourceProperties('AWS::ApiGateway::Stage', { TracingEnabled: true });
  });

  test('API CORS is locked to the CMS site (no wildcard), with the Vite dev server only outside prod', () => {
    expect(json).not.toContain(`"method.response.header.Access-Control-Allow-Origin":"'*'"`);
    const env = (tpl: Template) =>
      JSON.stringify(Object.values(tpl.findResources('AWS::Lambda::Function')).map((f) => f.Properties.Environment?.Variables?.CMS_ALLOWED_ORIGINS));
    expect(env(t)).not.toContain('localhost');
    expect(env(build('dev'))).toContain('http://localhost:5174');
  });

  test('the API stage is throttled', () => {
    t.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 })]),
    });
  });

  test('MFA (TOTP) is REQUIRED in prod and OFF in dev by default; cmsMfa overrides; bad values fail', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] });
    build('dev').hasResourceProperties('AWS::Cognito::UserPool', { MfaConfiguration: 'OFF' });
    build('dev', { cmsMfa: 'OPTIONAL' }).hasResourceProperties('AWS::Cognito::UserPool', { MfaConfiguration: 'OPTIONAL' });
    expect(() => build('dev', { cmsMfa: 'maybe' })).toThrow(/cmsMfa must be OFF, OPTIONAL or REQUIRED/);
  });

  test('the operator invitation email links the CMS and keeps admin-only sign-up', () => {
    const pool = (tpl: Template) => Object.values(tpl.findResources('AWS::Cognito::UserPool'))[0].Properties.AdminCreateUserConfig;
    const cfg = pool(t);
    expect(cfg.AllowAdminCreateUserOnly).toBe(true);
    const msg = JSON.stringify(cfg.InviteMessageTemplate.EmailMessage);
    expect(msg).toContain('{username}');
    expect(msg).toContain('{####}');
    expect(msg).toContain('DomainName'); // the CMS distribution's URL
    expect(msg).toContain('authenticator app'); // prod: MFA REQUIRED
    expect(JSON.stringify(pool(build('dev')).InviteMessageTemplate.EmailMessage)).not.toContain('authenticator app');
    expect(cfg.InviteMessageTemplate.EmailSubject).toMatch(/operator login/);
  });
});
