/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the ASL loader/transform (`lib/asl.ts`): the GA sd/hd/uhd splice must be preserved
 * byte-for-byte when the packaging overlay is OFF, and the two-job REMUX_ALL packaging states (job1
 * TS-HLS ladder + job2 three-format packaging) must be injected in memory (never on disk) when ON.
 * Also guards `buildJobSettings` backward-compat.
 */

import { buildJobSettings, composeProcessAsl, composeOrchestratorAsl, JsonObject } from '../lib/asl';
import { parseVodContext, ContextReader, VodContext } from '../lib/context';

function ctx(values: Record<string, unknown>): VodContext {
  const reader: ContextReader = { tryGetContext: (k: string) => values[k] };
  return parseVodContext(reader);
}
// Explicit thumbnailsProfile: 'OFF' — thumbnails default flipped to ON; OFF here means "pure GA core,
// nothing on" for the many describe blocks below that use this as their byte-identical baseline.
const OFF = ctx({ email: 'ci@example.com', thumbnailsProfile: 'OFF' });
const ON_CLEAR = ctx({ email: 'ci@example.com', packagingProfile: 'ON' });
const ADM = ctx({ email: 'ci@example.com', adMarkersProfile: 'ON' });
const ADM_PKG = ctx({ email: 'ci@example.com', adMarkersProfile: 'ON', packagingProfile: 'ON' });

const PFM = ctx({ email: 'ci@example.com', perFrameMetrics: 'ON' });
const PFM_PKG = ctx({ email: 'ci@example.com', perFrameMetrics: 'ON', packagingProfile: 'ON' });
const PFM_ADM = ctx({ email: 'ci@example.com', perFrameMetrics: 'ON', adMarkersProfile: 'ON' });
const EXPECTED_METRICS = ['VMAF', 'QVBR', 'SHOT_CHANGE'];
const THUMB = ctx({ email: 'ci@example.com', thumbnailsProfile: 'ON' });
const THUMB_PKG = ctx({ email: 'ci@example.com', thumbnailsProfile: 'ON', packagingProfile: 'ON' });
const THUMB_ADM = ctx({ email: 'ci@example.com', thumbnailsProfile: 'ON', adMarkersProfile: 'ON' });
/** The codec-specific settings block (H264Settings) of a group's video output. */
const videoCodecSettings = (group: JsonObject): JsonObject => {
  const codec = (videoOutput(group).VideoDescription as JsonObject).CodecSettings as JsonObject;
  const key = Object.keys(codec).find((k) => k.endsWith('Settings')) as string;
  return codec[key] as JsonObject;
};

const settingsOf = (states: JsonObject, state: string): JsonObject =>
  ((states[state] as JsonObject).Parameters as JsonObject).Settings as JsonObject;
const groupByName = (settings: JsonObject, name: string): JsonObject =>
  (settings.OutputGroups as JsonObject[]).find((g) => g.Name === name) as JsonObject;
const groupSettings = (group: JsonObject, key: string): JsonObject =>
  (group.OutputGroupSettings as JsonObject)[key] as JsonObject;
const videoOutput = (group: JsonObject): JsonObject =>
  (group.Outputs as JsonObject[]).find((o) =>
    ((o.VideoDescription as JsonObject | undefined)?.CodecSettings as JsonObject | undefined)?.Codec !== undefined,
  ) as JsonObject;

describe('buildJobSettings — backward compatibility (default opts reproduce the GA single-job splice)', () => {
  test('sd tier: FileInput.$ = $.fileUri and Destination.$ writes the destination bucket /index', () => {
    const s = buildJobSettings('sd');
    expect((s.Inputs as JsonObject[])[0]['FileInput.$']).toBe('$.fileUri');
    const cmaf = groupSettings(groupByName(s, 'CMAF'), 'CmafGroupSettings');
    expect(cmaf['Destination.$']).toBe("States.Format('s3://${DESTINATION_BUCKET}/{}/index', $.guid)");
  });
});

