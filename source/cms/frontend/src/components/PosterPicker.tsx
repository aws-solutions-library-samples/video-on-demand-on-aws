/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Poster override: browse every scrub-bar thumbnail (FRAME_CAPTURE JPEG) the thumbnailsProfile
 * overlay generated for an asset and pick one to replace the default poster (the pipeline's first
 * capture). Lazily loaded on first expand, same pattern as QualityMetricsPanel — nothing is fetched
 * until the section is opened. Selecting a frame is a two-step action (click to select, then "Set as
 * poster" to save) so a stray click never silently changes the poster.
 */
import { useState } from 'react';
import { Alert, Box, Button, ExpandableSection, SpaceBetween, Spinner, StatusIndicator } from '@cloudscape-design/components';
import { fetchThumbnailsManifest, setPoster } from '../lib/api';
import type { ThumbnailFrame } from '../types';

const THUMB_STYLE = {
  width: 120,
  aspectRatio: '16 / 9',
  objectFit: 'cover' as const,
  display: 'block',
  borderRadius: 4,
};

export default function PosterPicker({
  guid,
  currentPosterUrl,
  onPosterUpdated,
}: {
  guid: string;
  currentPosterUrl?: string | null;
  onPosterUpdated: (posterUrl: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [frames, setFrames] = useState<ThumbnailFrame[] | null>(null);
  const [selected, setSelected] = useState<ThumbnailFrame | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [justSaved, setJustSaved] = useState(false);

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const manifest = await fetchThumbnailsManifest(guid);
      setFrames(manifest.frames);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function select(frame: ThumbnailFrame) {
    setSelected(frame);
    setJustSaved(false);
    setSaveError(undefined);
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const { posterUrl } = await setPoster(guid, selected.key);
      onPosterUpdated(posterUrl);
      setSelected(null);
      setJustSaved(true);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ExpandableSection
      headerText="Browse thumbnails and choose a poster (fetched from the CDN; may take a moment for long assets)"
      expanded={expanded}
      onChange={({ detail }) => {
        setExpanded(detail.expanded);
        if (detail.expanded && !frames && !loading) load();
      }}
    >
      {loading ? (
        <Spinner />
      ) : error ? (
        <StatusIndicator type="warning">Couldn&apos;t load thumbnails ({error}).</StatusIndicator>
      ) : frames && frames.length > 0 ? (
        <SpaceBetween size="m">
          {saveError && (
            <Alert type="error" dismissible onDismiss={() => setSaveError(undefined)}>
              Couldn&apos;t set poster: {saveError}
            </Alert>
          )}
          {justSaved && (
            <Alert type="success" dismissible onDismiss={() => setJustSaved(false)}>
              Poster updated.
            </Alert>
          )}
          <Box variant="small" color="text-status-inactive">
            Blue border = current poster. Click a frame to select it, orange = pending selection.
          </Box>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
            {frames.map((f) => {
              const isCurrent = !!currentPosterUrl && f.url === currentPosterUrl;
              const isSelected = selected?.key === f.key;
              const border = isSelected ? '3px solid #ec7211' : isCurrent ? '3px solid #0972d3' : '3px solid transparent';
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => select(f)}
                  aria-label={`Use ${f.key} as the poster`}
                  aria-pressed={isSelected}
                  style={{ padding: 0, border, borderRadius: 6, cursor: 'pointer', background: 'none' }}
                >
                  <img src={f.url} alt="" loading="lazy" style={THUMB_STYLE} />
                </button>
              );
            })}
          </div>
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" disabled={!selected} loading={saving} onClick={save}>
              Set as poster
            </Button>
            {selected && (
              <Button variant="link" onClick={() => setSelected(null)} disabled={saving}>
                Cancel selection
              </Button>
            )}
          </SpaceBetween>
        </SpaceBetween>
      ) : frames ? (
        <StatusIndicator type="info">No thumbnails available for this asset.</StatusIndicator>
      ) : null}
    </ExpandableSection>
  );
}
