/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Documentation > Metadata: operator reference for the per-asset metadata + feature sidecars produced by
 * the Upload page (<source>.json / .esam.xml / .vtt). Static content — no API calls.
 */
import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Container,
  ContentLayout,
  Header,
  Link,
  SpaceBetween,
  StatusIndicator,
  Table,
} from '@cloudscape-design/components';

interface FieldRow {
  field: string;
  type: string;
  desc: string;
}

const SCHEMA_ROWS: FieldRow[] = [
  { field: 'schema', type: 'string', desc: "Schema version — 'vod-asset-metadata/1'." },
  { field: 'title', type: 'string | null', desc: 'Operator-supplied friendly title. Null when left blank.' },
  { field: 'adMarkers', type: 'boolean', desc: 'True when a SCTE-35 ESAM sidecar (<video>.esam.xml) was attached. False makes the pipeline ignore any .esam.xml at that key.' },
  { field: 'captions', type: 'boolean', desc: 'True when a WebVTT caption sidecar (<video>.vtt) was attached. False makes the pipeline ignore any .vtt at that key.' },
  { field: 'automatedCaptions', type: 'boolean', desc: 'Reserved — always false today (Amazon Transcribe not yet wired).' },
  { field: 'verticalCrop', type: 'boolean', desc: 'Reserved — always false today (ML auto-reframe not yet wired).' },
];

interface SidecarRow {
  file: string;
  purpose: string;
}

const SIDECAR_ROWS: SidecarRow[] = [
  { file: '<video>.json', purpose: 'Asset metadata (this schema). The pipeline reads its adMarkers / captions flags to decide whether to use the sidecars.' },
  { file: '<video>.esam.xml', purpose: 'SCTE-35 ad-break markers (ESAM SignalProcessingNotification), inserted at encode.' },
  { file: '<video>.vtt', purpose: 'WebVTT captions — WebVTT on HLS/CMAF, IMSC on DASH.' },
];

interface FeatureRow {
  feature: string;
  status: ReactNode;
  notes: string;
}

const FEATURE_ROWS: FeatureRow[] = [
  { feature: 'Ad markers (SCTE-35 ESAM)', status: <StatusIndicator type="success">Available</StatusIndicator>, notes: 'Attach ESAM XML on Upload; markers land in the HLS manifest + in-band (CMAF/DASH).' },
  { feature: 'Captions (WebVTT)', status: <StatusIndicator type="success">Available</StatusIndicator>, notes: 'Attach a .vtt on Upload; caption tracks are added to the delivery manifests.' },
];

export default function DocsMetadata() {
  const navigate = useNavigate();
  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Per-asset metadata and feature sidecars produced by the Upload page.">
          Sidecar files
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Overview</Header>}>
          <SpaceBetween size="s">
            <Box>
              The{' '}
              <Link onFollow={(e) => { e.preventDefault(); navigate('/upload'); }} href="/upload">
                Upload
              </Link>{' '}
              page's <b>Metadata</b> form captures a Title and optional feature toggles for a single video.
              On upload it writes a per-asset <Box variant="code" display="inline">&lt;video&gt;.json</Box>{' '}
              metadata sidecar next to the source, plus any feature sidecars (ESAM XML, WebVTT). All sidecars
              are uploaded before the video and are excluded from the ingest trigger, so they never start
              their own workflow.
            </Box>
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2" description="Written as <video>.json (schema vod-asset-metadata/1).">Metadata schema</Header>}>
          <Table<FieldRow>
            variant="embedded"
            items={SCHEMA_ROWS}
            columnDefinitions={[
              { id: 'field', header: 'Field', cell: (r) => <Box variant="code">{r.field}</Box> },
              { id: 'type', header: 'Type', cell: (r) => <Box variant="code">{r.type}</Box> },
              { id: 'desc', header: 'Description', cell: (r) => r.desc },
            ]}
          />
        </Container>

        <Container header={<Header variant="h2" description="Companion files uploaded alongside the source video.">Sidecar files</Header>}>
          <Table<SidecarRow>
            variant="embedded"
            items={SIDECAR_ROWS}
            columnDefinitions={[
              { id: 'file', header: 'File', cell: (r) => <Box variant="code">{r.file}</Box> },
              { id: 'purpose', header: 'Purpose', cell: (r) => r.purpose },
            ]}
          />
        </Container>

        <Container header={<Header variant="h2">Feature status</Header>}>
          <Table<FeatureRow>
            variant="embedded"
            items={FEATURE_ROWS}
            columnDefinitions={[
              { id: 'feature', header: 'Feature', cell: (r) => r.feature },
              { id: 'status', header: 'Status', cell: (r) => r.status },
              { id: 'notes', header: 'Notes', cell: (r) => r.notes },
            ]}
          />
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