describe('composeProcessAsl — OFF (default synth is byte-identical)', () => {
  const states = composeProcessAsl(OFF).States as JsonObject;

  test('injects no packaging states', () => {
    expect(states['Tier Package']).toBeUndefined();
    expect(states['Encode Ladder']).toBeUndefined();
    expect(states['Package DRM']).toBeUndefined();
  });

  test('injects no ad-markers branch (no Ad Markers? Choice, no clones, no Esam)', () => {
    expect(states['Ad Markers?']).toBeUndefined();
    expect(states['Choose Tier (Ad Markers)']).toBeUndefined();
    expect(states['Encode SD (Ad Markers)']).toBeUndefined();
    expect(JSON.stringify(states)).not.toContain('Esam');
    expect(JSON.stringify(states)).not.toContain('Scte35Esam');
  });

  test('leaves Choose Tier routing on videoHeight (no always-true first arm)', () => {
    const choices = (states['Choose Tier'] as JsonObject).Choices as JsonObject[];
    expect(choices[0].Variable).toBe('$.videoHeight');
  });

  test('sd/hd/uhd Settings are spliced OBJECTs carrying FileInput.$ + Destination.$', () => {
    for (const state of ['Encode SD', 'Encode HD', 'Encode UHD']) {
      const s = settingsOf(states, state);
      expect(typeof s).toBe('object');
      expect((s.Inputs as JsonObject[])[0]['FileInput.$']).toBe('$.fileUri');
      expect(groupSettings(groupByName(s, 'CMAF'), 'CmafGroupSettings')['Destination.$']).toContain('/index');
    }
  });

  test('Build Playback URLs carries a GA outputsSummary (single HLS + DASH, no per-format split)', () => {
    const summary = ((states['Build Playback URLs'] as JsonObject).Parameters as JsonObject)['outputsSummary.$'] as string;
    expect(summary).toContain('/index.m3u8');
    expect(summary).toContain('/index.mpd');
    expect(summary).not.toContain('/cmaf/');
    expect(summary).not.toContain('INTERMEDIATE_BUCKET');
  });

  test('Build Playback URLs forwards the $.config block to Publish (not loose toggle fields)', () => {
    const p = (states['Build Playback URLs'] as JsonObject).Parameters as JsonObject;
    expect(p['config.$']).toBe('$.config');
    expect(p).not.toHaveProperty('archiveSource.$');
    expect(p).not.toHaveProperty('enableSns.$');
    expect(p).not.toHaveProperty('enableSqs.$');
  });
});

