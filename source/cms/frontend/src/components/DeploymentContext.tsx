/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Side-nav deployment context (SideNavigation `itemsControl`): which VOD stack and Region this console
 * is operating, from GET /config, so operators running several stacks can tell them apart.
 */
import { useEffect, useState } from 'react';
import { Box, SpaceBetween } from '@cloudscape-design/components';
import { getCmsConfig } from '../lib/api';
import type { CmsConfig } from '../types';

export default function DeploymentContext() {
  const [config, setConfig] = useState<CmsConfig | null>(null);
  useEffect(() => {
    let active = true;
    getCmsConfig()
      .then((c) => active && setConfig(c))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (!config) return null;
  return (
    <SpaceBetween size="xxxs">
      <Box variant="awsui-key-label">Stack</Box>
      <Box fontSize="body-s">{config.stackName ?? 'Unknown stack'}</Box>
      <Box fontSize="body-s" color="text-status-inactive">
        {config.region ?? 'Unknown Region'}
      </Box>
    </SpaceBetween>
  );
}
