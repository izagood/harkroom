import { useState, useEffect, useCallback } from 'react';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { sidebarStorage } from '../lib/prefs';
import { usePrefsStore } from '../state/prefsStore';
import { DEFAULT_ZOOM, stepZoom } from '../lib/zoom';
// `isMacOS`·`MAC_TRAFFIC_LIGHT_PL` 이 여기 있었다 — 좌상단은 이제 늘 레일이다(아래 주석).
import { TOP_BAR_BG, TOP_BAR_H } from '../lib/platform';
import { CommunityRail } from './CommunityRail';
import { Rail, type RailPanel } from './Rail';
import { Sidebar } from './Sidebar';
import { SidebarToggleIcon } from './SidebarToggleIcon';
import { ChannelPane } from './ChannelPane';
import { AgentTower } from './AgentTower';
import { Notice } from './Notice';
import { ProjectionBanner } from './ProjectionBanner';
import { UpdateToast } from './UpdateToast';
import { ThreadPanel } from './ThreadPanel';
import { TerminalPanel } from './TerminalPanel';
import { SearchPalette, type SearchScope } from './SearchPalette';
import { Sweep } from './Sweep';
import { Directory } from './Directory';
import { Profile } from './Profile';
import { ChannelDirectory } from './ChannelDirectory';
import { Inbox } from './Inbox';
import { SavedMessages } from './SavedMessages';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