describe('composeProcessAsl — ON (two-job three-format packaging overlay)', () => {
  const states = composeProcessAsl(ON_CLEAR).States as JsonObject;

  test('keeps the normal Choose Tier routing (no always-true packaging arm, no Tier Package/Encode Ladder)', () => {
    const choices = (states['Choose Tier'] as JsonObject).Choices as JsonObject[];
    expect(choices.some((c) => c.Next === 'Tier Package')).toBe(false);
    expect(choices[0].Variable).toBe('$.videoHeight'); // GA height routing (no override arms)
    expect(states['Tier Package']).toBeUndefined();
    expect(states['Encode Ladder']).toBeUndefined();
  });

  test('each Encode tier is a per-tier TS-HLS Automated-ABR ladder to the intermediate bucket, routed to Package DRM', () => {
    for (const state of ['Encode SD', 'Encode HD', 'Encode UHD']) {
      const enc = states[state] as JsonObject;
      expect(enc.ResultPath).toBe('$.ladderOutput'); // job1 result parked off $.jobOutput
      expect(enc.Next).toBe('Package DRM');
      const s = settingsOf(states, state);
      expect((s.Inputs as JsonObject[])[0]['FileInput.$']).toBe('$.fileUri');
      const group = (s.OutputGroups as JsonObject[])[0];
      expect(group.Name).toBe('TS-HLS Ladder');
      expect(group.AutomatedEncodingSettings).toBeDefined(); // Automated ABR (variable rendition count)
      const hls = groupSettings(group, 'HlsGroupSettings');
      expect(hls['Destination.$']).toBe("States.Format('s3://${INTERMEDIATE_BUCKET}/{}/stream', $.guid)");
      expect(hls.Encryption).toBeUndefined(); // clear mezzanine, re-ingestible by job2
    }
  });

  test('Package DRM (job2) reads job1 master and emits 3 groups under per-format sub-paths', () => {
    const pkg = states['Package DRM'] as JsonObject;
    expect(pkg.ResultPath).toBe('$.jobOutput');
    expect(pkg.Next).toBe('Build Playback URLs');
    const s = settingsOf(states, 'Package DRM');
    expect((s.Inputs as JsonObject[])[0]['FileInput.$']).toBe(
      "States.Format('s3://${INTERMEDIATE_BUCKET}/{}/stream.m3u8', $.guid)",
    );
    expect(groupSettings(groupByName(s, 'HLS-TS'), 'HlsGroupSettings')['Destination.$']).toContain('/hls/index');
    expect(groupSettings(groupByName(s, 'CMAF-HLS'), 'CmafGroupSettings')['Destination.$']).toContain('/cmaf/index');
    expect(groupSettings(groupByName(s, 'DASH'), 'DashIsoGroupSettings')['Destination.$']).toContain('/dash/index');
    // Every group's video output is passthrough REMUX_ALL.
    for (const name of ['HLS-TS', 'CMAF-HLS', 'DASH']) {
      const codec = (videoOutput(groupByName(s, name)).VideoDescription as JsonObject).CodecSettings as JsonObject;
      expect(codec.Codec).toBe('PASSTHROUGH');
      expect((codec.PassthroughSettings as JsonObject).VideoSelectorMode).toBe('REMUX_ALL');
    }
  });

  test('re-paths Build Playback URLs to the per-format hls/ and dash/ sub-paths', () => {
    const p = (states['Build Playback URLs'] as JsonObject).Parameters as JsonObject;
    expect(p['hlsUrl.$']).toContain('/hls/index.m3u8');
    expect(p['dashUrl.$']).toContain('/dash/index.mpd');
    expect(p['cmafUrl.$']).toContain('/cmaf/index.m3u8');
    expect(p['hlsManifest.$']).toBe("States.Format('{}/hls/index.m3u8', $.guid)");
    expect(p['dashManifest.$']).toBe("States.Format('{}/dash/index.mpd', $.guid)");
    // The config passthrough survives the packaging re-path (only URL/manifest keys are overwritten).
    expect(p['config.$']).toBe('$.config');
  });

  test('Record Job persists cmafUrl so the console can surface the CMAF-HLS deliverable', () => {
    const params = (states['Record Job'] as JsonObject).Parameters as JsonObject;
    expect(params.UpdateExpression as string).toContain('cmafUrl = :cmaf');
    const values = params.ExpressionAttributeValues as JsonObject;
    expect((values[':cmaf'] as JsonObject)['S.$']).toBe('$.cmafUrl');
  });

  test('outputsSummary lists all three packaged formats + the job1 mezzanine (for the SNS email)', () => {
    const summary = ((states['Build Playback URLs'] as JsonObject).Parameters as JsonObject)['outputsSummary.$'] as string;
    expect(summary).toContain('/hls/index.m3u8'); // HLS/TS
    expect(summary).toContain('/cmaf/index.m3u8'); // CMAF-HLS
    expect(summary).toContain('/dash/index.mpd'); // DASH
    expect(summary).toContain('${INTERMEDIATE_BUCKET}'); // job1 mezzanine bucket
    expect(summary).toContain('/stream.m3u8'); // job1 TS-HLS master
  });

  test('every format ships clear: no Encryption on any group, and the summary labels HLS/TS "clear"', () => {
    const s = settingsOf(states, 'Package DRM');
    for (const [name, key] of [['HLS-TS', 'HlsGroupSettings'], ['CMAF-HLS', 'CmafGroupSettings'], ['DASH', 'DashIsoGroupSettings']]) {
      expect(groupSettings(groupByName(s, name), key).Encryption).toBeUndefined();
    }
    const summary = ((states['Build Playback URLs'] as JsonObject).Parameters as JsonObject)['outputsSummary.$'] as string;
    expect(summary).toContain('HLS (TS, clear)');
  });
});

