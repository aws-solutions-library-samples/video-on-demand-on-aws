/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                                *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at http://www.apache.org/licenses/LICENSE-2.0                  *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * CMS authenticated read API (Lambda proxy behind a Cognito authorizer): SSM discovery + DynamoDB
 * read (list/detail) and the operator write paths. AWS SDK v3 + global `fetch` are provided by the Node 22
 * managed runtime.
 *
 * Extensions: `./extensions/<id>.mjs` is loaded at cold start for each id in CMS_EXTENSIONS (the extensions
 * the stack enabled, in order); GET /config reports the same ids so the UI loads only their pages and players.
 * Each default export may provide any of these hooks (all optional):
 *   ssmKeys: string[]                          extra `/<vodStackName>/<key>` discovery params (-> config.extra[key])
 *   config(cfg) -> object                      extra GET /config fields
 *   summary(item) -> object                    extra fields on the list-shape asset
 *   detail(item) -> object                     extra fields on the asset detail
 *   searchText(asset) -> string[]              extra text the catalogue search matches
 *   listFilter(query) -> (asset => bool)|null  a GET /assets filter from the query string
 *   routes: { [apiResource]: (event, host) => response }  extra API routes (host: { json, loadConfig, ddb, s3 })
 */
import { existsSync } from 'node:fs';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, QueryCommand, GetItemCommand, DeleteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { S3Client, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const REGION = process.env.AWS_REGION;
const VOD_STACK_NAME = process.env.VOD_STACK_NAME;
// list-page size. A single named default (query-param `?limit=` overrides it, clamped to
// MAX_PAGE_SIZE) so a caller can't reintroduce an unbounded fetch by asking for a huge page.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// Mirrors SRC_BUCKET_START_TIME_INDEX in source/core/lib/constructs/interfaces.ts. The CMS backend is a
// separate deployable package from the VOD stack (no shared import path between them, same as the SSM
// param names below), so the GSI name is duplicated here by convention rather than imported.
const SRC_BUCKET_START_TIME_INDEX = 'srcBucket-startTime-index';
const ssm = new SSMClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const sfn = new SFNClient({ region: REGION });

// CORS: echo the request Origin only when the stack allowed it (the CMS site, + the Vite dev server in dev).
// Set per request in the handler; a Lambda container serves one request at a time.
const ALLOWED_ORIGINS = (process.env.CMS_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
let responseOrigin = ALLOWED_ORIGINS[0] || '*';
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Access-Control-Allow-Origin': responseOrigin, Vary: 'Origin', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

/** The enabled extension ids (set by the stack from VOD_EXTENSIONS; empty = the base CMS). */
const EXTENSION_IDS = (process.env.CMS_EXTENSIONS || '').split(',').map((id) => id.trim()).filter(Boolean);

/** Load `./extensions/<id>.mjs` for each enabled id. A missing module fails the cold start (a packaging bug). */
async function loadExtensions(ids) {
  const dir = new URL('./extensions/', import.meta.url);
  return Promise.all(
    ids.map(async (id) => {
      if (!existsSync(new URL(`${id}.mjs`, dir))) throw new Error(`CMS extension '${id}' is enabled but ./extensions/${id}.mjs is not in the bundle`);
      return (await import(new URL(`${id}.mjs`, dir).href)).default;
    }),
  );
}
const extensions = await loadExtensions(EXTENSION_IDS);
const extensionSsmKeys = extensions.flatMap((e) => e.ssmKeys ?? []);
const extensionRoutes = Object.assign({}, ...extensions.map((e) => e.routes ?? {}));
/** Merge one hook's object results across every extension. */
const mergeHook = (hook, ...args) => Object.assign({}, ...extensions.map((e) => (e[hook] ? e[hook](...args) : {})));

let configCache; // { region, tableName, cloudFrontDomain, sourceBucket, destinationBucket, orchestratorArn, ssaiHlsManifestEndpointPrefix, extra }

async function loadConfig() {
  if (configCache) return configCache;
  // Discovery keys from the cross-stack contract (source/contract, `SsmKey`). This asset is shipped
  // unbundled, so it cannot import that package; the CMS backend tests pin these names to it.
  const names = [
    'DynamoDBTable',
    'CloudFrontDomainName',
    'SourceBucket',
    'DestinationBucket',
    'OrchestratorStateMachineArn',
    // MediaTailor SSAI module (source/modules/ssai). Published by the separate MediaTailor
    // companion stack under this SAME discovery namespace (not its own stack name) so no extra IAM is
    // needed here; simply absent (GetParameters never throws for a missing name) when that stack isn't
    // deployed.
    'SsaiHlsManifestEndpointPrefix',
    // Extension discovery params (absent ones are simply missing from the GetParameters result).
    ...extensionSsmKeys,
  ].map((n) => `/${VOD_STACK_NAME}/${n}`);
  const res = await ssm.send(new GetParametersCommand({ Names: names }));
  const byName = Object.fromEntries((res.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const tableName = byName[`/${VOD_STACK_NAME}/DynamoDBTable`];
  if (!tableName) throw new Error(`SSM param /${VOD_STACK_NAME}/DynamoDBTable not found; is the VOD stack deployed?`);
  configCache = {
    region: REGION,
    tableName,
    cloudFrontDomain: byName[`/${VOD_STACK_NAME}/CloudFrontDomainName`] ?? null,
    sourceBucket: byName[`/${VOD_STACK_NAME}/SourceBucket`] ?? null,
    destinationBucket: byName[`/${VOD_STACK_NAME}/DestinationBucket`] ?? null,
    orchestratorArn: byName[`/${VOD_STACK_NAME}/OrchestratorStateMachineArn`] ?? null,
    ssaiHlsManifestEndpointPrefix: byName[`/${VOD_STACK_NAME}/SsaiHlsManifestEndpointPrefix`] ?? null,
    extra: Object.fromEntries(extensionSsmKeys.map((k) => [k, byName[`/${VOD_STACK_NAME}/${k}`] ?? null])),
  };
  return configCache;
}

/** Normalize a raw DynamoDB item into the list-shape Asset the cms expects. */
function toAssetSummary(item) {
  return {
    guid: item.guid ?? null,
    workflowStatus: item.workflowStatus ?? null,
    srcVideo: item.srcVideo ?? item.srcMediainfo?.filename ?? null,
    encodingProfile: item.encodingProfile ?? item.tier ?? null,
    srcHeight: item.srcHeight ?? null,
    startTime: item.startTime ?? null,
    endTime: item.endTime ?? null,
    archiveSource: item.archiveSource ?? null,
    hasAdBreaks: Boolean(item.adMarkersEsamXml || item.scte35 || item.adBreaks),
    qualityMetrics: typeof item.qualityMetrics === 'string' ? item.qualityMetrics.split(',').map((s) => s.trim()).filter(Boolean) : [],
    errorStage: item.errorStage ?? null,
    posterUrl: item.posterUrl ?? null,
    ...mergeHook('summary', item),
  };
}

/** Text the catalogue search matches: file name, guid, and whatever the extensions add. */
function searchText(a) {
  return [a.srcVideo, a.guid, ...extensions.flatMap((e) => (e.searchText ? e.searchText(a) : []))]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Reverse of b64url for a JSON string (pads back to a multiple of 4 base64 chars). */
function fromB64url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8');
}

/**
 * one page of the catalog, newest-first, via a `Query` against `srcBucket-startTime-index`
 * (ScanIndexForward: false) instead of an unbounded full-table Scan — O(page) read cost instead of
 * O(table). Every asset in a deployment shares the same srcBucket (the ASL writes the one source
 * bucket's name into every item), so a single-partition Query covers the whole catalog.
 *
 * `Limit` caps items DynamoDB *examines* per page, not items returned after the search/status filter
 * below is applied, so under an active filter a single Query page could come back under-full even
 * though more matches exist further in the index. To keep the page-size contract without reintroducing
 * an unbounded fetch, follow up to MAX_INTERNAL_PAGES additional Query pages (bounded, not "until the
 * end of the table") accumulating filtered matches until `limit` is reached, the GSI is exhausted, or
 * the cap is hit.
 */
async function listAssets({ search, status, filters = [], limit = DEFAULT_PAGE_SIZE, cursor }) {
  const pageSize = Math.min(Math.max(Number(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const { tableName, sourceBucket } = await loadConfig();
  if (!sourceBucket) throw new Error(`SSM param /${VOD_STACK_NAME}/SourceBucket not found; cannot page ${SRC_BUCKET_START_TIME_INDEX}`);
  const MAX_INTERNAL_PAGES = 10;

  let assets = [];
  let ExclusiveStartKey = cursor;
  for (let page = 0; assets.length < pageSize && page < MAX_INTERNAL_PAGES; page += 1) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: SRC_BUCKET_START_TIME_INDEX,
        KeyConditionExpression: 'srcBucket = :b',
        ExpressionAttributeValues: { ':b': { S: sourceBucket } },
        ScanIndexForward: false,
        Limit: pageSize,
        ExclusiveStartKey,
      }),
    );
    let batch = (res.Items ?? []).map(unmarshall).map(toAssetSummary);
    if (status) batch = batch.filter((a) => (a.workflowStatus ?? '').toLowerCase() === status.toLowerCase());
    for (const filter of filters) batch = batch.filter(filter);
    if (search) {
      // Every whitespace-separated term must match (so "beach sunset" narrows rather than widens).
      const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
      batch = batch.filter((a) => {
        const text = searchText(a);
        return terms.every((t) => text.includes(t));
      });
    }
    assets = assets.concat(batch);
    ExclusiveStartKey = res.LastEvaluatedKey;
    if (!ExclusiveStartKey) break;
    if (!search && !status && !filters.length) break; // unfiltered: one Query page is always exactly one result page
  }

  assets = assets.slice(0, pageSize);
  const nextToken = ExclusiveStartKey ? b64url(JSON.stringify(ExclusiveStartKey)) : null;
  return { assets, nextToken };
}

async function getAsset(guid) {
  const { tableName, ssaiHlsManifestEndpointPrefix } = await loadConfig();
  const res = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { guid: { S: guid } } }));
  if (!res.Item) return null;
  const item = unmarshall(res.Item);
  const hlsUrl = item.hlsUrl ?? null;
  // Server-side CMAF-HLS URL: the recorded value (Publish stage) is authoritative; fall back to the
  // /cmaf sibling of the /hls manifest for assets packaged before cmafUrl was recorded.
  const cmafUrl =
    item.cmafUrl ?? (hlsUrl && /\/hls\/index\.m3u8$/.test(hlsUrl) ? hlsUrl.replace(/\/hls\/index\.m3u8$/, '/cmaf/index.m3u8') : null);

  // MediaTailor SSAI playback URL for the HLS/TS rendition (the only one with real avail
  // markers in v1). prefix + the manifest path relative to the CloudFront origin is directly
  // playable. null when the MediaTailor stack isn't deployed or this asset has no hlsUrl yet.
  const ssaiHlsUrl =
    hlsUrl && ssaiHlsManifestEndpointPrefix
      ? ssaiHlsManifestEndpointPrefix + new URL(hlsUrl).pathname.replace(/^\//, '')
      : null;

  return {
    ...toAssetSummary(item),
    hlsUrl,
    dashUrl: item.dashUrl ?? null,
    cmafUrl,
    ssaiHlsUrl,
    orchestratorExecutionArn: item.orchestratorExecutionArn ?? null,
    qualityMetricsPrefix: item.qualityMetricsPrefix ?? null,
    posterUrl: item.posterUrl ?? null,
    thumbnailsPrefix: item.thumbnailsPrefix ?? null,
    adMarkersEsamXml: item.adMarkersEsamXml ?? null,
    ...mergeHook('detail', item),
    errorMessage: item.errorMessage ?? null,
    probeRaw: item.srcMediainfo ?? item.mediaInfo ?? null,
  };
}

/**
 * best-effort ordered list of `RESOLUTION=WxH` values from an HLS master playlist's
 * `#EXT-X-STREAM-INF` lines (document order — the only thing needed here; unlike
 * `abrLadder.ts`'s client-side parser this doesn't need bandwidth/codecs/frame-rate). Returns `[]` on
 * any failure (missing manifest, network error) - callers must treat resolution labeling as optional.
 */
async function listHlsResolutionsInOrder(bucket, guid) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${guid}/hls/index.m3u8` }));
    const text = await res.Body.transformToString();
    return [...text.matchAll(/^#EXT-X-STREAM-INF:.*RESOLUTION=(\d+x\d+)/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/**
 * build a manifest of direct, publicly-fetchable CloudFront URLs for an asset's per-frame
 * quality-metrics files — no GetObject/parsing here, the browser fetches and parses full-fidelity
 * itself. Always lists the DESTINATION bucket (mode-agnostic): GA-mode assets have native `.csv` files
 * there already; packaging-mode assets get rescued `.json` files there once the quality-metrics rescue Lambda
 * (triggered off MediaConvert job completion — see quality-metrics-processor/index.mjs) has processed
 * them (nothing to list until then; the intermediate bucket's 1-day TTL is the only reason that
 * rescue Lambda exists at all). When both exist for the same rendition+metric, `.json` wins.
 */
async function getQualityMetricsManifest(guid) {
  const { tableName, cloudFrontDomain, destinationBucket } = await loadConfig();
  const res = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { guid: { S: guid } } }));
  if (!res.Item) return null;
  const item = unmarshall(res.Item);
  const metrics = typeof item.qualityMetrics === 'string' ? item.qualityMetrics.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!metrics.length || !destinationBucket || !cloudFrontDomain) return { renditions: [] };

  const keyPrefix = `${guid}/`;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: destinationBucket, Prefix: keyPrefix }));
  const suffixPattern = new RegExp(`_(${metrics.join('|')})\\.(json|csv)$`);
  const byRenditionMetric = new Map(); // "<rendition>|<metric>" -> { renditionName, metric, format, url }
  for (const obj of listed.Contents ?? []) {
    const filename = obj.Key.slice(keyPrefix.length);
    const match = filename.match(suffixPattern);
    if (!match) continue;
    const [, metric, format] = match;
    const renditionName = filename.slice(0, filename.length - match[0].length) || 'default';
    const key = `${renditionName}|${metric}`;
    if (byRenditionMetric.get(key)?.format === 'json') continue; // json already won for this pair
    byRenditionMetric.set(key, { renditionName, metric, format, url: `https://${cloudFrontDomain}/${obj.Key}` });
  }

  const byRendition = new Map();
  for (const { renditionName, metric, format, url } of byRenditionMetric.values()) {
    if (!byRendition.has(renditionName)) byRendition.set(renditionName, []);
    byRendition.get(renditionName).push({ metric, format, url });
  }

  // Best-effort: label each rendition by its real resolution instead of the raw MediaConvert output
  // basename (e.g. "stream_video_1"). Verified live: the ladder job's mezzanine master and the final
  // delivered HLS master list every rendition in identical order with identical RESOLUTION values
  // (REMUX_ALL's AUTO passthrough preserves order 1:1), so the trailing index in the rendition's own
  // name ("..._N", 1-indexed) maps straight onto position N-1 in the always-durable final HLS master -
  // no need to touch the TTL'd intermediate bucket. Silently omitted (null) if the lookup fails or the
  // naming convention doesn't match (e.g. an unverified GA-mode basename) - never blocks the manifest.
  const resolutions = await listHlsResolutionsInOrder(destinationBucket, guid);
  const resolutionFor = (renditionName) => {
    const m = renditionName.match(/_(\d+)$/);
    if (!m) return null;
    return resolutions[Number(m[1]) - 1] ?? null;
  };

  return {
    renditions: [...byRendition.entries()].map(([name, files]) => ({ name, resolution: resolutionFor(name), files })),
  };
}

