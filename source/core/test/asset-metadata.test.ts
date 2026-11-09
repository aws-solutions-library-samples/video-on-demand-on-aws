/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

/**
 * The per-asset metadata gate (`overlays/asset-metadata.ts`): with a sidecar overlay ON, the Orchestrator
 * reads `<source>.json` and skips a sidecar read when the metadata sets that flag to false, so a stale
 * `.vtt` / `.esam.xml` from an earlier upload of the same key is not applied. OFF stays byte-identical.
 */

import { composeOrchestratorAsl, JsonObject } from '../lib/asl';
import { parseVodContext, ContextReader, VodContext } from '../lib/context';

function ctx(values: Record<string, unknown>): VodContext {
  const reader: ContextReader = { tryGetContext: (k: string) => values[k] };
  return parseVodContext(reader);
}

const OFF = ctx({ email: 'ci@example.com', thumbnailsProfile: 'OFF' });
const PFM = ctx({ email: 'ci@example.com', perFrameMetrics: 'ON' });
const CAP_ADM = ctx({ email: 'ci@example.com', captionsProfile: 'ON', adMarkersProfile: 'ON' });

/**
 * Evaluate a gate the way Step Functions does for these inputs: the Condition is
 * `$exists(<body>) and $contains(<body>, /<regex>/)`, so pull out the regex and apply it to the raw body.
 * (The same cases were verified against the live engine with the TestState API.)
 */
function nextOf(choice: JsonObject, input: { assetMetaRead?: { body: string } }): string {
  const rule = (choice.Choices as JsonObject[])[0];
  const pattern = /\$contains\([^,]+, \/(.+)\/\) %}$/.exec(rule.Condition as string)?.[1];
  if (!pattern) throw new Error(`unexpected Condition: ${rule.Condition}`);
  const body = input.assetMetaRead?.body;
  return (body !== undefined && new RegExp(pattern).test(body) ? rule.Next : choice.Default) as string;
}

describe('asset metadata gate (Read Asset Metadata + Captions/Ad Markers Requested?)', () => {
  const states = composeOrchestratorAsl(CAP_ADM).States as JsonObject;
  const read = states['Read Asset Metadata'] as JsonObject;
  const captionsGate = states['Captions Requested?'] as JsonObject;
  const adMarkersGate = states['Ad Markers Requested?'] as JsonObject;

  test('reads <source>.json with s3:getObject as raw text (never parsed, so malformed JSON cannot abort)', () => {
    expect(read.Resource).toBe('arn:aws:states:::aws-sdk:s3:getObject');
    expect((read.Parameters as JsonObject)['Key.$']).toBe("States.Format('{}.json', $.srcVideo)");
    expect((read.ResultSelector as JsonObject)['body.$']).toBe('$.Body');
    expect(JSON.stringify(read)).not.toContain('StringToJson');
    expect(captionsGate.QueryLanguage).toBe('JSONata');
    expect(read.ResultPath).toBe('$.assetMetaRead');
  });

  test('a missing .json is a graceful skip to the first gate; other errors fail the asset', () => {
    const catches = read.Catch as JsonObject[];
    expect(catches.find((c) => (c.ErrorEquals as string[]).includes('S3.NoSuchKey'))?.Next).toBe('Captions Requested?');
    expect(catches.find((c) => (c.ErrorEquals as string[]).includes('States.ALL'))?.Next).toBe('Set Ingest Error');
  });

  // The exact body the CMS writes (JSON.stringify(meta, null, 2)).
  const cms = (captions: boolean, adMarkers: boolean) => ({
    assetMetaRead: {
      body: JSON.stringify(
        { schema: 'vod-asset-metadata/1', title: 't', adMarkers, captions, automatedCaptions: false, verticalCrop: false },
        null,
        2,
      ),
    },
  });
  const raw = (body: string) => ({ assetMetaRead: { body } });
  test.each([
    ['no .json (read skipped)', {}, 'read'],
    ['CMS toggles off', cms(false, false), 'skip'],
    ['CMS toggles on', cms(true, true), 'read'],
    ['compact JSON, flags false', raw('{"captions":false,"adMarkers":false}'), 'skip'],
    ['flag absent', raw('{"title":"x"}'), 'read'],
    ['malformed JSON', raw('not json {'), 'read'],
    ['flag text inside the title only', raw('{"title":"\\"captions\\": false \\"adMarkers\\": false","captions":true,"adMarkers":true}'), 'read'],
  ])('%s -> %s the sidecar', (_name, input, expected) => {
    expect(nextOf(captionsGate, input)).toBe(expected === 'skip' ? 'Ad Markers Requested?' : 'Read Caption Sidecar');
    expect(nextOf(adMarkersGate, input)).toBe(expected === 'skip' ? 'Record Started' : 'Read ESAM Sidecar');
  });

  test('flags are independent: captions off + ad markers on', () => {
    const input = cms(false, true);
    expect(nextOf(captionsGate, input)).toBe('Ad Markers Requested?');
    expect(nextOf(adMarkersGate, input)).toBe('Read ESAM Sidecar');
  });

  test('OFF and perFrameMetrics-only: no metadata read or gates', () => {
    for (const c of [OFF, PFM]) {
      const s = composeOrchestratorAsl(c).States as JsonObject;
      expect(s['Read Asset Metadata']).toBeUndefined();
      expect(s['Captions Requested?']).toBeUndefined();
      expect(s['Ad Markers Requested?']).toBeUndefined();
    }
  });
});