describe('buildJobSettings — ESAM ad markers', () => {
  test('esam on the GA CMAF tier: root Esam block + CMAF video output Scte35Esam=INSERT/Source=NONE', () => {
    const s = buildJobSettings('hd', { esam: { sccXmlRef: '$.config.esam.esamXml' } });
    const esam = s.Esam as JsonObject;
    expect(esam.ResponseSignalPreroll).toBe(0);
    expect((esam.SignalProcessingNotification as JsonObject)['SccXml.$']).toBe('$.config.esam.esamXml');
    const cmfc = (videoOutput(groupByName(s, 'CMAF')).ContainerSettings as JsonObject).CmfcSettings as JsonObject;
    expect(cmfc.Scte35Esam).toBe('INSERT');
    expect(cmfc.Scte35Source).toBe('NONE');
  });

  test('esam on the TS-HLS ladder: M3u8 has NO Scte35Esam (unsupported); markers via PASSTHROUGH + AdMarkers', () => {
    const s = buildJobSettings('hd-ladder', { esam: { sccXmlRef: '$.config.esam.esamXml' } });
    const group = groupByName(s, 'TS-HLS Ladder');
    expect((groupSettings(group, 'HlsGroupSettings').AdMarkers as string[])).toEqual(['ELEMENTAL_SCTE35']);
    const m3u8 = (videoOutput(group).ContainerSettings as JsonObject).M3u8Settings as JsonObject;
    expect(m3u8.Scte35Esam).toBeUndefined(); // M3u8Settings has no Scte35Esam field (Step Functions rejects it)
    expect(m3u8.Scte35Source).toBe('PASSTHROUGH');
  });

  test('esam on the package job2: root Esam block + per-group SCTE-35 (HLS PASSTHROUGH+AdMarkers, CMAF/DASH INSERT)', () => {
    const s = buildJobSettings('package', { groupSubPaths: { 'HLS-TS': 'hls/index' }, esam: { sccXmlRef: '$.config.esam.esamXml' } });
    // The Esam block on job2 is what writes markers into the delivery manifests (verified live).
    expect((s.Esam as JsonObject)).toBeDefined();
    expect(((s.Esam as JsonObject).SignalProcessingNotification as JsonObject)['SccXml.$']).toBe('$.config.esam.esamXml');
    // HLS/TS — no Scte35Esam field on M3u8; PASSTHROUGH + group AdMarkers.
    expect((groupSettings(groupByName(s, 'HLS-TS'), 'HlsGroupSettings').AdMarkers as string[])).toEqual(['ELEMENTAL_SCTE35']);
    const hlsM3u8 = (videoOutput(groupByName(s, 'HLS-TS')).ContainerSettings as JsonObject).M3u8Settings as JsonObject;
    expect(hlsM3u8.Scte35Source).toBe('PASSTHROUGH');
    expect(hlsM3u8.Scte35Esam).toBeUndefined();
    // CMAF-HLS + DASH → INSERT
    const cmfc = (videoOutput(groupByName(s, 'CMAF-HLS')).ContainerSettings as JsonObject).CmfcSettings as JsonObject;
    expect(cmfc.Scte35Esam).toBe('INSERT');
    const mpd = (videoOutput(groupByName(s, 'DASH')).ContainerSettings as JsonObject).MpdSettings as JsonObject;
    expect(mpd.Scte35Esam).toBe('INSERT');
  });

  test('no esam option: templates stay byte-identical (no Esam, no Scte35Esam, source stays NONE)', () => {
    const s = buildJobSettings('hd-ladder');
    expect(s.Esam).toBeUndefined();
    const m3u8 = (videoOutput(groupByName(s, 'TS-HLS Ladder')).ContainerSettings as JsonObject).M3u8Settings as JsonObject;
    expect(m3u8.Scte35Source).toBe('NONE');
    expect(m3u8.Scte35Esam).toBeUndefined();
  });
});

