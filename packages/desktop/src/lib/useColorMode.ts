import { useEffect } from 'react';
import { usePrefsStore } from '../state/prefsStore';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useColorMode() {
  const colorMode = usePrefsStore((s) => s.colorMode);

  useEffect(() => {
    const applyTheme = () => {
      const theme = colorMode === 'system' ? getSystemTheme() : colorMode;
      document.documentElement.setAttribute('data-theme', theme);
    };

    applyTheme();

    if (colorMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme();
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, [colorMode]);
}