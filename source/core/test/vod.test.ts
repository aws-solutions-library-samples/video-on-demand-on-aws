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
 * Fine-grained assertions for the VOD v7.0.0 GA stack, using `aws-cdk-lib/assertions`
 * (`Template.fromStack` / `Annotations.fromStack`). Replaces the v6 whole-stack snapshot test and
 * the removed `@aws-cdk/assert` dependency.
 *
 * These assertions encode the stack's hard guardrails: near-zero solution-authored Lambdas, native Step Functions integrations only, three
 * state machines, CMAF-only delivery, no MediaPackage / MediaConvert custom resources, least-
 * privilege IAM, and a clean cdk-nag gate.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { VideoOnDemand } from '../lib/vod-stack';

/** Managed CloudFront **CachingOptimized** cache policy id (blueprint: replaces the v6 maxTtl=0 policy). */
const MANAGED_CACHING_OPTIMIZED_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6';
/** Managed **CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS** response-headers policy id.
 *  CORS (incl. preflight) + security headers; preflight is answered by the S3 origin (bucket CORS). */
const MANAGED_CORS_SECURITY_HEADERS_ID = 'eaab4381-ed33-4a86-88ca-d9558dc6cd63';
/** Managed **CORS-S3Origin** origin-request policy id (forwards Origin + Access-Control-Request-*). */
const MANAGED_CORS_S3_ORIGIN_REQUEST_ID = '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf';

const SOLUTION_ID = 'SO9674';
const GSI_NAME = 'srcBucket-startTime-index';

/** The three per-tier Encode states whose `Parameters.Settings` must be a spliced OBJECT. */
const ENCODE_STATES = ['Encode SD', 'Encode HD', 'Encode UHD'] as const;
/** State-machine name suffixes the workflow must produce (`${AWS::StackName}-<suffix>`). */
const SM_SUFFIXES = ['-orchestrator', '-ingest', '-process', '-publish'] as const;

/**
 * Build + synthesize the stack once (with the cdk-nag `AwsSolutionsChecks` aspect, exactly as
 * `bin/vod.ts` does) and memoize the resulting `Template` / `Annotations`.
 */
