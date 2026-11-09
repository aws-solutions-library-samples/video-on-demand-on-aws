/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Portal video tile: an edge-to-edge 16:9 poster over a compact title/metadata block, used by both the
 * Portal grid and the watch-page "More videos" rail. Poster-less assets (pre-thumbnails-overlay, or a
 * 404'd poster) fall back to a CSS-only placeholder block (no image asset), matching the Assets table's
 * `Thumb` idiom. Cloudscape primitives + inline styles only (repo convention: no Tailwind).
 */
import { Badge, Box } from '@cloudscape-design/components';
import { formatTitle, qualityLabel, timeAgo } from '../../lib/format';
import Poster from '../Poster';
import type { Asset } from '../../types';

export default function VideoCard({
  asset,
  onOpen,
  size = 'default',
}: {
  asset: Asset;
  onOpen: (guid: string) => void;
  size?: 'default' | 'small';
}) {
  const title = formatTitle(asset.srcVideo, asset.guid);
  const href = asset.guid ? `/portal/${asset.guid}` : undefined;

  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (asset.guid) onOpen(asset.guid);
      }}
      aria-label={`Play ${title}`}
      style={{
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
        cursor: asset.guid ? 'pointer' : 'default',
        width: size === 'small' ? 240 : '100%',
        flex: size === 'small' ? '0 0 auto' : undefined,
      }}
    >
      <Poster src={asset.posterUrl} />
      <Box padding={{ top: 'xs' }}>
        <Box variant="strong" fontSize={size === 'small' ? 'body-s' : 'body-m'}>
          {title}
        </Box>
        <Box padding={{ top: 'xxxs' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Badge color="blue">{qualityLabel(asset.srcHeight)}</Badge>
            <Box variant="small" color="text-status-inactive" display="inline">
              {timeAgo(asset.startTime)}
            </Box>
          </span>
        </Box>
      </Box>
    </a>
  );
}