describe('composeProcessAsl — ON ad markers (JSONata variant lookup, no Choice/clone states)', () => {
  test('core (packaging OFF): Encode {T} converts in place to a JSONata plain/esam variant lookup — no clones', () => {
    const states = composeProcessAsl(ADM).States as JsonObject;
    // No Choice gate, no cloned states — the ESAM flag is read inside the ONE Encode Task now.
    expect(states['Ad Markers?']).toBeUndefined();
    expect(states['Choose Tier (Ad Markers)']).toBeUndefined();
    expect(states['Tier SD (Ad Markers)']).toBeUndefined();
    expect(states['Encode SD (Ad Markers)']).toBeUndefined();
    // Check Video Track / Choose Tier are untouched — still routes straight to the single 'Choose Tier'.
    expect((states['Check Video Track'] as JsonObject).Choices).toEqual([
      expect.objectContaining({ Next: 'Choose Tier' }),
    ]);

    const encode = states['Encode SD'] as JsonObject;
    expect(encode.QueryLanguage).toBe('JSONata');
    expect(encode.Parameters).toBeUndefined();
    expect(encode.ResultPath).toBeUndefined();
    const settingsExpr = (encode.Arguments as JsonObject).Settings as string;
    // Both variants are embedded; the key expression reads the ESAM flag with an $exists guard (mirrors
    // the old Choice's IsPresent guard — the graceful-skip path never creates $.config.esam).
    expect(settingsExpr).toContain('"plain":{');
    expect(settingsExpr).toContain('"esam":{');
    expect(settingsExpr).not.toContain('"captions":{');
    expect(settingsExpr).not.toContain('"both":{');
    expect(settingsExpr).toContain('$exists($states.input.config.esam.esamEnabled)');
    expect(settingsExpr).toContain("$states.input.config.esam.esamEnabled = 'true'");
    // Output merges the job result back into the original input at $.jobOutput, so downstream JSONPath
    // states (Build Playback URLs) keep reading $.jobOutput.Job.Id exactly as before.
    expect(encode.Output).toBe('{% $merge([$states.input, {"jobOutput": $states.result}]) %}');
    const catchEntry = (encode.Catch as JsonObject[])[0];
    expect(catchEntry.ResultPath).toBeUndefined();
    expect(catchEntry.Output).toBe('{% $merge([$states.input, {"error": $states.errorOutput}]) %}');
    expect(encode.Next).toBe('Build Playback URLs');
  });

  test('overlay (packaging ON): Encode SD (job1) and Package DRM (job2) both convert in place — no clones', () => {
    const states = composeProcessAsl(ADM_PKG).States as JsonObject;
    expect(states['Package DRM (Ad Markers)']).toBeUndefined();
    expect(states['Choose Tier (Ad Markers)']).toBeUndefined();

    const encode = states['Encode SD'] as JsonObject;
    expect(encode.QueryLanguage).toBe('JSONata');
    expect(encode.Next).toBe('Package DRM'); // still the single Package DRM state, unchanged routing.
    const encodeSettingsExpr = (encode.Arguments as JsonObject).Settings as string;
    expect(encodeSettingsExpr).toContain('"esam":{');
    expect(encodeSettingsExpr).not.toContain('"captions":{');

    const pkg = states['Package DRM'] as JsonObject;
    expect(pkg.QueryLanguage).toBe('JSONata');
    const pkgSettingsExpr = (pkg.Arguments as JsonObject).Settings as string;
    expect(pkgSettingsExpr).toContain('"esam":{');
    expect(pkgSettingsExpr).toContain('$exists($states.input.config.esam.esamEnabled)');
  });

  test('the composed Encode SD lookup resolves FileInput/Destination to real JSONata expressions, not raw sentinels', () => {
    const states = composeProcessAsl(ADM).States as JsonObject;
    const settingsExpr = ((states['Encode SD'] as JsonObject).Arguments as JsonObject).Settings as string;
    expect(settingsExpr).toContain('"FileInput":$states.input.fileUri');
    expect(settingsExpr).toContain("'s3://${DESTINATION_BUCKET}/' & $states.input.guid & '/index'");
    expect(settingsExpr).not.toContain('__JSONATA_'); // every sentinel must have been resolved.
  });
});

