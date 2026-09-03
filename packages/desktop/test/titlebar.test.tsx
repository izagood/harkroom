import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Workspace } from '../src/components/Workspace';
import { sidebarStorage } from '../src/lib/prefs';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('macOS title bar (#270)', () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    Object.defineProperty(process, 'cwd', {
      writable: true,
      value: () => '/home/jaebin/dev/my-workspace/murmur/.worktrees/tbar270b/packages/desktop',
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'cwd', {
      writable: true,
      value: originalCwd,
    });
  });

  describe('1. tauri.macos.conf.json', () => {
    it('exists with titleBarStyle: Overlay, hiddenTitle: true, title: murmur', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const configPath = path.join(process.cwd(), 'src-tauri/tauri.macos.conf.json');
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      expect(config.app.windows[0].titleBarStyle).toBe('Overlay');
      expect(config.app.windows[0].hiddenTitle).toBe(true);
      expect(config.app.windows[0].title).toBe('murmur');
    });
  });

  describe('2. tauri.conf.json', () => {
    it('does not have decorations: false and has title', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const configPath = path.join(process.cwd(), 'src-tauri/tauri.conf.json');
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      expect(config.app.windows[0].decorations).toBeUndefined();
      expect(config.app.windows[0].title).toBe('murmur');
    });
  });

  describe('3. 헤더 drag region', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 Windows' });
      vi.spyOn(sidebarStorage, 'loadCollapsed').mockReturnValue(false);
      useAppStore.getState().set({
        history: [{ channelId: 'general', threadRootId: null }],
        historyIndex: 0,
        threadRootId: null,
      });
    });

    it('헤더 루트에 data-tauri-drag-region 이 있다', () => {
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const header = screen.getByRole('button', { name: '뒤로' }).closest('div[data-tauri-drag-region]');
      expect(header).toBeTruthy();
    });

    it('버튼들에는 data-tauri-drag-region 이 없다', () => {
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const backButton = screen.getByRole('button', { name: '뒤로' });
      expect(backButton.getAttribute('data-tauri-drag-region')).toBeNull();

      const forwardButton = screen.getByRole('button', { name: '앞으로' });
      expect(forwardButton.getAttribute('data-tauri-drag-region')).toBeNull();
    });
  });

  describe('4. macOS 여백', () => {
    it('macOS 에서 pl-[78px] 클래스 적용', () => {
      vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Mac' });
      vi.spyOn(sidebarStorage, 'loadCollapsed').mockReturnValue(false);
      useAppStore.getState().set({
        history: [{ channelId: 'general', threadRootId: null }],
        historyIndex: 0,
        threadRootId: null,
      });

      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const header = screen.getByRole('button', { name: '뒤로' }).closest('div[data-tauri-drag-region]');
      expect(header?.className).toContain('pl-[78px]');
    });

    it('비macOS 에서 pl-[78px] 클래스 없음', () => {
      vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 Windows' });
      vi.spyOn(sidebarStorage, 'loadCollapsed').mockReturnValue(false);
      useAppStore.getState().set({
        history: [{ channelId: 'general', threadRootId: null }],
        historyIndex: 0,
        threadRootId: null,
      });

      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const header = screen.getByRole('button', { name: '뒤로' }).closest('div[data-tauri-drag-region]');
      expect(header?.className).not.toContain('pl-[78px]');
    });
  });

  describe('5. 헤더 버튼 클릭', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 Windows' });
      vi.spyOn(sidebarStorage, 'loadCollapsed').mockReturnValue(false);
      useAppStore.getState().set({
        history: [{ channelId: 'general', threadRootId: null }],
        historyIndex: 0,
        threadRootId: null,
      });
    });

    it('뒤로 버튼 클릭 시 에러 없이 클릭됨', () => {
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const backButton = screen.getByRole('button', { name: '뒤로' });
      expect(() => fireEvent.click(backButton)).not.toThrow();
    });

    it('앞으로 버튼 클릭 시 에러 없이 클릭됨', () => {
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const forwardButton = screen.getByRole('button', { name: '앞으로' });
      expect(() => fireEvent.click(forwardButton)).not.toThrow();
    });
  });
});