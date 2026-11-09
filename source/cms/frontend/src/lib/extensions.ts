/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * UI extension seam. An extension is a directory `src/extensions/<name>/` whose `index.ts(x)` exports
 * `extension: CmsUiExtension`. Each is bundled as its own lazy chunk and loaded only when the deployed API
 * reports it enabled (`GET /config` `extensions`, from `.env` `VOD_EXTENSIONS`), so the UI shows exactly the
 * modules whose API routes exist: see `../context/ExtensionsContext.tsx` (`useExtensions`). With none
 * enabled the app is the base console. Each slot is optional.
 */
import type { ComponentType, ReactElement } from 'react';
import type { Asset } from '../types';

/** Props of the asset player (asset detail + Watch pages). */
export interface AssetPlayerProps {
  asset: Asset;
  /** Start playback here (seconds), e.g. from a `?t=` deep link. */
  startAt?: number;
}

export interface CmsUiExtension {
  readonly id: string;
  /** Extra routes under the authenticated layout (paths relative to `/`). */
  readonly routes?: ReadonlyArray<{ path: string; element: ReactElement }>;
  /** Links in the side navigation's Labs (preview) group, which is shown only when an extension adds some. */
  readonly labsNavItems?: ReadonlyArray<{ text: string; href: string }>;
  /** Extra controls at the end of the Upload page's "Metadata (optional)" form (none in the base console). */
  readonly uploadMetadataExtras?: ReadonlyArray<ComponentType>;
  /** Replaces the built-in asset player (the first extension that provides one wins). */
  readonly AssetPlayer?: ComponentType<AssetPlayerProps>;
}

/** A lazy loader for one bundled extension's `index` module. */
export type ExtensionLoader = () => Promise<{ extension: CmsUiExtension }>;

/** The bundled extensions, by id (directory name). */
export const BUNDLED_EXTENSIONS: Readonly<Record<string, ExtensionLoader>> = Object.fromEntries(
  Object.entries(import.meta.glob<{ extension: CmsUiExtension }>('../extensions/*/index.{ts,tsx}')).map(([file, load]) => [
    file.split('/')[2],
    load,
  ]),
);

/**
 * Load the enabled extensions, in `ids` order. An enabled id with no bundled code (a UI built without it)
 * is skipped with a warning: the console still works, just without that module's UI.
 */
export async function loadExtensions(
  ids: readonly string[],
  bundled: Readonly<Record<string, ExtensionLoader>> = BUNDLED_EXTENSIONS,
): Promise<CmsUiExtension[]> {
  const known = ids.filter((id) => {
    if (bundled[id]) return true;
    console.warn(`CMS extension '${id}' is enabled by the API but not bundled in this UI build; skipping it.`);
    return false;
  });
  return Promise.all(known.map(async (id) => (await bundled[id]()).extension));
}
