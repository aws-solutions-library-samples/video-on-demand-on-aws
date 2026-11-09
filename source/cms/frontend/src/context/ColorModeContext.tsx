/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Dark-mode engine (Cloudscape-native). Dark-first, persisted to localStorage. On change it flips
 * Cloudscape's global mode via applyMode(). The Amplify login card follows through ThemeProvider's
 * `colorMode` prop (wired in App.tsx), so one toggle drives both the login screen and the app.
 * NB: intentionally does NOT pull in the prototype's separate Tailwind design-system setTheme().
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import { COLOR_MODE_KEY } from '../theme/tokens';

interface ColorModeValue {
  dark: boolean;
  setDark: (dark: boolean) => void;
  toggle: () => void;
}

const ColorModeContext = createContext<ColorModeValue | undefined>(undefined);

function initialDark(): boolean {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(COLOR_MODE_KEY) : null;
  if (stored === 'light') return false;
  if (stored === 'dark') return true;
  return true; // dark-first default (matches the prototype)
}

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [dark, setDarkState] = useState<boolean>(initialDark);

  useEffect(() => {
    applyMode(dark ? Mode.Dark : Mode.Light);
    try {
      localStorage.setItem(COLOR_MODE_KEY, dark ? 'dark' : 'light');
    } catch {
      /* ignore storage failures */
    }
  }, [dark]);

  const setDark = useCallback((v: boolean) => setDarkState(v), []);
  const toggle = useCallback(() => setDarkState((v) => !v), []);
  const value = useMemo(() => ({ dark, setDark, toggle }), [dark, setDark, toggle]);

  return <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>;
}

export function useColorMode(): ColorModeValue {
  const ctx = useContext(ColorModeContext);
  if (!ctx) throw new Error('useColorMode must be used within a ColorModeProvider');
  return ctx;
}
