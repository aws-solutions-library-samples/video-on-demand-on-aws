/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the captions (WebVTT/IMSC) overlay (`captionsProfile`). Mirrors the ad-markers
 * overlay tests: OFF must be byte-identical (no CaptionSelector/CaptionDescriptions, no Captions? branch,
 * no Read Caption Sidecar), ON must splice the input CaptionSelector + per-format caption outputs and the
 * runtime graceful-skip branch, captions must reach the REMUX_ALL delivery via the job1 ladder (job2
 * passthrough unchanged), and the overlay must COEXIST with the ad-markers overlay (four encode chains).
 */

import { buildJobSettings, composeProcessAsl, composeOrchestratorAsl, JsonObject } from '../lib/asl';
import { parseVodContext, ContextReader, VodContext } from '../lib/context';

function ctx(values: Record<string, unknown>): VodContext {
  const reader: ContextReader = { tryGetContext: (k: string) => values[k] };
  return parseVodContext(reader);
}

// Explicit thumbnailsProfile: 'OFF' — thumbnails default flipped to ON; OFF here means "pure GA core,
// nothing on" for the byte-identical baseline below.
const OFF = ctx({ email: 'ci@example.com', thumbnailsProfile: 'OFF' });
const CAP = ctx({ email: 'ci@example.com', captionsProfile: 'ON' });
const CAP_PKG = ctx({ email: 'ci@example.com', captionsProfile: 'ON', packagingProfile: 'ON' });
const CAP_ADM = ctx({ email: 'ci@example.com', captionsProfile: 'ON', adMarkersProfile: 'ON' });
const CAP_ADM_PKG = ctx({
  email: 'ci@example.com',
  captionsProfile: 'ON',
  adMarkersProfile: 'ON',
  packagingProfile: 'ON',
});

const SOURCE_FILE_REF = "States.Format('s3://{}/{}.vtt', $.srcBucket, $.srcVideo)";

const inputOf = (settings: JsonObject): JsonObject => (settings.Inputs as JsonObject[])[0];
const captionSelector = (settings: JsonObject): JsonObject | undefined =>
  (inputOf(settings).CaptionSelectors as JsonObject | undefined)?.['Captions Selector 1'] as JsonObject | undefined;
const groupByName = (settings: JsonObject, name: string): JsonObject =>
  (settings.OutputGroups as JsonObject[]).find((g) => g.Name === name) as JsonObject;
const captionOutput = (group: JsonObject): JsonObject | undefined =>
  (group.Outputs as JsonObject[]).find((o) => o.NameModifier === '_captions') as JsonObject | undefined;
const destinationType = (group: JsonObject): string | undefined =>
  ((captionOutput(group)?.CaptionDescriptions as JsonObject[] | undefined)?.[0]?.DestinationSettings as
    | JsonObject
    | undefined)?.DestinationType as string | undefined;

describe('buildJobSettings — captions injection', () => {
  test('no captions option => byte-identical (no CaptionSelectors, no _captions output)', () => {
    const s = buildJobSettings('sd');
    expect(inputOf(s).CaptionSelectors).toBeUndefined();
    expect(captionOutput(groupByName(s, 'CMAF'))).toBeUndefined();
  });

  test('GA CMAF tier: input CaptionSelector (WebVTT sidecar) + a WebVTT caption output on the CMAF group', () => {
    const s = buildJobSettings('hd', { captions: { sourceFileRef: SOURCE_FILE_REF } });
    const selector = captionSelector(s) as JsonObject;
    const fileSource = (selector.SourceSettings as JsonObject).FileSourceSettings as JsonObject;
    expect((selector.SourceSettings as JsonObject).SourceType).toBe('WEBVTT');
    expect(fileSource['SourceFile.$']).toBe(SOURCE_FILE_REF);
    expect(destinationType(groupByName(s, 'CMAF'))).toBe('WEBVTT');
  });

  test('package (REMUX_ALL job2): a caption output on all three groups — WebVTT (HLS/CMAF), IMSC (DASH)', () => {
    const s = buildJobSettings('package', {
      inputRef: "States.Format('s3://${INTERMEDIATE_BUCKET}/{}/stream.m3u8', $.guid)",
      groupSubPaths: { 'HLS-TS': 'hls/index', 'CMAF-HLS': 'cmaf/index', DASH: 'dash/index' },
      captions: { sourceFileRef: SOURCE_FILE_REF },
    });
    expect(captionSelector(s)).toBeDefined();
    expect(destinationType(groupByName(s, 'HLS-TS'))).toBe('WEBVTT');
    expect(destinationType(groupByName(s, 'CMAF-HLS'))).toBe('WEBVTT');
    expect(destinationType(groupByName(s, 'DASH'))).toBe('IMSC');
  });
});

