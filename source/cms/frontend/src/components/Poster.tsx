/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Shared 16:9 poster frame with a CSS-only fallback. Renders the poster image when present and loading;
 * on a missing/404'd source it shows a navy block with a centered play glyph (no image asset), matching
 * the Assets table idiom. Used by the Portal VideoCard and the asset-detail hero. Cloudscape/inline only.
 */
import { type CSSProperties, useState } from 'react';
import { AWS_NAVY, AWS_ORANGE } from '../theme/tokens';

/** 16:9 frame shared by the image and the placeholder so both keep the same footprint. */
export const FRAME_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '16 / 9',
  borderRadius: 8,
  overflow: 'hidden',
  background: AWS_NAVY,
};

const IMG_STYLE: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };

export default function Poster({
  src,
  alt = '',
  style,
}: {
  src?: string | null;
  alt?: string;
  style?: CSSProperties;
}) {
  const [broken, setBroken] = useState(false);
  const frame = style ? { ...FRAME_STYLE, ...style } : FRAME_STYLE;

  if (!src || broken) {
    return (
      <div style={{ ...frame, display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
        <span style={{ fontSize: '2.5rem', lineHeight: 1, color: AWS_ORANGE }}>▶</span>
      </div>
    );
  }
  return (
    <div style={frame}>
      <img src={src} alt={alt} loading="lazy" style={IMG_STYLE} onError={() => setBroken(true)} />
    </div>
  );
}
