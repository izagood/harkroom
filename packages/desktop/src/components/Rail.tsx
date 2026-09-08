import { useEffect, useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { communityLabel, useActiveStore, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { getController } from '../state/controller';
import { blockingUnreadCount } from '../state/unread';
import { Identity, StatusMark } from './Identity';
import { Menu } from './Menu';
import { StatusPicker } from './StatusPicker';
import { TOP_BAR_BG, TOP_BAR_H } from '../lib/platform';
import { AgentsIcon, DmIcon, HomeIcon, SavedIcon } from './RailIcons';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';
import type { Translate } from '../i18n';

/**
 * 레일이 고른 칸. **북마크가 없다** — 북마크는 패널이 아니라 오버레이(`SavedMessages`)를
 * 열고 곧 원래 칸으로 돌아온다. 칸을 만들면 "북마크 패널"이라는 없는 화면을 타입이
 * 약속하게 된다.
 */
export type RailPanel = 'home' | 'dm' | 'agents';

/**
 * 레일 폭. **62px 에서 70px 로 넓혔다**(사용자 요청 1·3, 2026-09-08 — "제일 오른쪽 버튼이
 * 선과 딱 붙어 있다", "제일 왼쪽 레일에 양쪽 여백을 조금 주는 게 UI 적으로 좋아 보여").
 *
 * 실측(이 판 직전): 칸은 54px 이고 레일이 62px 이라 좌우 여백이 **4px** 이었다. 고른 칸의
 * 면이 레일을 거의 꽉 채워서, 기둥이 아니라 기둥에 붙은 띠처럼 보였다. 70 − 54 = 16 이라
 * 좌우가 **8px** 씩 된다.
 *
 * **여백을 칸에서 짜내지 않고 레일을 넓혔다.** 칸 폭 54px 은 라벨을 재어 고른 값이고
 * (`RailButton` 주석: 가장 긴 `Agents` 가 11px 에서 32.89px), 여백을 그 안에서 빼면 라벨이
 * 다시 위험해진다. 레일을 8px 내주는 쪽은 본문이 8px 좁아지는 것으로 끝난다.
 *
 * Tailwind 척도(`w-16`=64px, `w-20`=80px)에 70 이 없어 임의값을 쓴다 — 문서의 숫자를 척도로
 * 반올림해 버리면 문서가 계산해 둔 값과 화면의 값이 갈린다.
 *
 * 문서(`docs/desktop-rail.html`)는 62px 을 「치르는 값」으로 못박아 두었다. 그 숫자의 근거는
 * "본문이 그만큼 좁아진다"는 손해 계산이었고, 8px 을 더 내주는 판단은 화면을 보고 고르는
 * 것이라 사람의 몫이다 — 이 판이 그 요청을 받았다. 문서의 숫자를 함께 고치는 것은 이
 * 변경의 범위가 아니라 남긴다.
 */
const RAIL_W = 'w-[70px]';

/**
 * 칸 하나의 정의. 배열 하나로 두는 이유는 **숫자 단축키가 레일 순서를 그대로 따라야**
 * 하기 때문이다(문서: "숫자 단축키가 순서를 그대로 따른다"). 순서를 두 곳(그리는 곳·
 * 단축키 매는 곳)에 적으면 한쪽만 고쳐 `⌘3` 이 두 번째 칸을 여는 날이 온다.
 */
interface RailCell {
  /** `panel` 이 없는 칸은 오버레이를 여는 칸이다(북마크). */
  panel: RailPanel | null;
  /** 화면에 서는 이름. 9px 한 줄 — 문서: "아이콘에 글자를 붙인다". */
  label: string;
  /** 접근성 이름. 그림은 `aria-hidden` 이라 이름을 여기서 준다. */
  ariaLabel: string;
  /** 칸의 그림. 선 아이콘이고 색은 칸에서 물려받는다(`RailIcons.tsx`). */
  Icon: () => ReactElement;
  testId: string;
}

/**
 * 네 칸(문서 「레일 네 칸」).
 *
 * **첫 칸이 `채널` 이 아니라 `홈` 이다** — 문서가 그 이유를 길게 적었다: 그 자리에는
 * 채널이 아닌 것도 들어간다(Inbox·디렉터리, 앞으로 생길 것들). `채널` 로 못 박으면
 * 새로 생기는 것마다 갈 곳이 없어 "다시 아래로 매다는 짓"을 반복하게 되고, 지금
 * 사이드바가 정확히 그렇게 된 것이다.
 *
 * 그림은 문서가 그려 둔 것을 따른다 — DM 은 말풍선, 북마크는 책갈피, Inbox 트레이는
 * 홈이 받는다. 문서가 "홈과 에이전트는 아직 자리만 잡은 글리프"라고 적어 이모지를 대신
 * 세워 두었던 자리를, 이제 **선 아이콘**이 받는다(사용자 요청 2 · `RailIcons.tsx` 에
 * 이모지를 버린 이유가 있다).
 */
const RAIL_CELLS: RailCell[] = [
  { panel: 'home', label: 'Home', ariaLabel: 'Home', Icon: HomeIcon, testId: 'rail-home' },
  { panel: 'dm', label: 'DM', ariaLabel: 'Direct messages', Icon: DmIcon, testId: 'rail-dm' },
  { panel: 'agents', label: 'Agents', ariaLabel: 'Agents', Icon: AgentsIcon, testId: 'rail-agents' },
  { panel: null, label: 'Saved', ariaLabel: 'Saved messages', Icon: SavedIcon, testId: 'rail-saved' },
];

/**
 * 칸의 포커스 표시. **`Menu.tsx` 의 `MENU_ITEM_FOCUS` 와 같은 조합이다**(#488 B3) —
 * 그 파일의 주석이 함정을 적어 뒀다: Tailwind v4 에서 `outline-none` 은
 * `--tw-outline-style: none` 을 남기고 `outline-2` 는 굵기만 정하면서 스타일을 그 변수에서
 * 읽으므로, 둘만 쓰면 `focus-visible` 에서도 링이 그려지지 않는다. `outline-solid` 로
 * 변수를 되돌리는 클래스가 있어야 2px 이 실제로 선다.
 *
 * 링은 안쪽에 그린다(`-outline-offset-2`). 레일은 폭 62px 에 칸이 꽉 차서 바깥으로 밀어낸
 * 링은 레일 경계에서 잘리고 위아래 칸끼리 겹친다.
 */
const RAIL_FOCUS = 'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2';

/**
 * 사이드바 **왼쪽**의 레일(정본 문서 `docs/desktop-rail.html` 1단계).
 *
 * ## 왜 있는가
 *
 * 문서의 진단을 코드로 확인했다(2026-09-07, `Sidebar.tsx`): `nav` 하나가
 * `overflow-y-auto` 이고 그 안에 묶음이 **세로로만** 쌓인다 — 채널 · 보관 · 숨김 · 이동
 * (Inbox·Saved·Directory) · DM · 에이전트 · `LeasePanel`. 채널이 서른이면 그 아래 있는
 * 것은 전부 스크롤 밖으로 나가고, **밀려나는 쪽이 하필 DM 과 에이전트**다. 접기·정렬·
 * 즐겨찾기는 사람에게 관리를 시키는 회피책이고 한 열이라는 제약은 그대로여서, 축을
 * 하나 더 만든다.
 *
 * ## 이 레일이 하지 않는 것
 *
 * **커뮤니티 전환 목록을 만들지 않는다**(문서의 4단계). 커뮤니티가 하나뿐인 오늘은
 * 마크만 있으면 되고, 문서도 "하나뿐이면 마크만 두고 목록은 나중"이라고 적었다.
 * 여럿일 때의 전환은 이미 `CommunityRail`(#165)이 하고 있어 그것을 그대로 세운다 —
 * 같은 일을 하는 두 번째 표면을 만들면 어느 쪽이 정본인지 알 수 없게 된다.
 *
 * ## 세로를 쓰는 것은 네 칸뿐이다
 *
 * 문서: "레일에서 세로를 쓰는 것은 네 칸뿐이어야 한다." 그래서 커뮤니티 마크와 내 얼굴은
 * 스크롤에 들어가지 않고 위아래에 **고정**이고, 가운데 네 칸만 필요하면 스크롤한다.
 */
export function Rail({ panel, onPanelChange, onOpenSaved, onOpenSettings, onOpenCommunityMark, onLogout }: {
  panel: RailPanel;
  onPanelChange: (panel: RailPanel) => void;
  /** 북마크 칸이 여는 오버레이. **옵셔널이 아니다** — 기본값을 여기서 공급하면 배선을
   *  잊은 화면에서도 칸이 그려지고 눌러도 아무 일이 없다(design.md §4). */
  onOpenSaved: () => void;
  onOpenSettings: (section?: SectionId) => void;
  /** 커뮤니티 마크를 눌렀을 때. 전환 목록은 4단계이므로 지금은 설정 › 커뮤니티로 보낸다. */
  onOpenCommunityMark: () => void;
  onLogout: () => void;
}) {
  const t = useT();

  /**
   * 홈 칸의 배지 — **나를 막는 것만 센다**(문서: "배지는 나를 막는 것만 센다").
   * 안 읽음까지 세면 배지가 늘 켜져 있어서 아무 말도 하지 않게 된다.
   *
   * 값은 스토어의 `unread`(`InboxEntry[]`, 안 읽은 것만 담긴다)에서 **`mention`·`dm`
   * 만** 센다: 이 앱에서 내 답을 기다린다고 서버가 판정한 것이 그 둘이고, 나머지 사유는
   * "새 대화가 있다"에 가깝다. 사이드바의 채널별 `UnreadBadge` 와 같은 배열을 쓰므로
   * 두 표시가 갈라지지 않는다.
   *
   * 세는 규칙 자체는 `state/unread.ts` 에 있다 — 독(Dock) 배지가 같은 것을 세야 해서
   * 꺼냈다(`lib/useDockBadge.ts`). 여기서 다시 적으면 화면의 숫자와 독의 숫자가 갈라진다.
   *
   * **이 배지가 홈 칸에 있는 것이 문서의 요구다** — Inbox 는 홈 패널 맨 위 한 줄로
   * 내려가고 배지만 레일이 대신 받는다. 그래야 어느 칸에 있든 "나를 기다리는 것 2개"가
   * 계속 보인다.
   */
  const blockingCount = useActiveStore((s) => blockingUnreadCount(s.unread));

  /**
   * 담아 둔 메시지 수(#219). **배지로 그리지 않는다** — 문서: *"배지는 나를 막는 것만
   * 센다."* 담아 둔 것은 내가 스스로 미뤄 둔 것이고 나를 막지 않는다. 예전 사이드바에는
   * 이 자리에 강조색 배지가 있었는데, 그것이 문서가 지적한 "배지가 늘 켜져 있어서 아무 말도
   * 하지 않게 된다"의 실례다(#488 B2 의 강조색 회수와 같은 진단).
   *
   * **수치를 버리지도 않는다.** 칸의 접근 가능한 이름과 `title` 로 옮긴다 — 알고 싶은
   * 사람은 알 수 있고, 화면은 조용하다.
   */
  const savedCount = useActiveStore((s) => s.savedCount);

  const me = useActiveStore((s) => s.me);
  /**
   * 상태 고르기 패널이 열려 있는가. `Sidebar` 가 쓰던 것과 같은 규약이다 — **여는 쪽이
   * 닫는 쪽**이라야 메뉴 항목의 이름과 패널의 존재가 갈리지 않는다(`StatusPicker` 주석).
   */
  const [statusOpen, setStatusOpen] = useState(false);

  /**
   * 숫자 단축키(문서: "숫자 단축키가 레일 순서를 그대로 따른다"). `⌘1`~`⌘4` 다 —
   * `⌘1` 은 문서가 커뮤니티 스위처 그림에서 이미 쓴 표기이고, 이 앱의 다른 전역
   * 단축키(`⌘K`·`⌘[`·`⌘]`·`⌘\`·`⌘,`)와 같은 modifier 를 쓴다.
   *
   * `Workspace`·`Sidebar` 의 전역 핸들러와 같은 규칙을 따른다: 입력 요소에 포커스가
   * 있으면 가로채지 않는다. 숫자는 사람이 실제로 타이핑하는 글자다.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const index = Number(e.key) - 1;
      const cell = RAIL_CELLS[index];
      if (!Number.isInteger(index) || !cell) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      if (cell.panel) onPanelChange(cell.panel);
      else onOpenSaved();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onPanelChange, onOpenSaved]);

  /**
   * `⌘,` 로 설정을 연다(#488 A1). **`Sidebar` 에서 그대로 옮겨 왔다** — 메뉴에 `⌘,` 를
   * 적기로 한 이상 그 글자가 참이어야 하고(가르치는 정보가 거짓이면 장식보다 나쁘다),
   * 그래서 배선은 그것을 여는 자리와 **같은 컴포넌트**에 있어야 한다. 계정 메뉴가 레일로
   * 왔으니 이 효과도 함께 온다.
   *
   * 위 숫자 단축키와 한 효과로 합치지 않는다: 두 단축키가 사는 이유가 다르고(하나는
   * 메뉴가 가르치는 약속, 하나는 레일 순서), 합치면 한쪽을 고칠 때 다른 쪽 조건을 읽어야
   * 한다. 입력 요소 예외는 쉼표에서 특히 중요하다 — 사람이 실제로 타이핑하는 글자다.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ',') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      onOpenSettings();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onOpenSettings]);

  return (
    <nav
      data-testid="rail"
      aria-label={t('rail.nav.label')}
      /*
        **레일의 면은 사이드바와 다른 색이다**(사용자 요청 5, 2026-09-08 — "레일별로 색상을
        약간 다르게 해서 UI 적으로 구분되는 느낌을 줘"). 세 기둥이 `rail < sunken < surface`
        순으로 밝아지므로(`index.css`), 왼쪽으로 갈수록 한 단 가라앉는다 — 경계를 테두리
        하나에만 맡기지 않고 면 차이가 먼저 말한다.
      */
      className={`flex ${RAIL_W} shrink-0 flex-col bg-surface-rail`}
    >
      {/*
        창 최상단 띠의 레일 구간(사용자 요청 1·4).

        **테두리가 신호등을 지나가지 않게 하는 것이 이 조각의 일이다.** 앞 판은 레일 전체에
        `border-r` 이 걸려 있어 그 세로선이 창 맨 위까지 올라왔고, macOS 신호등은 78px 을
        쓰는데 레일은 62px 이라 **초록 버튼이 그 선 위에 걸쳐** 있었다 — 사용자가 첨부
        스크린샷에서 지적한 것이 그것이다. 레일을 신호등만큼 넓히는 것(86px+)은 본문을 그만큼
        먹으므로, 대신 **선을 띠 아래에서 시작**한다: `border-r` 이 이 띠에는 없고 아래 몸통에
        붙는다. 그러면 창 위 36px 은 세로선이 없는 한 줄이 되고, 신호등은 어느 선에도 닿지
        않는다.

        색도 여기서 통일된다(요청 4) — 이 띠 · 사이드바 브랜드 바 · `Workspace` 헤더 셋이
        같은 `TOP_BAR_BG` 를 쓰므로, 가로로 이어 붙은 한 줄이 한 색이다.

        `data-tauri-drag-region` 을 주는 이유: 창 좌상단은 원래 OS 타이틀바가 끌리던 자리다.
        신호등 옆 빈 자리를 끌 수 없으면 사람은 창을 옮길 자리를 잃는다(브랜드 바가 같은
        이유로 손잡이다). 안이 비어 있어 글자가 선택될 걱정은 없다.
      */}
      <div
        data-testid="rail-titlebar"
        data-tauri-drag-region
        aria-hidden="true"
        className={`shrink-0 ${TOP_BAR_H} border-b border-border ${TOP_BAR_BG}`}
      />
      {/*
        몸통. 오른쪽 테두리가 **여기**에 붙는다(위 띠 주석). `min-h-0` 은 아래 네 칸의
        `overflow-y-auto` 가 실제로 스크롤하게 하는 조건이다 — flex 자식의 기본
        `min-height: auto` 는 내용만큼 늘어나 스크롤이 창 밖으로 밀린다.
      */}
      <div className="relative flex min-h-0 flex-1 flex-col items-center gap-1 border-r border-border pb-1 pt-2">
        <CommunityMark onClick={onOpenCommunityMark} />
        {/* 네 칸만 스크롤한다 — 위아래 둘은 패널이 무엇을 보여주든 자리가 안 변한다
            (문서: "레일에서 그 둘만 고정이다"). */}
        <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
          {RAIL_CELLS.map((cell) => (
            <RailButton
              key={cell.testId}
              cell={cell}
              active={cell.panel !== null && cell.panel === panel}
              badge={cell.panel === 'home' ? blockingCount : 0}
              /* 북마크 수는 배지가 아니라 이름으로만 간다(위 `savedCount` 주석). */
              countInName={cell.testId === 'rail-saved' && savedCount > 0
                ? t('rail.cell.saved', { count: savedCount })
                : undefined}
              t={t}
              onClick={() => { if (cell.panel) onPanelChange(cell.panel); else onOpenSaved(); }}
            />
          ))}
        </div>
        {/*
          내 얼굴이 레일 맨 아래다(문서 「레일 맨 아래 · 나」). **메뉴 자체는 그대로다** —
          문서: "여기서 달라지는 것은 자리뿐이다 — 사이드바 맨 아래에서 레일 맨 아래로."
          그래서 항목도 `Sidebar` 의 계정 메뉴와 같은 넷(내 프로필 · 상태 바꾸기 · Settings
          `⌘,` · Sign out)을 그대로 옮겼고, 화살표도 톱니도 두지 않는다.

          레일은 62px 이라 메뉴가 그 폭에 갇히면 항목 글자가 잘린다. `left-0` 만 주고 오른쪽은
          놓아 메뉴가 자기 폭(`min-w-32`)으로 레일 밖으로 펼쳐지게 한다.
        */}
        <div className="relative w-full px-1 pb-1">
          <Menu
            className="left-0"
            header={<MeMenuHeader />}
            renderTrigger={(props) => (
              <button
                {...props}
                /* testid 를 `me-row` 로 **그대로 둔다** — 이 자리의 계약(#488 A1: 행 전체가
                   트리거 · 톱니 없음 · 상태를 메뉴에서 고른다)이 한 글자도 바뀌지 않았고
                   자리만 옮겼다. 이름을 바꾸면 그 계약을 재는 테스트가 통째로 끊겨,
                   옮긴 것과 잃은 것을 구별할 수 없게 된다. */
                data-testid="me-row"
                aria-label={me
                  ? t('rail.me.menuFor', { handle: me.handle })
                  : t('rail.me.menu')}
                className={`flex h-11 w-full items-center justify-center rounded hover:bg-surface-raised ${RAIL_FOCUS}`}
              >
                <span className="relative">
                  <Identity account={me ?? undefined} variant="avatar" className="h-7 w-7 shrink-0" />
                  {/* 자리를 비웠을 때만 표식이 선다 — `StatusMark` 가 `available` 에 `null` 을
                      주므로 판정을 여기서 복제하지 않는다(`Sidebar` 의 계정 행과 같은 규칙). */}
                  <StatusMark account={me ?? undefined} className="absolute -bottom-1 -right-1" />
                </span>
              </button>
            )}
            items={[
              { label: t('rail.me.profile'), onSelect: () => onOpenSettings('profile') },
              { label: t('rail.me.status'), onSelect: () => setStatusOpen(true) },
              { label: 'Settings', shortcut: '⌘,', onSelect: () => onOpenSettings() },
              { label: 'Sign out', onSelect: () => { getController().logout(); onLogout(); } },
            ]}
          />
          {/* 상태 고르기는 메뉴 항목이 **여는 것**이다. 레일 안에 두면 62px 에 눌려 입력칸이
              못 서므로 레일 오른쪽으로 띄운다 — 열려 있는 동안에만 그린다. */}
          {statusOpen && (
            <div className="absolute bottom-full left-full z-20 mb-1 w-64 rounded border border-border bg-surface-raised p-2 shadow-lg">
              <StatusPicker onDone={() => setStatusOpen(false)} />
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

/** 메뉴 머리 — 얼굴 · 이름 · `@handle` · 어느 커뮤니티인지. `Sidebar` 의 그것을 그대로 옮겼다. */
function MeMenuHeader() {
  const me = useActiveStore((s) => s.me);
  const workspaceLabel = useCommunityRegistry((r) => {
    const entry = r.entries.find((e) => e.id === r.activeId);
    return entry ? communityLabel(entry) : '';
  });
  return (
    <div className="flex items-center gap-2">
      <Identity account={me ?? undefined} variant="avatar" className="h-8 w-8 shrink-0" />
      <div className="min-w-0">
        {/*
          **굵은 줄은 `displayName` 이다**(실측 2026-09-07, 사용자가 화면에서 발견).
          두 줄이 **똑같이 `handle` 을 쓰고 있어** `jaebin / @jaebin` 처럼 같은 값이 두 번
          섰다. 필드는 이미 있었고(`AccountView.displayName`) 화면이 안 쓴 것이다 —
          이름을 `재빈` 으로 바꿔 두면 `재빈 / @jaebin` 으로 갈린다.

          `displayName` 이 비어 있으면 `handle` 로 떨어진다: 서버가 기본값으로 `handle` 을
          넣지만(빈 문자열이 오는 경로가 있다) 그때 굵은 줄이 사라지면 메뉴 머리가
          "누구의 것인지" 말하지 못한다.
        */}
        {/* **이름줄단 15px** — 이 메뉴 머리가 답하는 것이 "누구의 것인가" 하나이고, 아래
            `@handle · 워크스페이스` 는 이미 아랫단 11px 이다. 4단에서 둘째 단의 이름이
            그대로 이름줄이고(`MessageItem` 의 작성자 이름이 같은 단), 여기를 본문단으로
            두면 두 줄이 4px 차이로 붙어 어느 쪽이 이름인지 눈이 못 가른다. */}
        <div className="truncate text-name font-medium text-fg">{me?.displayName || me?.handle}</div>
        <div className="truncate text-meta text-fg-subtle">@{me?.handle} · {workspaceLabel}</div>
      </div>
    </div>
  );
}

/**
 * 칸 하나.
 *
 * **`aria-current` 로 지금 어느 칸인지 말한다.** 색과 굵기만으로 표시하면 그 구분이
 * 스크린리더에는 없는 것과 같다 — `CommunityRail` 의 타일이 이미 같은 규칙을 쓴다.
 * 배지도 같은 이유로 접근 가능한 이름에 수치를 싣는다: 주황 원 하나는 읽히지 않는다.
 *
 * 글자를 붙이는 것이 문서의 요구다 — "Slack 도 아이콘만 두지 않는다. 하물며 `에이전트` 는
 * 이 앱이 처음 쓰는 말이라 그림만으로는 배울 수 없다." 그 대신 레일에는 그 밖에 아무것도
 * 두지 않는다.
 */
function RailButton({ cell, active, badge, countInName, onClick, t }: {
  cell: RailCell;
  active: boolean;
  badge: number;
  /** 배지 없이 이름에만 싣는 수치(북마크 개수). 없으면 이름은 칸 이름 그대로다. */
  countInName?: string;
  onClick: () => void;
  t: Translate;
}) {
  /* 칸 이름과 수치를 잇는 방식이 언어의 것이라 **사전이 그 문장을 진다** — 코드가
     ` — ` 를 붙이면 그 자리가 한 언어의 어순으로 굳는다. `cell.ariaLabel` 자체는
     안 옮긴다: 그 넷은 이미 영어이고 폭을 재어 고른 값이다(`RAIL_CELLS` 주석). */
  const name = badge > 0
    ? t('rail.cell.withCount', {
      name: cell.ariaLabel,
      count: t('rail.cell.blocking', { count: badge }),
    })
    : countInName
      ? t('rail.cell.withCount', { name: cell.ariaLabel, count: countInName })
      : cell.ariaLabel;
  return (
    <button
      type="button"
      data-testid={cell.testId}
      aria-current={active ? 'page' : undefined}
      aria-label={name}
      title={name}
      onClick={onClick}
      className={`relative flex w-[54px] flex-col items-center gap-0.5 rounded-lg py-1.5 ${RAIL_FOCUS} ${
        active ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:bg-surface-hover'
      }`}
    >
      {/*
        **그림은 이제 이모지가 아니라 선 아이콘이다**(사용자 요청 2 — 참고 화면을 첨부했다).
        `RailIcons.tsx` 에 이모지를 버린 이유가 길게 있다: 폰트가 정하는 그림이라 OS 마다
        다른 집이 뜨고, 자기 색을 들고 오므로 고른 칸(`text-fg`)과 안 고른 칸(`text-fg-muted`)
        에서 **글자만 밝아지고 그림은 그대로**였다.

        크기가 `width`/`height` 속성으로 정해지므로 타이포 4단의 예외가 더 필요하지 않다 —
        `test/typeScale.test.ts` 의 `ALLOWED` 에서 이 줄 항목을 이 판에서 지웠다.
      */}
      <cell.Icon />
      {/*
        라벨은 타이포 4단의 맨 아랫단(11px)이다. 9px 이었고, 62px 레일에서 잘릴까가
        이 자리의 유일한 걱정이었다 — **재고 올렸다.** 버튼 내부 폭은 54px 이고 좌우
        패딩이 없다. SF(시스템 폰트)의 실제 전진폭으로 가장 긴 라벨 `Agents` 가 11px 에서
        32.89px 이라 21px 이 남는다(`Home` 28.00 · `Saved` 29.08 · `DM` 16.61).
        라벨은 이 배열이 정하는 닫힌 집합이라, 여기에 긴 이름을 새로 더할 때만 다시 재면
        된다. `truncate` 를 달지 않는 이유도 그것이다 — 잘릴 수 없는 폭이면 말줄임은
        일어나지 않을 코드이고, 있으면 "잘려도 된다"로 읽힌다.
      */}
      <span aria-hidden="true" className="text-meta leading-none">{cell.label}</span>
      {badge > 0 && (
        /*
          배지도 11px 로 올린다. 이것이 커지면 글리프를 덮을까가 걱정이지만 — `right-1` 로
          오른쪽이 고정이고 왼쪽으로 자라므로 레일 밖으로는 나가지 않는다. 실측으로 세 자리
          (`128`)에서도 오른쪽 끝에서 27px 이라 버튼 54px 의 절반이고, 두 자리(`99`)는 23px 이다.
          9px 대비 늘어난 폭은 두 자리에서 2.7px 뿐이다.
        */
        <span
          aria-hidden="true"
          data-testid={`${cell.testId}-badge`}
          className="absolute right-1 top-0.5 rounded-full bg-accent px-1 text-meta font-bold text-fg-on-strong"
        >
          {badge}
        </span>
      )}
    </button>
  );
}

/**
 * 레일 맨 위 커뮤니티 마크(문서 「레일 맨 위 · 커뮤니티」).
 *
 * 문서의 진단을 확인했다: **앱 화면 어디에도 지금 어느 커뮤니티에 있는지 나오지 않는다.**
 * 실측으로는 한 곳 있었다 — 계정 메뉴의 머리(#488 A1)가 `@handle · 워크스페이스` 를 적는다.
 * 다만 그것은 **메뉴를 열어야 보이는** 것이라 "화면에 늘 있는가"라는 문서의 물음에는
 * 여전히 아니다. 타이틀바의 `murmur` 가 앱 이름이라는 지적도 코드와 맞았다(`Sidebar` 의
 * 브랜드 바는 상수 문자열 `murmur` 다).
 *
 * **커뮤니티가 여럿이면 그리지 않는다.** 그때는 `CommunityRail`(#165)이 이 레일 왼쪽에
 * 서서 같은 일을 하고, 마크를 두 개 세우면 지금 있는 곳이 두 곳에 표시된다. 전환 목록은
 * 문서의 4단계다.
 *
 * 누르면 설정 › 커뮤니티로 간다 — 문서는 "커뮤니티를 옮겨 다니는 일은 설정에 들어가서 할
 * 일이 아니다"라고 적었지만 그것은 목록을 만드는 4단계의 이야기고, 지금 없는 목록을
 * 대신해 눌러도 아무 일이 없는 마크를 두는 것이 더 나쁘다(design.md §4).
 */
function CommunityMark({ onClick }: { onClick: () => void }) {
  const entries = useCommunityRegistry((r) => r.entries);
  const activeId = useCommunityRegistry((r) => r.activeId);
  const entry = entries.find((e) => e.id === activeId);
  if (!entry || entries.length > 1) return null;
  return <CommunityMarkTile entry={entry} onClick={onClick} />;
}

/**
 * 마크 타일. 연결 상태를 **자기 커뮤니티의 스토어에서 직접 읽는다** — `CommunityRail` 의
 * 타일과 같은 이유다(전역 플래그 하나로 합치면 "셋 중 하나가 끊겼다"가 "끊겼다"로 뭉친다).
 * 훅이 조건 뒤에 오지 않게 타일을 따로 뽑았다.
 */
function CommunityMarkTile({ entry, onClick }: { entry: CommunityEntry; onClick: () => void }) {
  const t = useT();
  const connected = useStore(entry.store, (s) => s.connected);
  const label = communityLabel(entry);
  // 이니셜은 **코드 포인트 단위**로 자른다 — `label[0]` 은 이모지를 반쪽만 잘라 깨진 글자를
  // 그린다(`CommunityRail` 이 같은 실수를 이미 고쳤다).
  const initial = Array.from(label)[0]?.toUpperCase() ?? '?';
  return (
    <button
      type="button"
      data-testid="rail-community-mark"
      /* `CommunityRail` 의 타일과 **같은 키를 본다** — 두 파일이 같은 문장을 따로
         적으면 한쪽만 고쳐진다(두 파일 주석이 이미 그 중복을 위험으로 적었다). */
      aria-label={t('rail.community.tile', {
        name: label,
        state: t(connected ? 'rail.community.connected' : 'rail.community.disconnected'),
      })}
      title={label}
      onClick={onClick}
      // `text-sm` 은 4단이 아니라 **h-9 원에 묶인 머리글자**다 — 위 `initial` 하나가 이
      // 버튼의 내용 전부이고, 크기가 원의 지름에서 따라 나온다(`Identity.tsx` 의 근거와
      // 같은 자리). 4단으로 올리면 원은 그대로인데 글자만 커져 가장자리에 붙는다.
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-sm font-bold text-fg-muted hover:bg-surface-hover ${RAIL_FOCUS} ${
        connected ? '' : 'border-2 border-danger'
      }`}
    >
      {initial}
    </button>
  );
}
