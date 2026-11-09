/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Self-service media upload. Uploads the selected file(s) directly to the VOD source
 * bucket via Amplify Storage uploadData() using the signed-in user's Cognito Identity Pool credentials
 * (scoped by IAM to uploads/<identityId>/*). Landing an object in the source bucket triggers the
 * pipeline (S3 -> EventBridge -> Orchestrator).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  ContentLayout,
  FileUpload,
  Form,
  FormField,
  Grid,
  Header,
  Input,
  KeyValuePairs,
  Link,
  ProgressBar,
  SpaceBetween,
  Textarea,
  Toggle,
} from '@cloudscape-design/components';
import FileDropzone, { useFilesDragging } from '@cloudscape-design/components/file-dropzone';
import { uploadData } from 'aws-amplify/storage';
import { useExtensions } from '../context/ExtensionsContext';

const ACCEPT = '.mp4,.mov,.m4v,.ts,.mxf,.webm,video/*';
const ALLOWED_EXT = /\.(mp4|mov|m4v|ts|mxf|webm)$/i;
const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB client guard

/**
 * Example SCTE-35 ESAM SignalProcessingNotification (prefilled for the Ad markers sidecar). Two avails
 * (a START/END pair each) at 30s and 60s on the OUTPUT timeline; edit the nptPoint / startOffset /
 * duration to match your content. Uploaded verbatim as `<video>.esam.xml`.
 */
const DEFAULT_ESAM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SignalProcessingNotification xmlns="urn:cablelabs:iptvservices:esam:xsd:signal:1" xmlns:sig="urn:cablelabs:md:xsd:signaling:3.0" xmlns:common="urn:cablelabs:iptvservices:esam:xsd:common:1" acquisitionPointIdentity="VodAdMarkers">
  <common:BatchInfo batchId="1"><common:Source/></common:BatchInfo>
  <!-- Ad avail #1 at 30s (30s duration): START (52) + END (53). -->
  <ResponseSignal acquisitionPointIdentity="VodAdMarkers" acquisitionSignalID="1" signalPointID="30.00" action="create">
    <sig:NPTPoint nptPoint="30.00"/>
    <sig:SCTE35PointDescriptor spliceCommandType="06"><sig:SegmentationDescriptorInfo segmentEventId="1" segmentTypeId="52" upidType="9" upid="1" duration="PT30S" segmentNumber="1" segmentsExpected="1"/></sig:SCTE35PointDescriptor>
  </ResponseSignal>
  <ConditioningInfo acquisitionSignalIDRef="1" startOffset="PT30S" duration="PT30S"/>
  <ResponseSignal acquisitionPointIdentity="VodAdMarkers" acquisitionSignalID="2" signalPointID="30.00" action="create">
    <sig:NPTPoint nptPoint="30.00"/>
    <sig:SCTE35PointDescriptor spliceCommandType="06"><sig:SegmentationDescriptorInfo segmentEventId="1" segmentTypeId="53" upidType="9" upid="2"/></sig:SCTE35PointDescriptor>
  </ResponseSignal>
  <!-- Ad avail #2 at 60s (30s duration). -->
  <ResponseSignal acquisitionPointIdentity="VodAdMarkers" acquisitionSignalID="3" signalPointID="60.00" action="create">
    <sig:NPTPoint nptPoint="60.00"/>
    <sig:SCTE35PointDescriptor spliceCommandType="06"><sig:SegmentationDescriptorInfo segmentEventId="2" segmentTypeId="52" upidType="9" upid="3" duration="PT30S" segmentNumber="1" segmentsExpected="1"/></sig:SCTE35PointDescriptor>
  </ResponseSignal>
  <ConditioningInfo acquisitionSignalIDRef="3" startOffset="PT60S" duration="PT30S"/>
  <ResponseSignal acquisitionPointIdentity="VodAdMarkers" acquisitionSignalID="4" signalPointID="60.00" action="create">
    <sig:NPTPoint nptPoint="60.00"/>
    <sig:SCTE35PointDescriptor spliceCommandType="06"><sig:SegmentationDescriptorInfo segmentEventId="2" segmentTypeId="53" upidType="9" upid="4"/></sig:SCTE35PointDescriptor>
  </ResponseSignal>
</SignalProcessingNotification>
`;

/** Human-readable byte size (e.g. 1536 -> "1.5 KB"). */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function Upload() {
  const extensions = useExtensions();
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(0);
  const [currentName, setCurrentName] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  // Optional per-asset metadata + sidecars (single-file uploads only — Title/ESAM/VTT are per-asset).
  const [title, setTitle] = useState('');
  const [adMarkers, setAdMarkers] = useState(false);
  const [esamXml, setEsamXml] = useState(DEFAULT_ESAM_XML);
  const [captions, setCaptions] = useState(false);
  const [captionFiles, setCaptionFiles] = useState<File[]>([]);

  const { areFilesDragging } = useFilesDragging();

  const invalid = files.filter((f) => !ALLOWED_EXT.test(f.name) || f.size > MAX_BYTES);
  const ready = files.filter((f) => !invalid.includes(f));
  const totalBytes = ready.reduce((sum, f) => sum + f.size, 0);

  // Per-asset metadata (Title) + sidecars attach to a single video, so the Metadata section is disabled
  // while more than one file is staged and nothing in it is uploaded. Its values are kept, and apply again
  // when the staging is back to one file.
  const multiFile = files.length > 1;
  const captionFile = captionFiles[0];
  const sidecarError = multiFile
    ? undefined
    : adMarkers && !esamXml.trim()
      ? 'Ad markers is on but the ESAM XML is empty.'
      : captions && !captionFile
        ? 'Captions is on but no .vtt file is selected.'
        : undefined;
  const canUpload = files.length > 0 && invalid.length === 0 && !sidecarError && !uploading;

  /** Append dropped files, skipping ones already staged (matched by name + size). */
  function addFiles(incoming: File[]) {
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    setDone([]);
    setError(undefined);
  }

  async function upload() {
    setError(undefined);
    setDone([]);
    setUploading(true);
    try {
      for (const file of files) {
        setCurrentName(file.name);
        setPct(0);
        // Upload the optional sidecars FIRST (tiny) so they exist before the workflow's read step. They
        // land at `<video-key>.json` / `.vtt` / `.esam.xml`, which the pipeline reads (or reserves) as
        // `<srcVideo>.<suffix>` — the S3->EventBridge trigger ignores those suffixes, so they don't start
        // their own workflow. The .json metadata sidecar is ALWAYS written for a single-file upload: its
        // adMarkers/captions flags gate the pipeline's sidecar reads, so a re-upload to the same key with a
        // toggle off ignores the stale .esam.xml / .vtt an earlier upload left there.
        if (!multiFile) {
          const meta = {
            schema: 'vod-asset-metadata/1',
            title: title.trim() || null,
            adMarkers,
            captions,
            automatedCaptions: false,
            verticalCrop: false,
          };
          await uploadData({
            path: ({ identityId }) => `uploads/${identityId}/${file.name}.json`,
            data: new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }),
            options: { contentType: 'application/json' },
          }).result;
        }
        if (!multiFile && captions && captionFile) {
          await uploadData({
            path: ({ identityId }) => `uploads/${identityId}/${file.name}.vtt`,
            data: captionFile,
            options: { contentType: 'text/vtt' },
          }).result;
        }
        if (!multiFile && adMarkers && esamXml.trim()) {
          await uploadData({
            path: ({ identityId }) => `uploads/${identityId}/${file.name}.esam.xml`,
            data: new Blob([esamXml], { type: 'application/xml' }),
            options: { contentType: 'application/xml' },
          }).result;
        }
        await uploadData({
          path: ({ identityId }) => `uploads/${identityId}/${file.name}`,
          data: file,
          options: {
            contentType: file.type || 'application/octet-stream',
            onProgress: ({ transferredBytes, totalBytes }) => {
              if (totalBytes) setPct(Math.round((transferredBytes / totalBytes) * 100));
            },
          },
        }).result;
        setDone((d) => [...d, file.name]);
      }
      setFiles([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
      setCurrentName('');
    }
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Upload a media file to start a transcode. Files land in the pipeline source bucket and trigger processing automatically."
        >
          Upload media
        </Header>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canUpload) upload();
        }}
      >
        <Form
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {files.length > 0 && !uploading && (
                <Button
                  variant="link"
                  onClick={() => {
                    setFiles([]);
                    setDone([]);
                    setError(undefined);
                  }}
                >
                  Clear
                </Button>
              )}
              <Button
                variant="primary"
                loading={uploading}
                disabled={!canUpload}
                onClick={upload}
              >
                {uploading ? 'Uploading' : `Upload${ready.length > 1 ? ` ${ready.length} files` : ''}`}
              </Button>
            </SpaceBetween>
          }
        >
          <SpaceBetween size="l">
            <Grid gridDefinition={[{ colspan: { default: 12, m: 8 } }, { colspan: { default: 12, m: 4 } }]}>
              <Container
                header={
                  <Header variant="h2" description="Drag and drop files anywhere here, or choose them to stage for upload.">
                    Select media
                  </Header>
                }
              >
                <SpaceBetween size="l">
                  <FileDropzone onChange={({ detail }) => addFiles(detail.value)}>
                    <SpaceBetween size="s" alignItems="center">
                      <Box variant="strong" textAlign="center">
                        {areFilesDragging ? 'Drop files to upload' : 'Drag and drop video files here'}
                      </Box>
                      <Box variant="small" color="text-body-secondary" textAlign="center">
                        mp4, mov, m4v, ts, mxf, webm — up to 5 GB each
                      </Box>
                      <FileUpload
                        multiple
                        accept={ACCEPT}
                        value={files}
                        onChange={({ detail }) => {
                          setFiles(detail.value);
                          setDone([]);
                          setError(undefined);
                        }}
                        showFileSize
                        showFileLastModified
                        tokenLimit={5}
                        i18nStrings={{
                          uploadButtonText: (multiple) => (multiple ? 'Choose files' : 'Choose file'),
                          dropzoneText: (multiple) => (multiple ? 'Drop files to upload' : 'Drop file to upload'),
                          removeFileAriaLabel: (idx) => `Remove file ${idx + 1}`,
                          limitShowFewer: 'Show fewer files',
                          limitShowMore: 'Show more files',
                          errorIconAriaLabel: 'Error',
                        }}
                      />
                    </SpaceBetween>
                  </FileDropzone>
                  {ready.length > 0 && (
                    <KeyValuePairs
                      columns={2}
                      items={[
                        { label: 'Ready to upload', value: `${ready.length} file${ready.length > 1 ? 's' : ''}` },
                        { label: 'Total size', value: formatBytes(totalBytes) },
                      ]}
                    />
                  )}
                </SpaceBetween>
              </Container>

              <Container header={<Header variant="h2">How it works</Header>}>
                <SpaceBetween size="m">
                  <Box>
                    <Box variant="awsui-key-label">1. Choose media</Box>
                    Drop or select video files — mp4, mov, m4v, ts, mxf, or webm, up to 5 GB each.
                  </Box>
                  <Box>
                    <Box variant="awsui-key-label">2. Upload</Box>
                    Files stream straight to the pipeline source bucket using your signed-in credentials.
                  </Box>
                  <Box>
                    <Box variant="awsui-key-label">3. Transcode</Box>
                    Landing a file starts the workflow automatically. Track progress on the{' '}
                    <Link
                      href="/assets"
                      onFollow={(e) => {
                        e.preventDefault();
                        navigate('/assets');
                      }}
                    >
                      Assets
                    </Link>{' '}
                    page.
                  </Box>
                </SpaceBetween>
              </Container>
            </Grid>

            <Container
              header={
                <Header
                  variant="h2"
                  description="Title + optional feature sidecars for this asset. Applies to a single staged video."
                >
                  Metadata (optional)
                </Header>
              }
            >
              <SpaceBetween size="l">
                {multiFile && (
                  <Alert type="info">
                    Metadata applies to a single video. Stage one file to add a title, ad markers or captions.
                  </Alert>
                )}
                <FormField label="Title" description="Friendly asset title, saved to the metadata sidecar (<video>.json).">
                  <Input
                    disabled={multiFile}
                    value={title}
                    onChange={({ detail }) => setTitle(detail.value)}
                    placeholder="e.g. Acme Launch Keynote"
                  />
                </FormField>
                <Toggle disabled={multiFile} checked={adMarkers} onChange={({ detail }) => setAdMarkers(detail.checked)}>
                  Ad markers (SCTE-35 ESAM)
                </Toggle>
                {adMarkers && !multiFile && (
                  <FormField
                    label="ESAM SCC XML"
                    description="Uploaded as <video>.esam.xml. NPT points are seconds on the output timeline — edit to match your content."
                  >
                    <Textarea
                      value={esamXml}
                      onChange={({ detail }) => setEsamXml(detail.value)}
                      rows={12}
                      spellcheck={false}
                      disableBrowserAutocorrect
                    />
                  </FormField>
                )}
                <Toggle disabled={multiFile} checked={captions} onChange={({ detail }) => setCaptions(detail.checked)}>
                  Captions (WebVTT)
                </Toggle>
                {captions && !multiFile && (
                  <FormField label="Caption file (.vtt)" description="Uploaded as <video>.vtt — WebVTT on HLS/CMAF, IMSC on DASH.">
                    <FileUpload
                      accept=".vtt,text/vtt"
                      value={captionFiles}
                      onChange={({ detail }) => setCaptionFiles(detail.value)}
                      showFileSize
                      tokenLimit={1}
                      i18nStrings={{
                        uploadButtonText: () => 'Choose .vtt',
                        dropzoneText: () => 'Drop .vtt to upload',
                        removeFileAriaLabel: (idx) => `Remove file ${idx + 1}`,
                        limitShowFewer: 'Show fewer files',
                        limitShowMore: 'Show more files',
                        errorIconAriaLabel: 'Error',
                      }}
                    />
                  </FormField>
                )}
                {/* Enabled extensions' extra options (none in the base console). */}
                {!multiFile && extensions.flatMap((ext) => ext.uploadMetadataExtras ?? []).map((Extra, i) => (
                  <Extra key={i} />
                ))}
              </SpaceBetween>
            </Container>

            {sidecarError && (
              <Alert type="warning" header="Sidecar options">
                {sidecarError}
              </Alert>
            )}
            {invalid.length > 0 && (
              <Alert type="warning" header="Unsupported files">
                Remove before uploading: {invalid.map((f) => f.name).join(', ')} (must be a supported video type under 5 GB).
              </Alert>
            )}
            {uploading && <ProgressBar value={pct} label={`Uploading ${currentName}`} description={`${pct}%`} />}
            {done.length > 0 && !uploading && (
              <Alert type="success" header="Upload complete">
                {done.length} file(s) uploaded — the pipeline has started.{' '}
                <Link
                  href="/assets"
                  onFollow={(e) => {
                    e.preventDefault();
                    navigate('/assets');
                  }}
                >
                  View assets
                </Link>
              </Alert>
            )}
            {error && (
              <Alert type="error" header="Upload failed">
                {error}
              </Alert>
            )}
          </SpaceBetween>
        </Form>
      </form>
    </ContentLayout>
  );
}
