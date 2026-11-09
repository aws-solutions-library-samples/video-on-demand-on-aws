/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { describe, expect, it } from 'vitest';
import { STALE_BUILD_RELOAD_KEY, STALE_BUILD_RELOAD_WINDOW_MS, shouldReloadForStaleBuild, type ReloadStore } from './staleBuild';

const memoryStore = (): ReloadStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe('shouldReloadForStaleBuild', () => {
  it('allows the first reload and records when it happened', () => {
    const store = memoryStore();
    expect(shouldReloadForStaleBuild(store, 1_000)).toBe(true);
    expect(store.data.get(STALE_BUILD_RELOAD_KEY)).toBe('1000');
  });

  it('blocks a second reload inside the window (no reload loop on a broken deploy)', () => {
    const store = memoryStore();
    shouldReloadForStaleBuild(store, 1_000);
    expect(shouldReloadForStaleBuild(store, 1_000 + STALE_BUILD_RELOAD_WINDOW_MS - 1)).toBe(false);
  });

  it('allows another reload once the window has passed (a later redeploy)', () => {
    const store = memoryStore();
    shouldReloadForStaleBuild(store, 1_000);
    expect(shouldReloadForStaleBuild(store, 1_000 + STALE_BUILD_RELOAD_WINDOW_MS)).toBe(true);
  });

  it('treats a garbage stored value as no previous reload', () => {
    const store = memoryStore();
    store.setItem(STALE_BUILD_RELOAD_KEY, 'not-a-number');
    expect(shouldReloadForStaleBuild(store, 5_000)).toBe(true);
  });
});
