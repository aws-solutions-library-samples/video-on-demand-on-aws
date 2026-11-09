/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadExtensions, type CmsUiExtension, type ExtensionLoader } from './extensions';

const fake = (id: string): { load: ExtensionLoader; calls: () => number } => {
  let n = 0;
  return {
    load: async () => {
      n += 1;
      return { extension: { id } as CmsUiExtension };
    },
    calls: () => n,
  };
};

describe('loadExtensions', () => {
  it('loads only the enabled ids, in order', async () => {
    const a = fake('a');
    const b = fake('b');
    const loaded = await loadExtensions(['b'], { a: a.load, b: b.load });
    expect(loaded.map((e) => e.id)).toEqual(['b']);
    expect(a.calls()).toBe(0); // a disabled module's chunk is never fetched
    expect(b.calls()).toBe(1);
  });

  it('nothing enabled = the base console', async () => {
    expect(await loadExtensions([], { a: fake('a').load })).toEqual([]);
  });

  it('skips (and warns about) an enabled id this build does not bundle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await loadExtensions(['a', 'missing'], { a: fake('a').load })).map((e) => e.id)).toEqual(['a']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'missing'"));
    warn.mockRestore();
  });
});
