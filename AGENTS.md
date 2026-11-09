# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

## What this is

Guidance for Video on Demand on AWS (SO9674), v7.0.0: a serverless ingest, transcode and publish
workflow. Source video lands in S3, is probed and transcoded to static **CMAF (HLS + DASH)** by AWS
Elemental MediaConvert, written back to S3 and served through Amazon CloudFront (OAC). It is deployed
with AWS CDK (`cdk deploy` is the canonical path; there are no CloudFormation parameters).

Orchestration is **four** AWS Step Functions state machines wired with **native service
integrations**. The core stack synthesizes **0 `AWS::Lambda::Function` resources**.

## Architecture

A parent **Orchestrator** state machine is the single per-asset execution and source of truth. It runs
three stage machines (Ingest, Process, Publish) as `states:startExecution.sync:2` child executions. Each
machine is an ASL template in `source/core/lib/state-machines/{orchestrator,ingest,process,publish}.asl.json`.

0. **Orchestrator** (`{stack}-orchestrator`): S3 → EventBridge → `StartExecution`. Derives a
   **deterministic `guid`** (`States.Hash(key + S3 versionId, 'SHA-256')`, a 64-char hex string) and
   creates the DynamoDB item with a **conditional `PutItem`** (`attribute_not_exists(guid)`), so a
   duplicate S3 event short-circuits to a benign `Duplicate Skipped` `Succeed`. `Load Job Config`
   assembles per-asset config and feature toggles into `$.config`, which stages read. A single `Catch`
   on each child routes to one `Record Failure` (`workflowStatus="Error"` + `errorStage` +
   `errorMessage`) and one `Notify Failure` SNS publish.
1. **Ingest**: validate metadata (ASL `Choice`, fail fast) → `mediaconvert:probe` (reads the video
   track height) → record the probe on the item → optional SNS ingest notification.
2. **Process**: `Choice` on probed height selects the `sd` | `hd` | `uhd` job template →
   `mediaconvert:createJob.sync` (one CMAF HLS + DASH output group, Automated ABR, QVBR; `Retry` with
   backoff on `MediaConvert.TooManyRequestsException`) → record outputs and playback URLs.
3. **Publish**: validate output → tag the source for archive (S3 object tagging + lifecycle rule) →
   record completion → optional SNS / SQS (best effort: a notification failure does not flip a
   Complete asset).

Stage machines end failures in a `Fail` state that propagates to the Orchestrator's `Catch`. Workflow
state lives in a DynamoDB table keyed by `guid` (GSI `srcBucket-startTime-index`); `workflowStatus`
moves `Ingest → Encoding → Complete`, or `Error`.

