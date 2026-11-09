/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { Box, HelpPanel } from '@cloudscape-design/components';

/** AppLayout `tools` content. */
export default function HelpPanelContent() {
  return (
    <HelpPanel header={<h2>Video on Demand on AWS</h2>}>
      <Box variant="p">
        Browse and inspect assets processed by the Video on Demand pipeline. Data is read through an
        authenticated API backed by the pipeline&apos;s DynamoDB job table.
      </Box>
      <Box variant="p">
        Use the navigation to switch views. Toggle light/dark from the top bar or Settings.
      </Box>
    </HelpPanel>
  );
}