describe('composeProcessAsl — captions OFF (byte-identical)', () => {
  const states = composeProcessAsl(OFF).States as JsonObject;
  test('no Captions? gate and no (Captions) clones', () => {
    expect(states['Captions?']).toBeUndefined();
    expect(states['Choose Tier (Captions)']).toBeUndefined();
    expect(states['Encode SD (Captions)']).toBeUndefined();
  });
});

describe('composeProcessAsl — captions ON (packaging OFF, GA CMAF): JSONata variant lookup, no Choice/clones', () => {
  const states = composeProcessAsl(CAP).States as JsonObject;

  test('no Captions? gate, no clones — Encode SD converts in place', () => {
    expect(states['Captions?']).toBeUndefined();
    expect(states['Choose Tier (Captions)']).toBeUndefined();
    expect(states['Encode SD (Captions)']).toBeUndefined();
    expect((states['Check Video Track'] as JsonObject).Choices).toEqual([
      expect.objectContaining({ Next: 'Choose Tier' }),
    ]);
  });

  test('the "plain"/"captions" variants are embedded, keyed on captionsEnabled with an $exists graceful-skip guard', () => {
    const encode = states['Encode SD'] as JsonObject;
    expect(encode.QueryLanguage).toBe('JSONata');
    const settingsExpr = (encode.Arguments as JsonObject).Settings as string;
    expect(settingsExpr).toContain('"plain":{');
    expect(settingsExpr).toContain('"captions":{');
    expect(settingsExpr).not.toContain('"esam":{');
    expect(settingsExpr).not.toContain('"both":{');
    expect(settingsExpr).toContain('$exists($states.input.config.captions.captionsEnabled)');
    expect(settingsExpr).toContain("$states.input.config.captions.captionsEnabled = 'true'");
  });

  test('the "captions" variant (built the same way applyCaptionsAndAdMarkersOverlays does) carries a CaptionSelector; "plain" does not', () => {
    const captionsVariant = buildJobSettings('sd', { jsonata: true, captions: { sourceFileRef: SOURCE_FILE_REF } });
    const plainVariant = buildJobSettings('sd', { jsonata: true });
    expect(captionSelector(captionsVariant)).toBeDefined();
    expect(captionSelector(plainVariant)).toBeUndefined();
  });
});

