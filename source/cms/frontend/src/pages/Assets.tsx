/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { type CSSProperties, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  ContentLayout,
  Header,
  SpaceBetween,
  Link,
  Pagination,
  StatusIndicator,
  Table,
  TextFilter,
} from '@cloudscape-design/components';
import { DEFAULT_PAGE_SIZE, fetchAssets } from '../lib/api';
import { statusType } from '../lib/status';
import type { Asset } from '../types';

/** Last path segment of an S3 key (e.g. `uploads/<id>/vertical.mov` -> `vertical.mov`). */
const baseName = (key: string): string => key.split('/').pop() || key;

const THUMB_STYLE: CSSProperties = { width: 96, height: 54, borderRadius: 4, background: '#232f3e', objectFit: 'cover', display: 'block' };

/**
 * Asset poster thumbnail with a graceful fallback: renders the `–` placeholder when there is no
 * posterUrl OR the image fails to load (older/stale/in-flight assets whose poster 404s), instead of the
 * browser's broken-image glyph. Clicking opens the asset detail.
 */
function Thumb({ posterUrl, href, onOpen }: { posterUrl?: string | null; href?: string; onOpen: (e: { preventDefault: () => void }) => void }) {
  const [broken, setBroken] = useState(false);
  if (!posterUrl || broken) {
    return (
      <Box color="text-status-inactive">
        <div style={{ ...THUMB_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>–</div>
      </Box>
    );
  }
  return (
    <a href={href} onClick={onOpen} aria-label="Open asset">
      <img src={posterUrl} alt="" loading="lazy" style={THUMB_STYLE} onError={() => setBroken(true)} />
    </a>
  );
}

export default function Assets() {
  const navigate = useNavigate();
  // `?status=Error` is the side nav's "Needs attention" view: the same table, filtered to failed assets.
  const [searchParams] = useSearchParams();
  const statusFilter = searchParams.get('status') ?? undefined;
  const needsAttention = statusFilter === 'Error';
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  // the table is fetched a page at a time (GSI-backed Query), not as one unbounded Scan.
  // pageCursors[i] is the opaque cursor needed to fetch page i+1 (pageCursors[0] is always undefined
  // — the first page needs no cursor); its length is therefore "how many pages are known to exist so
  // far". openEnd stays true until a fetch comes back with no further cursor, at which point pageCursors
  // is trimmed to the true final length and openEnd flips false, so Cloudscape renders a closed pager.
  const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(1);
  const [openEnd, setOpenEnd] = useState(true);

  // Raw (instant) filter input vs. the debounced value that actually drives the server-side search —
  // filtering is now a `search` query param (one page at a time), not a client-side pass over
  // everything, so every keystroke would otherwise fire a request.
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setFilter(filterInput), 300);
    return () => clearTimeout(t);
  }, [filterInput]);

  const load = (idx: number, search: string) => {
    setLoading(true);
    setError(undefined);
    fetchAssets({ limit: DEFAULT_PAGE_SIZE, cursor: pageCursors[idx - 1], search: search || undefined, status: statusFilter })
      .then(({ assets: page, nextToken }) => {
        setAssets(page);
        setPageCursors((prev) => {
          const next = prev.slice(0, idx);
          if (nextToken) next[idx] = nextToken;
          return next;
        });
        setOpenEnd(Boolean(nextToken));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  // A new (debounced) search always restarts from page 1 — the previously-known cursors belonged to
  // the old, unfiltered/differently-filtered result set and no longer mean anything.
  useEffect(() => {
    setPageIndex(1);
    setPageCursors([undefined]);
    setOpenEnd(true);
    load(1, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, statusFilter]);

  const goToPage = (idx: number) => {
    if (idx < 1 || idx > pageCursors.length || idx === pageIndex) return;
    setPageIndex(idx);
    load(idx, filter);
  };

  const refresh = () => load(pageIndex, filter);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={needsAttention ? 'Failed assets. Open one to see the error and re-drive it.' : undefined}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {needsAttention && <Button onClick={() => navigate('/assets')}>Show all assets</Button>}
              <Button iconName="refresh" onClick={refresh} loading={loading}>
                Refresh
              </Button>
              <Button variant="primary" iconName="upload" onClick={() => navigate('/upload')}>
                Upload media
              </Button>
            </SpaceBetween>
          }
        >
          {needsAttention ? 'Needs attention' : 'Assets'}
        </Header>
      }
    >
      {error && (
        <Box padding={{ bottom: 'm' }}>
          <Alert type="error" header="Failed to load assets">
            {error}
          </Alert>
        </Box>
      )}
      <Table<Asset>
        variant="container"
        loading={loading}
        loadingText="Loading assets"
        items={assets}
        trackBy="guid"
        filter={
          <TextFilter
            filteringText={filterInput}
            filteringPlaceholder="Find assets"
            filteringAriaLabel="Filter assets"
            onChange={({ detail }) => setFilterInput(detail.filteringText)}
          />
        }
        pagination={
          <Pagination
            currentPageIndex={pageIndex}
            pagesCount={pageCursors.length}
            openEnd={openEnd}
            onChange={({ detail }) => goToPage(detail.currentPageIndex)}
            onNextPageClick={({ detail }) => goToPage(detail.requestedPageIndex)}
            onPreviousPageClick={({ detail }) => goToPage(detail.requestedPageIndex)}
          />
        }
        columnDefinitions={[
          {
            id: 'thumb',
            header: 'Thumbnail',
            width: 128,
            cell: (a) => (
              <Thumb
                posterUrl={a.posterUrl}
                href={a.guid ? `/assets/${a.guid}` : undefined}
                onOpen={(e) => {
                  e.preventDefault();
                  if (a.guid) navigate(`/assets/${a.guid}`);
                }}
              />
            ),
          },
          {
            id: 'status',
            header: 'Status',
            cell: (a) => <StatusIndicator type={statusType(a.workflowStatus)}>{a.workflowStatus ?? 'Unknown'}</StatusIndicator>,
          },
          {
            id: 'src',
            header: 'Source file',
            cell: (a) =>
              a.guid ? (
                <Link
                  href={`/assets/${a.guid}`}
                  onFollow={(e) => {
                    e.preventDefault();
                    navigate(`/assets/${a.guid}`);
                  }}
                >
                  {a.srcVideo ? baseName(a.srcVideo) : a.guid}
                </Link>
              ) : (
                a.srcVideo ? baseName(a.srcVideo) : '-'
              ),
          },
          { id: 'tier', header: 'Tier', cell: (a) => a.encodingProfile ?? '-' },
          { id: 'started', header: 'Started', cell: (a) => a.startTime ?? '-' },
          { id: 'ads', header: 'Ad breaks', cell: (a) => (a.hasAdBreaks ? 'Yes' : '-') },
          { id: 'guid', header: 'GUID', cell: (a) => a.guid ?? '-' },
        ]}
        empty={<Box textAlign="center">No assets found</Box>}
      />
    </ContentLayout>
  );
}
