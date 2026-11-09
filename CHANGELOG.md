# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Custom domain with a TLS 1.2 minimum.** New `domainName` + `certificateArn` context keys (`DOMAIN_NAME`,
  `CERTIFICATE_ARN`; set both or neither, certificate in us-east-1) serve the distribution on your domain
  with a `TLSv1.2_2021` minimum protocol version. The `AwsSolutions-CFR4` suppression now applies only on
  the default `*.cloudfront.net` certificate. Unset, the template is unchanged.

### Security

- Service-role trust policies (MediaConvert, the four state machines, the EventBridge rule role) now carry
  `aws:SourceAccount` / `aws:SourceArn` conditions against the cross-service confused-deputy problem.
- CMS: the Cognito app client allows SRP only; `USER_PASSWORD_AUTH` is removed.
- CMS: OAuth is disabled on the Cognito app client (`disableOAuth: true`). The CDK defaults had left the
  implicit and code grants on with an `https://example.com` callback; unused today (no Hosted UI domain).
- CMS: AWS X-Ray tracing is enabled on the API Gateway stage.
- README: a non-production sample-code notice at the top and in Notices.
- README: a Security section on public-by-default media delivery (recommends
  [Secure Media Delivery at the Edge on AWS](https://docs.aws.amazon.com/solutions/secure-media-delivery-at-the-edge-on-aws/)
  for token-protected playback) and the account-level controls the deployer owns.

### Changed

- **UHD tier encodes HEVC.** The UHD templates (`uhd.json` CMAF, `hvc1` sample entry; `uhd-ladder.json`
  `packagingProfile` TS-HLS ladder) now use H.265 (Main profile, 8-bit, QVBR) instead of H.264. SD and HD
  stay H.264. Players on devices without HEVC decode cannot play UHD-tier assets, and with
  `packagingProfile=ON` the UHD HLS/TS output carries HEVC in MPEG-TS, which Apple's HLS authoring spec
  does not allow (use the CMAF-HLS output on Apple devices).
- **`scripts/configure.sh` usability.** Every prompt shows the saved value or the default (Enter keeps it);
  Region, archive tier, price class and on/off settings are arrow-key menus (numbered when not on a
  terminal or with `VOD_WIZARD_PLAIN=1`); input is validated before it is saved (email, stack name,
  retention days, country codes, IPv4 CIDRs, WebACL ARN, CORS origins). New prompts for `ENABLE_SNS`,
  `GEO_RESTRICTION`, `WAF_WEB_ACL_ARN` and `UPLOAD_CORS_ORIGINS`; the `ENABLE_SQS` prompt is removed (set
  it in `.env`). It ends with a review screen and offers to run `scripts/deploy-wizard.sh`.
- The wizard helpers are shared by both wizards in `scripts/lib/wizard.sh`, with a smoke test
  (`scripts/lib/wizard.test.sh`).

### Fixed

- Re-uploading a source to the same key reused the earlier upload's ad markers and captions: the
  Orchestrator applied any `<source>.esam.xml` / `<source>.vtt` it found, and the CMS never removed them
  when a toggle was off. With `adMarkersProfile` or `captionsProfile` on, the Orchestrator now reads the
  per-asset `<source>.json` first (`Read Asset Metadata`) and skips a sidecar whose flag is `false`
  (`Captions Requested?` / `Ad Markers Requested?`); with no `.json` it still uses file presence. The CMS
  now writes `<source>.json` on every single-file upload, so its toggles always apply.
- `scripts/configure.sh`: a re-run that pressed Enter turned off optional stages that were on and cleared
  their saved values; the prompt could show a different value from the one Enter kept; the example email
  was accepted; optional values could not be cleared; an invalid choice wrote an empty `KEY=` line;
  `.env` keys were moved to the end of the file, away from their comments; closed stdin looped forever.
- Every S3 upload failed at Process (`ValidationException`: execution name longer than 80 characters).
  Child executions were named `<Orchestrator execution name>-<stage>`, and EventBridge names the
  Orchestrator execution `<event-id>_<uuid>` (73 characters). Children are now named
  `<MD5 of the Orchestrator execution name>-<stage>` (at most 40 characters), still unique per run.
- CMS re-drive failed at Ingest: child executions were named `<guid>-<stage>`, a name Step Functions
  reserves for 90 days, so a re-run of the same guid hit `ExecutionAlreadyExists`. Children are now named
  after the Orchestrator execution. The re-drive's `DeleteItem` is now conditional on
  `workflowStatus = Error` (a concurrent re-drive gets 409), and if `StartExecution` then fails the cleared
  record is written to the Lambda log.

## [7.0.0] - Unreleased

Version 7.0.0 is a clean-break rewrite of the solution as a native-integration core. There is no
in-place upgrade path from 6.x; deploy 7.0.0 as a new stack.

### Added

- **Native-integration core.** A parent **Orchestrator** AWS Step Functions state machine
  (`{stack}-orchestrator`) runs three stage machines (Ingest, Process, Publish) as
  `states:startExecution.sync:2` child executions, giving one execution ARN per asset. All four machines
  use native service integrations; the synthesized core template contains **0
  `AWS::Lambda::Function` resources**. New `OrchestratorStateMachineArn` output.
- **CMAF (HLS + DASH) output.** A single MediaConvert `createJob.sync` job produces one single-file CMAF
  output group (byte-range HLS + DASH manifests) with Automated ABR and QVBR. The `sd` / `hd` / `uhd` job
  template is chosen per asset by an ASL `Choice` on the probed video height, with retry and backoff on
  MediaConvert throttling.
- **Native source probe** via `mediaconvert:probe` (replaces the MediaInfo Lambda and binary).
- **Idempotent ingestion.** The Orchestrator derives a deterministic `guid`
  (`States.Hash(key + S3 versionId, 'SHA-256')`) and creates the DynamoDB item with a conditional
  `PutItem`, so a duplicate S3 event ends in a benign `Duplicate Skipped` state with no second encode. A
  genuine re-upload (new version) still reprocesses. The `guid` is now a 64-character hex string.
- **Persisted failure state.** A single centralized `Catch` writes `workflowStatus=Error` with
  `errorStage` and `errorMessage` to the DynamoDB item and sends one failure notification.
  `workflowStatus` is now `Ingest | Encoding | Complete | Error`; the item also records
  `orchestratorExecutionArn`.
- **CloudFront delivery with Origin Access Control (OAC)**, the managed CachingOptimized policy, CORS and
  security-headers policies, Range GET support for byte-range CMAF playback, and optional
  `geoRestriction`, `priceClass`, and `wafWebAclArn` inputs.
- **Native source archiving** to Glacier or Deep Archive via S3 object tagging and a bucket lifecycle
  rule (`archiveSource`).
- **Configuration through CDK context**, validated at synth time (`email` required; `stackName`,
  `enableSns`, `enableSqs`, `archiveSource`, `priceClass`, `geoRestriction`, `wafWebAclArn`,
  `destinationRetentionDays`, plus the overlay keys below). Values can also be supplied in one
  repo-root `.env` shared by every app (`VOD_ENV_FILE` selects another file). Helper scripts
  `deployment/deploy.sh`, `scripts/configure.sh` and `scripts/deploy-wizard.sh` wrap the common deploy
  paths.
- **Modular repository.** npm workspaces: `source/core` (the core stack), the operator CMS under
  `source/cms`, and `source/contract`, the shared cross-stack contract (SSM discovery keys and context
  helpers) that companion stacks build on. The core stack and the CMS load optional extensions
  (`source/core/extensions/<name>`, `source/cms/…/extensions/<name>`) through a neutral hook seam.
- `/${stackName}/...` SSM Parameter Store parameters (table, source and destination buckets, CloudFront
  domain, Orchestrator ARN) for discovery by companion stacks.
- Observability: execution logging and X-Ray on every state machine, failure alarms, a CloudWatch
  dashboard, and an EventBridge dead-letter queue.
- **REMUX_ALL multi-format packaging overlay** (`packagingProfile=ON`, default off). Each tier encode
  produces a TS-HLS Automated-ABR ladder (job1, written to a dedicated non-origin intermediate bucket;
  templates `job-templates/{sd,hd,uhd}-ladder.json`). A second job (`package-drm.json`) uses
  `VideoSelectorMode=REMUX_ALL` passthrough to repackage every ladder rendition, without re-encoding,
  into HLS/TS, CMAF-HLS, and DASH under `<guid>/{hls,cmaf,dash}/`. The SNS success notification lists
  every packaged playback URL.
- **SCTE-35 ad-break markers via ESAM** (`adMarkersProfile=ON`, default off). The Orchestrator reads a
  per-asset `<source>.esam.xml` sidecar and MediaConvert inserts SCTE-35 markers at the points it
  specifies (HLS gets `AdMarkers`; verified to produce `#EXT-OATCLS-SCTE35` / `#EXT-X-CUE-OUT` in the
  packaged HLS/TS manifest). A source with no sidecar encodes normally. DASH MPD `<EventStream>`
  conditioning remains deferred. See `samples/ad-markers/scte35-esam-sample.xml`.
- **Captions / subtitles overlay** (`captionsProfile=ON`, default off). A per-asset `<source>.vtt`
  sidecar adds WebVTT tracks on HLS/CMAF and IMSC on DASH; a source with no sidecar encodes normally.
  With packaging on, captions are generated on the REMUX_ALL job, because passthrough does not carry a
  caption rendition through. See `samples/captions/`.
- **Per-frame quality metrics overlay** (`perFrameMetrics=ON`, default off). MediaConvert writes
  per-output VMAF, QVBR, and SHOT_CHANGE CSV reports; `qualityMetrics` and `qualityMetricsPrefix` are
  recorded on the DynamoDB item.
- **Thumbnails / poster overlay** (`thumbnailsProfile`, default **on**). A FRAME_CAPTURE output group
  writes a poster and periodic thumbnails to `<guid>/thumbnails/`; `thumbnailsPrefix` and `posterUrl`
  are recorded on the DynamoDB item. Set `thumbnailsProfile=OFF` to opt out.
- **Operator web app** (`source/cms`, optional `<stackName>-cms` companion stack). A Cognito-authenticated
  React + Cloudscape app with an authenticated API and CloudFront hosting: paginated asset catalog and
  detail pages, integrated HLS / DASH / CMAF-HLS players (plus an ad-stitched SSAI stream when one is
  published), adaptive bitrate ladder with measured per-rung bitrate,
  per-frame quality-metric charts, SCTE-35 ad breaks, poster selection, self-service upload with
  optional ESAM, caption, and metadata sidecars, and controlled re-drive of failed assets. It includes
  an event-driven Lambda that copies packaging-mode quality-metrics reports to the destination bucket.
  Because it is a separate stack, it does not affect the core 0-Lambda invariant.

All overlays are applied in memory at synth time. With an overlay off, the synthesized core template is
byte-identical, and the 0-Lambda invariant and the cdk-nag zero-findings gate hold with every overlay
off or on.

### Changed

- Orchestration moved from a router Lambda and Lambda-per-step chain to the Orchestrator and three
  stage machines. Stages no longer chain to each other; each ends failures in a `Fail` state that
  propagates to the Orchestrator's single failure path, replacing per-stage failure notifications.
- Runtime feature toggles (`archiveSource`, `enableSns`, `enableSqs`) are assembled into a single
  `$.config` block by the Orchestrator's `Load Job Config` state and read from `$.config.*` by every
  stage.
- Publish success notifications (SNS/SQS) are best effort: a notification failure after the item is
  `Complete` no longer fails the asset.
- The S3 -> EventBridge -> Orchestrator rule filters object keys to exclude the per-asset sidecars
  (`<source>.esam.xml`, `<source>.json`, and, with captions on, `<source>.vtt`), so uploading a sidecar
  never starts its own workflow.
- The solution is deployed with `cdk deploy` from a single CDK-synthesized template. CloudFormation
  parameters and the hosted launch template are removed.
- Runtime is Node.js 22 or later; Python is no longer required.

### Removed

- All solution-authored workflow Lambda functions and their source directories (input-validate,
  mediainfo, dynamo, profiler, encode, output-validate, archive-source, media-package-assets,
  sns-notification, sqs-publish, error-handler, step-functions, custom-resource).
- AWS Elemental MediaPackage VOD packaging, replaced by MediaConvert CMAF output (and the optional
  REMUX_ALL packaging overlay).
- The MP4 output and the MediaInfo binary build step.
- The stack-wide `tierOverride` context key. The quality tier is chosen per asset by probed video
  height; per-asset ladder selection is planned as a future per-title encoding feature.

## [6.1.18] - 2026-06-02

### Fixed

- Fixed typo in source-bucket lifecycle id suffix (#256)

### Security

- Security updates for npm packages

## [6.1.17] - 2026-03-31

### Security

- Security updates for npm packages

## [6.1.16] - 2026-03-10

### Changed

- Migration to guidance

## [6.1.15] - 2026-03-10

### Changed

- Migration to guidance

## [6.1.14] - 2025-09-23

### Security

- Security updates for npm packages

## [6.1.13] - 2025-08-26

### Changed

- Updated Lambda to Python 3.13

### Removed

- AppRegistry removed from solution

### Security

- Security updates for npm packages

## [6.1.12] - 2025-06-19

### Changed

- Updated Lambdas to NodeJS 22

### Security

- Security updates for npm packages

## [6.1.11] - 2025-03-14

### Security

- Security updates for npm packages

## [6.1.10] - 2024-11-21

### Security

- Security updates for npm packages

## [6.1.9] - 2024-09-17

### Security

- Security updates for npm packages

## [6.1.8] - 2024-08-22

### Security

- Security updates for npm packages

## [6.1.7] - 2024-08-09

### Security

- Security updates for transitive dependencies

## [6.1.6] - 2024-07-19

### Security

- Security updates for transitive dependencies

## [6.1.5] - 2023-10-30

### Security

- Security updates for transitive dependencies

## [6.1.4] - 2023-09-14

### Fixed

- Fixed typos ([PR #161](https://github.com/aws-solutions/video-on-demand-on-aws/pull/161), [PR #123](https://github.com/aws-solutions/video-on-demand-on-aws/pull/123), [PR #153](https://github.com/aws-solutions/video-on-demand-on-aws/issues/153))
- Fixed scripts to handle spaces in directory name ([Issue #141](https://github.com/aws-solutions/video-on-demand-on-aws/issues/153), [PR #142](https://github.com/aws-solutions/video-on-demand-on-aws/pull/142))

## [6.1.3] - 2023-07-10

### Changed

- Updated to JavaScript V3 SDK for NodeJS 18 update.
- All node JS Lambdas upgraded to NodeJS 18 runtime.
- Updated packages
- Removed deprecated moment package
- Enabled versioning and enforce SSL for S3 buckets
- Refactored S3 Config custom resource to reduce duplicated lines
- Updated S3 client configuration to use v4 signature by default and path addressing_style
- Updated operational metrics so that people can successfully opt out by following the Implementation Guide

## [6.1.2] - 2023-05-01

### Added

- Created unique cachePolicyName for CloudFront cache policy allowing the stack to deployed multiple times across regions.
- Added unique prefix for Application Registry name so if a stack update is performance the new application will show up in app manager.
- Added package-lock files to show snapshot of packages used during build.

### Removed

- Removed github action workflow files

## [6.1.1] - 2023-04-17

### Changed

- Updated object ownership configuration on the CloudFormation logging bucket

## [6.1.0] - 2023-02-27

### Changed

- Added region name and account ID to AppRegistry Application name
- Changed AppRegistry Attribute Group name to Region-StackName
- Updated AppRegistry attribute and tag names

### Fixed

- #155 appRegistry associateStack has been deprecated

## [6.0.0] - 2022-10-17

### Added

- Added cdk infrastructure in source/cdk directory
- Defined resources for cdk stack in source/cdk/lib/vod-stack.ts
- Added snapshot test to source/cdk/test directory
- Added SolutionId tag to resources
- Added cdk nag rule suppressions
- Added Service Catalog AppRegistry configuration

### Changed

- Removed CloudFormation template video-on-demand-on-aws.yaml
- Upgrade path from old versions require a delete and re-deploy since moving to CDK
- Use CachePolicy instead of ForwardedValues(deprecated) for cloudfront distribution
- Use @aws-solutions-constructs/aws-cloudfront-s3 construct for cloudfront distribution and destination bucket origin
- Updated deployment/build-s3-dist.sh to output cdk nag errors
- Updated to uuid v9

### Fixed

- Fixed mergeSettingsWithDefault arguments. Closes this issue <https://github.com/aws-solutions/video-on-demand-on-aws/issues/137>

## [5.3.1] - 2021-12-16

### Fixed

- Fixed spelling errors in CloudFormation template.

## [5.3.0] - 2021-11-17

### Added

- Added new input file types wmv, mkv, m3u8, mpeg, webm, and h264.
- Now allowing uppercase input file types to run the end to end video encoding workflow.
- Added the MXF and mxf file types. Closes this request <https://github.com/aws-solutions/video-on-demand-on-aws/issues/124>
- Additional headers added to Amazon CloudFront distribution attached to destination bucket for the out/* prefix. This will allow easier playback of content on modern browsers. Additional headers whitelisted are Origin, Access-Control-Allow-Origin, Access-Control-Request-Method, and Access-Control-Request-Headers.
- Additional methods added to Amazon CloudFront distribution for destination bucket. Head and options added.

### Changed

- Added steps in Readme to make building the project more clear.
- Added Readme build step to ensure bucket ownership when uploading build files.
- Removed deinterlacer preprocessor from templates to reduce costs. This causes MediaConvert jobs to run in Basic Tier mode instead of Pro Tier.
- Modified job templates that force output frame rate to 30, 24, or 15 fps to instead follow the source fps of your video file. This allows 60fps content, as well as PAL 25/50 fps video files to have their frame rate preserved.
- Removed Dash and MP4 outputs, leaving just the HLS output. This saves costs running this solution.
- Removed SelectorType and Tracks from job profiles, we will auto pick the first track. This allows audio only videos to encode without having an error.
- Changed AWS MediaConvert templates codecLevel to auto to allow for more supported input file types.
- Changed AWS MediaConvert audio track to auto to allow for video only workflows. This allows video files without audio track to work with the included AWS MediaConvert profiles.

### Fixed

- Fixed naming in the MediaConvert custom resource. Closes this PR <https://github.com/aws-solutions/video-on-demand-on-aws/pull/84>
- Update Axios package to 0.21.1

## [5.2.0] - 2020-12-10

### Added

- Support for S3 Signature Version4 for pre-signed URLs <https://github.com/awslabs/video-on-demand-on-aws/pull/111>
- New MediaConvert job templates with fewer HLS and DASH ABR renditions, updated encoder settings, and no presets
- Enabled point-in-time recovery backup for DynamoDB table

### Changed

- MediaInfo executable version (from v19.09 to v20.09) <https://github.com/awslabs/video-on-demand-on-aws/pull/116>
- CloudFront configuration improvements <https://github.com/awslabs/video-on-demand-on-aws/pull/96> <https://github.com/awslabs/video-on-demand-on-aws/pull/99>
- MediaConvert presets are no longer being created
- All new MediaConvert job templates gets created regardless of whether MediaPackage is enabled or not

### Fixed

- Settings are no longer overwritten when using custom templates <https://github.com/awslabs/video-on-demand-on-aws/pull/107>
- Solution now deploys even in regions with no MediaPackage support

## [5.1.0] - 2020-04-30

### Added

- Default encryption to SNS topic
- Environment variable to configure the AWS SDK to reuse TCP connections <https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/node-reusing-connections.html>
- SQS queue options at deployment to capture workflow outputs
- Support for accelerated transcoding in AWS Elemental MediaConvert: <https://aws.amazon.com/about-aws/whats-new/2019/10/announcing-new-aws-elemental-mediaconvert-features-for-accelerated-transcoding-dash-and-avc-video-quality/>
- support for Glacier deep archive

### Changed

- Lambda functions runtime to latest available (Node.js 12)
- Build assets to include package-lock.json files
- Build and test commands to use _npm ci_ instead of _npm install_
- Cloudformation template to use _AWS::Partition_ instead of _aws_
- Logic to add MediaPackage VOD as a custom origin to CloudFront (it's now done as a custom resource when the stack is created / updated)

### Fixed

- Links in README file
- fix to buildUrl function in output-validate lambda to support non root objects <https://github.com/awslabs/video-on-demand-on-aws/issues/61>
- fix mediainfo lambda function signing method error <https://github.com/awslabs/video-on-demand-on-aws/issues/670>

### Removed

- _'use strict'_ directives

## [5.0.0] - 2019-11-20

### Added

- MediaPackage VOD support
- Rotation support <https://github.com/awslabs/video-on-demand-on-aws/pull/27>

### Changed

- License to Apache-2.0
- Time properties in notification event (startTime and endTime) to use ISO 8601 formatting
- README to use correct casing for metadata sample
- Always use QVBR (Quality-Defined Variable Bitrate Control)
- DynamoDB table to use on-demand billing option
- Each function in the workflow to have its own role

### Fixed

- Typo in notification event property name (ecodeJobId -> encodeJobId)
- Links to issues in the CONTRIBUTING file
- Anonymized metrics helper to remove ServiceToken (which includes Lambda ARN) from sent data
- Suffix for supported format (mv4 -> m4v)
- Custom resource to handle WorkflowTrigger parameter update

### Removed

- References to unused workflowTrigger (Api)

## [4.3.0] - 2019-11-20

### Added

- CHANGELOG file

### Changed

- Lambda functions (except for mediainfo) runtime to nodejs10.x
- Mediainfo lambda function to python3.7
- Mediainfo executable version (from v0.7.92.1 to v19.09)
