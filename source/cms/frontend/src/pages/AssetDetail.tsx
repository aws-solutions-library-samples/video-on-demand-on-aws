/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Asset detail: key/value overview + playback URLs + a deep link to the per-asset Step Functions
 * execution, via the authed API.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Box,
  Button,
  Container,
  ContentLayout,
  ExpandableSection,
  Grid,
  Header,
  KeyValuePairs,
  Link,
  Modal,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Table,
} from '@cloudscape-design/components';
import { fetchAsset, redriveAsset } from '../lib/api';
import { canRedrive, statusType } from '../lib/status';
import { formatTitle, qualityLabel, timeAgo } from '../lib/format';
import AssetPlayer from '../components/AssetPlayer';
import AbrLadder from '../components/AbrLadder';
import Poster from '../components/Poster';
import PosterPicker from '../components/PosterPicker';
import QualityMetricsPanel from '../components/QualityMetricsPanel';
import { deriveStreamUrls } from '../lib/streams';
import { parseEsamAvails, formatTimecode } from '../lib/adMarkers';
import type { Asset } from '../types';

/**
 * Build a Step Functions console deep link to a specific execution from its ARN. The Ingest/Process/
 * Publish stage runs are child executions nested inside this orchestrator execution, so this single
 * link reaches all four state machines for the asset. Region is read from the ARN
 * (arn:aws:states:<region>:<acct>:execution:...).
 */
function sfnExecutionUrl(arn?: string | null): string | null {
  if (!arn) return null;
  const region = arn.split(':')[3];
  if (!region) return null;
  return `https://${region}.console.aws.amazon.com/states/home?region=${region}#/v2/executions/details/${arn}`;
}