describe('composeProcessAsl — captions ON + packaging ON (captions on the REMUX_ALL job2)', () => {
  const states = composeProcessAsl(CAP_PKG).States as JsonObject;

  test('no clones — Encode SD (job1) and Package DRM (job2) both convert in place', () => {
    expect(states['Encode SD (Captions)']).toBeUndefined();
    expect(states['Package DRM (Captions)']).toBeUndefined();
    expect((states['Encode SD'] as JsonObject).Next).toBe('Package DRM'); // still the single Package DRM.
  });

  test("job1 (Encode SD)'s variants never mention captions — a REMUX_ALL job2 doesn't carry a caption rendition through", () => {
    const encodeSettingsExpr = ((states['Encode SD'] as JsonObject).Arguments as JsonObject).Settings as string;
    expect(encodeSettingsExpr).not.toContain('"captions":{');
    expect(encodeSettingsExpr).not.toContain('config.captions.captionsEnabled');
  });

  test('Package DRM (job2) carries the "captions" variant, sourcing the sidecar + emitting outputs on all three groups', () => {
    const pkgSettingsExpr = ((states['Package DRM'] as JsonObject).Arguments as JsonObject).Settings as string;
    expect(pkgSettingsExpr).toContain('"captions":{');
    expect(pkgSettingsExpr).toContain('$exists($states.input.config.captions.captionsEnabled)');

    const pkg = buildJobSettings('package', {
      jsonata: true,
      groupSubPaths: { 'HLS-TS': 'hls/index', 'CMAF-HLS': 'cmaf/index', DASH: 'dash/index' },
      captions: { sourceFileRef: SOURCE_FILE_REF },
    });
    expect(captionSelector(pkg)).toBeDefined();
    expect(destinationType(groupByName(pkg, 'HLS-TS'))).toBe('WEBVTT');
    expect(destinationType(groupByName(pkg, 'CMAF-HLS'))).toBe('WEBVTT');
    expect(destinationType(groupByName(pkg, 'DASH'))).toBe('IMSC');
  });
});

describe('composeProcessAsl — coexistence with ad-markers (both ON)', () => {
  const states = composeProcessAsl(CAP_ADM).States as JsonObject;

  test('still no Choice gates or clones — one Encode SD carries all four variants', () => {
    expect(states['Choose Tier']).toBeDefined();
    expect(states['Choose Tier (Ad Markers)']).toBeUndefined();
    expect(states['Choose Tier (Captions)']).toBeUndefined();
    expect(states['Choose Tier (Ad Markers) (Captions)']).toBeUndefined();
    expect(states['Ad Markers?']).toBeUndefined();
    expect(states['Captions?']).toBeUndefined();

    const settingsExpr = ((states['Encode SD'] as JsonObject).Arguments as JsonObject).Settings as string;
    expect(settingsExpr).toContain('"plain":{');
    expect(settingsExpr).toContain('"esam":{');
    expect(settingsExpr).toContain('"captions":{');
    expect(settingsExpr).toContain('"both":{');
    // Both flags feed the key expression, 'both' taking priority when both sidecars are present.
    expect(settingsExpr).toMatch(/\?\s*'both'\s*:/);
  });

  test('the "both" variant (built the same way applyCaptionsAndAdMarkersOverlays does) carries BOTH Esam and a CaptionSelector', () => {
    const both = buildJobSettings('sd', {
      jsonata: true,
      esam: { sccXmlRef: '$.config.esam.esamXml' },
      captions: { sourceFileRef: SOURCE_FILE_REF },
    });
    expect(both.Esam).toBeDefined();
    expect(captionSelector(both)).toBeDefined();
  });
});

