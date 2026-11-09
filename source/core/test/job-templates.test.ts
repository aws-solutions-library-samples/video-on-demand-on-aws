/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the static CMAF job-template packaging decisions that the synthesized-template assertions
 * don't cover (the raw job-template JSON is spliced into the Process ASL, not asserted structurally).
 */
const TEMPLATE_DIR = path.join(__dirname, '..', 'lib', 'job-templates');
const TIERS = ['sd', 'hd', 'uhd'];

describe.each(TIERS)('CMAF job template: %s', (tier) => {
  const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, `${tier}.json`), 'utf-8'));
  const cmaf = template.OutputGroups?.[0]?.OutputGroupSettings?.CmafGroupSettings;

  test('is a single CMAF output group emitting both HLS and DASH', () => {
    expect(template.OutputGroups[0].OutputGroupSettings.Type).toBe('CMAF_GROUP_SETTINGS');
    expect(cmaf.WriteHlsManifest).toBe('ENABLED');
    expect(cmaf.WriteDashManifest).toBe('ENABLED');
  });

  test('encodes SD/HD as H.264 and UHD as HEVC (hvc1-tagged for Apple HLS)', () => {
    const codec = template.OutputGroups[0].Outputs.find((o: any) => o.VideoDescription).VideoDescription.CodecSettings;
    if (tier === 'uhd') {
      expect(codec.Codec).toBe('H_265');
      expect(codec.H265Settings.RateControlMode).toBe('QVBR');
      expect(codec.H265Settings.WriteMp4PackagingType).toBe('HVC1');
      expect(codec.H264Settings).toBeUndefined();
    } else {
      expect(codec.Codec).toBe('H_264');
      expect(codec.H264Settings.RateControlMode).toBe('QVBR');
    }
  });

  test('uses single-file CMAF so segments are byte-range addressed', () => {
    // SINGLE_FILE => one .cmfv/.cmfa per rendition; HLS uses #EXT-X-BYTERANGE and DASH uses
    // <SegmentBase> (byte ranges). CloudFront serves the byte ranges natively for the S3 origin.
    expect(cmaf.SegmentControl).toBe('SINGLE_FILE');
  });
});

// -------------------------------------------------------------------------------------------------
// Packaging overlay templates (per-tier TS-HLS ladders + job2 REMUX_ALL passthrough).
// -------------------------------------------------------------------------------------------------
const LADDER_TIERS = ['sd', 'hd', 'uhd'];
const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'package-drm.json'), 'utf-8'));

describe.each(LADDER_TIERS)('packaging overlay job1 template: %s-ladder.json (TS-HLS ABR mezzanine)', (tier) => {
  const ladder = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, `${tier}-ladder.json`), 'utf-8'));
  const group = ladder.OutputGroups[0];

  test('is a single HLS group with MPEG-TS (M3U8) outputs (H.264; HEVC for UHD) and no encryption', () => {
    expect(group.OutputGroupSettings.Type).toBe('HLS_GROUP_SETTINGS');
    for (const out of group.Outputs) {
      expect(out.ContainerSettings.Container).toBe('M3U8');
      expect(out.VideoDescription.CodecSettings.Codec).toBe(tier === 'uhd' ? 'H_265' : 'H_264');
    }
    // The mezzanine must be re-ingestible by job2 -> it MUST be clear (no encryption on any input path).
    expect(JSON.stringify(ladder)).not.toContain('Encryption');
    expect(group.OutputGroupSettings.HlsGroupSettings.Encryption).toBeUndefined();
  });

  test('uses Automated ABR (variable rendition count; job2 REMUX_ALL passes them all through)', () => {
    // The ladder emits an Automated-ABR rendition set; job2's AUTO video selector + REMUX_ALL passes
    // through however many renditions this tier produced (no fixed Streams enumeration to keep in sync).
    expect(group.AutomatedEncodingSettings.AbrSettings.MaxRenditions).toBeGreaterThanOrEqual(2);
    expect(group.AutomatedEncodingSettings.AbrSettings.MaxAbrBitrate).toBeGreaterThan(0);
  });
});

describe('packaging overlay job2 template: package-drm.json (REMUX_ALL passthrough, 3 formats)', () => {
  const groups = pkg.OutputGroups;
  const byName = (n: string) => groups.find((g: any) => g.Name === n);
  const videoOf = (g: any) => g.Outputs.find((o: any) => o.VideoDescription?.CodecSettings?.Codec);

  test('reads its input with the default/AUTO video selector (no Streams, no Rotate/ColorSpace)', () => {
    // AUTO + REMUX_ALL passes through EVERY rendition of the mezzanine master regardless of count
    // (verified live), so no Streams enumeration is pinned. Passthrough also rejects
    // Rotate/ColorSpace (MediaConvert error 1999), hence the minimal selector.
    expect(pkg.Inputs[0].VideoSelector.SelectorType).toBeUndefined();
    expect(pkg.Inputs[0].VideoSelector.Streams).toBeUndefined();
    expect(pkg.Inputs[0].VideoSelector.Rotate).toBeUndefined();
    expect(pkg.Inputs[0].VideoSelector.ColorSpace).toBeUndefined();
  });

  test('emits exactly three output groups (HLS-TS + CMAF-HLS + DASH), all video REMUX_ALL passthrough', () => {
    expect(groups.map((g: any) => g.OutputGroupSettings.Type).sort()).toEqual(
      ['CMAF_GROUP_SETTINGS', 'DASH_ISO_GROUP_SETTINGS', 'HLS_GROUP_SETTINGS'].sort(),
    );
    for (const name of ['HLS-TS', 'CMAF-HLS', 'DASH']) {
      const codec = videoOf(byName(name)).VideoDescription.CodecSettings;
      expect(codec.Codec).toBe('PASSTHROUGH');
      expect(codec.PassthroughSettings.VideoSelectorMode).toBe('REMUX_ALL');
      expect(codec.H264Settings).toBeUndefined(); // no re-encode
    }
  });

  test('segment layouts are correct: HLS-TS segmented files, CMAF-HLS one fMP4 per rendition', () => {
    expect(byName('HLS-TS').OutputGroupSettings.HlsGroupSettings.SegmentControl).toBe('SEGMENTED_FILES');
    expect(byName('CMAF-HLS').OutputGroupSettings.CmafGroupSettings.SegmentControl).toBe('SINGLE_FILE');
  });

  test('every group ships clear: no Encryption block anywhere in the template', () => {
    expect(JSON.stringify(pkg)).not.toContain('Encryption');
  });
});