Behavior is configured entirely through **CDK context**, validated at synth time in
`source/core/lib/context.ts` (bad input throws, so `cdk synth` fails fast). `email` is required. See the
[Configuration](README.md#configuration) section of the README for the full key table.

### Opt-in overlays

Optional capabilities ship as **in-memory overlays**: `asl.ts` rewrites the ASL and job settings at
synth time (files on disk are never edited) and the synthesized default template stays
**byte-identical** when an overlay is OFF. 0-Lambda and the cdk-nag zero gate hold in every state.

| Context key | Default | What it adds |
|---|---|---|
| `packagingProfile` | `OFF` | Two-job REMUX_ALL packaging: per-tier TS-HLS ladder (job1) → HLS/TS + CMAF-HLS + DASH (job2), all clear |
| `adMarkersProfile` | `OFF` | SCTE-35 ad markers from a per-asset `<source>.esam.xml` ESAM sidecar |
| `captionsProfile` | `OFF` | WebVTT/IMSC captions from a per-asset `<source>.vtt` sidecar |
| `perFrameMetrics` | `OFF` | MediaConvert per-frame VMAF / QVBR / SHOT_CHANGE CSV reports |
| `thumbnailsProfile` | **`ON`** | FRAME_CAPTURE poster + thumbnails (the one overlay that defaults on) |

Captions and ad markers share one JSONata `$lookup` over synth-time Settings variants on the same
Encode / Package DRM Task, so stacking overlays never clones states.

### Extensions

Capabilities maintained outside this repository plug in through the **extension seam**
(`source/core/lib/extensions.ts`): each `source/core/extensions/<name>/index.ts` exports a `CoreExtension`
that parses its own context keys and contributes optional hooks (job settings, Process/Orchestrator ASL,
Storage/MediaConvert/Workflow constructs, outputs and SSM params), run where the core overlays run. An
installed extension is enabled only when listed in `vodExtensions` (`.env` `VOD_EXTENSIONS`, resolved by
`resolveExtensions` in `source/contract`); the CMS reports the enabled ids on `GET /config` and its UI loads
only those. With none enabled (this repository) the stack is the core distribution; the CMS has the same seam
(`source/cms/backend/lib/extensions.ts`, the assets Lambda's `extensions/*.mjs`, and
`source/cms/frontend/src/lib/extensions.ts`). Keep core code free of extension-specific logic: add a
neutral hook instead.

### Companion stacks

- **Operator CMS** (`source/cms`): a separate, Cognito-authenticated CDK app (backend API + React
  frontend). It consumes the core stack only through its `/${stackName}/` SSM
  parameters and DynamoDB table, and carries its own cdk-nag posture.
- **Companion modules** are separate stacks under `source/modules` (its own npm workspaces root; see
  `source/modules/AGENTS.md`). The streaming-media WAF (`source/modules/waf`) ships here; MediaTailor SSAI
  is available separately. The core stack reads them only at deploy time: `wafWebAclArn` takes any CLOUDFRONT-scope
  WebACL ARN, and the CMS tolerantly reads an
  optional `SsaiHlsManifestEndpointPrefix`. Scripts skip their module steps when
  `source/modules/<name>` is absent, so a tree without them builds, tests and deploys unchanged.

Companion stacks discover the core stack through SSM Parameter Store params named
`/${vodStackName}/<Key>`. The keys are defined once in `source/contract` (`SsmKey`,
`ssmParameterName`); producers and consumers import them rather than repeating string literals.

## Layout

npm workspaces (root `package.json`, one root `package-lock.json`). The CDK library version is pinned
repo-wide through the root `overrides`.

- `source/contract` (`@vod/contract`): the cross-stack contract (SSM discovery keys) and the shared
  context `.env` fallback (`withEnvFallback`). Built to `dist/` on install.
- `source/core/bin/vod.ts`: entry point; validates context, instantiates the core stack (the only stack in
  this app), applies cdk-nag `AwsSolutionsChecks`.
- `source/core/lib/vod-stack.ts`: the core stack; wires the constructs, outputs and SSM params.
- `source/core/lib/context.ts`: pure-TS context parser + validator; exports `VodContext`.
- `source/core/lib/asl.ts`: ASL loader and the compose pipeline (`composeProcessAsl`,
  `composeOrchestratorAsl`) that applies each overlay in a fixed order; `job-settings.ts` builds the
  per-profile MediaConvert `Settings`.
- `source/core/lib/extensions.ts`: the extension seam (discovery + hook types).
- `source/core/lib/overlays/`: one module per overlay (`packaging`, `ad-markers`, `captions`,
  `metrics`, `thumbnails`), the shared JSONata variant engine (`variants`, `jsonata`) and `types`.
- `source/core/lib/constructs/`: `storage`, `notifications`, `delivery`, `media`, `workflow`
  constructs; `interfaces.ts` holds shared prop types.
- `source/core/lib/state-machines/*.asl.json`, `source/core/lib/job-templates/*.json`: raw definitions,
  read at synth with `fs.readFileSync`.
- `source/cms/{backend,frontend}`: the operator CMS companion app.
- `deployment/`: `build-s3-dist.sh`, `run-unit-tests.sh`, and the deploy helper scripts.
- `scripts/synth-matrix.sh`: synthesizes every stack across a fixed context matrix; diff two runs to
  prove a refactor is byte-identical.

## Commands

Runtime: **Node.js 22+** (`.nvmrc`).

```bash
npm ci                                                            # install every workspace (repo root)
npm run build && npm test                                         # build + test every workspace
cd deployment && ./run-unit-tests.sh                              # contract + core tests with coverage

npm test -w @vod/core                                             # one workspace
cd source/core && npm run cdk -- synth -c email=you@example.com    # synth + cdk-nag (fails on findings)
cd source/core && npm run cdk -- deploy -c email=you@example.com   # deploy the core stack
cd source/core && npx jest context.test.ts                         # one file
cd source/core && npx jest -t "0 Lambda functions"                 # one test

scripts/synth-matrix.sh source/core /tmp/before                    # template matrix for refactor diffs
```

Deploy-time params for every app live in the repo-root `.env` (copy `.env.example`; UPPER_SNAKE keys,
git-ignored), located by `deployEnvPath()` in `source/contract`. `-c key=value` overrides `.env`;
`VOD_ENV_FILE=<path>` selects another file (`none` = no file).

## Tests

Each workspace has its own tests (`source/{contract,core}/test`, `source/cms/backend/test`, vitest in
`source/cms/frontend`). `source/core/test/*.test.ts` assert against the synthesized template with `aws-cdk-lib/assertions`
(no whole-stack snapshot). Invariants that must keep passing:

- `AWS::Lambda::Function` count is 0 in the core stack.
- Four state machines exist, with logging + X-Ray; orchestrator wiring and the single `Record Failure`
  path (`orchestrator.test.ts`).
- Least-privilege IAM shape and the substitution / splice wiring.
- cdk-nag reports zero unsuppressed findings (only documented, reasoned suppressions).

## Conventions

- TypeScript `strict: true`. Raw ASL state machines get **no auto-generated IAM**: every action
  (EventBridge managed rules, `Describe`/`StopExecution` for `.sync`, the `iam:PassRole` condition,
  tag-scoped `GetJob`/`CancelJob`) is hand-authored in the construct roles.
- CMAF-only default: do not add MP4 / DRM / SSAI / SCTE-35 / ML config surface or output groups to the
  default stack. New capabilities ship as opt-in overlays, extensions or companion stacks that leave the
  default template byte-identical when OFF.
- Never put secrets in source, context or state-machine definitions; resolve them at deploy time with
  `{{resolve:secretsmanager:...}}`.
- Source files carry the Apache-2.0 license header; keep it on new files.
- Versions live in `solution-manifest.yaml` and each `package.json`. `CHANGELOG.md` follows Keep a
  Changelog + SemVer.