export default function AssetDetail() {
  const { guid = '' } = useParams();
  const navigate = useNavigate();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  // re-drive: confirm modal + in-flight + result notice.
  const [confirmRedrive, setConfirmRedrive] = useState(false);
  const [redriving, setRedriving] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | undefined>();

  const load = useCallback(() => {
    setLoading(true);
    setError(undefined);
    fetchAsset(guid)
      .then(setAsset)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [guid]);

  useEffect(load, [load]);

  async function doRedrive() {
    setRedriving(true);
    setNotice(undefined);
    try {
      await redriveAsset(guid);
      setConfirmRedrive(false);
      setNotice({ type: 'success', text: 'Re-drive started. The asset is reprocessing from Ingest; refresh to follow its status.' });
      load();
    } catch (e) {
      setNotice({ type: 'error', text: `Re-drive failed: ${String(e)}` });
    } finally {
      setRedriving(false);
    }
  }

  // CMAF-HLS URL: prefer the server-recorded value (Publish stage persists cmafUrl); fall back to the
  // derived /cmaf sibling for assets packaged before it was recorded. Undefined for GA flat assets.
  const cmafUrl = asset ? asset.cmafUrl ?? deriveStreamUrls(asset).cmafUrl : undefined;

  // Ad avails parsed from the persisted ESAM SCC XML (the source of truth for SCTE-35 markers).
  const adAvails = useMemo(() => parseEsamAvails(asset?.adMarkersEsamXml), [asset]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {asset && canRedrive(asset.workflowStatus) && (
                <Button iconName="refresh" onClick={() => setConfirmRedrive(true)} disabled={redriving}>
                  Re-drive
                </Button>
              )}
              <Button iconName="arrow-left" onClick={() => navigate('/assets')}>
                Back to assets
              </Button>
            </SpaceBetween>
          }
        >
          {formatTitle(asset?.srcVideo, guid)}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {notice && (
          <Alert
            type={notice.type}
            dismissible
            onDismiss={() => setNotice(undefined)}
            header={notice.type === 'success' ? 'Re-drive started' : 'Re-drive failed'}
          >
            {notice.text}
          </Alert>
        )}
        {error && (
          <Alert type="error" header="Failed to load asset">
            {error}
          </Alert>
        )}
        {loading ? (
          <Spinner size="large" />
        ) : asset ? (
          (() => {
            const execUrl = sfnExecutionUrl(asset.orchestratorExecutionArn);
            // Bottom row: ladder + ad markers share a row when both exist; either alone spans full width.
            const hasLadder = !!asset.hlsUrl;
            const hasAd = !!asset.adMarkersEsamXml;
            const bottom: { def: { colspan: Record<string, number> }; node: ReactNode }[] = [];
            if (hasLadder) {
              bottom.push({
                def: { colspan: hasAd ? { default: 12, l: 8 } : { default: 12 } },
                node: (
                  <Container
                    fitHeight
                    header={
                      <Header variant="h2" description="Output renditions delivered for this asset: reported bitrate parsed from the HLS manifest, actual (video-only) bitrate measured from the delivered CMAF files.">
                        Adaptive bitrate ladder
                      </Header>
                    }
                  >
                    <AbrLadder hlsUrl={asset.hlsUrl} guid={asset.guid} />
                  </Container>
                ),
              });
            }
            if (hasAd) {
              bottom.push({
                def: { colspan: hasLadder ? { default: 12, l: 4 } : { default: 12 } },
                node: (
                  <Container
                    fitHeight
                    header={
                      <Header variant="h2" description={`${adAvails.length} ad avail${adAvails.length === 1 ? '' : 's'} from the ESAM sidecar (SCTE-35).`}>
                        Ad markers
                      </Header>
                    }
                  >
                    <SpaceBetween size="m">
                      {adAvails.length > 0 ? (
                        <Table
                          variant="embedded"
                          items={adAvails}
                          columnDefinitions={[
                            { id: 'index', header: '#', cell: (a) => a.index, width: 60 },
                            { id: 'start', header: 'Start', cell: (a) => formatTimecode(a.startSeconds) },
                            { id: 'duration', header: 'Duration', cell: (a) => (a.durationSeconds ? `${a.durationSeconds}s` : 'open') },
                          ]}
                        />
                      ) : (
                        <StatusIndicator type="warning">
                          Could not parse ad avails from the ESAM XML - showing the raw source below.
                        </StatusIndicator>
                      )}
                      <ExpandableSection headerText="ESAM SCC XML (source)">
                        <Box variant="code">
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{asset.adMarkersEsamXml}</pre>
                        </Box>
                      </ExpandableSection>
                    </SpaceBetween>
                  </Container>
                ),
              });
            }
            if (asset.qualityMetrics.length > 0 && asset.guid) {
              bottom.push({
                def: { colspan: { default: 12 } },
                node: (
                  <Container
                    fitHeight
                    header={
                      <Header
                        variant="h2"
                        description={`${asset.qualityMetrics.join(', ')} per-frame reports from the MediaConvert encode.`}
                      >
                        Quality metrics
                      </Header>
                    }
                  >
                    <QualityMetricsPanel guid={asset.guid} />
                  </Container>
                ),
              });
            }
            if (asset.thumbnailsPrefix && asset.guid) {
              bottom.push({
                def: { colspan: { default: 12 } },
                node: (
                  <Container
                    fitHeight
                    header={
                      <Header variant="h2" description="Pick a scrub-bar frame to use as the poster instead of the default first frame.">
                        Poster
                      </Header>
                    }
                  >
                    <PosterPicker
                      guid={asset.guid}
                      currentPosterUrl={asset.posterUrl}
                      onPosterUpdated={(posterUrl) => setAsset((prev) => (prev ? { ...prev, posterUrl } : prev))}
                    />
                  </Container>
                ),
              });
            }

            return (
              <SpaceBetween size="l">
                {/* Hero: poster + title + status + at-a-glance badges. */}
                <Container media={{ content: <Poster src={asset.posterUrl} />, position: 'side', width: '40%' }}>
                  <SpaceBetween size="s">
                    <Box variant="h2">{formatTitle(asset.srcVideo, asset.guid)}</Box>
                    <StatusIndicator type={statusType(asset.workflowStatus)}>
                      {asset.workflowStatus ?? 'Unknown'}
                    </StatusIndicator>
                    <SpaceBetween direction="horizontal" size="xs">
                      <Badge color="blue">{qualityLabel(asset.srcHeight)}</Badge>
                      {asset.hasAdBreaks && <Badge color="green">Ad breaks</Badge>}
                    </SpaceBetween>
                    <Box variant="small" color="text-status-inactive">
                      {asset.srcVideo ?? '-'} · {timeAgo(asset.startTime)}
                    </Box>
                  </SpaceBetween>
                </Container>

                {/* Metric cards: Details / Playback / Workflow, 3-across on desktop. */}
                <Grid
                  gridDefinition={[
                    { colspan: { default: 12, m: 4 } },
                    { colspan: { default: 12, m: 4 } },
                    { colspan: { default: 12, m: 4 } },
                  ]}
                >
                  <Container fitHeight header={<Header variant="h2">Details</Header>}>
                    <KeyValuePairs
                      columns={2}
                      items={[
                        { label: 'Tier', value: asset.encodingProfile ?? '-' },
                        { label: 'Source height', value: asset.srcHeight ?? '-' },
                        { label: 'Started', value: asset.startTime ?? '-' },
                        { label: 'Ended', value: asset.endTime ?? '-' },
                        { label: 'Archive class', value: asset.archiveSource ?? '-' },
                        { label: 'GUID', value: asset.guid ?? '-' },
                        ...(asset.errorMessage ? [{ label: 'Error', value: asset.errorMessage }] : []),
                      ]}
                    />
                  </Container>
                  <Container fitHeight header={<Header variant="h2">Playback</Header>}>
                    <KeyValuePairs
                      columns={1}
                      items={[
                        { label: 'HLS', value: asset.hlsUrl ? <Link external href={asset.hlsUrl}>{asset.hlsUrl}</Link> : '-' },
                        { label: 'DASH', value: asset.dashUrl ? <Link external href={asset.dashUrl}>{asset.dashUrl}</Link> : '-' },
                        ...(cmafUrl ? [{ label: 'CMAF-HLS', value: <Link external href={cmafUrl}>{cmafUrl}</Link> }] : []),
                        ...(asset.ssaiHlsUrl
                          ? [{ label: 'HLS (SSAI via MediaTailor)', value: <Link external href={asset.ssaiHlsUrl}>{asset.ssaiHlsUrl}</Link> }]
                          : []),
                        ...(asset.qualityMetrics.length ? [{ label: 'Quality metrics', value: asset.qualityMetrics.join(', ') }] : []),
                      ]}
                    />
                  </Container>
                  <Container
                    fitHeight
                    header={
                      <Header variant="h2" description="Ingest, Process and Publish runs nest inside this orchestrator execution.">
                        Workflow
                      </Header>
                    }
                  >
                    <KeyValuePairs
                      columns={1}
                      items={[
                        {
                          label: 'Step Functions execution',
                          value: execUrl ? (
                            <Link external href={execUrl}>
                              View orchestrator execution in the Step Functions console
                            </Link>
                          ) : (
                            '-'
                          ),
                        },
                      ]}
                    />
                  </Container>
                </Grid>

                {(asset.hlsUrl || asset.dashUrl) && (
                  <Container header={<Header variant="h2">Player</Header>}>
                    <AssetPlayer asset={asset} />
                  </Container>
                )}

                {bottom.length > 0 && (
                  <Grid gridDefinition={bottom.map((b) => b.def)}>
                    {bottom.map((b, i) => (
                      <div key={i}>{b.node}</div>
                    ))}
                  </Grid>
                )}
              </SpaceBetween>
            );
          })()
        ) : (
          <Box textAlign="center">Asset not found</Box>
        )}
      </SpaceBetween>

      <Modal
        visible={confirmRedrive}
        onDismiss={() => setConfirmRedrive(false)}
        header="Re-drive failed asset"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setConfirmRedrive(false)} disabled={redriving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={doRedrive} loading={redriving}>
                Re-drive
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            This clears the failed record for <Box variant="strong">{asset?.srcVideo ?? guid}</Box> and starts a new
            transcode of the current source object from the beginning (Ingest → Process → Publish).
          </Box>
          <Box color="text-status-inactive">
            A new MediaConvert job runs and incurs transcode cost. Only do this once the cause of the failure has been
            addressed.
          </Box>
        </SpaceBetween>
      </Modal>
    </ContentLayout>
  );
}
