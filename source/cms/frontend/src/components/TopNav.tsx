/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { TopNavigation } from '@cloudscape-design/components';
import { useAuthenticator } from '@aws-amplify/ui-react';
import { useNavigate } from 'react-router-dom';
import { useColorScheme } from '../hooks/useColorScheme';
import { APP_NAME } from '../theme/tokens';

/** Sticky top bar (matched by AppLayout headerSelector="#top-nav"): brand, color-mode toggle, user menu. */
export default function TopNav() {
  const navigate = useNavigate();
  const { dark, toggle } = useColorScheme();
  const { user, signOut } = useAuthenticator((ctx) => [ctx.user]);
  const loginId = user?.signInDetails?.loginId ?? user?.username ?? 'operator';

  return (
    <div id="top-nav" style={{ position: 'sticky', top: 0, zIndex: 1002 }}>
      <TopNavigation
        identity={{
          href: '/assets',
          title: APP_NAME,
          logo: { src: '/AWS_logo_WHT_100.png', alt: 'AWS' },
          onFollow: (e) => {
            e.preventDefault();
            navigate('/assets');
          },
        }}
        i18nStrings={{
          overflowMenuTriggerText: 'More',
          overflowMenuTitleText: 'All',
          overflowMenuBackIconAriaLabel: 'Back',
          overflowMenuDismissIconAriaLabel: 'Close menu',
        }}
        utilities={[
          {
            type: 'button',
            iconName: dark ? 'star-filled' : 'star',
            text: dark ? 'Dark' : 'Light',
            ariaLabel: 'Toggle color mode',
            onClick: () => toggle(),
          },
          {
            type: 'menu-dropdown',
            text: loginId,
            iconName: 'user-profile',
            items: [
              { id: 'settings', text: 'Settings' },
              { id: 'signout', text: 'Sign out' },
            ],
            onItemClick: (e) => {
              if (e.detail.id === 'signout') signOut?.();
              else if (e.detail.id === 'settings') navigate('/settings');
            },
          },
        ]}
      />
    </div>
  );
}