/** Matches the pipeline's own FRAME_CAPTURE naming (source/core/lib/asl.ts, appendFrameCaptureGroup):
 * frame.0000000.jpg, frame.0000001.jpg, ... Used both to filter the S3 listing and to validate a
 * client-supplied frameKey before it's ever used to build a DynamoDB write — a full filename, not a
 * free-form path, so there is no key-traversal or arbitrary-URL surface. */
const FRAME_KEY_PATTERN = /^frame\.\d{7}\.jpg$/;

/**
 * List every scrub-bar thumbnail JPEG the thumbnailsProfile overlay generated for an asset, as direct
 * CloudFront URLs (browser fetches the images itself — same no-GetObject pattern as
 * getQualityMetricsManifest, reusing the same s3:ListBucket-only grant on the destination bucket).
 * Frame count depends on video duration (1 capture/5s, capped at 500), so this is always a single
 * ListObjectsV2 page. Returns `{ frames: [] }` (not 404) when the overlay wasn't ON for this asset —
 * only a genuinely missing DynamoDB item is a 404, mirroring getQualityMetricsManifest.
 */
async function getThumbnailsManifest(guid) {
  const { tableName, cloudFrontDomain, destinationBucket } = await loadConfig();
  const res = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { guid: { S: guid } } }));
  if (!res.Item) return null;
  if (!destinationBucket || !cloudFrontDomain) return { frames: [] };

  const keyPrefix = `${guid}/thumbnails/`;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: destinationBucket, Prefix: keyPrefix }));
  const frames = (listed.Contents ?? [])
    .map((obj) => obj.Key.slice(keyPrefix.length))
    .filter((name) => FRAME_KEY_PATTERN.test(name))
    .sort()
    .map((key) => ({ key, url: `https://${cloudFrontDomain}/${keyPrefix}${key}` }));
  return { frames };
}

