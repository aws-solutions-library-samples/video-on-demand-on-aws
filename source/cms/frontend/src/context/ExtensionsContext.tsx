/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * The enabled UI extensions for the signed-in console: fetched once from `GET /config` (`extensions`, set by
 * the CMS stack from `.env` `VOD_EXTENSIONS`) and loaded lazily (see ../lib/extensions.ts). Consumers read
 * them with `useExtensions()`; until they are loaded a spinner stands in for the app.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Box, Spinner } from '@cloudscape-design/components';
import { getCmsConfig } from '../lib/api';
import { loadExtensions, type CmsUiExtension } from '../lib/extensions';

const ExtensionsContext = createContext<readonly CmsUiExtension[]>([]);

/** The enabled UI extensions (empty for the base console). */
export const useExtensions = (): readonly CmsUiExtension[] => useContext(ExtensionsContext);

export function ExtensionsProvider({ children }: { children: ReactNode }) {
  const [extensions, setExtensions] = useState<readonly CmsUiExtension[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCmsConfig()
      .then((config) => loadExtensions(config.extensions ?? []))
      .catch((err: unknown) => {
        // Never block the console on this: without the config it runs as the base console.
        console.error('Could not load the enabled CMS extensions; continuing without them.', err);
        return [];
      })
      .then((loaded) => {
        if (!cancelled) setExtensions(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!extensions) {
    return (
      <Box textAlign="center" padding="xxxl">
        <Spinner size="large" />
      </Box>
    );
  }
  return <ExtensionsContext.Provider value={extensions}>{children}</ExtensionsContext.Provider>;
}
