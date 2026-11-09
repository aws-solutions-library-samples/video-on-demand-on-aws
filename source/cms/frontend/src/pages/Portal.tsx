/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Portal: a consumer-facing, YouTube-style grid of the most recent published assets. Reads the authed
 * list route (already newest-first, carries posterUrl), shows only Complete assets, and offers instant
 * client-side search + sort. A card click opens the dedicated /portal/:guid watch page. Cloudscape-only.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  ContentLayout,
  Grid,
  Header,
  Input,
  Select,
  type SelectProps,
  SpaceBetween,
  Spinner,
} from '@cloudscape-design/components';
import { DEFAULT_PAGE_SIZE, fetchAssets } from '../lib/api';
import { formatTitle } from '../lib/format';
import VideoCard from '../components/portal/VideoCard';
import type { Asset } from '../types';

const SORT_OPTIONS: SelectProps.Option[] = [
  { label: 'Newest first', value: 'newest' },
  { label: 'Oldest first', value: 'oldest' },
  { label: 'Title A–Z', value: 'title' },
];

/** Responsive colspans: 1 column on phones, 2 on small, 3 on medium, 4 on large. */
const COL = { colspan: { default: 12, xxs: 6, s: 4, m: 3 } };

export default function Portal() {
  const navigate = useNavigate();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // catalog is fetched page-by-page (GSI-backed, newest-first) rather than in one unbounded
  // request; nextToken is the opaque cursor for the next page, null once the catalog is exhausted.
  const [nextToken, setNextToken] = useState<string | null>(null);
  // Search + sort live in the URL (not local state) so they survive navigating to a watch page and
  // back (including the browser back button), and so a search can be bookmarked/shared. They operate
  // over whatever pages have been loaded so far (see "Load more" below), same as before pagination.
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const sort = SORT_OPTIONS.find((o) => o.value === searchParams.get('sort')) ?? SORT_OPTIONS[0];

  useEffect(() => {
    setLoading(true);
    setError(undefined);
    fetchAssets({ limit: DEFAULT_PAGE_SIZE })
      .then(({ assets: page, nextToken: token }) => {
        setAssets(page);
        setNextToken(token);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const loadMore = () => {
    if (!nextToken || loadingMore) return;
    setLoadingMore(true);
    fetchAssets({ limit: DEFAULT_PAGE_SIZE, cursor: nextToken })
      .then(({ assets: page, nextToken: token }) => {
        setAssets((prev) => [...prev, ...page]);
        setNextToken(token);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingMore(false));
  };

  const items = useMemo(() => {
    // Consumer portal: only surface finished videos (operator views cover in-flight/errored assets).
    const complete = assets.filter((a) => (a.workflowStatus ?? '').toLowerCase() === 'complete');
    const q = search.trim().toLowerCase();
    const filtered = q
      ? complete.filter((a) =>
          `${formatTitle(a.srcVideo, a.guid)} ${a.srcVideo ?? ''} ${a.guid ?? ''}`.toLowerCase().includes(q),
        )
      : complete;
    // fetchAssets() is already newest-first; only re-sort when the user asks for something else.
    if (sort.value === 'oldest') return [...filtered].reverse();
    if (sort.value === 'title')
      return [...filtered].sort((a, b) =>
        formatTitle(a.srcVideo, a.guid).localeCompare(formatTitle(b.srcVideo, b.guid)),
      );
    return filtered;
  }, [assets, search, sort]);

  return (
    <ContentLayout
      header={
        <Header variant="h1" counter={`(${items.length})`} description="Recently published videos, ready to stream.">
          Portal
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header="Failed to load videos">
            {error}
          </Alert>
        )}
        <Grid gridDefinition={[{ colspan: { default: 12, s: 8 } }, { colspan: { default: 12, s: 4 } }]}>
          <Input
            type="search"
            value={search}
            placeholder="Search videos"
            ariaLabel="Search videos"
            clearAriaLabel="Clear search"
            onChange={({ detail }) =>
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (detail.value) next.set('q', detail.value);
                  else next.delete('q');
                  return next;
                },
                { replace: true },
              )
            }
          />
          <Select
            selectedOption={sort}
            options={SORT_OPTIONS}
            ariaLabel="Sort videos"
            onChange={({ detail }) =>
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  // Keep the URL clean at the default sort instead of always stamping ?sort=newest.
                  if (detail.selectedOption.value && detail.selectedOption.value !== SORT_OPTIONS[0].value) {
                    next.set('sort', detail.selectedOption.value);
                  } else {
                    next.delete('sort');
                  }
                  return next;
                },
                { replace: true },
              )
            }
          />
        </Grid>
        {/* Screen-reader-only live announcement of result count as the user types (the header counter is visual-only). */}
        {search && (
          <div
            aria-live="polite"
            role="status"
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}
          >
            {items.length} video{items.length === 1 ? '' : 's'} found
          </div>
        )}
        {loading ? (
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        ) : items.length === 0 ? (
          <Box textAlign="center" color="text-status-inactive" padding="xxl">
            {search ? 'No videos match your search.' : 'No published videos yet.'}
          </Box>
        ) : (
          <Grid gridDefinition={items.map(() => COL)}>
            {items.map((a) => (
              <VideoCard key={a.guid} asset={a} onOpen={(guid) => navigate(`/portal/${guid}`)} />
            ))}
          </Grid>
        )}
        {/* the catalog loads a page at a time; search/sort only see what's been loaded so far. */}
        {!loading && nextToken && (
          <Box textAlign="center">
            <Button onClick={loadMore} loading={loadingMore}>
              Load more
            </Button>
          </Box>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
