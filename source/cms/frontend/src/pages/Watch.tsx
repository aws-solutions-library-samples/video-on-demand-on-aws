/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Watch: the Portal's dedicated /portal/:guid player page. Fetches the asset detail (stream URLs are
 * detail-only) and reuses <AssetPlayer> for multi-format playback, with a horizontally
 * scrollable "More videos" rail of other recent published assets for continued browsing. Cloudscape-only.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Box,
  Button,
  Container,
  ContentLayout,
  Header,
  SpaceBetween,
  Spinner,
} from '@cloudscape-design/components';
import { DEFAULT_PAGE_SIZE, fetchAsset, fetchAssets } from '../lib/api';
import { formatTitle, qualityLabel, timeAgo } from '../lib/format';
import AssetPlayer from '../components/AssetPlayer';
import VideoCard from '../components/portal/VideoCard';
import type { Asset } from '../types';

const isComplete = (a: Asset): boolean => (a.workflowStatus ?? '').toLowerCase() === 'complete';

export default function Watch() {
  const { guid = '' } = useParams();
  const navigate = useNavigate();
  // `?t=<seconds>`: start playback at that offset (deep links).
  const [searchParams] = useSearchParams();
  const tParam = Number(searchParams.get('t'));
  const startAt = Number.isFinite(tParam) && tParam > 0 ? tParam : undefined;
  const [asset, setAsset] = useState<Asset | null>(null);
  const [rail, setRail] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setAsset(null);
    // the rail only needs one page of the most-recent assets (comfortably more than the ~12
    // shown), not the whole catalog.
    Promise.all([fetchAsset(guid), fetchAssets({ limit: DEFAULT_PAGE_SIZE }).catch(() => ({ assets: [] as Asset[], nextToken: null }))])
      .then(([detail, page]) => {
        if (!active) return;
        setAsset(detail);
        setRail(page.assets);
      })
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [guid]);

  const moreVideos = useMemo(
    () => rail.filter((a) => isComplete(a) && a.guid !== guid).slice(0, 12),
    [rail, guid],
  );

  const title = asset ? formatTitle(asset.srcVideo, asset.guid) : guid;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <Button iconName="arrow-left" onClick={() => navigate('/portal')}>
              Back to Portal
            </Button>
          }
        >
          {title}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header="Failed to load video">
            {error}
          </Alert>
        )}
        {loading ? (
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        ) : asset && !error ? (
          <>
            {isComplete(asset) ? (
              <AssetPlayer asset={asset} startAt={startAt} />
            ) : (
              <Alert type="info" header="Video not ready">
                This video is still processing or unavailable (status: {asset.workflowStatus ?? 'unknown'}). Check back
                once it finishes.
              </Alert>
            )}
            <Box>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Badge color="blue">{qualityLabel(asset.srcHeight)}</Badge>
                <Box variant="small" color="text-status-inactive" display="inline">
                  {timeAgo(asset.startTime)}
                </Box>
                {asset.encodingProfile && (
                  <Box variant="small" color="text-status-inactive" display="inline">
                    · {asset.encodingProfile} tier
                  </Box>
                )}
              </span>
            </Box>
          </>
        ) : (
          !error && (
            <Box textAlign="center" color="text-status-inactive" padding="xxl">
              Video not found.
            </Box>
          )
        )}
        {moreVideos.length > 0 && (
          <Container header={<Header variant="h2">More videos</Header>}>
            <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8 }}>
              {moreVideos.map((a) => (
                <VideoCard key={a.guid} asset={a} size="small" onOpen={(g) => navigate(`/portal/${g}`)} />
              ))}
            </div>
          </Container>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
