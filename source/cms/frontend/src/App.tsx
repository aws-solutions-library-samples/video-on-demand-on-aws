/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * App shell — the prototype's Cloudscape layout: a dark-mode-aware,
 * Cognito-gated (split SignInPage), router-driven shell (TopNav + SideNavigation + AppLayout + Outlet).
 * Provider order: ColorModeProvider -> Amplify ThemeProvider(authTheme, colorMode) -> Authenticator.Provider
 * -> AuthGate -> BrowserRouter -> Routes. Cloudscape-native only (no Tailwind design-system).
 */
import { Authenticator, ThemeProvider, type Theme } from '@aws-amplify/ui-react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ColorModeProvider, useColorMode } from './context/ColorModeContext';
import MainLayout from './components/MainLayout';
import Portal from './pages/Portal';
import Watch from './pages/Watch';
import Assets from './pages/Assets';
import AssetDetail from './pages/AssetDetail';
import Upload from './pages/Upload';
import Settings from './pages/Settings';
import DocsMetadata from './pages/DocsMetadata';
import DocsStateMachines from './pages/DocsStateMachines';
import AuthGate from './components/SignInPage';
import { ExtensionsProvider, useExtensions } from './context/ExtensionsContext';

// Retokened login card so the Amplify Authenticator matches the AWS console palette.
const authTheme: Theme = {
  name: 'vod-cms-auth',
  tokens: {
    colors: {
      brand: {
        primary: {
          '80': { value: '#ff9900' },
          '90': { value: '#ec7211' },
          '100': { value: '#232f3e' },
        },
      },
    },
  },
};

function AuthenticatedApp() {
  return (
    <ExtensionsProvider>
      <AppRoutes />
    </ExtensionsProvider>
  );
}

function AppRoutes() {
  const extensions = useExtensions();
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MainLayout />}>
          <Route index element={<Navigate to="/assets" replace />} />
          <Route path="portal" element={<Portal />} />
          <Route path="portal/:guid" element={<Watch />} />
          <Route path="assets" element={<Assets />} />
          <Route path="assets/:guid" element={<AssetDetail />} />
          <Route path="upload" element={<Upload />} />
          <Route path="settings" element={<Settings />} />
          <Route path="docs/metadata" element={<DocsMetadata />} />
          <Route path="docs/state-machines" element={<DocsStateMachines />} />
          {extensions.flatMap((ext) => ext.routes ?? []).map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          <Route path="*" element={<Navigate to="/assets" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function ThemedAuthenticator() {
  const { dark } = useColorMode();
  return (
    <ThemeProvider theme={authTheme} colorMode={dark ? 'dark' : 'light'}>
      <Authenticator.Provider>
        <AuthGate>
          <AuthenticatedApp />
        </AuthGate>
      </Authenticator.Provider>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <ColorModeProvider>
      <ThemedAuthenticator />
    </ColorModeProvider>
  );
}