describe('composeProcessAsl — per-frame quality metrics (perFrameMetrics)', () => {
  test('OFF: no PerFrameMetrics on any encode output (byte-identical core)', () => {
    const states = composeProcessAsl(OFF).States as JsonObject;
    for (const state of ['Encode SD', 'Encode HD', 'Encode UHD']) {
      const cmaf = groupByName(settingsOf(states, state), 'CMAF');
      expect(videoCodecSettings(cmaf).PerFrameMetrics).toBeUndefined();
    }
    expect(JSON.stringify(states)).not.toContain('PerFrameMetrics');
  });

  test('ON (GA CMAF): PerFrameMetrics set on each tier video output; audio output untouched', () => {
    const states = composeProcessAsl(PFM).States as JsonObject;
    for (const state of ['Encode SD', 'Encode HD', 'Encode UHD']) {
      const cmaf = groupByName(settingsOf(states, state), 'CMAF');
      expect(videoCodecSettings(cmaf).PerFrameMetrics).toEqual(EXPECTED_METRICS);
      const audio = (cmaf.Outputs as JsonObject[]).find((o) => !o.VideoDescription) as JsonObject;
      expect(JSON.stringify(audio)).not.toContain('PerFrameMetrics');
    }
  });

  test('ON + packaging: metrics ride the TS-HLS ladder job1, NOT the REMUX_ALL passthrough job2', () => {
    const states = composeProcessAsl(PFM_PKG).States as JsonObject;
    // job1 ladder encode (Encode SD -> the sd-ladder) carries metrics.
    const ladder = groupByName(settingsOf(states, 'Encode SD'), 'TS-HLS Ladder');
    expect(videoCodecSettings(ladder).PerFrameMetrics).toEqual(EXPECTED_METRICS);
    // job2 Package DRM is PASSTHROUGH (no re-encode) -> no metrics anywhere in its Settings.
    expect(JSON.stringify(settingsOf(states, 'Package DRM'))).not.toContain('PerFrameMetrics');
  });

  test('ON + ad-markers: the "esam" variant embedded in the single Encode SD lookup also carries metrics', () => {
    // composeProcessAsl(PFM_ADM) collapses to ONE Encode SD Task with a JSONata variant lookup (see the
    // 'ON ad markers' describe block above), so its embedded "esam" variant is checked directly here via
    // the same buildJobSettings(..., { jsonata: true, ... }) call applyCaptionsAndAdMarkersOverlays makes.
    const s = buildJobSettings('sd', { jsonata: true, perFrameMetrics: true, esam: { sccXmlRef: '$.config.esam.esamXml' } });
    const cmaf = groupByName(s, 'CMAF');
    expect(videoCodecSettings(cmaf).PerFrameMetrics).toEqual(EXPECTED_METRICS);
    expect(s.Esam).toBeDefined();

    const states = composeProcessAsl(PFM_ADM).States as JsonObject;
    expect(states['Encode SD (Ad Markers)']).toBeUndefined();
    expect(((states['Encode SD'] as JsonObject).Arguments as JsonObject).Settings as string).toContain('"esam":{');
  });

  const recordJobExpr = (states: JsonObject): string =>
    ((states['Record Job'] as JsonObject).Parameters as JsonObject).UpdateExpression as string;

  test('OFF: Record Job does not persist quality-metrics attributes', () => {
    const states = composeProcessAsl(OFF).States as JsonObject;
    expect(recordJobExpr(states)).not.toContain('qualityMetrics');
    expect(JSON.stringify(states['Build Playback URLs'])).not.toContain('qualityMetricsPrefix');
  });

  test('ON (GA): Record Job persists qualityMetrics + a destination-bucket report prefix', () => {
    const states = composeProcessAsl(PFM).States as JsonObject;
    expect(recordJobExpr(states)).toContain('qualityMetrics = :qm, qualityMetricsPrefix = :qmp');
    const values = ((states['Record Job'] as JsonObject).Parameters as JsonObject)
      .ExpressionAttributeValues as JsonObject;
    expect((values[':qm'] as JsonObject).S).toBe('VMAF,QVBR,SHOT_CHANGE');
    const prefix = ((states['Build Playback URLs'] as JsonObject).Parameters as JsonObject)['qualityMetricsPrefix.$'];
    expect(prefix).toBe("States.Format('s3://${DESTINATION_BUCKET}/{}/', $.guid)");
  });

  test('ON + packaging: the report prefix points at the intermediate bucket (ladder job1 CSVs)', () => {
    const states = composeProcessAsl(PFM_PKG).States as JsonObject;
    const prefix = ((states['Build Playback URLs'] as JsonObject).Parameters as JsonObject)['qualityMetricsPrefix.$'];
    expect(prefix).toBe("States.Format('s3://${INTERMEDIATE_BUCKET}/{}/', $.guid)");
  });
});