/**
 * Poster override (WRITE path #2, alongside the redrive): let an operator replace the pipeline's
 * default poster (the first FRAME_CAPTURE JPEG) with any other scrub-bar frame. `frameKey` is
 * server-validated against FRAME_KEY_PATTERN and the CloudFront URL is reconstructed here (never
 * accepted from the client as a URL) — the same `https://<cloudFrontDomain>/<guid>/thumbnails/<frame>`
 * shape the pipeline itself writes (see injectThumbnailsRecord in source/core/lib/asl.ts). Only a
 * DynamoDB UpdateItem is needed; no S3 write, since CloudFront already serves the chosen JPEG.
 */
async function setPoster(guid, frameKey) {
  if (typeof frameKey !== 'string' || !FRAME_KEY_PATTERN.test(frameKey)) {
    return { status: 400, error: `frameKey must match ${FRAME_KEY_PATTERN} (e.g. "frame.0000012.jpg")` };
  }
  const { tableName, cloudFrontDomain } = await loadConfig();
  if (!cloudFrontDomain) return { status: 500, error: 'CloudFront domain not available from SSM' };

  const res = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { guid: { S: guid } } }));
  if (!res.Item) return { status: 404, error: 'not found' };

  const posterUrl = `https://${cloudFrontDomain}/${guid}/thumbnails/${frameKey}`;
  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { guid: { S: guid } },
      UpdateExpression: 'SET posterUrl = :p',
      ExpressionAttributeValues: { ':p': { S: posterUrl } },
    }),
  );
  return { status: 200, body: { posterUrl } };
}

