/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                                *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at http://www.apache.org/licenses/LICENSE-2.0                  *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { resolveExtensions, SsmKey, ssmParameterName } from '@vod/contract';
import { CmsExtension, loadCmsExtensions } from './extensions';

export interface CmsStackProps extends cdk.StackProps {
  /** Short app name used to name resources (e.g. "vod-cms"). */
  readonly appName: string;
  /** "dev" | "staging" | "prod" — controls removal policy. */
  readonly environment: string;
  /** VOD stack name whose `/<name>/…` SSM params + DynamoDB table this app reads. */
  readonly vodStackName: string;
  /** MUST match the VOD stack's own packagingProfile. Gates the quality-metrics rescue Lambda (see bin/cms.ts). */
  readonly packagingProfile: 'OFF' | 'ON';
  /**
   * Extensions to apply (see `./extensions.ts`). Default: every directory under `backend/extensions/`.
   */
  readonly extensions?: readonly CmsExtension[];
}

/**
 * CmsStack — the operator web app (the "cms" module) as a SINGLE deployable stack (named
 * `<vodStackName>-cms`). It owns everything the companion app needs:
 *   - Cognito user pool + app client + identity pool + per-user upload role,
 *   - an authenticated read API (API Gateway REST + Cognito authorizer + one Lambda serving
 *     GET /config, /assets, /assets/{guid} — SSM + DynamoDB reads scoped to the VOD stack),
 *   - a private S3 site bucket + CloudFront (OAC) distribution serving the built SPA.
 *
 * The frontend is built and `aws s3 sync`-ed to the site bucket by scripts/deploy-all.sh AFTER this
 * stack deploys (content is script-published, not a CDK BucketDeployment).
 *
 * This is a reference COMPANION app (NOT the zero-Lambda core VOD stack); it carries its own
 * cdk-nag posture. The Amplify `<Authenticator>` uses embedded sign-in (not the Hosted UI), so there
 * is no OAuth callback-URL dependency on the CloudFront domain. The CloudFront/OAC/security-headers
 * posture mirrors the VOD `delivery.ts` construct, adapted for a SPA (default root object + 403/404 ->
 * /index.html rewrites for react-router client-side routing).
 */
