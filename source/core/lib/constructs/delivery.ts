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
 * DeliveryConstruct for the VOD v7.0.0 stack.
 *
 * Fronts the transcoded static-CMAF output (destination) bucket with a CloudFront distribution
 * using the `@aws-solutions-constructs/aws-cloudfront-s3` (`CloudFrontToS3`) construct. That
 * construct wires an Origin Access Control (OAC) to the S3 origin by default (no OAI), so no
 * OAI is added here and the (dead) `AwsSolutions-CFR7` suppression is intentionally NOT re-added.
 *
 * Differences from the v6 stack:
 *   - The v6 custom `maxTtl=0` `CachePolicy` is gone. Static CMAF manifests/segments are
 *     immutable per GUID prefix, so caching is desirable: this uses the AWS-managed
 *     **CachingOptimized** policy.
 *   - CORS is handled **natively** (no CloudFront Function / no Lambda): the managed
 *     **CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS** response-headers policy sets the
 *     CORS + security headers (HSTS, nosniff), the destination bucket carries an S3 CORS config so the
 *     origin answers the OPTIONS **preflight**, and the managed `CORS-S3Origin` origin-request policy
 *     forwards the CORS request headers to S3. (A response-headers policy alone cannot answer preflight
 *     for an S3/OAC origin — CloudFront forwards OPTIONS to S3, which 403s without origin CORS; verified
 *     live.) The construct's own header-injection function is disabled via `insertHttpSecurityHeaders: false`.
 *   - `HTTP/2 + HTTP/3` and IPv6 are enabled.
 *   - CloudFront access logs are written to the shared logs bucket owned by StorageConstruct.
 *   - `priceClass`, and the optional `geoRestriction` / `wafWebAclArn`, come from validated context.
 *
 * The cdk-nag suppression this construct owns is `AwsSolutions-CFR4`, scoped to the distribution and
 * only on the default `*.cloudfront.net` certificate, for which CloudFront forces the security policy to
 * `TLSv1`. With the optional `domainName` + `certificateArn` context keys the distribution serves the
 * custom domain with a `TLSv1.2_2021` minimum and the suppression is not added. The
 * geo-restriction (`CFR1`) and WAF (`CFR2`) findings are handled at stack scope by the orchestrator
 * (`lib/vod-stack.ts`) because they reflect a stack-wide "off by default" decision.
 */

import { Construct } from 'constructs';
import { Stack } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { CloudFrontToS3 } from '@aws-solutions-constructs/aws-cloudfront-s3';
import { NagSuppressions } from 'cdk-nag';

import { PriceClass } from '../context';
import { DeliveryConstructProps, IDeliveryConstruct } from './interfaces';

/** Prefix under the shared logs bucket for the CloudFront standard access logs. */
const CLOUDFRONT_LOG_PREFIX = 'cloudfront-logs/';

/** Map the validated context price-class literal to the CDK `cloudfront.PriceClass` enum. */
const PRICE_CLASS_MAP: Readonly<Record<PriceClass, cloudfront.PriceClass>> = {
  PriceClass_100: cloudfront.PriceClass.PRICE_CLASS_100,
  PriceClass_200: cloudfront.PriceClass.PRICE_CLASS_200,
  PriceClass_All: cloudfront.PriceClass.PRICE_CLASS_ALL,
};

