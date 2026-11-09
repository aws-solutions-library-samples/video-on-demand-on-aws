/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

/**
 * The extension seam (`lib/extensions.ts`): discovery from an extensions directory, and enablement only by
 * the `vodExtensions` (`VOD_EXTENSIONS`) list, using a throwaway fake extension.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ContextReader, parseVodContext, VodContextError } from '../lib/context';
import { CoreExtension, loadCoreExtensions } from '../lib/extensions';

/** A fake extension directory: `<dir>/fake/index.js`, active when `fakeMode=ON`. */
function fakeExtensionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-ext-'));
  fs.mkdirSync(path.join(dir, 'fake'));
  fs.mkdirSync(path.join(dir, 'not-an-extension')); // no index: skipped
  fs.writeFileSync(
    path.join(dir, 'fake', 'index.js'),
    `exports.extension = {
      name: 'fake',
      contextKeys: ['fakeMode'],
      activate: (reader) => (reader.tryGetContext('fakeMode') === 'ON' ? { name: 'fake', config: { on: true } } : undefined),
    };`,
  );
  return dir;
}

const reader = (values: Record<string, unknown>): ContextReader => ({ tryGetContext: (k: string) => values[k] });

describe('loadCoreExtensions', () => {
  test('discovers each <dir>/<name>/index and skips directories without one', () => {
    expect(loadCoreExtensions(fakeExtensionsDir()).map((e) => e.name)).toEqual(['fake']);
  });

  test('a missing extensions directory means none (the core distribution)', () => {
    expect(loadCoreExtensions(path.join(os.tmpdir(), 'vod-ext-does-not-exist'))).toEqual([]);
  });
});

describe('parseVodContext — extension enablement (vodExtensions)', () => {
  const available: CoreExtension[] = loadCoreExtensions(fakeExtensionsDir());
  const base = { email: 'ci@example.com' };

  test('an installed extension stays off unless listed', () => {
    expect(parseVodContext(reader(base), available).extensions).toEqual([]);
  });

  test('listed, it activates (and its own keys decide whether it has hooks)', () => {
    expect(parseVodContext(reader({ ...base, vodExtensions: 'fake' }), available).extensions).toEqual([]);
    const ctx = parseVodContext(reader({ ...base, vodExtensions: 'fake', fakeMode: 'ON' }), available);
    expect(ctx.extensions.map((e) => e.name)).toEqual(['fake']);
  });

  test('listing an extension that is not installed fails synth', () => {
    expect(() => parseVodContext(reader({ ...base, vodExtensions: 'fake,other' }), available)).toThrow(VodContextError);
    expect(() => parseVodContext(reader({ ...base, vodExtensions: 'other' }), [])).toThrow(/'other', which is not installed/);
  });

  test("setting an unlisted extension's own key fails synth instead of being ignored", () => {
    expect(() => parseVodContext(reader({ ...base, fakeMode: 'ON' }), available)).toThrow(/'fakeMode' is set but extension 'fake' is not enabled/);
  });
});