/**
 * Measured (actual) per-rung video bitrate for the ABR ladder. The HLS master only carries the
 * encoder's REPORTED AVERAGE-BANDWIDTH/BANDWIDTH — and those fold in the ~128 kbps audio group, so
 * they overstate the true per-rung VIDEO bitrate (verified live: +5% on the top rung, +27% on the
 * bottom, where the fixed audio dominates). This computes the truthful video-only bitrate straight
 * from the delivered CMAF video files: each rendition is one single-file `.cmfv` (SegmentControl
 * SINGLE_FILE), so `bytes*8 / duration` is its actual bitrate — no need to sum segments or read the
 * media bodies (object sizes come from the listing). Duration is taken from the source probe already
 * on the item (Container.Duration), so no manifest fetch is needed.
 *
 * Layout-agnostic: packaging-ON assets keep CMAF under `<guid>/cmaf/`, GA single-CMAF assets under
 * `<guid>/` — detected with the same `/hls/` test getAsset uses. Best-effort like the quality-metrics
 * / resolution lookups: any gap (no probe duration, no CMAF files) yields `{ rungs: [] }`, never a
 * throw, so the ladder silently falls back to reported-only. Rungs are returned in `index` (N) order,
 * N=0 highest — the same descending order the HLS master lists renditions in, so the browser zips
 * them onto its manifest-parsed rungs by position (the rendition-order invariant relied on by
 * listHlsResolutionsInOrder above). Uses only the existing destination-bucket s3:ListBucket grant.
 */