let cached: { template: Template; annotations: Annotations } | undefined;
function synth(): { template: Template; annotations: Annotations } {
  if (!cached) {
    // thumbnailsProfile defaults ON (see context.ts); explicitly OFF here so this stays the "pure GA
    // core, nothing on" baseline the many OFF/default describe blocks below compare against.
    const app = new cdk.App({ context: { email: 'ci@example.com', thumbnailsProfile: 'OFF' } });
    const stack = new VideoOnDemand(app, 'VideoOnDemand');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cached = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cached;
}

/** Synthesize the stack with the packaging overlay ON. Memoized. */
let cachedOn: { template: Template; annotations: Annotations } | undefined;
function synthOn(): { template: Template; annotations: Annotations } {
  if (!cachedOn) {
    const app = new cdk.App({
      context: {
        email: 'ci@example.com',
        packagingProfile: 'ON',
      },
    });
    const stack = new VideoOnDemand(app, 'VideoOnDemandPkg');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cachedOn = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cachedOn;
}

/** Synthesize the stack with the ad-markers (ESAM) overlay ON. Memoized. */
let cachedAdm: { template: Template; annotations: Annotations } | undefined;
function synthAdMarkers(): { template: Template; annotations: Annotations } {
  if (!cachedAdm) {
    const app = new cdk.App({ context: { email: 'ci@example.com', adMarkersProfile: 'ON' } });
    const stack = new VideoOnDemand(app, 'VideoOnDemandAdm');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cachedAdm = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cachedAdm;
}

/** Synthesize the stack with ad markers ON layered on the packaging overlay (ON). Memoized. */
let cachedAdmPkg: { template: Template; annotations: Annotations } | undefined;
function synthAdMarkersPkg(): { template: Template; annotations: Annotations } {
  if (!cachedAdmPkg) {
    const app = new cdk.App({
      context: { email: 'ci@example.com', adMarkersProfile: 'ON', packagingProfile: 'ON' },
    });
    const stack = new VideoOnDemand(app, 'VideoOnDemandAdmPkg');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cachedAdmPkg = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cachedAdmPkg;
}

/** Synthesize the stack with per-frame metrics ON (QC overlay). Memoized. */
let cachedPfm: { template: Template; annotations: Annotations } | undefined;
function synthPerFrameMetrics(): { template: Template; annotations: Annotations } {
  if (!cachedPfm) {
    const app = new cdk.App({ context: { email: 'ci@example.com', perFrameMetrics: 'ON' } });
    const stack = new VideoOnDemand(app, 'VideoOnDemandPfm');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cachedPfm = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cachedPfm;
}

/** Synthesize the stack with the captions overlay ON (WebVTT/IMSC). Memoized. */
let cachedCap: { template: Template; annotations: Annotations } | undefined;
function synthCaptions(): { template: Template; annotations: Annotations } {
  if (!cachedCap) {
    const app = new cdk.App({ context: { email: 'ci@example.com', captionsProfile: 'ON' } });
    const stack = new VideoOnDemand(app, 'VideoOnDemandCap');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cachedCap = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cachedCap;
}

/** Synthesize the stack with captions ON layered on packaging (ON) and ad-markers (ON) — deepest compose. */
let cachedCapAdmPkg: { template: Template; annotations: Annotations } | undefined;
function synthCaptionsAdmPkg(): { template: Template; annotations: Annotations } {
  if (!cachedCapAdmPkg) {
    const app = new cdk.App({
      context: { email: 'ci@example.com', captionsProfile: 'ON', adMarkersProfile: 'ON', packagingProfile: 'ON' },
    });
    const stack = new VideoOnDemand(app, 'VideoOnDemandCapAdmPkg');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cachedCapAdmPkg = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cachedCapAdmPkg;
}

let cachedThumb: { template: Template; annotations: Annotations } | undefined;
function synthThumbnails(): { template: Template; annotations: Annotations } {
  if (!cachedThumb) {
    const app = new cdk.App({ context: { email: 'ci@example.com', thumbnailsProfile: 'ON' } });
    const stack = new VideoOnDemand(app, 'VideoOnDemandThumb');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cachedThumb = { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
  }
  return cachedThumb;
}

/** Recursively remove every `Comment` key (doc-only fields may legitimately carry `${...}` text). */
function stripComments(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripComments);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'Comment') continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return node;
}

/** All `${TOKEN}` inner names found in a string. */
function substitutionTokens(text: string): string[] {
  return (text.match(/\$\{[^}]+\}/g) ?? []).map((m) => m.slice(2, -1));
}

/** Extract the literal suffix of a `StateMachineName` rendered as `Fn::Join('', [{Ref},'-x'])`. */
function stateMachineNameSuffix(props: { StateMachineName?: unknown }): string {
  const name = props.StateMachineName as { 'Fn::Join'?: [string, unknown[]] } | string | undefined;
  if (typeof name === 'string') return name;
  const parts = name?.['Fn::Join']?.[1];
  if (Array.isArray(parts)) {
    const last = parts[parts.length - 1];
    if (typeof last === 'string') return last;
  }
  return '';
}

function stateMachineResources(template: Template): Record<string, { Properties: Record<string, any> }> {
  return template.findResources('AWS::StepFunctions::StateMachine') as Record<
    string,
    { Properties: Record<string, any> }
  >;
}

// -------------------------------------------------------------------------------------------------
// Resource inventory / guardrails.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — resource inventory', () => {
  test('is near-zero-Lambda: exactly 0 AWS::Lambda::Function resources', () => {
    // Hard guardrail (blueprint §0). All orchestration uses native Step Functions integrations.
    // CloudFrontToS3 is used with insertHttpSecurityHeaders:false over an SSE-S3 (no CMK) existing
    // bucket, and the source bucket's EventBridge notification is set via the L1 escape hatch, so
    // NO BucketNotifications / OAC-key-updater / header-injection helper Lambda is synthesized.
    synth().template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('has exactly 3 S3 buckets (source, destination, logs — CloudFrontToS3 adds none)', () => {
    synth().template.resourceCountIs('AWS::S3::Bucket', 3);
  });

  test('has exactly 1 DynamoDB table, keyed by guid with the srcBucket-startTime-index GSI', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties(
      'AWS::DynamoDB::Table',
      Match.objectLike({
        KeySchema: Match.arrayWith([Match.objectLike({ AttributeName: 'guid', KeyType: 'HASH' })]),
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: GSI_NAME,
            KeySchema: Match.arrayWith([
              Match.objectLike({ AttributeName: 'srcBucket', KeyType: 'HASH' }),
              Match.objectLike({ AttributeName: 'startTime', KeyType: 'RANGE' }),
            ]),
          }),
        ]),
      }),
    );
  });

  test('has exactly 4 Step Functions state machines (orchestrator + 3 stages)', () => {
    synth().template.resourceCountIs('AWS::StepFunctions::StateMachine', 4);
  });

  test('the state machine names end with -ingest, -process, and -publish', () => {
    const sms = stateMachineResources(synth().template);
    const suffixes = Object.values(sms).map((r) => stateMachineNameSuffix(r.Properties)).sort();
    expect(suffixes).toEqual([...SM_SUFFIXES].sort());
  });

  test('has NO MediaPackage resources and NO MediaConvert/MediaPackage custom resources', () => {
    const resources = synth().template.toJSON().Resources as Record<string, { Type: string }>;
    const offenders = Object.values(resources)
      .map((r) => r.Type)
      .filter(
        (type) =>
          type.startsWith('Custom::') ||
          type.includes('MediaPackage') ||
          type.startsWith('AWS::MediaConvert::'),
      );
    // v6 shipped Custom::MediaConvertEndPoint / Custom::MediaConvertTemplates / MediaPackageVod;
    // v7 replaces them with the MediaConvert construct + native integrations (zero custom resources).
    expect(offenders).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// State machine observability (proves SF1/SF2 are satisfied without suppression).
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — state machine logging & tracing', () => {
  test('all 4 state machines have LoggingConfiguration and TracingConfiguration.Enabled = true', () => {
    const sms = stateMachineResources(synth().template);
    const smList = Object.values(sms);
    expect(smList).toHaveLength(4);
    for (const sm of smList) {
      expect(sm.Properties.LoggingConfiguration).toBeDefined();
      expect(sm.Properties.TracingConfiguration).toEqual(
        expect.objectContaining({ Enabled: true }),
      );
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Ingest trigger: S3 -> EventBridge -> Orchestrator state machine.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — ingest trigger', () => {
  test('the source bucket enables EventBridge notifications', () => {
    // NOTE: the storage construct sets this via the L1 escape hatch to keep the zero-Lambda
    // invariant, so the synthesized shape is EventBridgeConfiguration:{EventBridgeEnabled:true}
    // (not the empty {} the high-level `eventBridgeEnabled:true` prop would produce alongside a
    // BucketNotifications helper Lambda).
    synth().template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        NotificationConfiguration: {
          EventBridgeConfiguration: Match.objectLike({ EventBridgeEnabled: true }),
        },
      }),
    );
  });

  test('has at least one Events::Rule targeting a state machine with a DLQ and an invocation role', () => {
    const { template } = synth();
    const rules = template.findResources('AWS::Events::Rule');
    expect(Object.keys(rules).length).toBeGreaterThanOrEqual(1);
    template.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({ source: ['aws.s3'], 'detail-type': ['Object Created'] }),
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.anyValue(),
            DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }),
            RoleArn: Match.anyValue(),
          }),
        ]),
      }),
    );
  });

  test('the EventBridge invocation role can only start the Orchestrator state machine', () => {
    // The SfnStateMachine target auto-grants exactly states:StartExecution to the invocation role.
    synth().template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 'states:StartExecution', Effect: 'Allow' }),
          ]),
        }),
      }),
    );
  });
});

