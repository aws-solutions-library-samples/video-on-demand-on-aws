/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Documentation > State Machines: operator reference for the four Step Functions state machines that
 * process every asset (Orchestrator -> Ingest -> Process -> Publish). Static content — no API calls.
 * The execution-graph screenshots under /public are illustrative only, captured from a single
 * successful run; see the callout below.
 */
import { useRef } from 'react';
import { Alert, Box, Button, Container, ContentLayout, Header, SpaceBetween } from '@cloudscape-design/components';

interface StageDoc {
  id: string;
  title: string;
  image: string;
  description: string;
}

const STAGES: StageDoc[] = [
  {
    id: 'orchestrator',
    title: 'Orchestrator',
    image: '/stepfunctions_graph.png',
    description:
      'The single per-asset execution and source of truth. Derives a deterministic guid, creates the ' +
      'DynamoDB item up front (a duplicate S3 event short-circuits to a benign "Duplicate Skipped"), then ' +
      'runs Ingest, Process, and Publish in turn as nested child executions. A single Catch on each child ' +
      'routes any failure to one centralized error record + notification.',
  },
  {
    id: 'ingest',
    title: 'Ingest',
    image: '/stepfunctions_graph (ingest).png',
    description:
      'Validates the incoming metadata, then probes the source with MediaConvert to read its video ' +
      'properties (resolution, etc.) and attaches the result to the asset record.',
  },
  {
    id: 'process',
    title: 'Process',
    image: '/stepfunctions_graph (process).png',
    description:
      'Chooses the SD / HD / UHD job template from the probed source height, then runs the MediaConvert ' +
      'transcode job (CMAF HLS + DASH, Automated ABR) and records the resulting outputs and playback URLs.',
  },
  {
    id: 'publish',
    title: 'Publish',
    image: '/stepfunctions_graph (publish).png',
    description:
      'Validates the encode output, tags the source for archival per the configured retention policy, and ' +
      'records the asset as Complete — with best-effort SNS/SQS notifications.',
  },
];

/** A stage's execution-graph image, plus a button that opens it in the browser's fullscreen mode. */
function StageGraph({ image, title }: { image: string; title: string }) {
  const imgRef = useRef<HTMLImageElement>(null);
  return (
    <SpaceBetween size="xs">
      <Box textAlign="right">
        <Button iconName="full-screen" onClick={() => imgRef.current?.requestFullscreen()}>
          View full screen
        </Button>
      </Box>
      <img
        ref={imgRef}
        src={image}
        alt={`${title} state machine — example graph from a successful execution`}
        style={{ maxWidth: '100%', borderRadius: 8 }}
      />
    </SpaceBetween>
  );
}

export default function DocsStateMachines() {
  return (
    <ContentLayout
      header={
        <Header variant="h1" description="The four Step Functions state machines behind every asset.">
          Workflow
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Overview</Header>}>
          <SpaceBetween size="s">
            <Box>
              Every uploaded asset runs through one parent <b>Orchestrator</b> state machine, which in turn
              runs three stage state machines — <b>Ingest</b>, <b>Process</b>, and <b>Publish</b> — as nested
              child executions. All workflow state (status, errors, outputs) is tracked on the asset's
              DynamoDB item, visible on each asset's detail page.
            </Box>
            <Alert type="warning" header="Examples only">
              The execution-graph screenshots below are captured from a single <b>successful</b> run of each
              state machine. They illustrate the happy path only — they do not show retry/backoff behavior,
              the error (<code>Catch</code>) branches, or the optional feature branches (ad markers,
              captions, packaging) that only appear when those overlays are enabled. Treat them as a
              reference for how a normal, successful asset flows through the pipeline, not as an exhaustive
              map of every possible execution.
            </Alert>
          </SpaceBetween>
        </Container>

        {STAGES.map((stage) => (
          <Container key={stage.id} header={<Header variant="h2">{stage.title}</Header>}>
            <SpaceBetween size="s">
              <Box>{stage.description}</Box>
              <StageGraph image={stage.image} title={stage.title} />
            </SpaceBetween>
          </Container>
        ))}
      </SpaceBetween>
    </ContentLayout>
  );
}