async function getAbrBitrates(guid) {
  const { tableName, destinationBucket } = await loadConfig();
  const res = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { guid: { S: guid } } }));
  if (!res.Item) return null;
  if (!destinationBucket) return { rungs: [] };
  const item = unmarshall(res.Item);

  let duration = 0;
  try {
    duration = JSON.parse(item.probe)?.ProbeResults?.[0]?.Container?.Duration ?? 0;
  } catch {
    duration = 0;
  }
  if (!Number.isFinite(duration) || duration <= 0) return { rungs: [] };

  const hlsUrl = item.hlsUrl ?? null;
  const prefix = hlsUrl && /\/hls\/index\.m3u8$/.test(hlsUrl) ? `${guid}/cmaf/` : `${guid}/`;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: destinationBucket, Prefix: prefix }));

  const rungs = [];
  for (const obj of listed.Contents ?? []) {
    const m = obj.Key.slice(prefix.length).match(/^index_cmaf_video_(\d+)\.cmfv$/);
    if (!m) continue;
    rungs.push({ index: Number(m[1]), actualVideoBps: Math.round((obj.Size * 8) / duration) });
  }
  rungs.sort((a, b) => a.index - b.index);
  return { rungs };
}

/**
 * Controlled re-drive: re-run a FAILED asset through the pipeline in place. Because the
 * Orchestrator derives a DETERMINISTIC guid (SHA-256 of key + S3 version-id) and creates the item with
 * a conditional PutItem (attribute_not_exists(guid)), simply re-firing StartExecution on an unchanged
 * object would short-circuit to "Duplicate Skipped" and do nothing. So we:
 *   1. Load the item and refuse anything that is not workflowStatus="Error" (only failed assets).
 *   2. HeadObject the source to get its current version-id (so the re-run's guid matches the object).
 *   3. DeleteItem(guid), conditional on workflowStatus="Error" — clears the failed record so the Orchestrator's conditional PutItem succeeds
 *      and the SAME asset reprocesses in place (the run recreates the item with a fresh status).
 *   4. StartExecution on the Orchestrator with an S3-"Object Created"-shaped input.
 * This was the console's first write path (WRITE path #1; setPoster above is #2); its IAM is scoped to
 * DeleteItem on the VOD table, GetObject on the source bucket, and StartExecution on the single
 * Orchestrator ARN (see cms-stack.ts).
 */
