/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards a runtime data-flow bug class that synth/cdk-nag cannot catch: a Step
 * Functions Task with no ResultPath defaults to ResultPath "$", so its service
 * response REPLACES the whole execution state and downstream states lose their
 * fields (e.g. a DynamoDB putItem response clobbering $.config). Every Task
 * that continues to a non-terminal state must declare ResultPath.
 */
const SM_DIR = path.join(__dirname, '..', 'lib', 'state-machines');
const MACHINES = ['orchestrator', 'ingest', 'process', 'publish'];

describe.each(MACHINES)('ASL data-flow: %s', (name) => {
  const def = JSON.parse(fs.readFileSync(path.join(SM_DIR, `${name}.asl.json`), 'utf-8'));
  const states: Record<string, any> = def.States;

  test.each(Object.entries(states).filter(([, s]) => (s as any).Type === 'Task'))(
    'Task "%s" declares ResultPath unless it routes to a terminal state',
    (_stateName, state: any) => {
      const next = state.Next;
      const nextType = next ? states[next]?.Type : undefined;
      const routesToTerminal = state.End === true || nextType === 'Fail' || nextType === 'Succeed';
      if (routesToTerminal) return; // clobbering $ is harmless right before a terminal state
      expect(state).toHaveProperty('ResultPath');
    }
  );
});

/**
 * The runtime feature toggles live in a single clear $.config JSON block (assembled by the
 * orchestrator's Load Job Config Pass, an interim stand-in for a future S3 sidecar metadata file).
 * Consumers must read $.config.*, never the loose top-level fields that used to exist.
 */
describe('ASL data-flow: toggles are read from $.config, not loose top-level fields', () => {
  const LOOSE = /"\$\.(archiveSource|enableSns|enableSqs)"/;

  test.each(MACHINES)('%s references no loose top-level toggle path', (name) => {
    const text = fs.readFileSync(path.join(SM_DIR, `${name}.asl.json`), 'utf-8');
    expect(text).not.toMatch(LOOSE);
  });

  test('ingest branches on $.config.archiveSource and $.config.enableSns', () => {
    const states = JSON.parse(fs.readFileSync(path.join(SM_DIR, 'ingest.asl.json'), 'utf-8')).States;
    expect(states['Validate Metadata'].Choices[0].Variable).toBe('$.config.archiveSource');
    expect(states['SNS Choice'].Choices[0].Variable).toBe('$.config.enableSns');
  });

  test('publish branches on $.config.archiveSource / enableSqs / enableSns and tags from $.config', () => {
    const states = JSON.parse(fs.readFileSync(path.join(SM_DIR, 'publish.asl.json'), 'utf-8')).States;
    expect(states['Archive Source Choice'].Choices[0].Variable).toBe('$.config.archiveSource');
    expect(states['SQS Choice'].Choices[0].Variable).toBe('$.config.enableSqs');
    expect(states['SNS Choice'].Choices[0].Variable).toBe('$.config.enableSns');
    expect(states['Tag Source'].Parameters.Tagging.TagSet[0]['Value.$']).toBe('$.config.archiveSource');
  });

  test('process carries the config block forward to Publish (Build Playback URLs whitelist)', () => {
    const states = JSON.parse(fs.readFileSync(path.join(SM_DIR, 'process.asl.json'), 'utf-8')).States;
    expect(states['Build Playback URLs'].Parameters['config.$']).toBe('$.config');
  });
});
