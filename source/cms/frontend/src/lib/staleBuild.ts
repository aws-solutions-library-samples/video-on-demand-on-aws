/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Stale-build recovery. Every CMS deploy replaces the content-hashed chunks under /assets/ (the
 * `aws s3 sync --delete` in scripts/deploy-all.sh), so a tab opened before the deploy still points at
 * chunk names that no longer exist. A lazy import (the ECharts chart, extension UIs) then fails, and
 * the CloudFront SPA fallback answers the missing chunk with index.html. Vite surfaces that as a
 * `vite:preloadError` event; reloading picks up the new index.html and its chunk names.
 *
 * Reload at most once per window so a genuinely broken deploy can't trap the tab in a reload loop.
 */
export const STALE_BUILD_RELOAD_KEY = 'vod-cms:stale-build-reload-at';
export const STALE_BUILD_RELOAD_WINDOW_MS = 60_000;

export interface ReloadStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True (and records the attempt) when a reload is allowed; false if one already ran within the window. */
export function shouldReloadForStaleBuild(store: ReloadStore, now: number = Date.now()): boolean {
  const last = Number(store.getItem(STALE_BUILD_RELOAD_KEY));
  if (Number.isFinite(last) && last > 0 && now - last < STALE_BUILD_RELOAD_WINDOW_MS) return false;
  store.setItem(STALE_BUILD_RELOAD_KEY, String(now));
  return true;
}

/** Wire the once-per-window reload onto Vite's chunk-load failure event. */
export function installStaleBuildReload(win: Window = window): void {
  win.addEventListener('vite:preloadError', (event) => {
    let allowed = false;
    try {
      allowed = shouldReloadForStaleBuild(win.sessionStorage);
    } catch {
      /* storage unavailable: let the error surface to the error boundary instead of risking a loop */
    }
    if (!allowed) return;
    event.preventDefault(); // suppress the rethrow; the reload replaces this page
    win.location.reload();
  });
}
