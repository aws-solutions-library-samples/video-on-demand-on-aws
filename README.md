<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Guidance for Video on Demand on AWS (v7.0.0)

A serverless, file-based **video-on-demand (VOD)** workflow. Drop a source video into an Amazon S3
bucket; it is probed, transcoded to adaptive **CMAF (HLS + DASH)** by AWS Elemental MediaConvert,
written back to S3 and served over Amazon CloudFront. Workflow state and playback URLs are recorded in
Amazon DynamoDB and optionally pushed to Amazon SNS and Amazon SQS.

Solution ID: **SO9674**. v7.0.0 is a clean-break rewrite of the v6 design: orchestration is AWS Step
Functions with native service integrations, and the core stack deploys **zero AWS Lambda functions**.

> **Important:** This is sample code, for non-production usage. You should work with your security and
> legal teams to meet your organizational security, regulatory and compliance requirements before
> deployment.

## On this page

- [Features](#features)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Deploy](#deploy)
- [Deployment validation](#deployment-validation)
- [Configuration](#configuration)
- [MediaConvert job templates](#mediaconvert-job-templates)
- [Quickstart: your first transcode](#quickstart-your-first-transcode)
- [Cost](#cost)
- [Quotas and limits](#quotas-and-limits)
- [Next steps](#next-steps)
- [Uninstall](#uninstall)
- [Known limitations](#known-limitations)
- [Security](#security)
- [Revisions](#revisions)
- [Contributing and license](#contributing-and-license)
- [Notices](#notices)

## Features

**Core stack** (always deployed, 0 Lambda functions):

- **S3 drop-in ingest.** Uploading a source video triggers the workflow through EventBridge; there is no
  API to call.
- **Idempotent ingestion.** A duplicate S3 event for the same object version is skipped. 
- **Adaptive CMAF (HLS + DASH).** One MediaConvert job with Automated ABR and QVBR, single-file CMAF
  renditions with byte-range manifests. The `sd` / `hd` / `uhd` template is chosen by probed height.
- **Optional packaging job.** With `packagingProfile=ON`, the tier encode writes a TS-HLS ladder and a
  second MediaConvert job repackages every rendition into HLS/TS, CMAF-HLS and DASH with no re-encode
  (REMUX_ALL passthrough). **REMUX_ALL currently requires your AWS account to be allow-listed: request
  it through AWS Support before enabling packaging.**
- **CloudFront delivery** from a private S3 origin through Origin Access Control, with optional
  geo-restriction and WAF association.
- **Workflow state** per asset in DynamoDB, optional SNS notifications and SQS result delivery,
  optional source archiving to Glacier / Deep Archive.
- **Observability.** Execution logging + X-Ray on all four state machines, failure alarms, a dashboard
  and an EventBridge DLQ.

**Opt-in modules and companion stacks.** Modules are context keys on the core stack: they rewrite its
state machines and job settings at synth time and leave the default template byte-identical when off.
Companion stacks are separate stacks that discover the core stack through SSM parameters.

**Enable with** is the setting that turns a feature on. For a module it is a core-stack context key: set
it in `.env` as `UPPER_SNAKE_CASE` (`packagingProfile=ON` is `PACKAGING_PROFILE=ON`), or pass
`-c packagingProfile=ON`. For a companion stack it is the `.env` setting that makes
`scripts/deploy-wizard.sh` deploy that stack; `scripts/configure.sh` asks for each one, and each stack
also has its own deploy script.

| Feature | Enable with | Kind | More |
|---|---|---|---|
| Multi-format packaging (HLS/TS + CMAF-HLS + DASH from one REMUX_ALL job) | `packagingProfile=ON` | module | [config](#configuration) |
| SCTE-35 ad markers from an ESAM sidecar | `adMarkersProfile=ON` | module | [sample](samples/ad-markers/README.md) |
| WebVTT / IMSC captions from a `.vtt` sidecar | `captionsProfile=ON` | module | [sample](samples/captions/README.md) |
| Per-frame quality metrics (VMAF, QVBR, SHOT_CHANGE) | `perFrameMetrics=ON` | module | [config](#configuration) |
| Poster + thumbnails (**on by default**) | `thumbnailsProfile` | module | [config](#configuration) |
| Operator web app: catalog, upload, players, metrics, re-drive | `DEPLOY_CMS=true` (or run `source/cms/scripts/deploy-all.sh`) | companion stack | [CMS](source/cms/README.md) |
| CloudFront WAF allow-list (countries, IPv4 ranges) | `WAF_ALLOWED_COUNTRIES` and/or `WAF_ALLOWED_IPS` (or run `source/modules/waf/deploy.sh`) | companion stack | [WAF](source/modules/waf/README.md) |

The **CloudFront WAF allow-list** ([`source/modules/waf`](source/modules/waf/README.md)) is a us-east-1
WebACL that blocks by default and allows only listed viewer countries and/or IPv4 ranges. The guided
scripts deploy it before the core stack and attach it for you. To use a WebACL you already have instead,
pass its ARN as `wafWebAclArn`. MediaTailor server-side ad insertion is a companion stack available
separately. The core stack and the CMS also load optional extensions from `source/core/extensions/` and
`source/cms/…/extensions/` when present (none ship in this repository).

## Architecture

![Video on Demand on AWS (SO9674) v7.0.0 architecture: S3 drop-in ingest triggers a parent Step Functions Orchestrator that runs Ingest, Process, and Publish stages using native MediaConvert, DynamoDB, SNS, and SQS integrations, writing CMAF output to S3 for CloudFront (OAC) delivery.](assets/architecture.jpg)

1. A source video is uploaded to the source Amazon S3 bucket.
2. The new object emits an Amazon EventBridge event that starts the AWS Step Functions **Orchestrator**
   state machine, which derives a deterministic asset `guid` and creates the asset's DynamoDB item.
3. The **Ingest** state machine validates the request, probes the source with AWS Elemental MediaConvert
   and records the probe results in Amazon DynamoDB.
4. The **Process** state machine chooses the `sd`, `hd` or `uhd` tier from the probed video height.
5. A MediaConvert job transcodes an adaptive bitrate ladder with Automated ABR and QVBR (plus optional
   SCTE-35 ad markers from an ESAM sidecar and captions from a WebVTT sidecar).
6. With `packagingProfile=ON`, a second MediaConvert job repackages the ladder into HLS/TS, CMAF-HLS and
   DASH without re-encoding. Otherwise the step 5 job writes CMAF (HLS + DASH) directly.
7. Content encryption and DRM through SPEKE v2 (shown dashed) are **not included** in this repository; see
   [Known limitations](#known-limitations).
8. The **Publish** state machine validates the outputs, optionally tags the source for archive to
   S3 Glacier or Glacier Deep Archive, records the playback URLs in DynamoDB and sends the result to
   Amazon SNS (and optionally Amazon SQS). Amazon CloudWatch holds the execution logs, failure alarms and
   a dashboard.
9. MediaConvert writes every output to the destination S3 bucket, the CloudFront origin.
10. Amazon CloudFront delivers the streams to video players through Origin Access Control.

A parent **Orchestrator** state machine runs three stage machines (Ingest → Process → Publish) as
`states:startExecution.sync:2` child executions, so there is one execution ARN per asset and a single
failure path. Each of the four machines is an ASL template in `source/core/lib/state-machines/`. `workflowStatus` on the
DynamoDB item moves `Ingest → Encoding → Complete`, or `Error` (with `errorStage` / `errorMessage`).

## Repository layout

npm workspaces with a single root `package-lock.json`:

```
source/
  contract/          @vod/contract: SSM discovery keys + shared context helpers (used by every app)
  core/              @vod/core: the core VideoOnDemand stack (required)
  cms/
    backend/         operator web app stack (Cognito, API, hosting)
    frontend/        operator web app (React, Vite, Cloudscape)
  modules/
    waf/             CloudFront WAF allow-list stack (us-east-1; own workspaces root)
deployment/          deploy.sh, build-s3-dist.sh, run-unit-tests.sh
scripts/             configure.sh + deploy-wizard.sh (guided setup), synth-matrix.sh (template diffs)
assets/              architecture diagram
samples/             sidecar examples (ESAM, WebVTT)
.env.example         the one deploy-config template for every stack
```

## Prerequisites

- **Operating system:** macOS or Linux (the scripts are Bash). On Windows, use
  [WSL](https://learn.microsoft.com/windows/wsl/).
- **AWS account permissions** to create Amazon S3, Amazon CloudFront, AWS Step Functions, AWS Elemental
  MediaConvert, Amazon DynamoDB, Amazon SNS, Amazon SQS, Amazon EventBridge, Amazon CloudWatch (logs,
  alarms, dashboards), AWS X-Ray, AWS Systems Manager Parameter Store and IAM resources, and to assume the
  CDK bootstrap roles (`cdk-hnb659fds-*`). The CMS also creates Amazon Cognito, Amazon API Gateway and
  AWS Lambda resources; the WAF allow-list creates AWS WAF resources in us-east-1.
- **Node.js 22+** (`.nvmrc`), and network access for the first `npm ci`.
- **AWS CLI v2**, configured for the target account and Region.
- For the guided scripts: Bash, plus [FFmpeg](https://ffmpeg.org/) and `python3` (preinstalled on macOS
  and most Linux) for the optional smoke test.
- **Supported Regions:** any Region where AWS Elemental MediaConvert is available (see the
  [MediaConvert endpoints](https://docs.aws.amazon.com/general/latest/gr/mediaconvert.html)). The
  Guidance is single-Region (CloudFront is global). **us-east-1**, **us-west-2** and **eu-west-1** have the
  higher default on-demand queue concurrency (200 vs 100).
- CDK bootstrapped once per account/Region: `npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>`, plus
  us-east-1 if you use the WAF allow-list (the deploy wizard checks both and offers to do it).

## Deploy

All inputs are **CDK context**, validated at synth time, and live in one repo-root `.env` (template:
[`.env.example`](.env.example)) that every stack and script reads; `-c key=value` overrides it. Full
reference: [Configuration](#configuration).

```bash
git clone https://github.com/aws-solutions-library-samples/video-on-demand-on-aws.git
cd video-on-demand-on-aws
```

### Option A: guided (recommended for a first deploy)

```bash
scripts/configure.sh       # answer prompts -> writes .env, then offers to start the deploy wizard
```

Two scripts split the work: `configure.sh` saves your settings to `.env`, and `deploy-wizard.sh` deploys
them. You only start one; it hands off to the other.

| To... | Run |
|---|---|
| Deploy for the first time | `scripts/configure.sh`, then choose **deploy** at the end |
| Change settings and redeploy | `scripts/configure.sh` again (Enter keeps each saved value) |
| Redeploy without changing settings | `scripts/deploy-wizard.sh` |

If you run `deploy-wizard.sh` before any config exists, it starts `configure.sh` for you.

**`scripts/configure.sh`** writes the config in five stages: Basics, Notifications and storage, Delivery,
Overlays, then Review. It first checks that the AWS CLI has working credentials (and explains how to
sign in, and which permissions a deploy needs, if not). It then asks for the notification email, stack
name and Region, whether to also deploy the operator web app (CMS), the notification and storage
options, the CloudFront price class, who can watch, upload CORS origins, and which modules to turn on.

"Who can watch" is one choice, so countries are asked once:

| Choice | Asks for | Result |
|---|---|---|
| Anyone (default) | nothing | public playback |
| Listed countries | countries | CloudFront geo restriction (`GEO_RESTRICTION`), no extra stack |
| WAF allow-list | countries and/or IPv4 CIDRs (suggests your current IP) | `WAF_ALLOWED_COUNTRIES` / `WAF_ALLOWED_IPS`; the deploy wizard deploys the WAF stack |
| Existing WebACL | its ARN, then optional geo restriction | `WAF_WEB_ACL_ARN` |

An installed extension with its own stages also asks for its settings. Every prompt shows the saved
value or the default, and Enter keeps it; fixed choices are arrow-key menus (numbered when not on a terminal, or with `VOD_WIZARD_PLAIN=1`).
Settings are edited in place in `.env`, so a re-run that only presses Enter changes nothing; type `-` to
clear an optional value. It ends with a review of the effective config and what changed, then offers to
start `scripts/deploy-wizard.sh` (the default), print the individual deploy commands, or exit.

**`scripts/deploy-wizard.sh`** does the deploy. It reads `.env` and asks only deploy-time questions (the
Region if `.env` has none, whether to include the CMS, the CMS environment and, on the first CMS deploy,
the operator username). It walks through its stages, confirming before each deploy:

1. **Preflight:** runs `configure.sh` if `.env` has no `EMAIL`, shows the target account, Region and
   stack name for you to confirm, checks the CDK bootstrap (and us-east-1 for the WAF), installs and
   builds the core packages.
2. **Plan:** confirms whether to include the CMS (defaulting to your `configure.sh` answer), lists the
   deploy order, and offers a `cdk diff` if the core stack already exists.
3. **WAF allow-list** (`<stack>-waf` in us-east-1), when `WAF_ALLOWED_COUNTRIES` or `WAF_ALLOWED_IPS` is
   set, plus any installed extension's stacks; otherwise skipped. It saves the WebACL ARN as
   `WAF_WEB_ACL_ARN`, so this and every later core deploy attach it.
4. **Core stack** (about 5 minutes on a first deploy, including CloudFront updating globally). A first
   deploy reminds you to confirm the SNS subscription email.
5. **SSAI companion stack**, when installed and selected; otherwise skipped.
6. **CMS** (`<stack>-cms`), if selected: asks for the CMS environment (`prod` retains the user pool and
   requires MFA; `dev` deletes everything with the stack) and deploys it. On the first deploy it creates
   an operator user (Cognito emails you a temporary password); later deploys find that user and skip
   this. It then adds the CMS origin to `UPLOAD_CORS_ORIGINS` and, if that changed, redeploys the core
   stack so browser uploads work.
7. **Smoke test** (optional): transcodes a colour-bar clip and opens the result in a web player.

If a step fails it shows the error and asks whether to stop or continue. Run it again after changing
`.env`; it redeploys only what's enabled.

### Option B: scripted (CI, or one stack at a time)

```bash
cp .env.example .env          # set EMAIL (required) and any module keys
deployment/deploy.sh          # npm ci (first run), build, cdk deploy of the core stack
```

`deployment/deploy.sh --dry-run` prints the command without deploying; `--email`, `--stack` and
`--region` override `.env`. The manual equivalent:

```bash
npm ci
cd source/core && npm run cdk -- deploy VideoOnDemand -c email=you@example.com
```

Companion stacks have their own scripts, which read the same `.env`:

```bash
source/modules/waf/deploy.sh --region <core-region>   # WAF allow-list in us-east-1, then the core stack with it
source/cms/scripts/deploy-all.sh vod-cms prod         # operator web app (see its README)
```

The WAF script needs `WAF_ALLOWED_COUNTRIES` and/or `WAF_ALLOWED_IPS` in `.env`; it prints the WebACL ARN
to save as `WAF_WEB_ACL_ARN` so later core deploys keep it attached. The CMS script passes
`PACKAGING_PROFILE` through, so with packaging on it also deploys the Lambda that copies per-frame quality
metrics out of the 1-day intermediate bucket.

### Outputs

Core stack outputs: `SourceBucket`, `DestinationBucket`, `CloudFrontDomainName`, `DynamoDBTable` and the
four state machine ARNs. The same values are published as `/<stackName>/…` SSM parameters, which the
companion stacks (and the Quickstart below) read. Confirm the SNS subscription email sent to your address
at deploy to receive workflow notifications.

## Deployment validation

After the deploy finishes (replace `VideoOnDemand` if you set `STACK_NAME`):

1. The stack status is `CREATE_COMPLETE` (or `UPDATE_COMPLETE`):

   ```bash
   aws cloudformation describe-stacks --stack-name VideoOnDemand --query "Stacks[0].StackStatus" --output text
   ```

2. The discovery parameters exist (`SourceBucket`, `DestinationBucket`, `CloudFrontDomainName`, ...):

   ```bash
   aws ssm get-parameters-by-path --path /VideoOnDemand/ --query "Parameters[].Name" --output table
   ```

3. Four state machines are listed (`VideoOnDemand-orchestrator` and the Ingest, Process and Publish
   stages):

   ```bash
   aws stepfunctions list-state-machines --query "stateMachines[?starts_with(name, 'VideoOnDemand')].name" --output table
   ```

4. You received the **AWS Notification - Subscription Confirmation** email and confirmed it.

Then run the [Quickstart](#quickstart-your-first-transcode) for an end-to-end check.

## Configuration

Every input is **CDK context**, validated at synth time in `source/core/lib/context.ts`, so a bad value
fails `cdk synth` / `cdk deploy` with an actionable message. There are no CloudFormation parameters.
Values come from an explicit `-c key=value` (or `cdk.json` context), else the matching `UPPER_SNAKE_CASE`
variable (`packagingProfile` → `PACKAGING_PROFILE`) in the repo-root `.env`. Set `VOD_ENV_FILE=<path>` to
use another file (for example `.env.prod`), or `VOD_ENV_FILE=none` to ignore `.env`. The CMS context
keys are in [its README](source/cms/README.md).

| Context key | Default | Purpose |
|---|---|---|
| `email` | **required** | Address subscribed to the SNS notifications topic (ingest / publish / error). |
| `stackName` | `VideoOnDemand` | CloudFormation stack name; also the prefix of the `/<stackName>/…` SSM parameters and the archive-lifecycle tag key. |
| `enableSns` | `true` | Send workflow success/failure notifications to SNS. |
| `enableSqs` | `false` | Also deliver the workflow result payload to an SQS queue. |
| `archiveSource` | `NONE` | Source-archive class, applied by tag + lifecycle rule: `NONE` \| `GLACIER` \| `DEEP_ARCHIVE`. |
| `priceClass` | `PriceClass_All` | CloudFront price class: `PriceClass_100` \| `PriceClass_200` \| `PriceClass_All`. |
| `geoRestriction` | (none) | CloudFront geo-restriction allow-list (ISO 3166-1 alpha-2 codes). |
| `wafWebAclArn` | (none) | AWS WAFv2 (CLOUDFRONT scope) web ACL ARN to associate with the distribution. |
| `domainName` | (none) | Custom domain for the distribution (for example `video.example.com`). Set with `certificateArn`; the distribution then enforces a `TLSv1.2_2021` minimum. Point a DNS CNAME (or Route 53 alias) at the CloudFront domain after deploy. |
| `certificateArn` | (none) | ACM certificate ARN in **us-east-1** covering `domainName`. Required with it. |
| `destinationRetentionDays` | (none) | Lifecycle expiry (days) on the output bucket; unset = keep indefinitely. |
| `uploadCorsOrigins` | (none) | CORS allow-list on the source bucket for browser uploads (comma-separated). `*` is a fine starting point; uploads still need a signed-in operator's Cognito credentials. Narrow it to the CMS CloudFront origin for production (the deploy wizard does this for you). |
| `vodExtensions` | (none) | Installed extensions to enable, comma-separated (`VOD_EXTENSIONS`); read by the core stack and the CMS. None ship in this repository. |
| `packagingProfile` | `OFF` | Two-job REMUX_ALL packaging: each tier (SD/HD/UHD by probed height) encodes a TS-HLS ladder, then one passthrough job repackages every rendition into HLS/TS, CMAF-HLS and DASH, with no re-encode. Requires the account to be allow-listed for REMUX_ALL (request through AWS Support). |
| `adMarkersProfile` | `OFF` | SCTE-35 ad-break markers from a per-asset `<source>.esam.xml` ESAM sidecar; a source without one encodes normally. See [`samples/ad-markers`](samples/ad-markers/README.md). |
| `captionsProfile` | `OFF` | WebVTT (HLS/CMAF) + IMSC (DASH) captions from a per-asset `<source>.vtt` sidecar; a source without one encodes normally. See [`samples/captions`](samples/captions/README.md). |
| `perFrameMetrics` | `OFF` | Per-output VMAF / QVBR / SHOT_CHANGE CSV reports from MediaConvert. Adds encode time and cost (VMAF up to ~2x on 4K). |
| `thumbnailsProfile` | `ON` | FRAME_CAPTURE poster + periodic thumbnails to `<guid>/thumbnails/`, with `posterUrl` on the item. Set `OFF` to opt out. |

Every module is native (no Lambda) and leaves the default template byte-identical when off. Modules
compose: for example captions and ad markers both apply with packaging on.

The **WAF allow-list** stack reads its own keys from the same `.env` (full reference in
[its README](source/modules/waf/README.md)):

| `.env` key | Default | Purpose |
|---|---|---|
| `WAF_ALLOWED_COUNTRIES` | (none) | Viewer countries the WebACL allows (ISO 3166-1 alpha-2). Separate from the core stack's `geoRestriction`. |
| `WAF_ALLOWED_IPS` | (none) | Source IPv4 CIDRs the WebACL allows, whatever the country. A request is allowed if either list matches; set at least one. |

## MediaConvert job templates

Encoding settings live as JSON in [`source/core/lib/job-templates/`](source/core/lib/job-templates/). They
are read at synth time and become the `Settings` of the MediaConvert `CreateJob` call in the Process state
machine (they are not deployed as MediaConvert job template resources). The Process stage picks a tier from
the probed source height:

| Tier | Source height | Template | Video codec | Automated ABR ladder |
|---|---|---|---|---|
| SD | below 720 | `sd.json` | H.264 High | up to 4 renditions, 400 kbps to 2.5 Mbps, up to 960x540 |
| HD | 720 to 1439 | `hd.json` | H.264 High | up to 6 renditions, 600 kbps to 6 Mbps, up to 1920x1080 |
| UHD | 1440 and above | `uhd.json` | HEVC (H.265) Main | up to 8 renditions, 800 kbps to 16 Mbps, up to 3840x2160 |

Every tier uses Automated ABR (MediaConvert chooses the rendition count, resolutions and bitrates within
these limits), QVBR rate control with multi-pass HQ, AAC-LC 128 kbps stereo audio, and one CMAF output
group (HLS + DASH, 6 s segments, 2 s fragments).

**UHD is a full HEVC ladder:** every UHD rendition, including the lowest, is HEVC, so a UHD asset plays only
on devices and players that decode HEVC (for example Safari and Apple devices, most smart TVs and
streaming devices; browser support elsewhere depends on the OS and hardware). HEVC is also billed at a
higher MediaConvert rate than H.264. If you need UHD assets to play everywhere, add H.264 renditions to
`uhd.json` or route UHD sources to the HD tier.

With `packagingProfile=ON` the `sd-ladder.json`, `hd-ladder.json` and `uhd-ladder.json` templates are
used instead (the same ladders written as TS-HLS), and `package-drm.json` repackages them with no
re-encode. Keep each tier and its `-ladder` twin in step when you change one.

> **UHD with packaging on:** validate UHD playback on your target devices before enabling packaging for UHD.

**These templates are a starting point.** They target general-purpose web and device playback, not a
specific catalog or audience. Codec, ladder shape, bitrate ceilings, quality level, GOP and segment
lengths, audio layout and captions are all business decisions that depend on your content, your viewers'
devices and networks, and your cost targets. Tune them before production: edit the JSON, run the unit tests
(`npm test -w @vod/core`), redeploy, and compare output on your own content (`perFrameMetrics=ON` adds
VMAF reports to help). Your AWS account team and AWS Elemental Media Services specialists can help you
tailor the encoding parameters to your business requirements.

## Quickstart: your first transcode

`scripts/deploy-wizard.sh` can run this for you as its last stage. To do it by hand, after the core
stack is deployed (needs [FFmpeg](https://ffmpeg.org/) and the AWS CLI pointed
at the deployment Region):

```bash
STACK=VideoOnDemand   # or your STACK_NAME
param() { aws ssm get-parameter --name "/$STACK/$1" --query Parameter.Value --output text; }
SRC_BUCKET=$(param SourceBucket); ORCH_SM=$(param OrchestratorStateMachineArn); TABLE=$(param DynamoDBTable)

# 1. Make a 30 s synthetic colour-bar clip (no licensing questions)
ffmpeg -f lavfi -i "smptehdbars=size=1920x1080:rate=25:duration=30" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=30" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest sample.mp4

# 2. Upload it to the source bucket: any object except a sidecar (*.esam.xml, *.json, *.vtt) starts a run
aws s3 cp sample.mp4 "s3://$SRC_BUCKET/sample.mp4"

# 3. Watch the Orchestrator (one execution per asset; a 30 s clip takes a few minutes)
aws stepfunctions list-executions --state-machine-arn "$ORCH_SM" --max-results 5 \
  --query "executions[].{name:name,status:status}" --output table

# 4. When workflowStatus is Complete, read the playback URLs
aws dynamodb scan --table-name "$TABLE" --filter-expression "srcVideo = :k" \
  --expression-attribute-values '{":k":{"S":"sample.mp4"}}' \
  --query "Items[].{status:workflowStatus.S,hls:hlsUrl.S,dash:dashUrl.S}" --output table
```

Playback URLs are `https://<CloudFrontDomainName>/<guid>/index.m3u8` (HLS) and `…/index.mpd` (DASH);
with `packagingProfile=ON` they are `…/<guid>/hls/index.m3u8` and `…/<guid>/dash/index.mpd`. Open them
in the [hls.js](https://hlsjs.video-dev.org/demo/) or [dash.js](https://reference.dashif.org/dash.js/)
demo players, Safari or VLC. The SNS topic also emails you the URLs once you confirm the subscription
email sent at deploy.

## Cost

You are responsible for the cost of the AWS services used. Everything is on-demand and pay-per-use, so
an idle stack costs little beyond stored bytes. The main drivers:

- **AWS Elemental MediaConvert**: billed per output minute; the rate depends on resolution and features.
  Usually the largest line item.
- **Amazon S3**: storage for source and outputs, plus requests. Output storage grows without bound
  unless you set `destinationRetentionDays`.
- **Amazon CloudFront**: data transfer out and requests; scales with playback.
- **DynamoDB, Step Functions (Standard), SNS, SQS, EventBridge**: small per-workflow charges.
- The CMS adds Cognito, API Gateway and Lambda charges; companion stacks add their own (for example
  WAF per WebACL and request, MediaTailor per ad-insertion session).

We recommend creating a [budget](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html)
through [AWS Cost Explorer](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/) to help manage
costs. Prices are subject to change; see each service's pricing page for full details.

### Sample cost table

The following table is a sample monthly cost breakdown for deploying the core stack with the default
settings in the US East (N. Virginia) Region (`us-east-1`), as of November 2026, excluding the Free Tier.

Assumptions:
- **Ingest:** 100 hours (6,000 minutes) per month of 1080p, 30 fps H.264 source, as 600 assets of 10 minutes
  each, averaging 10 Mbps.
- **Ladder:** the `hd` tier writes up to 6 Automated ABR renditions (up to 6 Mbps); we assume 4 HD and 2 SD,
  which is 10 normalized minutes per source minute. MediaConvert bills Automated ABR at the Professional
  tier, multi-pass HQ rate.
- **Delivery:** 5 TB per month from CloudFront to viewers in North America.
- **Excluded:** audio-only and thumbnail outputs, data transfer between services, and requests. S3 storage
  is the first month only; it grows each month you keep the outputs.

| AWS service | Dimensions | Cost [USD] |
|---|---|---|
| AWS Elemental MediaConvert | 60,000 normalized minutes at $0.012 (Professional tier, multi-pass HQ, AVC, <= 30 fps) | $720.00 |
| Amazon CloudFront | 5,120 GB data transfer out at $0.085/GB, about 2.3 million HTTPS requests | $437.00 |
| Amazon S3 | About 1.2 TB S3 Standard (450 GB source + 750 GB outputs) at $0.023/GB-month | $28.00 |
| Amazon CloudWatch | 1 dashboard, 4 alarms, execution logs | $5.00 |
| AWS Step Functions (Standard) | About 18,000 state transitions (about 30 per asset) at $0.025 per 1,000 | $0.45 |
| Amazon DynamoDB, Amazon SNS, Amazon SQS, Amazon EventBridge | On-demand table, about 1,200 notifications, S3 events | < $1.00 |
| **Total** | | **about $1,190 per month** |

MediaConvert and CloudFront dominate. To lower them, cap renditions in the job templates, choose a `priceClass` that
excludes the higher-cost edge Regions, and set `destinationRetentionDays` so outputs don't accumulate. Model your own workload with
the [AWS Pricing Calculator](https://calculator.aws/) and the
[MediaConvert pricing page](https://aws.amazon.com/mediaconvert/pricing/).

## Quotas and limits

AWS Elemental MediaConvert account limits, per Region:

- **On-demand queue concurrency:** 200 jobs in us-east-1, us-west-2 and eu-west-1; 100 elsewhere.
- **`CreateJob` rate:** 5 requests/second, burst of 100.

The Process stage submits one encode per execution and retries `MediaConvert.TooManyRequestsException`
with exponential backoff. For sustained high volume, raise the quotas in the
[Service Quotas console](https://console.aws.amazon.com/servicequotas/) or use a reserved queue. See the
[MediaConvert quotas reference](https://docs.aws.amazon.com/general/latest/gr/mediaconvert.html).

## Next steps

- **Operate it from a browser:** deploy the [operator web app (CMS)](source/cms/README.md) for upload,
  catalog, playback, quality metrics and re-drive.
- **Serve a custom domain** with a `TLSv1.2_2021` minimum: set `domainName` and `certificateArn`.
- **Restrict access:** choose "Who can watch" in `scripts/configure.sh` (CloudFront geo restriction, the
  WAF allow-list, or your own WebACL through `wafWebAclArn`), and add token-protected playback (see [Media delivery is public by default](#media-delivery-is-public-by-default)).
- **Turn on modules** for packaging, ad markers, captions or per-frame quality metrics (see
  [Configuration](#configuration)).
- **Integrate downstream systems** with `enableSqs=true`, or subscribe to the SNS topic.
- **Control storage costs** with `destinationRetentionDays` and `archiveSource`.

## Uninstall

Remove companion stacks first, then the core stack. Before deleting the WAF stack, detach its WebACL:
choose another "Who can watch" option in `scripts/configure.sh` (or clear `WAF_WEB_ACL_ARN`) and redeploy
the core stack. CloudFormation can't delete a WebACL that a distribution still uses.

```bash
cd source/cms/backend && npx cdk destroy <stackName>-cms -c vodStackName=<stackName>
cd source/modules/waf && npm run cdk -- destroy --all     # only if you deployed the WAF stack (us-east-1)
cd source/core && npm run cdk -- destroy VideoOnDemand
```

**Buckets are retained on purpose.** The source, destination and logging buckets use a `RETAIN` removal policy, so `cdk destroy` never deletes media; they keep incurring storage charges until you delete them.
For a demo deployment you can lose, empty and delete them (destructive, deletes all objects):

```bash
for B in <SourceBucket> <DestinationBucket> <LoggingBucket>; do
  aws s3 rm "s3://$B" --recursive && aws s3 rb "s3://$B"
done
```

If versioning is enabled, delete the remaining object versions first.

## Known limitations

- **No in-place upgrade from v6.** v7 deploys as a new stack with no automated data or asset migration:
  playback URLs change (single CMAF path), MediaPackage VOD is removed, and the DynamoDB schema differs,
  so don't point v7 at v6 data. Stand v7 up next to v6, re-ingest and validate playback, cut viewers
  over, then decommission v6 (its buckets are retained).
- **Captions in CMAF are WebVTT and IMSC only**; 608/708 passthrough and burn-in are not available in a
  CMAF output group.
- **Input contract:** any container and codec that
  [MediaConvert supports as input](https://docs.aws.amazon.com/mediaconvert/latest/ug/reference-codecs-containers-input.html).
  The workflow stops before encoding when MediaConvert can't probe the file (corrupt or unsupported
  container) or the file has no video track (for example audio-only): the asset is marked `Error`, with
  `errorStage` and `errorMessage` on its DynamoDB item, and the SNS failure notification is sent. Other
  sources are encoded as-is to 8-bit SDR, progressive (H.264 for SD and HD, HEVC Main for UHD): HDR or 10-bit sources are not tone-mapped and
  interlaced sources are not deinterlaced, so check their output or convert them before upload.
- **Single-Region** by design (CloudFront is global).
- **Not included:** progressive MP4, VMAP and DASH-manifest SSAI conditioning (SSAI is HLS/TS only),
  per-title encoding (the tier is chosen by probed height), content protection (DRM / encryption) and AI
  enrichment.

## Security

- **Private origin.** The S3 origin is reachable only through CloudFront (Origin Access Control).
- **Least-privilege IAM.** Every role is hand-authored and scoped to specific ARNs: MediaConvert
  `CreateJob` / `GetJob` / `CancelJob` are tag-scoped to `SolutionId=SO9674`, and `iam:PassRole` is
  constrained to `mediaconvert.amazonaws.com`. Service-role trust policies carry `aws:SourceAccount` /
  `aws:SourceArn` conditions against the confused-deputy problem.
- **Transport and storage.** CloudFront redirects to HTTPS and adds the managed CORS + security-headers
  policy (HSTS, `X-Content-Type-Options`); S3 and DynamoDB are encrypted at rest. CloudFront fixes the
  TLS policy of the default `*.cloudfront.net` domain at TLSv1, so for production set `domainName` +
  `certificateArn` to serve a custom domain with a `TLSv1.2_2021` minimum.
- **Secrets** resolve from Secrets Manager at deploy time (`{{resolve:secretsmanager:...}}`) and never
  appear in source, context or templates.
- **Gates.** cdk-nag (`AwsSolutionsChecks`) runs on every synth with zero unsuppressed findings; each
  suppression carries a reason in the code.

### Media delivery is public by default

Anyone with a playback URL can fetch the output: manifests, segments, thumbnails, posters and
quality-metrics reports. Asset paths are unguessable SHA-256 guids, but a shared URL works for anyone, and
CORS allows every origin so any web player can embed the stream. That suits public content. For premium,
licensed or embargoed content, add access control at the edge:

- **Token-protected playback.** [Secure Media Delivery at the Edge on AWS](https://docs.aws.amazon.com/solutions/secure-media-delivery-at-the-edge-on-aws/)
  adds per-viewer, expiring playback tokens validated at CloudFront, with session revocation. Put it in
  front of this stack's distribution for any content that should not be freely shareable.
- **AWS WAF.** The included WAF allow-list blocks by default and lets only listed countries and IPv4
  ranges through (see [Configuration](#configuration)). For rate limiting and managed rule groups,
  attach your own CLOUDFRONT-scope WebACL with `wafWebAclArn`. `geoRestriction` covers territorial
  licensing without a WAF.
- **Content protection.** DRM is not included (see [Known limitations](#known-limitations)).

### Your responsibilities

This guidance secures the resources it creates. The account it runs in is yours to secure. Before
production use, turn on:

- **AWS CloudTrail** (all Regions, log file validation) for an audit trail of API activity.
- **Amazon GuardDuty** and **AWS Security Hub** for threat detection and posture findings.
- **AWS Config** for configuration history and drift.
- An **incident response** process: who receives the SNS failure alerts, and how to contain a leaked
  playback URL or compromised operator account (disable the Cognito user, invalidate the CloudFront path).

The operator CMS has its own posture; see its [security notes](source/cms/README.md#security-notes).

To report a security issue, see [SECURITY.md](SECURITY.md).

## Revisions

See [CHANGELOG.md](CHANGELOG.md) for the release history (Keep a Changelog format, Semantic Versioning).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for build, test and design-guardrail details. Licensed under the
Apache License, Version 2.0; see [LICENSE.txt](LICENSE.txt).

## Notices

*Customers are responsible for making their own independent assessment of the information in this
Guidance. This Guidance: (a) is for informational purposes only, (b) represents AWS current product
offerings and practices, which are subject to change without notice, and (c) does not create any
commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services
are provided "as is" without warranties, representations, or conditions of any kind, whether express or
implied. AWS responsibilities and liabilities to its customers are controlled by AWS agreements, and this
Guidance is not part of, nor does it modify, any agreement between AWS and its customers.*

*This is sample code, for non-production usage. You should work with your security and legal teams to
meet your organizational security, regulatory and compliance requirements before deployment.*
