import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { sidebarStorage } from '../lib/prefs';
import { Sidebar } from './Sidebar';
import { ChannelPane } from './ChannelPane';
import { Notice } from './Notice';
import { ThreadPanel } from './ThreadPanel';
import { SearchPalette } from './SearchPalette';
import { Sweep } from './Sweep';
import { Directory } from './Directory';
import { Inbox } from './Inbox';
import type { SectionId } from './settings/sections';

export function Workspace({ onLogout, onOpenSettings }: {
  onLogout: () => void;
  onOpenSettings: (section?: SectionId) => void;
}) {
  const threadRootId = useAppStore((s) => s.threadRootId);
  const history = useAppStore((s) => s.history);
  const historyIndex = useAppStore((s) => s.historyIndex);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialScoped, setSearchInitialScoped] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => sidebarStorage.loadCollapsed());

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const newValue = !prev;
      sidebarStorage.saveCollapsed(newValue);
      return newValue;
    });
  }, []);

  const handleOpenSearch = useCallback((scoped: boolean) => {
    setSearchInitialScoped(scoped);
    setSearchOpen(true);
  }, []);

  const handleGoBack = useCallback(async () => {
    await getController().goBack();
  }, []);

  const handleGoForward = useCallback(async () => {
    await getController().goForward();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // 입력 요소에 포커스가 있으면 단축키를 가로채지 않는다.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchInitialScoped(false);
        setSearchOpen(true);
        return;
      }

      // 뒤로: Cmd/Ctrl + [
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        void handleGoBack();
        return;
      }

      // 앞으로: Cmd/Ctrl + ]
      if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault();
        void handleGoForward();
        return;
      }

      // 사이드바 토글: Cmd/Ctrl + \
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        handleToggleSidebar();
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleGoBack, handleGoForward, handleToggleSidebar]);

  return (
    <div className="flex h-screen text-sm">
      <Sidebar
        onLogout={onLogout}
        onOpenSettings={onOpenSettings}
        onOpenDirectory={() => setDirectoryOpen(true)}
        onOpenInbox={() => setInboxOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* 헤더: 뒤로/앞으로 버튼과 사이드바 펼치기 버튼 */}
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-1">
          {sidebarCollapsed && (
            <button
              onClick={handleToggleSidebar}
              className="rounded px-2 py-1 hover:bg-zinc-700"
              aria-label="사이드바 펼치기"
              title="사이드바 펼치기"
            >
              ☰
            </button>
          )}
          <button
            onClick={handleGoBack}
            disabled={!canGoBack}
            className={`rounded px-2 py-1 ${canGoBack ? 'hover:bg-zinc-700' : 'text-zinc-600 cursor-not-allowed'}`}
            aria-label="뒤로"
            title="뒤로 (Cmd+[)"
          >
            ←
          </button>
          <button
            onClick={handleGoForward}
            disabled={!canGoForward}
            className={`rounded px-2 py-1 ${canGoForward ? 'hover:bg-zinc-700' : 'text-zinc-600 cursor-not-allowed'}`}
            aria-label="앞으로"
            title="앞로 (Cmd+])"
          >
            →
          </button>
          {/* 훑기는 사이드바가 아니라 헤더에 둔다 — 사이드바를 접은 사람도 미읽음을
              정리할 수 있어야 하고, 그것이 바로 이 기능을 쓰는 상황이다. */}
          <button
            onClick={() => setSweepOpen(true)}
            className="ml-auto rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            title="미읽음을 하나씩 훑는다"
          >
            미읽음 훑기
          </button>
        </div>
        {/* 알림은 헤더 바로 아래, 대화 위에 둔다 — 채널 안에 그리면 채널을 못 연 실패를
            보여 줄 자리 자체가 없다. */}
        <Notice />
        <div className="flex flex-1 overflow-hidden">
          <ChannelPane onOpenSearch={handleOpenSearch} />
          {threadRootId && <ThreadPanel />}
        </div>
      </div>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} initialScoped={searchInitialScoped} />
      <Sweep open={sweepOpen} onClose={() => setSweepOpen(false)} />
      <Directory open={directoryOpen} onClose={() => setDirectoryOpen(false)} />
      <Inbox open={inboxOpen} onClose={() => setInboxOpen(false)} />
    </div>
  );
}