describe('composeProcessAsl — thumbnails/poster (thumbnailsProfile)', () => {
  const recordJobExpr = (states: JsonObject): string =>
    ((states['Record Job'] as JsonObject).Parameters as JsonObject).UpdateExpression as string;
  const frameCaptureGroup = (settings: JsonObject): JsonObject | undefined =>
    (settings.OutputGroups as JsonObject[]).find((g) => g.Name === 'Thumbnails');
  const buildUrlsParams = (states: JsonObject): JsonObject =>
    (states['Build Playback URLs'] as JsonObject).Parameters as JsonObject;

  test('explicit OFF: no FRAME_CAPTURE group and no thumbnails record (byte-identical core)', () => {
    const states = composeProcessAsl(OFF).States as JsonObject;
    expect(JSON.stringify(states)).not.toContain('FRAME_CAPTURE');
    expect(JSON.stringify(states)).not.toContain('thumbnailsPrefix');
    expect(recordJobExpr(states)).not.toContain('posterUrl');
  });

  test('true default (no thumbnailsProfile in context at all): FRAME_CAPTURE + thumbnails record ARE present', () => {
    const trueDefault = ctx({ email: 'ci@example.com' });
    const states = composeProcessAsl(trueDefault).States as JsonObject;
    expect(JSON.stringify(states)).toContain('FRAME_CAPTURE');
    expect(recordJobExpr(states)).toContain('posterUrl');
  });

  test('ON (GA CMAF): a FRAME_CAPTURE FILE group is appended to each tier encode, targeting the destination bucket', () => {
    const states = composeProcessAsl(THUMB).States as JsonObject;
    for (const state of ['Encode SD', 'Encode HD', 'Encode UHD']) {
      const g = frameCaptureGroup(settingsOf(states, state)) as JsonObject;
      expect(g).toBeDefined();
      expect((g.OutputGroupSettings as JsonObject).Type).toBe('FILE_GROUP_SETTINGS');
      const dest = ((g.OutputGroupSettings as JsonObject).FileGroupSettings as JsonObject)['Destination.$'];
      expect(dest).toBe("States.Format('s3://${DESTINATION_BUCKET}/{}/thumbnails/frame', $.guid)");
      const codec = (videoOutput(g).VideoDescription as JsonObject).CodecSettings as JsonObject;
      expect(codec.Codec).toBe('FRAME_CAPTURE');
    }
  });

  test('ON + packaging: the FRAME_CAPTURE group rides ladder job1 but still targets DESTINATION (not intermediate); job2 has none', () => {
    const states = composeProcessAsl(THUMB_PKG).States as JsonObject;
    const g = frameCaptureGroup(settingsOf(states, 'Encode SD')) as JsonObject;
    expect(g).toBeDefined();
    const dest = ((g.OutputGroupSettings as JsonObject).FileGroupSettings as JsonObject)['Destination.$'] as string;
    expect(dest).toContain('${DESTINATION_BUCKET}');
    expect(dest).not.toContain('INTERMEDIATE_BUCKET');
    // job2 Package DRM is REMUX_ALL passthrough (no decode) -> no frame capture.
    expect(JSON.stringify(settingsOf(states, 'Package DRM'))).not.toContain('FRAME_CAPTURE');
  });

  test('ON + ad-markers: the "esam" variant embedded in the single Encode SD lookup still gets thumbnails', () => {
    // Mirrors the perFrameMetrics+ad-markers test above: composeProcessAsl(THUMB_ADM) collapses to ONE
    // Encode SD Task, so the embedded "esam" variant is checked directly via the same
    // buildJobSettings(..., { jsonata: true, ... }) call applyCaptionsAndAdMarkersOverlays makes.
    const s = buildJobSettings('sd', { jsonata: true, thumbnails: true, esam: { sccXmlRef: '$.config.esam.esamXml' } });
    const g = frameCaptureGroup(s) as JsonObject;
    expect(g).toBeDefined();
    const codec = (videoOutput(g).VideoDescription as JsonObject).CodecSettings as JsonObject;
    expect(codec.Codec).toBe('FRAME_CAPTURE');

    const states = composeProcessAsl(THUMB_ADM).States as JsonObject;
    expect(states['Encode SD (Ad Markers)']).toBeUndefined();
  });

  test('ON: Record Job persists thumbnailsPrefix + posterUrl as CloudFront URLs', () => {
    const states = composeProcessAsl(THUMB).States as JsonObject;
    expect(recordJobExpr(states)).toContain('thumbnailsPrefix = :tp, posterUrl = :pu');
    expect(buildUrlsParams(states)['thumbnailsPrefix.$']).toBe(
      "States.Format('https://${CLOUDFRONT_DOMAIN}/{}/thumbnails/', $.guid)",
    );
    expect(buildUrlsParams(states)['posterUrl.$']).toBe(
      "States.Format('https://${CLOUDFRONT_DOMAIN}/{}/thumbnails/frame.0000000.jpg', $.guid)",
    );
  });
});