describe('composeOrchestratorAsl — caption sidecar detection', () => {
  test('OFF: no Read Caption Sidecar state', () => {
    const states = composeOrchestratorAsl(OFF).States as JsonObject;
    expect(states['Read Caption Sidecar']).toBeUndefined();
  });

  test('captions ON: Load Job Config -> Read Asset Metadata -> Captions Requested? -> Read Caption Sidecar (headObject) -> Record Started, NoSuchKey graceful skip', () => {
    const states = composeOrchestratorAsl(CAP).States as JsonObject;
    expect((states['Load Job Config'] as JsonObject).Next).toBe('Read Asset Metadata');
    expect((states['Read Asset Metadata'] as JsonObject).Next).toBe('Captions Requested?');
    const gate = states['Captions Requested?'] as JsonObject;
    expect(gate.Default).toBe('Read Caption Sidecar');
    expect((gate.Choices as JsonObject[])[0].Next).toBe('Record Started');
    const read = states['Read Caption Sidecar'] as JsonObject;
    expect(read.Resource).toBe('arn:aws:states:::aws-sdk:s3:headObject');
    expect((read.Parameters as JsonObject)['Key.$']).toBe("States.Format('{}.vtt', $.srcVideo)");
    expect((read.ResultSelector as JsonObject).captionsEnabled).toBe('true');
    expect(read.ResultPath).toBe('$.config.captions');
    expect(read.Next).toBe('Record Started');
    const catches = read.Catch as JsonObject[];
    expect(catches.find((c) => (c.ErrorEquals as string[]).includes('S3.NoSuchKey'))?.Next).toBe('Record Started');
    expect(catches.find((c) => (c.ErrorEquals as string[]).includes('States.ALL'))?.Next).toBe('Set Ingest Error');
  });

  test('captions + ad-markers ON: the reads chain Metadata -> Caption -> ESAM -> Record Started (Ad Markers)', () => {
    const states = composeOrchestratorAsl(CAP_ADM).States as JsonObject;
    expect((states['Load Job Config'] as JsonObject).Next).toBe('Read Asset Metadata');
    expect((states['Read Asset Metadata'] as JsonObject).Next).toBe('Captions Requested?');
    // Skipping captions still reaches the ad-markers gate (and vice-versa the ESAM read is never dropped).
    expect(((states['Captions Requested?'] as JsonObject).Choices as JsonObject[])[0].Next).toBe('Ad Markers Requested?');
    const capRead = states['Read Caption Sidecar'] as JsonObject;
    expect(capRead.Next).toBe('Ad Markers Requested?');
    expect((capRead.Catch as JsonObject[]).find((c) => (c.ErrorEquals as string[]).includes('S3.NoSuchKey'))?.Next).toBe(
      'Ad Markers Requested?',
    );
    expect((states['Ad Markers Requested?'] as JsonObject).Default).toBe('Read ESAM Sidecar');
    expect((states['Read ESAM Sidecar'] as JsonObject).Next).toBe('Record Started (Ad Markers)');
  });
});

// Deepest composition: captions + ad-markers + packaging. Job1 (ladder) only ever varies on esam (never
// captions); job2 (Package DRM) varies on both, and its "both" variant carries BOTH the ESAM block and
// the caption source/outputs.
describe('composeProcessAsl — captions + ad-markers + packaging (deepest composition)', () => {
  const states = composeProcessAsl(CAP_ADM_PKG).States as JsonObject;

  test('no clones anywhere — Encode SD and Package DRM are still singular', () => {
    expect(states['Encode SD (Ad Markers) (Captions)']).toBeUndefined();
    expect(states['Package DRM (Ad Markers) (Captions)']).toBeUndefined();
    expect((states['Encode SD'] as JsonObject).Next).toBe('Package DRM');
  });

  test("job1 (Encode SD)'s variants vary only on esam — captions never touch the ladder", () => {
    const settingsExpr = ((states['Encode SD'] as JsonObject).Arguments as JsonObject).Settings as string;
    expect(settingsExpr).toContain('"plain":{');
    expect(settingsExpr).toContain('"esam":{');
    expect(settingsExpr).not.toContain('"captions":{');
    expect(settingsExpr).not.toContain('"both":{');
  });

  test('job2 (Package DRM) carries the "both" variant, which has BOTH the ESAM block and the caption source', () => {
    const pkgSettingsExpr = ((states['Package DRM'] as JsonObject).Arguments as JsonObject).Settings as string;
    expect(pkgSettingsExpr).toContain('"both":{');

    const both = buildJobSettings('package', {
      jsonata: true,
      groupSubPaths: { 'HLS-TS': 'hls/index', 'CMAF-HLS': 'cmaf/index', DASH: 'dash/index' },
      esam: { sccXmlRef: '$.config.esam.esamXml' },
      captions: { sourceFileRef: SOURCE_FILE_REF },
    });
    expect(both.Esam).toBeDefined();
    expect(captionSelector(both)).toBeDefined();
  });
});