async function redriveAsset(guid) {
  const { tableName, orchestratorArn } = await loadConfig();
  if (!orchestratorArn) return { status: 500, error: 'Orchestrator state machine ARN not available from SSM' };

  const res = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { guid: { S: guid } } }));
  if (!res.Item) return { status: 404, error: 'not found' };
  const item = unmarshall(res.Item);
  if ((item.workflowStatus ?? '').toLowerCase() !== 'error') {
    return { status: 409, error: `only failed (Error) assets can be re-driven; this asset is "${item.workflowStatus ?? 'Unknown'}"` };
  }
  const srcBucket = item.srcBucket;
  const srcVideo = item.srcVideo;
  if (!srcBucket || !srcVideo) return { status: 422, error: 'asset is missing srcBucket/srcVideo; cannot re-drive' };

  // Current object version so the re-run's deterministic guid matches an unchanged object (falls back
  // to the literal "null" the Orchestrator uses when the bucket has no versioning).
  let versionId = 'null';
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: srcBucket, Key: srcVideo }));
    versionId = head.VersionId ?? 'null';
  } catch (err) {
    // A HEAD carries no response body, so the SDK often can't map the S3 error code: a missing object
    // (404) or a delete-marker latest version (405) surfaces either with that HTTP status or, when the
    // status is stripped too, as the SDK's generic name="Unknown"/message="UnknownError" signature.
    // All of these mean the source is gone -> 410. A classified non-404/405 status is a real upstream
    // read failure -> 502.
    const httpStatus = err?.$metadata?.httpStatusCode;
    const gone =
      httpStatus === 404 ||
      httpStatus === 405 ||
      err?.name === 'NotFound' ||
      err?.name === 'NoSuchKey' ||
      (httpStatus === undefined && (err?.name === 'Unknown' || err?.message === 'UnknownError'));
    if (gone) {
      return { status: 410, error: `source object s3://${srcBucket}/${srcVideo} is unavailable; it may have been deleted. Cannot re-drive.` };
    }
    return { status: 502, error: `could not read source object s3://${srcBucket}/${srcVideo}: ${err?.name ?? ''} ${err?.message ?? err}`.trim() };
  }

  // Conditional on the record still being in Error: two near-simultaneous re-drives (or a re-drive racing
  // a run that has already recreated the item) cannot delete a live record. Only one caller wins.
  let deleted;
  try {
    deleted = await ddb.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: { guid: { S: guid } },
        ConditionExpression: 'workflowStatus = :e',
        ExpressionAttributeValues: { ':e': { S: 'Error' } },
        ReturnValues: 'ALL_OLD',
      }),
    );
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { status: 409, error: 'asset is no longer in Error (already re-driven or reprocessing)' };
    }
    throw err;
  }
  const input = JSON.stringify({ detail: { bucket: { name: srcBucket }, object: { key: srcVideo, 'version-id': versionId } } });
  try {
    const exec = await sfn.send(new StartExecutionCommand({ stateMachineArn: orchestratorArn, input }));
    return { status: 202, body: { executionArn: exec.executionArn ?? null, guid } };
  } catch (err) {
    // The failed record is already gone; keep its error details in the logs so they are not lost.
    console.error('re-drive StartExecution failed after the Error record was cleared', {
      guid,
      error: err?.name,
      previousRecord: deleted?.Attributes ? unmarshall(deleted.Attributes) : undefined,
    });
    throw err;
  }
}

