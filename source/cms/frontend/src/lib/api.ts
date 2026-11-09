/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Authenticated fetch helper. Centralises the Cognito pattern: pull the current session's ID token
 * and send it in the `Authorization` header (NO `Bearer` prefix — what the API Gateway Cognito User
 * Pools authorizer expects). Every route is behind the gate, so a missing token is a hard error.
 * Replaces the CMS's unauthenticated `fetch('/api/...')` dev-server calls.
 */
import { fetchAuthSession } from 'aws-amplify/auth';
import type {
  AbrBitratesResponse,
  Asset,
  CmsConfig,
  QualityMetricsManifest,
  ThumbnailsManifest,
} from '../types';

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** GET/POST an API route with the signed-in user's ID token (also used by the UI extensions). */
export async function authedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('No auth token available');
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: token, ...(init.headers ?? {}) },
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

export const fetchConfig = () => authedFetch<CmsConfig>('/config');

let configPromise: Promise<CmsConfig> | undefined;
/** {@link fetchConfig}, fetched once per page load (the CMS config is fixed per deployment). */
export const getCmsConfig = (): Promise<CmsConfig> => {
  configPromise ??= fetchConfig().catch((e) => {
    configPromise = undefined;
    throw e;
  });
  return configPromise;
};

/** default/mirrors the backend's own DEFAULT_PAGE_SIZE (index.mjs) — no shared import path
 * between the two packages, so each holds its own copy of the same constant, by convention. */
export const DEFAULT_PAGE_SIZE = 20;

export interface AssetPage {
  assets: Asset[];
  /** Opaque cursor for the next page; null once the catalog (or a search's matches) is exhausted. */
  nextToken: string | null;
}

export const fetchAssets = (
  opts: {
    search?: string;
    status?: string;
    limit?: number;
    cursor?: string;
    /** Extra query-string filters understood by an API extension (unset values are omitted). */
    params?: Record<string, string | undefined>;
  } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.search) qs.set('search', opts.search);
  if (opts.status) qs.set('status', opts.status);
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.cursor) qs.set('cursor', opts.cursor);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value) qs.set(key, value);
  }
  const q = qs.toString();
  return authedFetch<AssetPage>(`/assets${q ? `?${q}` : ''}`);
};

export const fetchAsset = (guid: string) =>
  authedFetch<{ asset: Asset }>(`/assets/${encodeURIComponent(guid)}`).then((r) => r.asset);

/**
 * Controlled re-drive: re-run a FAILED asset through the pipeline in place (delete-then-restart
 * on the Orchestrator, server-side). Only assets with workflowStatus="Error" are accepted; the API
 * returns 409 otherwise. Resolves to the new Step Functions execution ARN.
 */
export const redriveAsset = (guid: string) =>
  authedFetch<{ executionArn: string | null; guid: string }>(`/assets/${encodeURIComponent(guid)}/redrive`, {
    method: 'POST',
  });

/**
 * fetch the quality-metrics manifest (URLs only, no file bodies) for an asset. The caller
 * fetches each URL directly against the VOD CloudFront domain (CORS-open) and parses it client-side.
 */
export const fetchQualityMetricsManifest = (guid: string) =>
  authedFetch<QualityMetricsManifest>(`/assets/${encodeURIComponent(guid)}/quality-metrics`);

/** Poster override: fetch every scrub-bar thumbnail (FRAME_CAPTURE JPEG) generated for an asset. */
export const fetchThumbnailsManifest = (guid: string) =>
  authedFetch<ThumbnailsManifest>(`/assets/${encodeURIComponent(guid)}/thumbnails`);

/**
 * Measured per-rung video-only bitrate (computed server-side from the delivered CMAF `.cmfv` sizes),
 * to show alongside the manifest's reported AVERAGE-BANDWIDTH in the ABR ladder. Best-effort: the
 * ladder falls back to reported-only if this is empty/unavailable.
 */
export const fetchAbrBitrates = (guid: string) =>
  authedFetch<AbrBitratesResponse>(`/assets/${encodeURIComponent(guid)}/abr-bitrates`);

/**
 * Poster override: replace the pipeline's default poster (first frame) with the chosen thumbnail
 * frame (e.g. "frame.0000012.jpg", from a `ThumbnailFrame.key`). Resolves to the new poster URL.
 */
export const setPoster = (guid: string, frameKey: string) =>
  authedFetch<{ posterUrl: string }>(`/assets/${encodeURIComponent(guid)}/poster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frameKey }),
  });
