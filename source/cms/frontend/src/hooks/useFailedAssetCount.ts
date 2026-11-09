/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Count of failed assets (workflowStatus=Error) for the side-nav "Needs attention" badge. Reads one
 * status-filtered page of the list API, so the count is capped at FAILED_PAGE_SIZE ("50+" beyond that),
 * and refreshes at most once per REFRESH_MS as the operator navigates.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchAssets } from '../lib/api';

const FAILED_PAGE_SIZE = 50;
const REFRESH_MS = 30_000;

export interface FailedAssetCount {
  count: number;
  /** True when more failed assets exist than one page holds. */
  more: boolean;
}

let lastFetch = 0;
let lastValue: FailedAssetCount | null = null;

export function useFailedAssetCount(): FailedAssetCount | null {
  const { pathname } = useLocation();
  const [value, setValue] = useState<FailedAssetCount | null>(lastValue);

  useEffect(() => {
    if (Date.now() - lastFetch < REFRESH_MS) return;
    lastFetch = Date.now();
    let active = true;
    fetchAssets({ status: 'Error', limit: FAILED_PAGE_SIZE })
      .then(({ assets, nextToken }) => {
        lastValue = { count: assets.length, more: Boolean(nextToken) };
        if (active) setValue(lastValue);
      })
      .catch(() => {
        lastFetch = 0; // retry on the next navigation
      });
    return () => {
      active = false;
    };
  }, [pathname]);

  return value;
}