export function Workspace({ onLogout, onOpenSettings }: {
  onLogout: () => void;
  /** #279: `targetId` 는 "이 에이전트가 선택된 상태로" 라는 뜻이다. */
  onOpenSettings: (section?: SectionId, targetId?: string) => void;
}) {
  const t = useT();
  const threadRootId = useActiveStore((s) => s.threadRootId);
  const terminalTarget = useActiveStore((s) => s.terminalTarget);
  const history = useActiveStore((s) => s.history);
  const historyIndex = useActiveStore((s) => s.historyIndex);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialScope, setSearchInitialScope] = useState<SearchScope>('all');
  const [sweepOpen, setSweepOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [channelDirectoryOpen, setChannelDirectoryOpen] = useState(false);
  const [directoryAccountId, setDirectoryAccountId] = useState<string | null>(null);
  const [profileAccountId, setProfileAccountId] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => sidebarStorage.loadCollapsed());
  /**
   * 레일이 고른 칸(정본 문서 `docs/desktop-rail.html` 1단계). **레일 안이 아니라 여기서
   * 든다** — 레일과 사이드바가 같은 값을 봐야 하고, 둘 중 하나가 가지면 다른 쪽이 그것을
   * 되받는 배선이 생긴다. 형제 둘의 공통 부모가 이 화면이다.
   *
   * **영속하지 않는다.** 다시 열었을 때 DM 칸에서 시작하면 "채널이 사라졌다"로 읽히고,
   * 홈은 Inbox·즐겨찾기·채널이 모두 있는 칸이라 어디로 갈지 고르기에 가장 나은 출발점이다.
   * 기억해 둘 값이라는 근거가 실제로 생기면 `prefs` 에 넣는다(지금 넣으면 추측이다).
   */
  const [railPanel, setRailPanel] = useState<RailPanel>('home');

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
    setSearchInitialScope(scoped ? 'channel' : 'all');
    setSearchOpen(true);
  }, []);

  const handleGoBack = useCallback(async () => {
    await getController().goBack();
  }, []);

  const handleGoForward = useCallback(async () => {
    await getController().goForward();
  }, []);

  /**
   * 이름을 누르면 **프로필**이 열리고, 아무도 지목하지 않으면 디렉터리(검색 목록)가 열린다
   * (identity 문서 · Task 14).
   *
   * 지금까지는 둘 다 디렉터리였다 — `MessageBody` 는 접근성 이름을 이미 "프로필 열기"로
   * 부르고 있었으므로 **그 이름이 거짓이었다.** 디렉터리는 "누가 있나"에 답하는 검색이고,
   * 프로필은 "이 사람이 무엇인가"에 답한다: 물음이 다르므로 화면도 다르다.
   */
  const handleOpenDirectory = useCallback((accountId: string | null = null) => {
    if (accountId) { setProfileAccountId(accountId); return; }
    setDirectoryAccountId(null);
    setDirectoryOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      /**
       * ⌘F 는 **입력 중에도** 먹는다. 브라우저·에디터에서 ⌘F 는 글을 쓰다가도 찾기를 여는
       * 키라, 여기서만 안 되면 사람은 키가 없는 줄 안다. 나머지 단축키는 아래 가드대로
       * 입력 요소에 포커스가 있으면 가로채지 않는다.
       *
       * ⌘K(전체)와 다른 물음이다: ⌘F 는 **지금 보고 있는 것 안에서** 찾는다 — 스레드
       * 패널이 열려 있으면 그 스레드, 없으면 활성 채널이다. ⌘K 의 두 번째 입구가 되면
       * 두 키를 나눠 둔 뜻이 없어진다.
       */
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchInitialScope(threadRootId ? 'thread' : 'channel');
        setSearchOpen(true);
        return;
      }

      /**
       * 확대/축소도 **입력 중에 먹는다** — ⌘F 와 같은 이유다. 글을 쓰다가 작아서 안 보이는
       * 것이 이 기능이 생긴 이유인데, 하필 그 자리(작성창)에서만 안 들으면 키가 없는 것과
       * 같다. 조합키라 타이핑과 부딪치지 않는다.
       *
       * **Tauri 의 `zoomHotkeysEnabled` 를 쓰지 않고 여기서 잡는다.** 그 폴리필은 20% 씩
       * 제멋대로 오가면서 프런트엔드에 값을 알려주지 않아, 설정 화면의 라디오는 100% 인데
       * 화면은 140% 인 상태를 만든다. 여기서 `prefs.zoom` 을 고치면 손잡이가 하나다 —
       * 설정 화면과 단축키가 같은 값을 읽고 쓴다(`lib/zoom.ts`).
       *
       * `=`·`+` 를 함께 받는 이유: macOS 에서 ⌘+ 는 Shift 를 함께 눌러야 `+` 가 되고,
       * 그냥 누르면 `=` 가 온다. 사람은 둘 다 "키우기"로 누른다.
       */
      if (e.metaKey || e.ctrlKey) {
        const zoomKey = e.key === '=' || e.key === '+' ? 1 : e.key === '-' || e.key === '_' ? -1 : 0;
        if (zoomKey !== 0) {
          e.preventDefault();
          const { zoom, setZoom } = usePrefsStore.getState();
          setZoom(stepZoom(zoom, zoomKey === 1 ? 1 : -1));
          return;
        }
        if (e.key === '0') {
          e.preventDefault();
          usePrefsStore.getState().setZoom(DEFAULT_ZOOM);
          return;
        }
      }

      // 입력 요소에 포커스가 있으면 단축키를 가로채지 않는다.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchInitialScope('all');
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
  }, [handleGoBack, handleGoForward, handleToggleSidebar, threadRootId]);

  /*
   * 신호등 여백은 **창의 좌상단에 실제로 있는 바**가 진다(#270). 그 자리가 이제 늘
   * 레일이다 — 사이드바를 접어도 레일은 남으므로 이 헤더가 좌상단이 되는 경우가 없어졌다.
   * 그래서 `headerNeedsTrafficLightRoom` 판정을 지웠다: 조건이 항상 거짓인 분기를 남겨
   * 두면 다음 사람이 그 분기가 살아 있다고 읽는다.
   */

  /*
   * **앱 기본 글자 크기는 여기 한 줄이 정한다** — 타이포 4단의 본문단 13px 이다.
   *
   * 14px(`text-sm`)이었다. 그 값은 4단(11 / 13 / 15 / 17) 중 아무것도 아니었고, 그래서
   * 화면 아래쪽 자리마다 `text-xs`·`text-sm` 으로 다시 덮어야 했다 — 덮는 쪽도 12·14px
   * 이라 어휘가 둘로 갈렸다. 이 한 줄을 13px 로 내리면 **본문 자리는 아무것도 안 적어도
   * 맞다**. 실제로 이 작업에서 아래쪽의 중복 선언 여러 곳이 그래서 사라졌다.
   *
   * **`text-body` 는 `@theme` 토큰이다**(`index.css`). 한동안 임의값(`text-[13px]`)이었고,
   * 그때의 이유는 척도 이름이 v4 기본값 12 / 14 / 16px 이라 4단 중 아무것도 가리킬 수
   * 없다는 것이었다. v4 기본 척도를 재정의하는 길(`text-sm` 을 13px 로)은 지금도 택하지
   * 않는다 — 그러면 `text-sm` 이 문서의 14px 과 다른 값이 되어 사람이 두 뜻을 계속
   * 구분해야 한다. 대신 4단에 **역할 이름**을 새로 줬다. 회귀선은 `test/typeScale.test.ts` 다.
   */
  return (
    <div className="flex h-full text-body">
      {/* 전환기 레일은 **사이드바 밖**에 둔다(#165). 사이드바 안에 넣으면 사이드바를 접는
          순간(폭 0) 전환기까지 함께 사라져, 커뮤니티를 바꾸려면 먼저 사이드바를 펴야 한다.
          커뮤니티가 하나면 이 컴포넌트는 아무것도 그리지 않으므로 오늘 화면과 같다. */}
      <CommunityRail />
      {/*
        레일도 **사이드바 밖**이다(정본 문서 1단계). `CommunityRail`(#165) 이 같은 이유로
        이미 밖에 있다: 사이드바 안에 넣으면 사이드바를 접는 순간(폭 0) 레일까지 함께
        사라져, 칸을 바꾸려면 먼저 사이드바를 펴야 한다.

        문서가 스스로 적어 둔 손해가 여기서 갈린다 — *"좁은 창에서는 레일만 남기고 패널을
        접는 단계가 하나 더 필요하다."* 그 단계가 이미 있다: `⌘\` 로 사이드바를 접으면
        62px 레일만 남는다. 문서가 "필요하다"고 적은 것을 새로 만들지 않고 기존 접기에
        얹은 것이 이 배치의 값이다.
      */}
      <Rail
        panel={railPanel}
        onPanelChange={setRailPanel}
        onOpenSaved={() => setSavedOpen(true)}
        onOpenSettings={onOpenSettings}
        /* 전환 목록은 문서의 4단계다. 그때까지 마크는 설정 › 커뮤니티로 보낸다 —
           눌러도 아무 일이 없는 마크를 두지 않는다(design.md §4). */
        onOpenCommunityMark={() => onOpenSettings('communities')}
        onLogout={onLogout}
      />
      {/*
        업데이트 팝업의 **앵커**다. 폭 0 이므로 칸을 차지하지 않지만, 흐름 안에 있으니
        왼쪽 끝이 곧 "레일 오른쪽 = 사이드바 칸의 시작"이다. 팝업은 이 안에서
        `absolute` 로 서서 레이아웃을 밀지 않는다.

        원래는 팝업 자신이 `fixed bottom-4 right-4` 였고, 그 자리가 컴포저의 `전송` 을
        덮었다. 왼쪽으로 옮기면서 `fixed left-[62px]` 로 레일 폭을 베낄 수도 있었지만,
        커뮤니티가 둘 이상일 때 `CommunityRail`(56px)이 하나 더 서므로 그 숫자는 곧
        틀린다. 폭을 아는 것은 레이아웃이니 자리도 레이아웃이 정하게 둔다.

        사이드바 **안**에 넣지 않는 이유는 `CommunityRail`·`Rail` 이 사이드바 밖에 있는
        것과 같다: 사이드바를 접으면(폭 0) 팝업까지 사라져, 업데이트를 알리는 자리가
        접기 상태에 따라 없어진다.
      */}
      <div className="relative w-0 shrink-0">
        <UpdateToast />
      </div>
      <Sidebar
        panel={railPanel}
        onOpenDirectory={() => handleOpenDirectory(null)}
        onOpenChannelDirectory={() => setChannelDirectoryOpen(true)}
        onOpenInbox={() => setInboxOpen(true)}
        /* 에이전트 격자의 카드가 여는 곳. 신호는 `#279` 의 `onOpenSettings(section, targetId)`
           를 **재사용**한다 — 프로필의 `에이전트 설정` 버튼과 본문 멘션이 이미 그것으로 같은
           자리를 열고 있으므로, 새 신호를 만들면 같은 문에 손잡이가 셋이 된다. */
        onOpenAgentConfig={(agentId) => onOpenSettings('agents', agentId)}
        /* 설정을 볼 수 없는 사람이 카드를 눌렀을 때. 프로필을 여는 함수는 이미 하나다
           (`handleOpenDirectory` — id 를 주면 프로필, 안 주면 디렉터리). */
        onOpenProfile={(accountId) => handleOpenDirectory(accountId)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* 헤더: 뒤로/앞으로 버튼과 사이드바 펼치기 버튼(#270 에서 창 손잡이가 되었다).
            `data-tauri-drag-region` 은 **그 속성이 있는 요소 자체**를 눌렀을 때만 드래그를
            시작한다 — 자식 버튼을 누르면 이벤트 대상이 버튼이므로 창은 움직이지 않고 버튼이
            그대로 눌린다. 그래서 손잡이는 루트에만 두고 버튼·입력에는 붙이지 않는다.

            신호등 여백은 여기가 지지 않는다 — 창의 좌상단은 늘 레일이다(위 주석). */}
        <div
          data-testid="app-header"
          data-tauri-drag-region
          /*
            면 색은 `TOP_BAR_BG` 가 정한다(요청 4). 값은 이 판 전과 같은 `raised` 지만, 이제
            **여기서 정하지 않는다** — 레일의 띠·브랜드 바와 한 줄로 보이는 조각이라 한 곳에서
            같이 바뀌어야 한다. 여기 색을 손으로 적으면 다음에 한쪽만 고쳐지고, 그 어긋남이
            방금 사용자가 지적한 것이다.
          */
          className={`flex ${TOP_BAR_H} items-center gap-2 border-b border-border ${TOP_BAR_BG} pl-2 pr-2`}
        >
          {sidebarCollapsed && (
            <button
              onClick={handleToggleSidebar}
              className="rounded px-2 py-1 hover:bg-surface-hover"
              aria-label={t('workspace.showSidebar')}
              title={t('workspace.showSidebar')}
            >
              <SidebarToggleIcon />
            </button>
          )}
          <button
            onClick={handleGoBack}
            disabled={!canGoBack}
            className={`rounded px-2 py-1 ${canGoBack ? 'hover:bg-surface-hover' : 'text-fg-muted cursor-not-allowed'}`}
            aria-label={t('workspace.back')}
            title={t('workspace.backTitle')}
          >
            ←
          </button>
          <button
            onClick={handleGoForward}
            disabled={!canGoForward}
            className={`rounded px-2 py-1 ${canGoForward ? 'hover:bg-surface-hover' : 'text-fg-muted cursor-not-allowed'}`}
            aria-label={t('workspace.forward')}
            title={t('workspace.forwardTitle')}
          >
            →
          </button>
          {/* 훑기는 사이드바가 아니라 헤더에 둔다 — 사이드바를 접은 사람도 미읽음을
              정리할 수 있어야 하고, 그것이 바로 이 기능을 쓰는 상황이다. */}
          <button
            onClick={() => setSweepOpen(true)}
            // 같은 헤더 줄의 앞/뒤 버튼은 크기를 안 적어 본문단을 물려받는다 — 이 버튼만
            // 아랫단으로 내리면 한 줄 안에 두 단이 서고, 그 줄이 들쭉날쭉해진다.
            className="ml-auto rounded px-2 py-1 text-fg-muted hover:bg-surface-hover"
            title={t('workspace.sweepTitle')}
          >
            {t('workspace.sweep')}
          </button>
        </div>
        {/* 알림은 헤더 바로 아래, 대화 위에 둔다 — 채널 안에 그리면 채널을 못 연 실패를
            보여 줄 자리 자체가 없다. */}
        <Notice />
        {/*
          투영 고장은 **여기**서 말한다(#488 A3-a). 전에는 사이드바 `ACTIVE WORK` 안에
          있었는데, 그 칸은 "지금 무슨 일이 벌어지는가"를 말하는 자리라 **고장이 일처럼**
          보였고 고치는 문(설정 열기)도 그 좁은 칸에 들어가지 못했다.
        */}
        <ProjectionBanner onOpenSettings={onOpenSettings} />
        <div className="flex flex-1 overflow-hidden">
          {/*
            인박스는 **모달이 아니라 자리**다(정본 문서 `docs/desktop-remaining-gaps.html`
            C2). 그래서 화면 맨 아래 오버레이 묶음이 아니라 **이 가로줄의 형제**로 선다 —
            아래 `SearchPalette`·`Directory` 들과 자리가 갈린 것이 이번 작업의 요지다.

            **채널의 왼쪽이다.** 문서가 *"막는 말을 확인하면서 그 스레드를 여는 것이 기본
            동작"* 이라 했으므로 인박스와 스레드가 **동시에** 보여야 하는데, 오른쪽은
            `ThreadPanel` 과 `TerminalPanel` 이 이미 같은 자리를 다투는 곳이다(아래 #141
            주석). 셋째를 그 자리에 넣으면 "동시에 보인다"가 창 폭에 따라 참이 되었다
            거짓이 된다.

            왼쪽에 세우면 **읽는 순서가 일의 순서와 같아진다**: 인박스(나를 막는 것) →
            채널 → 스레드(내가 답하는 곳). 인박스에서 줄을 눌러 열린 스레드는 화면의 반대쪽
            끝에 서므로, 방금 누른 줄이 밀려나지 않는다.

            껍데기의 나머지 결정(Esc·닫기·포커스·좁은 창)은 `Inbox.tsx` 의 주석에 있다.
          */}
          <Inbox open={inboxOpen} onClose={() => setInboxOpen(false)} />
          {/* 멘션 이동(#279)의 배선은 **여기**다. 초판이 이 두 줄을 빼먹어 앱에서 모든
              멘션이 눌러도 아무 일이 없는 버튼이었다 — 단위 테스트는 props 를 손으로
              넘겨 그 사실을 볼 수 없었다. `test/mentionClick.test.tsx` 가 이 화면을
              통째로 띄워 지킨다. */}
          {/*
            **Agents 칸은 본문까지 바꾼다.** 다른 칸(홈·DM)은 사이드바만 갈아 끼우고 본문은
            보던 채널을 그대로 두는데, 이 칸은 다르다: 답하는 물음이 *"지금 우리 팀이 무슨
            일을 하고 있고 무엇을 멈출 수 있나"* 여서 상세와 위험한 동작이 본문 폭을
            필요로 한다(개편 컨셉의 셋째 열, `AgentTower` 주석). 300px 에 접어 넣었던 것이
            사람이 지적한 어긋남이다.

            `ThreadPanel`·`TerminalPanel` 은 **형제로 그대로** 남는다 — 관제탑에서 문을
            열면 그 오른쪽에 서므로, 목록에서 방금 누른 줄이 밀려나지 않는다.
          */}
          {railPanel === 'agents' ? (
            <AgentTower
              onOpenThread={(rootId) => {
                // 칸을 **되돌린 뒤** 연다. 관제탑이 본문을 쥔 채로 스레드를 열면 스레드
                // 패널만 서고 정작 그 대화가 있는 채널은 관제탑에 가린다. 이동은
                // `openMessage` 하나에 맡긴다(채널 전환·스레드 패널·실패 통지가 그 길이다).
                setRailPanel('home');
                void getController().openMessage(rootId);
              }}
            />
          ) : (
            <ChannelPane
              onOpenSearch={handleOpenSearch}
              onOpenDirectory={handleOpenDirectory}
              onOpenSettings={onOpenSettings}
            />
          )}
          {threadRootId && (
            <ThreadPanel onOpenDirectory={handleOpenDirectory} onOpenSettings={onOpenSettings} />
          )}
          {/* #141: 터미널은 스레드 패널과 **같은 자리**를 쓰고 둘이 나란히 열린다.
              채널 레이아웃 안에 심지 않는다 — `#189`(앱 안 터미널 패널이 어디서 도는가)가
              열려 있어서, 지금 심으면 그 결정이 코드로 먼저 굳는다. */}
          {terminalTarget && <TerminalPanel />}
        </div>
      </div>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} initialScope={searchInitialScope} />
      <Sweep open={sweepOpen} onClose={() => setSweepOpen(false)} />
      <Directory open={directoryOpen} onClose={() => { setDirectoryOpen(false); setDirectoryAccountId(null); }} accountId={directoryAccountId} />
      {profileAccountId && (
        <Profile
          accountId={profileAccountId}
          onClose={() => setProfileAccountId(null)}
          onOpenSettings={onOpenSettings}
        />
      )}
      <ChannelDirectory open={channelDirectoryOpen} onClose={() => setChannelDirectoryOpen(false)} />
      {/* `<Inbox>` 가 여기 있었다 — 이 묶음은 **화면을 덮는 것들**이고, 인박스는 이제
          덮지 않는다(위 패널 줄의 주석). 나머지는 그대로 `Overlay` 를 쓴다. */}
      <SavedMessages open={savedOpen} onClose={() => setSavedOpen(false)} />
    </div>
  );
}
