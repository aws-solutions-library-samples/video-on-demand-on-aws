/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Side navigation, grouped by the operator workflow as collapsible sections: 1 · Ingest (upload) ->
 * 2 · Process (assets moving through the pipeline, with a "Needs attention" view of failed ones) ->
 * 3 · Publish (the viewer portal); then Labs (enabled extensions' preview features, collapsed; omitted when
 * there are none) and Documentation
 * (collapsed). `itemsControl` shows the deployment (stack + Region). Structure from branch
 * prototype/cms-nav (variant D), styling from prototype/cms-nav-style (variant B). Settings lives in
 * the top-bar user menu.
 */
import { Badge, SideNavigation, StatusIndicator, type SideNavigationProps } from '@cloudscape-design/components';
import { useLocation, useNavigate } from 'react-router-dom';
import { useFailedAssetCount, type FailedAssetCount } from '../hooks/useFailedAssetCount';
import DeploymentContext from './DeploymentContext';
import { useExtensions } from '../context/ExtensionsContext';

export const NEEDS_ATTENTION_HREF = '/assets?status=Error';

function needsAttentionInfo(failed: FailedAssetCount | null) {
  if (!failed) return undefined;
  if (!failed.count) return <StatusIndicator type="success">0</StatusIndicator>;
  return <Badge color="red">{failed.more ? `${failed.count}+` : failed.count}</Badge>;
}

function items(failed: FailedAssetCount | null, labsItems: { text: string; href: string }[]): SideNavigationProps.Item[] {
  return [
    {
      type: 'section',
      text: '1 · Ingest',
      defaultExpanded: true,
      items: [{ type: 'link', text: 'Upload media', href: '/upload' }],
    },
    {
      type: 'section',
      text: '2 · Process',
      defaultExpanded: true,
      items: [
        { type: 'link', text: 'All assets', href: '/assets' },
        { type: 'link', text: 'Needs attention', href: NEEDS_ATTENTION_HREF, info: needsAttentionInfo(failed) },
      ],
    },
    {
      type: 'section',
      text: '3 · Publish',
      defaultExpanded: true,
      items: [{ type: 'link', text: 'Viewer portal', href: '/portal' }],
    },
    { type: 'divider' },
    // Labs: preview features contributed by enabled extensions; the base console has none, so no section.
    ...(labsItems.length > 0
      ? ([
          {
            type: 'expandable-link-group',
            text: 'Labs (preview)',
            href: labsItems[0].href,
            items: labsItems.map((item) => ({ type: 'link', text: item.text, href: item.href })),
          },
          { type: 'divider' },
        ] satisfies SideNavigationProps.Item[])
      : []),
    {
      type: 'section',
      text: 'Documentation',
      defaultExpanded: false,
      items: [
        { type: 'link', text: 'Sidecar files', href: '/docs/metadata' },
        { type: 'link', text: 'Workflow', href: '/docs/state-machines' },
      ],
    },
  ];
}

/** The nav href that should show as active for the current location. */
function activeHref(pathname: string, search: string): string {
  if (pathname === '/assets' && new URLSearchParams(search).get('status') === 'Error') return NEEDS_ATTENTION_HREF;
  if (pathname.startsWith('/portal')) return '/portal';
  if (pathname.startsWith('/assets')) return '/assets';
  return pathname;
}

/** Router-driven Cloudscape side navigation; active item follows the current path. */
export default function Navigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const failed = useFailedAssetCount();
  const labsItems = useExtensions().flatMap((ext) => ext.labsNavItems ?? []);
  return (
    <SideNavigation
      activeHref={activeHref(location.pathname, location.search)}
      header={{ href: '/assets', text: 'VOD console' }}
      items={items(failed, labsItems)}
      itemsControl={<DeploymentContext />}
      onFollow={(e) => {
        if (!e.detail.external) {
          e.preventDefault();
          navigate(e.detail.href);
        }
      }}
    />
  );
}