describe('composeOrchestratorAsl', () => {
  test('OFF: byte-identical (no Read ESAM Sidecar; Load Job Config -> Record Started)', () => {
    const states = composeOrchestratorAsl(OFF).States as JsonObject;
    expect(states['Read ESAM Sidecar']).toBeUndefined();
    expect((states['Load Job Config'] as JsonObject).Next).toBe('Record Started');
    expect(((states['Load Job Config'] as JsonObject).Parameters as JsonObject).perFrameMetrics).toBeUndefined();
  });

  test('perFrameMetrics=ON: Load Job Config surfaces the toggle (${PER_FRAME_METRICS}); no ad-markers states', () => {
    const states = composeOrchestratorAsl(PFM).States as JsonObject;
    const params = (states['Load Job Config'] as JsonObject).Parameters as JsonObject;
    expect(params.perFrameMetrics).toBe('${PER_FRAME_METRICS}');
    // perFrameMetrics alone must not pull in the ad-markers overlay.
    expect(states['Read ESAM Sidecar']).toBeUndefined();
    expect((states['Load Job Config'] as JsonObject).Next).toBe('Record Started');
  });

  test('ON: injects the s3:getObject sidecar read with graceful-skip + real-error catches', () => {
    const states = composeOrchestratorAsl(ADM).States as JsonObject;
    expect((states['Load Job Config'] as JsonObject).Next).toBe('Read Asset Metadata');
    expect((states['Read Asset Metadata'] as JsonObject).Next).toBe('Ad Markers Requested?');
    expect((states['Ad Markers Requested?'] as JsonObject).Default).toBe('Read ESAM Sidecar');
    const read = states['Read ESAM Sidecar'] as JsonObject;
    expect(read.Resource).toBe('arn:aws:states:::aws-sdk:s3:getObject');
    expect((read.Parameters as JsonObject)['Key.$']).toBe("States.Format('{}.esam.xml', $.srcVideo)");
    expect(read.ResultPath).toBe('$.config.esam');
    expect((read.ResultSelector as JsonObject)['esamXml.$']).toBe('$.Body');
    expect((read.ResultSelector as JsonObject).esamEnabled).toBe('true');
    // Sidecar-present path persists the XML via the Record Started (Ad Markers) clone.
    expect(read.Next).toBe('Record Started (Ad Markers)');
    const catches = read.Catch as JsonObject[];
    const skip = catches.find((c) => (c.ErrorEquals as string[]).includes('S3.NoSuchKey')) as JsonObject;
    expect(skip.Next).toBe('Record Started'); // graceful skip: no markers, no adMarkersEsamXml
    const fail = catches.find((c) => (c.ErrorEquals as string[]).includes('States.ALL')) as JsonObject;
    expect(fail.Next).toBe('Set Ingest Error'); // real S3 error -> failure path
  });

  test('ON: Record Started (Ad Markers) persists the raw ESAM XML to the item; plain Record Started does not', () => {
    const states = composeOrchestratorAsl(ADM).States as JsonObject;
    const adm = states['Record Started (Ad Markers)'] as JsonObject;
    expect(adm).toBeDefined();
    const admItem = ((adm.Parameters as JsonObject).Item as JsonObject).adMarkersEsamXml as JsonObject;
    expect(admItem['S.$']).toBe('$.config.esam.esamXml');
    expect(adm.Next).toBe('Ingest'); // same downstream as Record Started
    // The plain Record Started (graceful-skip path) carries no ad-markers attribute.
    const plainItem = ((states['Record Started'] as JsonObject).Parameters as JsonObject).Item as JsonObject;
    expect(plainItem.adMarkersEsamXml).toBeUndefined();
  });

  test('OFF: no Record Started (Ad Markers) clone', () => {
    const states = composeOrchestratorAsl(OFF).States as JsonObject;
    expect(states['Record Started (Ad Markers)']).toBeUndefined();
  });
});