export const handler = async (event, context) => {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  responseOrigin = ALLOWED_ORIGINS.length === 0 ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  try {
    const resource = event.resource || event.requestContext?.resourcePath || '';
    if (resource === '/config') {
      const c = await loadConfig();
      // Do not leak the raw table name/arn to the browser; expose only what the UI needs.
      return json(200, {
        region: c.region,
        cloudFrontDomain: c.cloudFrontDomain,
        sourceBucket: c.sourceBucket,
        tableConfigured: true,
        stackName: VOD_STACK_NAME ?? null,
        // The enabled extensions: the UI loads only these (their pages, nav items and players).
        extensions: EXTENSION_IDS,
        ...mergeHook('config', c),
      });
    }
    if (resource === '/assets') {
      const q = event.queryStringParameters ?? {};
      let cursor;
      if (q.cursor) {
        try {
          cursor = JSON.parse(fromB64url(q.cursor));
        } catch {
          return json(400, { error: 'invalid cursor' });
        }
      }
      const { assets, nextToken } = await listAssets({
        search: q.search,
        status: q.status,
        filters: extensions.map((e) => (e.listFilter ? e.listFilter(q) : null)).filter(Boolean),
        limit: q.limit,
        cursor,
      });
      return json(200, { assets, nextToken });
    }
    if (resource === '/assets/{guid}') {
      const guid = event.pathParameters?.guid;
      if (!guid) return json(400, { error: 'missing guid' });
      const asset = await getAsset(guid);
      return asset ? json(200, { asset }) : json(404, { error: 'not found' });
    }
    if (resource === '/assets/{guid}/quality-metrics') {
      const guid = event.pathParameters?.guid;
      if (!guid) return json(400, { error: 'missing guid' });
      const manifest = await getQualityMetricsManifest(guid);
      return manifest ? json(200, manifest) : json(404, { error: 'not found' });
    }
    if (resource === '/assets/{guid}/abr-bitrates') {
      const guid = event.pathParameters?.guid;
      if (!guid) return json(400, { error: 'missing guid' });
      const bitrates = await getAbrBitrates(guid);
      return bitrates ? json(200, bitrates) : json(404, { error: 'not found' });
    }
    if (resource === '/assets/{guid}/redrive') {
      if ((event.httpMethod || '').toUpperCase() !== 'POST') return json(405, { error: 'method not allowed' });
      const guid = event.pathParameters?.guid;
      if (!guid) return json(400, { error: 'missing guid' });
      const r = await redriveAsset(guid);
      return r.status === 202 ? json(202, r.body) : json(r.status, { error: r.error });
    }
    if (resource === '/assets/{guid}/thumbnails') {
      const guid = event.pathParameters?.guid;
      if (!guid) return json(400, { error: 'missing guid' });
      const manifest = await getThumbnailsManifest(guid);
      return manifest ? json(200, manifest) : json(404, { error: 'not found' });
    }
    if (resource === '/assets/{guid}/poster') {
      if ((event.httpMethod || '').toUpperCase() !== 'POST') return json(405, { error: 'method not allowed' });
      const guid = event.pathParameters?.guid;
      if (!guid) return json(400, { error: 'missing guid' });
      let body;
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch {
        return json(400, { error: 'invalid JSON body' });
      }
      const r = await setPoster(guid, body.frameKey);
      return r.status === 200 ? json(200, r.body) : json(r.status, { error: r.error });
    }
    if (extensionRoutes[resource]) return await extensionRoutes[resource](event, { json, loadConfig, ddb, s3 });
    return json(404, { error: `unknown route: ${resource}` });
  } catch (err) {
    // Details stay in the logs (they can name tables, buckets and ARNs); the caller gets a request id to quote.
    console.error(err);
    return json(500, { error: 'internal error', requestId: context?.awsRequestId ?? null });
  }
};
