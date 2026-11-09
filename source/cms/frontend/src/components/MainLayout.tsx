/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * The Cloudscape shell: TopNav above AppLayout (navigation + tools + Outlet). Pages render into the
 * Outlet. Mirrors the edge-prototype-starter MainLayout (Cloudscape-native subset).
 */
import { useState } from 'react';
import { AppLayout } from '@cloudscape-design/components';
import { Outlet } from 'react-router-dom';
import TopNav from './TopNav';
import Navigation from './Navigation';
import HelpPanelContent from './HelpPanel';

export default function MainLayout() {
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <>
      <TopNav />
      <AppLayout
        headerSelector="#top-nav"
        navigation={<Navigation />}
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        tools={<HelpPanelContent />}
        toolsOpen={toolsOpen}
        onToolsChange={({ detail }) => setToolsOpen(detail.open)}
        content={<Outlet />}
        ariaLabels={{
          navigation: 'Navigation',
          navigationToggle: 'Open navigation',
          navigationClose: 'Close navigation',
          tools: 'Help panel',
          toolsToggle: 'Open help panel',
          toolsClose: 'Close help panel',
        }}
      />
    </>
  );
}