export class DeliveryConstruct extends Construct implements IDeliveryConstruct {
  /** The CloudFront distribution fronting the destination bucket (OAC origin). */
  public readonly distribution: cloudfront.Distribution;
  /** `distribution.distributionDomainName`. -> `${CLOUDFRONT_DOMAIN}`. */
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: DeliveryConstructProps) {
    super(scope, id);

    const { context, storage } = props;

    // Optional geo-restriction allowlist (uppercased ISO 3166-1 alpha-2 codes from context).
    const geoRestriction =
      context.geoRestriction && context.geoRestriction.length > 0
        ? cloudfront.GeoRestriction.allowlist(...context.geoRestriction)
        : undefined;

    // Optional custom domain + ACM certificate (both or neither, validated in context). Only with a custom
    // certificate can the TLS minimum be raised: CloudFront fixes `*.cloudfront.net` at TLSv1.
    const customDomain =
      context.domainName && context.certificateArn
        ? {
            domainNames: [context.domainName],
            certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', context.certificateArn),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {};

    // CORS for hls.js/dash.js cross-origin manifest/segment fetches, handled natively (no
    // CloudFront Function / no Lambda), per the AWS blog "CORS configuration through Amazon
    // CloudFront" (option 1 RHP + option 3 origin CORS). Three pieces work together:
    //   1. `CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS` response-headers policy sets
    //      the CORS headers (incl. preflight) + security headers (HSTS, nosniff) on responses.
    //   2. The destination bucket has an S3 CORS config (StorageConstruct), so the ORIGIN answers the
    //      OPTIONS preflight — a response-headers policy alone cannot (CloudFront forwards OPTIONS to
    //      S3; without origin CORS, S3/OAC returns 403 and the browser preflight fails, verified live).
    //   3. The managed `CORS-S3Origin` origin-request policy forwards Origin / Access-Control-Request-*
    //      to S3 so it can evaluate the preflight. All origins are allowed uniformly (`*`), so the
    //      preflight response is identical for every viewer and safe to cache under CachingOptimized.
    const cloudFront = new CloudFrontToS3(this, 'CloudFrontToS3', {
      // Serve the transcoded CMAF output bucket via OAC (default) — no OAI is created.
      existingBucketObj: storage.destinationBucket,
      // The construct's built-in security-header CloudFront Function is disabled; the managed
      // CORS + security-headers response policy below supplies those headers instead.
      insertHttpSecurityHeaders: false,
      // Origin bucket access logging is owned by StorageConstruct; do not have the construct
      // attach its own S3 access-log bucket to the (existing) origin bucket.
      logS3AccessLogs: false,
      cloudFrontDistributionProps: {
        defaultBehavior: {
          // OPTIONS is allowed and forwarded so the S3 origin can answer the CORS preflight.
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Managed CachingOptimized policy (replaces the deleted v6 custom maxTtl=0 policy).
          // Byte-range (Range GET) requests are served natively for the S3 origin — no config needed;
          // the single-file CMAF output (HLS #EXT-X-BYTERANGE, DASH <SegmentBase>) relies on this.
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          // Managed CORS **with preflight** + security headers on all responses.
          responseHeadersPolicy:
            cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS,
          // Forward Origin + Access-Control-Request-* to S3 so the origin can answer the preflight.
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        },
        // Console "Description": names the stack it belongs to (stack names are <= 100 chars, so this stays
        // within CloudFront's 128-character limit).
        comment: `${Stack.of(this).stackName} - Video on Demand on AWS`,
        httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        enableIpv6: true,
        priceClass: PRICE_CLASS_MAP[context.priceClass],
        // CloudFront standard access logs -> shared logs bucket owned by StorageConstruct.
        enableLogging: true,
        logBucket: storage.logsBucket,
        logFilePrefix: CLOUDFRONT_LOG_PREFIX,
        // Optional edge controls (both off by default per validated context).
        geoRestriction,
        webAclId: context.wafWebAclArn,
        // Custom domain + TLSv1.2_2021 minimum (off by default; spreads nothing when unset).
        ...customDomain,
      },
    });

    this.distribution = cloudFront.cloudFrontWebDistribution;
    this.distributionDomainName = this.distribution.distributionDomainName;

    // cdk-nag suppressions this construct owns.
    // CFR4 applies only on the default certificate; with a custom domain the TLSv1.2_2021 minimum satisfies it.
    NagSuppressions.addResourceSuppressions(this.distribution, [
      ...(context.certificateArn
        ? []
        : [
            {
              id: 'AwsSolutions-CFR4', // equivalent to cfn_nag W70
              reason:
                'The distribution uses the default *.cloudfront.net certificate, for which CloudFront ' +
                'automatically enforces a TLSv1 security policy regardless of MinimumProtocolVersion. ' +
                'Set the domainName + certificateArn context keys to serve a custom domain with a ' +
                'TLSv1.2_2021 minimum.',
            },
          ]),
      {
        id: 'AwsSolutions-CFR7',
        reason:
          'The S3 origin DOES use an Origin Access Control (the @aws-solutions-constructs/aws-cloudfront-s3 ' +
          'construct provisions an AWS::CloudFront::OriginAccessControl with SigningBehavior=always and sets ' +
          'the origin OriginAccessControlId; the origin bucket policy grants only cloudfront.amazonaws.com via ' +
          'the OAC). cdk-nag 2.38 (CFR7 is new since 2.27) does not detect the OAC because the construct ' +
          'attaches it via a CfnDistribution property override rather than an L2 prop, so the finding is a ' +
          'false positive. Verified in the synthesized template and by the deployed distribution blocking ' +
          'direct S3 access.',
      },
    ]);
  }
}
