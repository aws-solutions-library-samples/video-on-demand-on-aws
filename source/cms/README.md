# VOD operator web app (`cms`)

A deployable, **Cognito-authenticated** operator web app for the
[video-on-demand-on-aws](../../README.md) pipeline. Operators browse the asset catalog, verify
playback, inspect quality metrics and ad breaks, choose a poster,
self-service upload new source media, and re-drive failed assets — all from the browser.

> **Optional companion stack — NOT the GA transcoding stack.** This app deploys separately from
> `source/core` and only *reads* the VOD stack's `/<stackName>/` SSM discovery params + DynamoDB job
> table (plus two narrowly-scoped writes; see below). Because it is a distinct app, its Lambda-backed
> API does **not** affect the GA stack's 0-Lambda / cdk-nag zero-findings invariants — this companion
> carries its own documented cdk-nag posture.

## What it does

- **Asset catalog + detail** — paginated, searchable list (newest first) and a per-asset detail page:
  status, source/output metadata, playback URLs, and a deep link to the Step Functions execution.
- **Integrated playback** — DASH, CMAF-HLS and HLS/TS players (`frontend/src/players/`). When the
  MediaTailor SSAI module (`source/modules/ssai`) is deployed, the HLS player also offers the **ad-stitched (SSAI) rendition** —
  the ad-insertion (ADS Lambda + creative delivery) lives in that module stack, not here; the CMS
  just plays the resulting manifest via the `SsaiHlsManifestEndpointPrefix` SSM param.
- **Quality metrics** — charts the per-frame VMAF/QVBR/SHOT_CHANGE reports (when the pipeline's
  `perFrameMetrics` overlay is on), fetched and parsed client-side.
- **Ad markers** — lists the SCTE-35 avails parsed from an asset's ESAM sidecar (when `adMarkersProfile`
  is on).
- **Poster selection** — browse the FRAME_CAPTURE scrub-bar thumbnails and pick any frame as the
  asset's poster, overriding the pipeline default (first frame).
- **Self-service upload** — Amplify Storage uploads directly to the VOD source bucket (per-user
  prefix), triggering the pipeline.
- **Controlled re-drive** — re-run a **failed** asset in place, behind a confirmation modal.

## Architecture

A **single stack** named `<vodStackName>-cms` (e.g. `VideoOnDemand-cms`) owns everything:

- **Cognito** — user pool (self sign-up off; operators are admin-created), app client, identity pool,
  and a per-user upload role scoped to `uploads/<cognito-sub>/*` on the VOD source bucket.
- **Authenticated read API** — API Gateway REST + a **Cognito User Pools authorizer** fronting one
  Lambda. Its role is least-privilege: `ssm:GetParameters` on `/<vodStackName>/*`, read-only DynamoDB
  on the VOD table + `/index/*`, `s3:ListBucket` (no GetObject) on the destination bucket, and the two
  scoped writes below.
- **Static hosting** — a private S3 site bucket served via CloudFront with Origin Access Control (OAC);
  SPA deep links rewrite 403/404 → `/index.html`.

### API routes

| Method + path | Purpose |
|---|---|
| `GET /config` | Region, VOD stack name, CloudFront domain, source bucket (UI bootstrap). |
| `GET /assets` | Paginated, searchable catalog (Query on the `srcBucket-startTime-index` GSI). |
| `GET /assets/{guid}` | Asset detail. |
| `GET /assets/{guid}/quality-metrics` | Manifest of per-frame metric files (CloudFront URLs). |
| `GET /assets/{guid}/abr-bitrates` | Measured per-rung video-only bitrate (CMAF `.cmfv` size ÷ probe duration). Reuses the destination-bucket `s3:ListBucket` grant; no new IAM. |
| `GET /assets/{guid}/thumbnails` | Manifest of scrub-bar thumbnail frames (CloudFront URLs). |
| `POST /assets/{guid}/redrive` | **Write.** Re-run a failed asset in place. |
| `POST /assets/{guid}/poster` | **Write.** Set the poster to a chosen thumbnail frame. |