export class CmsStack extends cdk.Stack {
  public readonly userPoolId: string;
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: CmsStackProps) {
    super(scope, id, props);

    const { appName, environment, vodStackName, packagingProfile } = props;
    // Activate each ENABLED extension (installed and named in the `vodExtensions` list, `.env` VOD_EXTENSIONS)
    // against this app's context; an extension parses and validates its own keys.
    const enabled = resolveExtensions(
      this.node,
      (props.extensions ?? loadCmsExtensions()).map((ext) => ({ name: ext.id, contextKeys: ext.contextKeys, ext })),
    );
    const activeById = enabled
      .map(({ ext }) => ({ id: ext.id, hooks: ext.activate(this.node) }))
      .filter((e): e is { id: string; hooks: NonNullable<typeof e.hooks> } => e.hooks !== undefined);
    const active = activeById.map((e) => e.hooks);
    const isProd = environment === 'prod';
    const mfaRaw = (this.node.tryGetContext('cmsMfa') as string | undefined) ?? (isProd ? 'REQUIRED' : 'OFF');
    if (!['OFF', 'OPTIONAL', 'REQUIRED'].includes(mfaRaw)) {
      throw new Error(`cmsMfa must be OFF, OPTIONAL or REQUIRED; received ${JSON.stringify(mfaRaw)}.`);
    }
    const cmsMfa = { OFF: cognito.Mfa.OFF, OPTIONAL: cognito.Mfa.OPTIONAL, REQUIRED: cognito.Mfa.REQUIRED }[mfaRaw as 'OFF' | 'OPTIONAL' | 'REQUIRED'];
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // ─── Cognito ─────────────────────────────────────────────────────────────────────────────────
    // Internal operator tool: self sign-up OFF (admin-created users). Username sign-in; email
    // required + verified for password recovery.
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${appName}-${environment}`,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // MFA (TOTP, set up in the sign-in flow): REQUIRED by default in prod, OFF in dev; `-c cmsMfa=OFF|OPTIONAL|REQUIRED`.
      mfa: cmsMfa,
      ...(cmsMfa !== cognito.Mfa.OFF ? { mfaSecondFactor: { otp: true, sms: false } } : {}),
      removalPolicy,
    });

    // Browser app client: no secret, SRP only (Amplify UI's default flow). USER_PASSWORD_AUTH is left off: it
    // sends the plaintext password to Cognito and nothing here needs it. OAuth is disabled: there is no
    // Hosted UI domain, and the CDK defaults (implicit + code grant, example.com callback) would become a
    // token-leak path if one were ever added.
    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: `${appName}-web-client`,
      generateSecret: false,
      disableOAuth: true,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
    });

    this.userPoolId = userPool.userPoolId;

    // Identity Pool + authenticated role — gives signed-in users short-lived AWS creds so Amplify
    // Storage can upload media directly to the VOD source bucket. Authenticated only.
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `${appName}-${environment}-identity-pool`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        { clientId: userPoolClient.userPoolClientId, providerName: userPool.userPoolProviderName },
      ],
    });

    const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // Least-privilege UPLOAD (scoped to the user's own prefix): multipart-capable PUT into
    // uploads/<this user's Cognito identity id>/* on the VOD source bucket (name from the VOD stack's
    // SSM discovery param). Confined to the caller's prefix — no access to other users' objects.
    // Amplify Storage uses multipart for larger files, which needs ListParts
    // (s3:ListMultipartUploadParts) and Abort in addition to PutObject (PutObject also authorizes
    // CreateMultipartUpload / UploadPart / CompleteMultipartUpload). GetObject is required because
    // Amplify's uploadData() issues a HeadObject on the target key (a GetObject-authorized call) —
    // without it the upload fails with a 403 on the HEAD. The ${cognito-identity.amazonaws.com:sub}
    // IAM policy variable is a literal (single-quoted, not a JS template) so each user is confined to
    // their own prefix.
    const sourceBucketName = ssm.StringParameter.valueForStringParameter(this, ssmParameterName(vodStackName, SsmKey.SourceBucket));
    const sourceBucketArn = `arn:${cdk.Aws.PARTITION}:s3:::${sourceBucketName}`;
    // the VOD stack's destination bucket. GA-mode quality-metrics CSVs already live here
    // (publicly fetchable via the VOD CloudFront distribution); the rescue Lambda below also writes
    // its distilled JSON here for packaging-mode assets. Always present (unlike IntermediateBucket).
    const destinationBucketName = ssm.StringParameter.valueForStringParameter(this, ssmParameterName(vodStackName, SsmKey.DestinationBucket));
    const destinationBucketArn = `arn:${cdk.Aws.PARTITION}:s3:::${destinationBucketName}`;
    // the VOD stack's intermediate/mezzanine bucket - only exists (and only publishes this SSM
    // param) when packagingProfile=ON on the main stack. A CloudFormation cross-stack SSM reference
    // (`valueForStringParameter`) hard-fails synth/deploy if the parameter doesn't exist, so this read -
    // and the whole rescue Lambda/rule below - is gated on the `packagingProfile` prop (bin/cms.ts),
    // which MUST match the VOD stack's own value. Not auto-detected; deliberately explicit.
    const intermediateBucketName =
      packagingProfile === 'ON' ? ssm.StringParameter.valueForStringParameter(this, ssmParameterName(vodStackName, SsmKey.IntermediateBucket)) : undefined;
    const intermediateBucketArn = intermediateBucketName ? `arn:${cdk.Aws.PARTITION}:s3:::${intermediateBucketName}` : undefined;
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        resources: [`${sourceBucketArn}/uploads/` + '${cognito-identity.amazonaws.com:sub}/*'],
      }),
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    });

    // ─── Authenticated read API (API Gateway + Lambda) ───────────────────────────────────────────
    // Resolve the VOD job table name from the VOD stack's SSM param at deploy time, so we can scope
    // IAM to that exact table ARN (least privilege) without hardcoding the name.
    const tableName = ssm.StringParameter.valueForStringParameter(this, ssmParameterName(vodStackName, SsmKey.DynamoDBTable));
    const tableArn = cdk.Stack.of(this).formatArn({ service: 'dynamodb', resource: 'table', resourceName: tableName });

    // Orchestrator state-machine ARN (from the VOD stack's SSM discovery param) — the single target of
    // the re-drive write path. Resolved at deploy so states:StartExecution is scoped to this ARN.
    const orchestratorArn = ssm.StringParameter.valueForStringParameter(this, ssmParameterName(vodStackName, SsmKey.OrchestratorStateMachineArn));

    // CSP sources resolved at deploy: the API origin (lazy: the API is defined further down) and the core
    // stack's media CDN (its /<vodStackName>/CloudFrontDomainName param).
    const mediaDomain = ssm.StringParameter.valueForStringParameter(this, ssmParameterName(vodStackName, SsmKey.CloudFrontDomainName));
    let apiForCsp: apigateway.RestApi | undefined;
    const apiOrigin = cdk.Lazy.string({ produce: () => `https://${apiForCsp!.restApiId}.execute-api.${this.region}.${this.urlSuffix}` });
    const regional = (svc: string) => `https://${svc}.${this.region}.amazonaws.com`;
    const extCsp = (key: 'connect' | 'media' | 'img') => active.flatMap((ext) => [...(ext.contentSecurityPolicy?.[key] ?? [])]);
    const contentSecurityPolicy = () =>
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // Cloudscape / Amplify UI set inline style attributes
        ['img-src', "'self'", 'data:', 'blob:', `https://${mediaDomain}`, ...extCsp('img')].join(' '),
        ['media-src', "'self'", 'blob:', 'data:', `https://${mediaDomain}`, // data: for the players' placeholder text track
           `https://*.mediatailor.${this.region}.amazonaws.com`, ...extCsp('media')].join(' '),
        [
          'connect-src',
          "'self'",
          apiOrigin,
          regional('cognito-idp'),
          regional('cognito-identity'),
          `https://*.s3.${this.region}.amazonaws.com`,
          regional('s3'),
          `https://${mediaDomain}`,
          `https://*.mediatailor.${this.region}.amazonaws.com`,
          ...extCsp('connect'),
        ].join(' '),
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ');

    // ─── Static-site hosting: private S3 origin + CloudFront (OAC) ───────────────────────────────
    // Access-log target for both CloudFront standard logs and the site bucket's S3 server access
    // logs. CloudFront standard logging delivers via ACLs, so the log bucket must allow ACLs
    // (BUCKET_OWNER_PREFERRED) rather than the default owner-enforced setting.
    const logsBucket = new s3.Bucket(this, 'LogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy,
      autoDeleteObjects: !isProd,
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 's3-access-logs/',
      removalPolicy,
      autoDeleteObjects: !isProd,
    });

    // Custom security-headers response policy (first-party SPA — no CORS-all-origins needed).
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      // No fixed name — CDK derives a unique one (avoids collision with any earlier cms/console stack).
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(730), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
        // CSP: the SPA's own origin plus exactly what it talks to (the API, Cognito, the upload bucket, the
        // media CDN, MediaTailor for an SSAI stream, and whatever enabled extensions add). Limits the blast
        // radius of any XSS, since Amplify keeps the Cognito tokens in localStorage.
        contentSecurityPolicy: { contentSecurityPolicy: contentSecurityPolicy(), override: true },
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${id} operator web app (cms)`,
      defaultBehavior: {
        // Native OAC (sigv4): provisions AWS::CloudFront::OriginAccessControl and a bucket policy
        // granting only cloudfront.amazonaws.com for this distribution — direct S3 access is denied.
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      defaultRootObject: 'index.html',
      // SPA client-side routing: a deep link (e.g. /assets/<guid>) has no S3 object, so the OAC S3
      // origin returns 403 (404 covered for completeness). Rewrite both to index.html (200).
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
      ],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: true,
      logBucket: logsBucket,
      logFilePrefix: 'cloudfront-logs/',
      // No custom domain/ACM cert, no WAF, no geo restriction (all off by default; see suppressions).
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // Browser origins allowed to call the API: the CMS site, plus the Vite dev server (`npm run dev`) in dev.
    const siteOrigin = `https://${distribution.distributionDomainName}`;
    const allowedOrigins = [siteOrigin, ...(isProd ? [] : ['http://localhost:5174'])];

    // The invitation email Cognito sends an admin-created operator (its default is a bare "Your username is
    // {username} and temporary password is {####}."): say what it is for, link the CMS, and explain first
    // sign-in. Set here as a property override, not the L2 `userInvitation` prop, because it needs the
    // distribution's domain, which is created after the user pool.
    const mfaStep =
      cmsMfa === cognito.Mfa.REQUIRED
        ? ' You will then set up an authenticator app (TOTP) for multi-factor authentication.'
        : '';
    (userPool.node.defaultChild as cognito.CfnUserPool).addPropertyOverride('AdminCreateUserConfig.InviteMessageTemplate', {
      EmailSubject: `Your Video on Demand on AWS operator login (${vodStackName})`,
      EmailMessage: [
        '<p>Hello,</p>',
        `<p>An operator account has been created for you on the <b>Video on Demand on AWS</b> web app for the <b>${vodStackName}</b> stack.</p>`,
        `<p>Sign in: <a href="${siteOrigin}">${siteOrigin}</a><br>`,
        'Username: <b>{username}</b><br>',
        'Temporary password: <b>{####}</b></p>',
        `<p>On first sign-in you will be asked to choose a new password.${mfaStep} The temporary password expires in 7 days; ask your administrator to resend the invitation if it does.</p>`,
        '<p>If you were not expecting this email, you can ignore it.</p>',
      ].join('\n'),
    });

    const handler = new lambda.Function(this, 'AssetsFunction', {
      // No fixed functionName — let CDK derive a stack-unique name so the cms stack can coexist with
      // (and cleanly replace) any earlier cms/console stacks without a physical-name collision.
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'assets')),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'AssetsFnLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        VOD_STACK_NAME: vodStackName,
        // CORS: the API echoes the request Origin only when it is one of these.
        CMS_ALLOWED_ORIGINS: allowedOrigins.join(','),
        // The active extensions: the API loads only their ./extensions/<id>.mjs and reports them on /config,
        // which the UI uses to load only their pages and players. Omitted when none (the base CMS).
        ...(activeById.length > 0 ? { CMS_EXTENSIONS: activeById.map((e) => e.id).join(',') } : {}),
        ...Object.assign({}, ...active.map((ext) => ext.handlerEnvironment ?? {})),
      },
    });

    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters', 'ssm:GetParameter'],
        resources: [cdk.Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${vodStackName}/*` })],
      }),
    );
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
        resources: [tableArn, `${tableArn}/index/*`],
      }),
    );

    // ─── controlled re-drive (WRITE path #1) ────────────────────────────────────────────────
    // Tightly scoped: DeleteItem on the VOD table (clears a failed record so the Orchestrator's
    // conditional PutItem reprocesses in place), GetObject on the source bucket (HeadObject reads the
    // current version-id), and StartExecution on the single Orchestrator state machine — nothing else.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DeleteItem'],
        resources: [tableArn],
      }),
    );
    // GetObject on the object keyspace (HeadObject reads the current version-id); ListBucket on the
    // bucket itself so a HEAD of a missing key returns a truthful 404 (without it S3 answers 403 to
    // avoid confirming existence, which the re-drive can't tell apart from a real permission error).
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [`${sourceBucketArn}/*`, sourceBucketArn],
      }),
    );
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [orchestratorArn],
      }),
    );
    // list-only (no GetObject) on the destination bucket, scoped to the bucket ARN itself (no
    // wildcard) — just enough for ListObjectsV2 to discover a rendition's actual quality-metrics files
    // (JSON rescued from packaging mode, or native CSV in GA mode) before handing the browser direct
    // CloudFront URLs to fetch.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [destinationBucketArn],
      }),
    );
    // the resolution-label lookup reads the delivered HLS master (`<guid>/hls/index.m3u8`)
    // body server-side (listHlsResolutionsInOrder) - unlike the list-only patterns elsewhere in this
    // stack, this one genuinely needs GetObject, scoped to the object keyspace only.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${destinationBucketArn}/*`],
      }),
    );

    // ─── Poster override (WRITE path #2) ───────────────────────────────────────────────────────────
    // Let an operator browse the FRAME_CAPTURE scrub-bar thumbnails (listed via the s3:ListBucket
    // grant above — same bucket, same no-GetObject pattern as above) and pick one to replace the
    // pipeline's default poster (its first capture). Only a DynamoDB UpdateItem is needed: the chosen
    // frame's CloudFront URL is reconstructed server-side from a regex-validated filename, never
    // accepted from the client as a URL, so no S3 write/read grant is required for this path.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [tableArn],
      }),
    );

    // ─── Extensions: their own resources + API grants ────────────────────────────────────────────
    for (const ext of active) {
      ext.extendApi?.({ stack: this, handler, vodStackName, removalPolicy });
    }

    // ─── Quality-metrics rescue Lambda (event-driven, decoupled from the read API) ─────────
    // Only when packagingProfile=ON (the intermediate bucket exists) — see the `intermediateBucketName`
    // resolution above for why this is a synth-time flag, not an auto-detected lookup. Triggered by
    // MediaConvert's own `Job State Change` EventBridge event (native, automatic — no GA-core changes
    // needed to emit it). See quality-metrics-processor/index.mjs's header comment for why a GetJob
    // call is needed to disambiguate a rescuable ladder-job1 completion from a packaging job2/GA-mode
    // completion that share the same `userMetadata.workflow` value.
    if (intermediateBucketArn) {
      const qualityMetricsProcessor = new lambda.Function(this, 'QualityMetricsProcessorFunction', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'quality-metrics-processor')),
        timeout: cdk.Duration.minutes(5),
        memorySize: 256,
        logGroup: new logs.LogGroup(this, 'QualityMetricsProcessorFnLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        environment: {
          INTERMEDIATE_BUCKET: intermediateBucketName as string,
          DESTINATION_BUCKET: destinationBucketName,
        },
      });
      // GetJob/DescribeEndpoints have no job-ARN-scoped permission pattern (jobId varies per event, and
      // DescribeEndpoints is account-wide by design) — Resource: '*' is the only option MediaConvert
      // supports for these read-only actions.
      qualityMetricsProcessor.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['mediaconvert:GetJob', 'mediaconvert:DescribeEndpoints'],
          resources: ['*'],
        }),
      );
      qualityMetricsProcessor.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [`${intermediateBucketArn}/*`],
        }),
      );
      // ListObjectsV2 needs s3:ListBucket on the bucket ARN itself (not the /* object keyspace).
      qualityMetricsProcessor.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [intermediateBucketArn],
        }),
      );
      qualityMetricsProcessor.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [`${destinationBucketArn}/*`],
        }),
      );
      new events.Rule(this, 'QualityMetricsJobCompleteRule', {
        description: "Fires the quality-metrics rescue Lambda on this stack's own MediaConvert job completions.",
        eventPattern: {
          source: ['aws.mediaconvert'],
          detailType: ['MediaConvert Job State Change'],
          detail: {
            status: ['COMPLETE'],
            userMetadata: { workflow: [vodStackName] },
          },
        },
        targets: [new targets.LambdaFunction(qualityMetricsProcessor)],
      });
      NagSuppressions.addResourceSuppressions(
        qualityMetricsProcessor,
        [
          { id: 'AwsSolutions-L1', reason: 'Pinned to NODEJS_22_X (current supported LTS) for reproducible builds.' },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'mediaconvert:GetJob/DescribeEndpoints have no job-ARN-scoped permission (jobId varies per event; DescribeEndpoints is account-wide by design) — Resource "*" is the only option MediaConvert supports for these read-only actions. s3:GetObject/PutObject wildcards are the intermediate/destination bucket OBJECT keyspaces (`<bucket>/*`), not the bucket ARNs themselves — intentional least privilege, same pattern as the other S3 grants in this stack.',
          },
        ],
        true,
      );
    }

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${appName}-${environment}-api`,
      description: 'Authenticated read API for the VOD operator web app (cms).',
      deployOptions: {
        stageName: environment,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiAccessLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        tracingEnabled: true, // AWS X-Ray tracing on the stage
        // Stage-wide throttle: ample for an operator console, and caps runaway cost from a bad client.
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
      },
      // Browser CORS only from the CMS site (+ the Vite dev server in dev); the API is bearer-token authed.
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    apiForCsp = api;

    // CORS on 4xx (e.g. 401 from the authorizer) so the browser can read the error.
    api.addGatewayResponse('Default4xx', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': `'${siteOrigin}'`, 'Access-Control-Allow-Headers': "'*'" },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuth', { cognitoUserPools: [userPool] });
    const authOpts: apigateway.MethodOptions = { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO };
    const integration = new apigateway.LambdaIntegration(handler);

    api.root.addResource('config').addMethod('GET', integration, authOpts);
    const assets = api.root.addResource('assets');
    assets.addMethod('GET', integration, authOpts);
    const asset = assets.addResource('{guid}');
    asset.addMethod('GET', integration, authOpts);
    // controlled re-drive of a failed asset (POST /assets/{guid}/redrive) — Cognito-authed.
    asset.addResource('redrive').addMethod('POST', integration, authOpts);
    // quality-metrics manifest (GET /assets/{guid}/quality-metrics) — Cognito-authed.
    asset.addResource('quality-metrics').addMethod('GET', integration, authOpts);
    // Measured per-rung video bitrate for the ABR ladder (GET /assets/{guid}/abr-bitrates) —
    // Cognito-authed. Reuses the destination-bucket s3:ListBucket grant above (object sizes from the
    // listing; no GetObject on the media).
    asset.addResource('abr-bitrates').addMethod('GET', integration, authOpts);
    // Poster override: browse the scrub-bar thumbnails (GET .../thumbnails) and pick one as the poster
    // (POST .../poster, WRITE path #2) — Cognito-authed.
    asset.addResource('thumbnails').addMethod('GET', integration, authOpts);
    asset.addResource('poster').addMethod('POST', integration, authOpts);
    // Extension routes under /assets/{guid} — Cognito-authed like the rest.
    for (const ext of active) {
      ext.addAssetRoutes?.({ asset, integration, authOpts });
    }


    // ─── Outputs consumed by scripts/deploy-all.sh -> frontend/.env + publish ────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPoolId, description: 'VITE_COGNITO_USER_POOL_ID' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId, description: 'VITE_COGNITO_CLIENT_ID' });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: identityPool.ref, description: 'VITE_COGNITO_IDENTITY_POOL_ID' });
    new cdk.CfnOutput(this, 'CognitoRegion', { value: this.region, description: 'VITE_COGNITO_REGION' });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url, description: 'VITE_API_URL' });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distributionDomainName,
      description: 'CloudFront domain that serves the operator web app (cms) SPA.',
    });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName, description: 'Private S3 origin bucket (aws s3 sync target).' });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId, description: 'CloudFront distribution id (invalidation target).' });

    // ─── cdk-nag: this COMPANION app carries its own posture (separate from the VOD zero gate) ───
    NagSuppressions.addResourceSuppressions(userPool, [
      ...(cmsMfa === cognito.Mfa.REQUIRED
        ? []
        : [
            {
              id: 'AwsSolutions-COG2',
              reason: `MFA is ${mfaRaw} because this is a non-prod CMS environment or cmsMfa was set explicitly; prod defaults to REQUIRED (TOTP). Set -c cmsMfa=REQUIRED for any shared deployment.`,
            },
          ]),
      {
        id: 'AwsSolutions-COG3',
        reason:
          'Cognito threat protection (advanced security) needs the Plus feature plan, a per-MAU cost this guidance does not impose by default. Operators can enable it on the user pool; self sign-up is off, the password policy is strong and MFA defaults to REQUIRED in prod.',
      },
      {
        id: 'AwsSolutions-COG8',
        reason: 'Plus feature plan not enabled by default (per-MAU cost); see AwsSolutions-COG3. Enable it for production deployments that need threat protection.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(
      authenticatedRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Upload role is scoped to uploads/${cognito-identity.amazonaws.com:sub}/* on the single VOD source bucket — the /* wildcard is the per-user object keyspace (intentional least privilege), not a broad grant.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(handler, [
      { id: 'AwsSolutions-L1', reason: 'Pinned to NODEJS_22_X (current supported LTS) for reproducible builds.' },
    ]);
    NagSuppressions.addResourceSuppressions(
      api,
      [
        { id: 'AwsSolutions-APIG2', reason: 'No request-body validation model: the GET routes take no body. Of the two write routes, POST /assets/{guid}/redrive is parameterised only by the {guid} path segment and carries no body (the handler validates guid + asset status server-side); POST /assets/{guid}/poster takes a small { frameKey } body, validated server-side against a fixed filename regex (frame.NNNNNNN.jpg) before use — a request-validation model would duplicate that same check, not add safety.' + active.flatMap((ext) => ext.requestValidationNotes ?? []).map((note) => ` ${note}`).join('') },
        { id: 'AwsSolutions-APIG3', reason: 'No WAF on the companion cms API for now; add a WebACL before external-facing use (same pattern as the delivery protection).' },
        { id: 'AwsSolutions-APIG4', reason: 'All resource methods use the Cognito authorizer; the CORS OPTIONS preflight is intentionally unauthenticated per the CORS spec.' },
        { id: 'AwsSolutions-COG4', reason: 'CORS preflight OPTIONS is unauthenticated by design; every data method uses the Cognito User Pools authorizer.' },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(logsBucket, [
      { id: 'AwsSolutions-S1', reason: 'This IS the access-log bucket (CloudFront standard logs + the site bucket S3 access logs). Enabling access logging on itself would recurse.' },
    ]);
    NagSuppressions.addResourceSuppressions(distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'Geo restriction is off by default for this internal companion cms (same off-by-default stance as the VOD stack); add an allowlist before external-facing use.' },
      { id: 'AwsSolutions-CFR2', reason: 'No WAF WebACL on the companion cms for now; add a webAclId (see the streaming-media WAF module) before internet-facing use — consistent with the API APIG3 posture.' },
      {
        id: 'AwsSolutions-CFR4',
        reason:
          'The distribution uses the default *.cloudfront.net certificate, for which CloudFront automatically enforces a TLSv1 security policy regardless of MinimumProtocolVersion. A custom domain + ACM certificate would be required to raise it, which is out of scope for this deploy-and-go companion.',
      },
    ]);
    // Stack-scoped: CDK-managed service roles use AWS managed policies (Lambda basic execution, API
    // Gateway CloudWatch, log retention) -> IAM4; the API Lambda's read policy uses table `/index/*` +
    // `/<vodStackName>/*` wildcards (intentionally narrow) -> IAM5. In dev, autoDeleteObjects injects a
    // Custom::S3AutoDeleteObjects handler (Lambda) whose role uses managed policies + bucket wildcards
    // and pins its own runtime -> IAM4/IAM5/L1. Prod (RETAIN) omits the custom resource.
    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-managed service roles (Lambda basic execution, API Gateway CloudWatch, log retention, dev auto-delete-objects) use AWS managed policies. Acceptable for the companion cms.' },
      { id: 'AwsSolutions-IAM5', reason: 'DynamoDB scoped to the VOD table + its `/index/*` (read) and the table ARN (re-drive DeleteItem + the poster-override UpdateItem, no wildcard); SSM GetParameters scoped to `/<vodStackName>/*`; the re-drive s3:GetObject is scoped to the source bucket object keyspace (`<sourceBucket>/*`, the only wildcard, needed to HeadObject arbitrary source keys) with s3:ListBucket on the bucket ARN (so a missing key HEADs as 404 not 403) and states:StartExecution is scoped to the single Orchestrator ARN (no wildcard); s3:ListBucket on the destination bucket ARN (no `/*`, no GetObject) is shared by the quality-metrics manifest and the poster-override thumbnails listing; dev auto-delete-objects needs wildcard object actions on the buckets it empties. All intentionally narrow.' },
      { id: 'AwsSolutions-L1', reason: 'The API Lambda is pinned to NODEJS_22_X; CDK-managed custom-resource Lambdas (dev auto-delete-objects) pin their own runtime and are not user-controlled.' },
    ]);
  }
}
