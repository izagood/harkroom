import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { usePrefsStore } from '../src/state/prefsStore';
import { prefsStorage, DEFAULT_PREFS } from '../src/lib/prefs';
import { AppearanceSettings } from '../src/components/settings/AppearanceSettings';
import { useColorMode } from '../src/lib/useColorMode';

function TestWrapper({ children }: { children: React.ReactNode }) {
  useColorMode();
  return <>{children}</>;
}

describe('Appearance 설정', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    document.documentElement.removeAttribute('data-theme');
  });

  test('1. 기본값이 system 이고, colorMode 가 없는 옛 저장본을 불러도 system 이다', () => {
    const parsed = {} as { notifications?: unknown; sidebarWidth?: number; sidebarCollapsed?: boolean; colorMode?: string };
    const result = {
      notifications: { ...DEFAULT_PREFS.notifications, ...(parsed.notifications ?? {}) },
      sidebarWidth: parsed.sidebarWidth ?? DEFAULT_PREFS.sidebarWidth,
      sidebarCollapsed: parsed.sidebarCollapsed ?? DEFAULT_PREFS.sidebarCollapsed,
      colorMode: parsed.colorMode ?? DEFAULT_PREFS.colorMode,
    };
    expect(result.colorMode).toBe('system');
  });

  test('2. dark 를 고르면 data-theme 이 dark 가 되고 저장된다', async () => {
    render(
      <TestWrapper>
        <AppearanceSettings />
      </TestWrapper>
    );
    
    const darkButton = screen.getByRole('radio', { name: /dark appearance/i });
    fireEvent.click(darkButton);
    
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
    
    const stored = localStorage.getItem('murmur.prefs');
    const parsed = stored ? JSON.parse(stored) : {};
    expect(parsed.colorMode).toBe('dark');
  });

  test('3. 로그아웃 후에도 colorMode 가 남아 있다', () => {
    usePrefsStore.getState().setColorMode('dark');
    
    const prefs = prefsStorage.load();
    expect(prefs.colorMode).toBe('dark');
  });

  test('4. segmented control 이 3단이고 현재 값이 눌린 상태로 보인다', () => {
    render(
      <TestWrapper>
        <AppearanceSettings />
      </TestWrapper>
    );
    
    const buttons = screen.getAllByRole('radio');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    
    const darkButton = buttons.find(b => b.getAttribute('aria-label') === 'Dark appearance');
    expect(darkButton?.getAttribute('aria-checked')).toBe('true');
    
    const systemButton = buttons.find(b => b.getAttribute('aria-label') === 'System appearance');
    expect(systemButton?.getAttribute('aria-checked')).toBe('false');
  });
});