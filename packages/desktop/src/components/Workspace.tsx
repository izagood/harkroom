import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { sidebarStorage } from '../lib/prefs';
import { isMacOS, MAC_TRAFFIC_LIGHT_PL } from '../lib/platform';
import { Sidebar } from './Sidebar';
import { ChannelPane } from './ChannelPane';
import { Notice } from './Notice';
import { ThreadPanel } from './ThreadPanel';
import { TerminalPanel } from './TerminalPanel';
import { SearchPalette } from './SearchPalette';
import { Sweep } from './Sweep';
import { Directory } from './Directory';
import { Inbox } from './Inbox';
import { SavedMessages } from './SavedMessages';
import type { SectionId } from './settings/sections';

export function Workspace({ onLogout, onOpenSettings }: {
  onLogout: () => void;
  /** #279: `targetId` 는 "이 에이전트가 선택된 상태로" 라는 뜻이다. */
  onOpenSettings: (section?: SectionId, targetId?: string) => void;
}) {
  const threadRootId = useAppStore((s) => s.threadRootId);
  const terminalAgentId = useAppStore((s) => s.terminalAgentId);
  const history = useAppStore((s) => s.history);
  const historyIndex = useAppStore((s) => s.historyIndex);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialScoped, setSearchInitialScoped] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryAccountId, setDirectoryAccountId] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
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

  const handleOpenDirectory = useCallback((accountId: string | null = null) => {
    setDirectoryAccountId(accountId);
    setDirectoryOpen(true);
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

  /**
   * 신호등 여백은 **창의 좌상단에 실제로 있는 바**가 진다. 사이드바가 펴져 있으면 그 자리는
   * 사이드바 브랜드 바(`Sidebar`)이고, 접었을 때만 이 헤더가 좌상단이 된다. 판정은 마운트마다
   * 한 번이면 된다 — 앱이 도는 동안 OS 가 바뀌지는 않는다.
   */
  const isMac = useMemo(() => isMacOS(), []);
  const headerNeedsTrafficLightRoom = isMac && sidebarCollapsed;

  return (
    <div className="flex h-screen text-sm">
      <Sidebar
        onLogout={onLogout}
        onOpenSettings={onOpenSettings}
        onOpenDirectory={() => handleOpenDirectory(null)}
        onOpenInbox={() => setInboxOpen(true)}
        onOpenSaved={() => setSavedOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* 헤더: 뒤로/앞으로 버튼과 사이드바 펼치기 버튼(#270 에서 창 손잡이가 되었다).
            `data-tauri-drag-region` 은 **그 속성이 있는 요소 자체**를 눌렀을 때만 드래그를
            시작한다 — 자식 버튼을 누르면 이벤트 대상이 버튼이므로 창은 움직이지 않고 버튼이
            그대로 눌린다. 그래서 손잡이는 루트에만 두고 버튼·입력에는 붙이지 않는다.

            왼쪽 여백은 `pl-2`/`pl-[78px]` 를 **갈아 끼운다**. `px-2` 와 `pl-[78px]` 를 같이
            두면 어느 쪽이 이기는지가 Tailwind 의 출력 순서에 달리므로 승부를 만들지 않는다. */}
        <div
          data-testid="app-header"
          data-tauri-drag-region
          className={`flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 py-1 pr-2 ${
            headerNeedsTrafficLightRoom ? MAC_TRAFFIC_LIGHT_PL : 'pl-2'
          }`}
        >
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
          {/* 멘션 이동(#279)의 배선은 **여기**다. 초판이 이 두 줄을 빼먹어 앱에서 모든
              멘션이 눌러도 아무 일이 없는 버튼이었다 — 단위 테스트는 props 를 손으로
              넘겨 그 사실을 볼 수 없었다. `test/mentionClick.test.tsx` 가 이 화면을
              통째로 띄워 지킨다. */}
          <ChannelPane
            onOpenSearch={handleOpenSearch}
            onOpenDirectory={handleOpenDirectory}
            onOpenSettings={onOpenSettings}
          />
          {threadRootId && (
            <ThreadPanel onOpenDirectory={handleOpenDirectory} onOpenSettings={onOpenSettings} />
          )}
          {/* #141: 터미널은 스레드 패널과 **같은 자리**를 쓰고 둘이 나란히 열린다.
              채널 레이아웃 안에 심지 않는다 — `#189`(앱 안 터미널 패널이 어디서 도는가)가
              열려 있어서, 지금 심으면 그 결정이 코드로 먼저 굳는다. */}
          {terminalAgentId && <TerminalPanel />}
        </div>
      </div>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} initialScoped={searchInitialScoped} />
      <Sweep open={sweepOpen} onClose={() => setSweepOpen(false)} />
      <Directory open={directoryOpen} onClose={() => { setDirectoryOpen(false); setDirectoryAccountId(null); }} accountId={directoryAccountId} />
      <Inbox open={inboxOpen} onClose={() => setInboxOpen(false)} />
      <SavedMessages open={savedOpen} onClose={() => setSavedOpen(false)} />
    </div>
  );
}