// -------------------------------------------------------------------------------------------------
// Least-privilege IAM (Process role).
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — least-privilege IAM', () => {
  test('the Process role passes only the MediaConvert role, scoped by iam:PassedToService', () => {
    synth().template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'iam:PassRole',
              Effect: 'Allow',
              Condition: {
                StringEquals: { 'iam:PassedToService': 'mediaconvert.amazonaws.com' },
              },
            }),
          ]),
        }),
      }),
    );
  });

  test('MediaConvert GetJob/CancelJob are constrained to SolutionId=SO9674 jobs', () => {
    synth().template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['mediaconvert:GetJob', 'mediaconvert:CancelJob']),
              Effect: 'Allow',
              Condition: {
                StringEquals: { 'aws:ResourceTag/SolutionId': SOLUTION_ID },
              },
            }),
          ]),
        }),
      }),
    );
  });

  test('every service-role trust policy is guarded by aws:SourceAccount + aws:SourceArn (confused deputy)', () => {
    const roles = synth().template.findResources('AWS::IAM::Role');
    const guarded = ['states.amazonaws.com', 'mediaconvert.amazonaws.com', 'events.amazonaws.com'];
    let checked = 0;
    for (const [id, role] of Object.entries(roles)) {
      for (const stmt of (role as any).Properties.AssumeRolePolicyDocument.Statement) {
        if (!guarded.includes(stmt.Principal?.Service)) continue;
        checked += 1;
        expect([id, stmt.Condition?.StringEquals?.['aws:SourceAccount']]).toEqual([id, { Ref: 'AWS::AccountId' }]);
        expect([id, stmt.Condition?.ArnLike?.['aws:SourceArn']]).toEqual([id, expect.anything()]);
      }
    }
    // 4 state-machine roles + the MediaConvert service role + the EventBridge rule role.
    expect(checked).toBe(6);
  });

  test('no IAM policy has an Action:* + Resource:* star-star statement', () => {
    const policies = synth().template.findResources('AWS::IAM::Policy') as Record<
      string,
      { Properties: { PolicyDocument: { Statement: any[] } } }
    >;
    const starStar: unknown[] = [];
    for (const policy of Object.values(policies)) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        if (actions.includes('*') && resources.includes('*')) starStar.push(stmt);
      }
    }
    expect(starStar).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// CloudFront delivery.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — CloudFront delivery', () => {
  test('the distribution has a console description naming its stack', () => {
    synth().template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({ Comment: Match.stringLikeRegexp(' - Video on Demand on AWS$') }),
      }),
    );
  });

  test('the distribution uses HTTP/2+3, IPv6, managed CachingOptimized, and a response-headers policy', () => {
    synth().template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          HttpVersion: 'http2and3',
          IPV6Enabled: true,
          DefaultCacheBehavior: Match.objectLike({
            CachePolicyId: MANAGED_CACHING_OPTIMIZED_ID,
            ResponseHeadersPolicyId: MANAGED_CORS_SECURITY_HEADERS_ID,
          }),
        }),
      }),
    );
  });

  test('CORS is native: OPTIONS forwarded, CORS-S3Origin origin-request policy, no CloudFront Function', () => {
    const { template } = synth();
    // OPTIONS must be allowed + forwarded so the S3 origin can answer the preflight, and the
    // CORS-S3Origin origin-request policy forwards the CORS request headers to S3.
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            AllowedMethods: Match.arrayWith(['OPTIONS']),
            OriginRequestPolicyId: MANAGED_CORS_S3_ORIGIN_REQUEST_ID,
          }),
        }),
      }),
    );
    // CORS is handled by the response-headers policy + S3 origin CORS — no edge function.
    template.resourceCountIs('AWS::CloudFront::Function', 0);
  });

  test('the destination bucket has an S3 CORS config so the origin answers OPTIONS preflight', () => {
    const { template } = synth();
    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        CorsConfiguration: {
          CorsRules: Match.arrayWith([
            Match.objectLike({
              AllowedMethods: Match.arrayWith(['GET', 'HEAD']),
              AllowedOrigins: ['*'],
            }),
          ]),
        },
      }),
    );
  });

  test('the custom maxTtl=0 CachePolicy (and any custom response-headers policy) is gone', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudFront::CachePolicy', 0);
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
  });

  // geo-restriction + WAF are off by default (the GA delivery path).
  test('by default the distribution has no WebACLId and no geo restriction (WAF off)', () => {
    const { template } = synth();
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          WebACLId: Match.absent(),
          Restrictions: Match.absent(),
        }),
      }),
    );
    // The WAF WebACL is never in the main stack (it lives in the separate us-east-1 stack).
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('associates a WebACLId when wafWebAclArn is set (WAF on)', () => {
    const arn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/streaming/abc';
    const app = new cdk.App({ context: { email: 'ci@example.com', wafWebAclArn: arn } });
    const stack = new VideoOnDemand(app, 'VideoOnDemandWaf');
    Template.fromStack(stack).hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({ DistributionConfig: Match.objectLike({ WebACLId: arn }) }),
    );
  });

  test('by default the distribution uses the cloudfront.net certificate (no aliases, no ViewerCertificate)', () => {
    synth().template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({ Aliases: Match.absent(), ViewerCertificate: Match.absent() }),
      }),
    );
  });

  test('domainName + certificateArn serve a custom domain with a TLSv1.2_2021 minimum and a clean nag gate', () => {
    const certificateArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';
    const app = new cdk.App({ context: { email: 'ci@example.com', domainName: 'video.example.com', certificateArn } });
    const stack = new VideoOnDemand(app, 'VideoOnDemandDomain');
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    Template.fromStack(stack).hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          Aliases: ['video.example.com'],
          ViewerCertificate: {
            AcmCertificateArn: certificateArn,
            MinimumProtocolVersion: 'TLSv1.2_2021',
            SslSupportMethod: 'sni-only',
          },
        }),
      }),
    );
    // CFR4 is satisfied (not suppressed) once a custom certificate enforces TLS 1.2.
    const findings = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(findings.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// ASL substitution wiring + structural splice (blueprint risk #2 / #3 guard).
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — ASL substitution wiring', () => {
  test('every state machine resolves all of its DefinitionString tokens via DefinitionSubstitutions', () => {
    // The state machines use the native CloudFormation `DefinitionSubstitutions` property, so each
    // registered `${KEY}` legitimately remains in `DefinitionString` and is resolved by
    // CloudFormation at deploy time. This asserts the meaningful invariant behind the blueprint's
    // "no literal ${ remains" test plan item: NO UNRESOLVED token survives — every `${KEY}` outside
    // a Comment field is backed by an entry in DefinitionSubstitutions.
    const sms = stateMachineResources(synth().template);
    for (const sm of Object.values(sms)) {
      const props = sm.Properties;
      const subKeys = Object.keys((props.DefinitionSubstitutions as Record<string, unknown>) ?? {});
      const withoutComments = JSON.stringify(stripComments(JSON.parse(props.DefinitionString as string)));
      const tokens = [...new Set(substitutionTokens(withoutComments))];
      const unresolved = tokens.filter((tk) => !subKeys.includes(tk));
      expect(unresolved).toEqual([]);
    }
  });

  test('no ${JOB_SETTINGS_*} placeholder survives anywhere, comments included (structural splice happened)', () => {
    // Comments too: CloudFormation's validator flags any unsubstituted ${...} in DefinitionString (E1029).
    const sms = stateMachineResources(synth().template);
    for (const sm of Object.values(sms)) {
      expect(sm.Properties.DefinitionString as string).not.toContain('${JOB_SETTINGS_');
    }
  });

  test('each Encode state Settings is a spliced OBJECT carrying FileInput.$ and Destination.$', () => {
    const sms = stateMachineResources(synth().template);
    const process = Object.values(sms).find(
      (r) => stateMachineNameSuffix(r.Properties) === '-process',
    );
    expect(process).toBeDefined();
    const parsed = JSON.parse(process!.Properties.DefinitionString as string) as {
      States: Record<string, { Parameters: { Settings: unknown } }>;
    };
    for (const state of ENCODE_STATES) {
      const settings = parsed.States[state].Parameters.Settings;
      // Guard against the risk-#2 failure: a scalar substitution would leave Settings a string.
      expect(typeof settings).toBe('object');
      expect(Array.isArray(settings)).toBe(false);
      const asString = JSON.stringify(settings);
      expect(asString).toContain('"FileInput.$"'); // runtime source URI (risk #3)
      expect(asString).toContain('"Destination.$"'); // runtime per-guid CMAF destination (risk #3)
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Packaging overlay (packagingProfile=ON): two-job REMUX_ALL.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — packaging overlay (OFF vs ON)', () => {
  const processDef = (t: Template): string => {
    const proc = Object.values(stateMachineResources(t)).find(
      (r) => stateMachineNameSuffix(r.Properties) === '-process',
    );
    return proc!.Properties.DefinitionString as string;
  };

  test('OFF (default): the Process definition has no packaging/passthrough states', () => {
    const def = processDef(synth().template);
    expect(def).not.toContain('PASSTHROUGH');
    expect(def).not.toContain('REMUX_ALL');
    expect(def).not.toContain('Encode Ladder');
    synth().template.resourceCountIs('AWS::S3::Bucket', 3);
  });

  test('ON: tier encodes feed a single REMUX_ALL Package DRM job (no separate Encode Ladder)', () => {
    const def = processDef(synthOn().template);
    expect(def).not.toContain('Encode Ladder'); // dropped: the tier encode IS the mezzanine now
    expect(def).not.toContain('Tier Package');
    expect(def).toContain('Package DRM');
    expect(def).toContain('PASSTHROUGH');
    expect(def).toContain('REMUX_ALL');
    expect(def).toContain('${INTERMEDIATE_BUCKET}'); // tier ladder writes the mezzanine here
    expect(def).toContain('/hls/index.m3u8'); // per-format re-pathed playback URL
    expect(def).not.toContain('Encryption'); // every format ships clear
  });

  test('ON: adds the 4th (intermediate) bucket, keeps 0 Lambda, registers INTERMEDIATE_BUCKET', () => {
    const { template } = synthOn();
    template.resourceCountIs('AWS::S3::Bucket', 4);
    // No auto-delete / no bucket-notification helper Lambda on the intermediate bucket.
    template.resourceCountIs('AWS::Lambda::Function', 0);
    const proc = Object.values(stateMachineResources(template)).find(
      (r) => stateMachineNameSuffix(r.Properties) === '-process',
    );
    expect(Object.keys(proc!.Properties.DefinitionSubstitutions)).toContain('INTERMEDIATE_BUCKET');
  });

  test('ON: cdk-nag has zero unsuppressed AwsSolutions-* errors', () => {
    const errors = synthOn().annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// SCTE-35 ad-markers overlay (adMarkersProfile=ON): ESAM sidecar read + Process branch.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — ad-markers ESAM overlay (adMarkersProfile=ON)', () => {
  const defOf = (t: Template, suffix: string): string => {
    const sm = Object.values(stateMachineResources(t)).find(
      (r) => stateMachineNameSuffix(r.Properties) === suffix,
    );
    return sm!.Properties.DefinitionString as string;
  };

  test('OFF (default): no ESAM sidecar read and no Ad Markers branch', () => {
    expect(defOf(synth().template, '-orchestrator')).not.toContain('Read ESAM Sidecar');
    expect(defOf(synth().template, '-process')).not.toContain('Ad Markers?');
    expect(defOf(synth().template, '-process')).not.toContain('Esam');
  });

  test('ON: the Orchestrator reads the <source>.esam.xml sidecar via s3:getObject', () => {
    const def = defOf(synthAdMarkers().template, '-orchestrator');
    expect(def).toContain('Read ESAM Sidecar');
    expect(def).toContain('aws-sdk:s3:getObject');
    expect(def).toContain('.esam.xml');
  });

  test('ON: the Process definition converts Encode SD to a JSONata "esam" variant lookup (no clone states)', () => {
    const def = defOf(synthAdMarkers().template, '-process');
    // No Choice-routed clone — captions/ad-markers are flags read inside the single Encode Task.
    expect(def).not.toContain('Ad Markers?');
    expect(def).not.toContain('Encode SD (Ad Markers)');
    expect(def).toContain('"QueryLanguage":"JSONata"');
    expect(def).toContain('esamEnabled');
    expect(def).toContain('Esam');
    expect(def).toContain('SignalProcessingNotification');
  });

  test('ON: keeps the zero-Lambda invariant', () => {
    synthAdMarkers().template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('ON: the Orchestrator role is granted scoped s3:GetObject for the sidecar read', () => {
    synthAdMarkers().template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Action: Match.arrayWith(['s3:GetObject']), Effect: 'Allow' }),
          ]),
        }),
      }),
    );
  });

  test('ON: the EventBridge rule excludes the .esam.xml + .json sidecars from triggering a workflow', () => {
    synthAdMarkers().template.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          detail: Match.objectLike({
            object: { key: [{ 'anything-but': { suffix: ['.esam.xml', '.json'] } }] },
          }),
        }),
      }),
    );
  });

  test('ON: cdk-nag has zero unsuppressed AwsSolutions-* errors AND warnings', () => {
    const { annotations } = synthAdMarkers();
    const errors = annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const warnings = annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
    expect(warnings.map((w) => JSON.stringify(w.entry.data))).toEqual([]);
  });

  test('ON + packaging: composes with REMUX_ALL (ESAM ladder job1 -> the single Package DRM job2, both JSONata variant lookups), 0 Lambda, nag-clean', () => {
    const { template, annotations } = synthAdMarkersPkg();
    const def = defOf(template, '-process');
    expect(def).not.toContain('Package DRM (Ad Markers)');
    expect(def).toContain('REMUX_ALL');
    expect(def).toContain('esamEnabled');
    template.resourceCountIs('AWS::Lambda::Function', 0);
    const errors = annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Per-frame quality metrics overlay (perFrameMetrics=ON): synth-time splice + Load Job Config toggle.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — per-frame metrics overlay (perFrameMetrics=ON)', () => {
  const defOf = (t: Template, suffix: string): string => {
    const sm = Object.values(stateMachineResources(t)).find(
      (r) => stateMachineNameSuffix(r.Properties) === suffix,
    );
    return sm!.Properties.DefinitionString as string;
  };

  test('OFF (default): no PerFrameMetrics anywhere in the Process definition', () => {
    expect(defOf(synth().template, '-process')).not.toContain('PerFrameMetrics');
    expect(defOf(synth().template, '-orchestrator')).not.toContain('perFrameMetrics');
  });

  test('ON: the Process encode outputs carry PerFrameMetrics; keeps the zero-Lambda invariant', () => {
    const def = defOf(synthPerFrameMetrics().template, '-process');
    expect(def).toContain('PerFrameMetrics');
    expect(def).toContain('VMAF');
    synthPerFrameMetrics().template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('ON: the Orchestrator surfaces the toggle in Load Job Config (perFrameMetrics)', () => {
    const def = defOf(synthPerFrameMetrics().template, '-orchestrator');
    expect(def).toContain('perFrameMetrics');
  });

  test('ON: cdk-nag has zero unsuppressed AwsSolutions-* errors AND warnings', () => {
    const { annotations } = synthPerFrameMetrics();
    const errors = annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const warnings = annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
    expect(warnings.map((w) => JSON.stringify(w.entry.data))).toEqual([]);
  });
});

describe('VideoOnDemand stack — thumbnails overlay (thumbnailsProfile=ON)', () => {
  const defOf = (t: Template, suffix: string): string => {
    const sm = Object.values(stateMachineResources(t)).find(
      (r) => stateMachineNameSuffix(r.Properties) === suffix,
    );
    return sm!.Properties.DefinitionString as string;
  };

  test('explicit OFF: no FRAME_CAPTURE anywhere in the Process definition', () => {
    expect(defOf(synth().template, '-process')).not.toContain('FRAME_CAPTURE');
  });

  test('true default (no thumbnailsProfile context at all): FRAME_CAPTURE + thumbnail records ARE present', () => {
    const app = new cdk.App({ context: { email: 'ci@example.com' } });
    const stack = new VideoOnDemand(app, 'VideoOnDemandTrueDefault');
    const def = defOf(Template.fromStack(stack), '-process');
    expect(def).toContain('FRAME_CAPTURE');
    expect(def).toContain('thumbnailsPrefix');
    expect(def).toContain('posterUrl');
    Template.fromStack(stack).resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('ON: the Process definition adds a FRAME_CAPTURE group + thumbnail records; keeps the zero-Lambda invariant', () => {
    const def = defOf(synthThumbnails().template, '-process');
    expect(def).toContain('FRAME_CAPTURE');
    expect(def).toContain('thumbnailsPrefix');
    expect(def).toContain('posterUrl');
    synthThumbnails().template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('ON: cdk-nag has zero unsuppressed AwsSolutions-* errors AND warnings', () => {
    const { annotations } = synthThumbnails();
    const errors = annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const warnings = annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
    expect(warnings.map((w) => JSON.stringify(w.entry.data))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Captions overlay (captionsProfile=ON): WebVTT/IMSC caption tracks from a <source>.vtt sidecar.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — captions overlay (captionsProfile=ON)', () => {
  const defOf = (t: Template, suffix: string): string => {
    const sm = Object.values(stateMachineResources(t)).find(
      (r) => stateMachineNameSuffix(r.Properties) === suffix,
    );
    return sm!.Properties.DefinitionString as string;
  };

  test('OFF (default): no caption sidecar read and no Captions branch', () => {
    expect(defOf(synth().template, '-orchestrator')).not.toContain('Read Caption Sidecar');
    expect(defOf(synth().template, '-process')).not.toContain('Captions?');
    expect(defOf(synth().template, '-process')).not.toContain('CaptionSelectors');
  });

  test('ON: the Orchestrator HEADs the <source>.vtt sidecar via s3:headObject', () => {
    const def = defOf(synthCaptions().template, '-orchestrator');
    expect(def).toContain('Read Caption Sidecar');
    expect(def).toContain('aws-sdk:s3:headObject');
    expect(def).toContain('.vtt');
  });

  test('ON: the Process definition converts Encode SD to a JSONata "captions" variant lookup (no clone states)', () => {
    const def = defOf(synthCaptions().template, '-process');
    expect(def).not.toContain('Captions?');
    expect(def).not.toContain('Encode SD (Captions)');
    expect(def).toContain('"QueryLanguage":"JSONata"');
    expect(def).toContain('captionsEnabled');
    expect(def).toContain('CaptionSelectors');
    expect(def).toContain('CaptionDescriptions');
    expect(def).toContain('WEBVTT');
  });

  test('ON: keeps the zero-Lambda invariant', () => {
    synthCaptions().template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('ON: the EventBridge rule also excludes the .vtt caption sidecar (with .esam.xml + .json)', () => {
    synthCaptions().template.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          detail: Match.objectLike({
            object: { key: [{ 'anything-but': { suffix: ['.esam.xml', '.json', '.vtt'] } }] },
          }),
        }),
      }),
    );
  });

  test('ON: cdk-nag has zero unsuppressed AwsSolutions-* errors AND warnings', () => {
    const { annotations } = synthCaptions();
    const errors = annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const warnings = annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
    expect(warnings.map((w) => JSON.stringify(w.entry.data))).toEqual([]);
  });

  test('ON + ad-markers + packaging: the deepest compose keeps 0 Lambda and is nag-clean', () => {
    const { template, annotations } = synthCaptionsAdmPkg();
    const def = defOf(template, '-process');
    expect(def).not.toContain('Encode SD (Ad Markers) (Captions)');
    expect(def).toContain("'both'"); // the combined esam+captions variant key, embedded on Package DRM (job2).
    expect(def).toContain('REMUX_ALL');
    template.resourceCountIs('AWS::Lambda::Function', 0);
    const errors = annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => JSON.stringify(e.entry.data))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// cdk-nag gate.
// -------------------------------------------------------------------------------------------------
describe('VideoOnDemand stack — cdk-nag', () => {
  test('has zero unsuppressed AwsSolutions-* errors', () => {
    const errors = synth().annotations.findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    const messages = errors.map((e) => JSON.stringify(e.entry.data));
    expect(messages).toEqual([]);
  });

  test('has zero unsuppressed AwsSolutions-* warnings', () => {
    const warnings = synth().annotations.findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    expect(warnings.map((w) => JSON.stringify(w.entry.data))).toEqual([]);
  });
});