**Write path 1 — re-drive** (Error-only): the handler refuses anything but `workflowStatus="Error"`,
HeadObjects the source for its current version-id, `DeleteItem`s the failed record (so the
Orchestrator's deterministic-`guid` conditional `PutItem` reprocesses instead of dedup-skipping), then
`StartExecution`s the Orchestrator. IAM: `dynamodb:DeleteItem` on the table, `s3:GetObject` +
`s3:ListBucket` on the source bucket (ListBucket so a missing source HEADs as a truthful 404 → clean
410, not 403), and `states:StartExecution` on the single Orchestrator ARN.

**Write path 2 — poster override**: validates the requested frame against a fixed filename pattern
(`frame.NNNNNNN.jpg`), reconstructs its CloudFront URL server-side (never trusts a client-supplied
URL), and `UpdateItem`s `posterUrl`. IAM: `dynamodb:UpdateItem` on the table (no S3 write — CloudFront
already serves the JPEG).

## Layout

| Path | What it is |
|------|-----------|
| `backend/` | CDK app: `bin/cms.ts`, `lib/cms-stack.ts` (the single stack), `lambda/assets/index.mjs` (the API), `lambda/quality-metrics-processor/` (packaging-mode metrics rescue) |
| `frontend/` | Vite + React + Cloudscape SPA: `src/pages/` (asset list/detail), `src/players/` (players), `src/components/`, `src/lib/api.ts` (authed fetch), Amplify auth (`src/App.tsx`, `src/aws-exports.ts`) |
| `scripts/` | `deploy-all.sh` |

## Extensions

Optional features plug in without changing the base app. An installed extension (its directories below) is
enabled only when its name is listed in the repo-root `.env` `VOD_EXTENSIONS` (comma-separated, shared with the
core stack; `scripts/configure.sh` asks):

| Seam | Where | What it can add |
|------|-------|-----------------|
| CDK | `backend/extensions/<name>/index.ts` (see `backend/lib/extensions.ts`) | Its own context keys, API Lambda env + grants, extra resources, `/assets/{guid}/…` routes |
| API | `backend/lambda/assets/extensions/<name>.mjs` (see the header of `lambda/assets/index.mjs`) | `/config` fields, asset list/detail fields, search text, list filters, route handlers |
| UI | `frontend/src/extensions/<name>/index.ts(x)` (see `frontend/src/lib/extensions.ts`) | Routes, Labs navigation links, a replacement asset player |
| Deploy | `backend/extensions/<name>/deploy-context.sh` | Deploy-time context for `scripts/deploy-all.sh`, from the shared `.env` |

`deploy-all.sh` passes the list to the stack, which sets `CMS_EXTENSIONS` on the API Lambda (it loads only those
`.mjs` hooks) and reports the same ids on `GET /config` as `extensions`. The UI lazily loads only those
extensions after sign-in, so a module's pages, links and player options appear exactly when its API is deployed.
A listed name that isn't installed, or an unlisted extension's own context key, fails `cdk synth`. With none
enabled the app is exactly the base console described above.

## Prerequisites

- Node.js 22+, AWS CLI v2, CDK bootstrapped in the target account/region (`npx cdk bootstrap`).
- The VOD stack already deployed in the **same account/region** (it publishes the `/<vodStackName>/`
  SSM params this app reads).

## Deploy

```bash
npm ci   # at the repo root: one install for every npm workspace (deploy-all.sh also runs it if needed)

# Deploys the <vodStackName>-cms stack, writes frontend/.env from its outputs, then builds and
# publishes the SPA (s3 sync + CloudFront invalidation). Prints the CMS URL at the end.
# args: appName environment region vodStackName
scripts/deploy-all.sh vod-cms dev us-east-1 VideoOnDemand

# Create an operator (self sign-up is off):
aws cognito-idp admin-create-user --user-pool-id <UserPoolId-from-output> --username alice \
  --user-attributes Name=email,Value=alice@example.com Name=email_verified,Value=true

# Open https://<DistributionDomainName-from-output> and sign in.
# Local dev against the deployed API:
( cd frontend && npm run dev )   # http://localhost:5174
```

**Self-service upload** needs a CORS rule on the VOD **source** bucket for the CMS origin, because the
browser uploads directly to it. After the first deploy prints the CloudFront domain, set it on the core
stack and redeploy:

```bash
# add to the repo-root .env, then redeploy the core stack
UPLOAD_CORS_ORIGINS=https://<cms-domain>.cloudfront.net,http://localhost:5174
deployment/deploy.sh
```

Without this, uploads fail in the browser with `ERR_NETWORK` (a blocked CORS preflight).

## Adaptive bitrate ladder: reported vs measured

The asset-detail ladder shows two bitrate
columns per rung: **Reported** (the encoder's `AVERAGE-BANDWIDTH` / `BANDWIDTH`, parsed client-side
from the HLS master) and **Measured (video)** — the *actual* video-only bitrate the API computes
server-side (`GET /assets/{guid}/abr-bitrates`) from the delivered CMAF `.cmfv` object size ÷ source
duration (no media download; sizes come from an `s3:ListBucket` on the destination bucket, duration
from the item's `probe`). Reported `AVERAGE-BANDWIDTH` overstates the true per-rung video bitrate
because it folds in the ~128 kbps audio group — negligible at the top rung, but material at the
bottom (measured live at +5% on 1080p rising to +27% on 360p). The measured value comes from CMAF
because CMAF fMP4 is the lowest-overhead container: measuring the MPEG-TS rendition instead would add
a further +3–7% packetization overhead. **CMAF is always present to measure, in both modes:**
`packagingProfile=OFF` (GA) is a single CMAF-HLS + DASH job whose `.cmfv` files sit at `<guid>/`, and
`packagingProfile=ON` (REMUX_ALL) produces them at `<guid>/cmaf/` (job2's passthrough repackage of the
job1 TS-HLS ladder — a lossless remux, so the CMAF carries job1's identical video essence). The API
picks the right prefix automatically; a rung with no matching `.cmfv` (or missing duration) simply
shows `-` in the Measured column and the ladder falls back to reported-only.

## Security notes

- No AWS credentials in the browser; all AWS access is server-side in the Lambda, gated by the Cognito
  authorizer. The Lambda role is least-privilege (see the API routes table above).
- **Sign-in** is Cognito SRP only (`USER_PASSWORD_AUTH` is off). MFA (TOTP) defaults to `REQUIRED` when
  `environment=prod` (the deploy wizard's default) and `OFF` otherwise, including a bare
  `scripts/deploy-all.sh` run, which defaults to `dev`. Pass `-c cmsMfa=REQUIRED` (or deploy with
  `environment=prod`) for any shared deployment.
- **Every signed-in operator has the same rights**: browse, upload (each upload starts a MediaConvert job),
  re-drive failed assets and change posters. Create accounts only for people who should have all of them.
- This is a **reference companion app**, not production-hardened. Before any internet-facing use:
  add a WAF WebACL to the API + CloudFront, require MFA, and review the documented cdk-nag
  suppressions in `backend/lib/cms-stack.ts`.
