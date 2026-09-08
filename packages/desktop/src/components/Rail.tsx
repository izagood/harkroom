import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { communityLabel, useActiveStore, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { getController } from '../state/controller';
import { blockingUnreadCount } from '../state/unread';
import { Identity, StatusMark } from './Identity';
import { Menu } from './Menu';
import { StatusPicker } from './StatusPicker';
import { TOP_BAR_H } from '../lib/platform';
import { RailIcon, type RailIconName } from './RailIcon';
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
 * 레일 폭.
 *
 * **62px 이었고 72px 로 넓혔다**(실측 2026-09-08, 사용자가 화면에서 지적 — "제일 오른쪽
 * 버튼 선과 딱 붙어 있어서 UI가 부자연스러워"). 문서는 「치르는 값 · 가로 62px」에서 62 를
 * 못 박았지만, 그 숫자를 정할 때 계산에 없던 것이 **macOS 신호등**이다: 신호등 3개는
 * 창 왼쪽에서 78px 을 쓰고(`MAC_TRAFFIC_LIGHT_PL`) 레일은 62px 이라, 맨 오른쪽(최대화)
 * 단추가 레일의 오른쪽 경계선 밖으로 나가려다 선에 닿았다. 스크린샷에서 잰 간격이 3px 이다.
 *
 * 72px 은 두 요구를 함께 만족하는 가장 작은 값이다: 신호등 오른쪽 끝(창 왼쪽에서 58px)과
 * 경계선 사이에 14px 이 남고(#1), 칸(54px) 좌우로 9px 씩 여백이 생긴다(#3 — "양쪽 여백을
 * 조금 주는게 UI 적으로 좋아보여"). 문서가 계산한 손해("본문이 그만큼 좁아진다")는 10px
 * 늘어난다 — 신호등이 선을 밟는 것보다 그쪽이 싸다.
 */
const RAIL_W = 'w-[72px]';

/**
 * 칸이 레일 좌우 경계에서 떨어져 서는 여백(#3). **`items-center` 만으로는 부족하다** —
 * 가운데 맞춤은 남는 자리를 반씩 나눠 주므로 칸이 레일 폭에 꽉 차면(옛 72px 에 54px 칸)
 * 4px 밖에 남지 않고, 그 4px 은 여백으로 정한 값이 아니라 **남은 값**이다. 여백을 여기서
 * 이름으로 정해 두면 칸 폭이나 레일 폭이 바뀔 때 무엇이 지켜져야 하는지가 남는다.
 */
const RAIL_GUTTER = 'px-2';

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
  /** 접근성 이름. 아이콘은 `aria-hidden` 이라 이름을 여기서 준다. */
  ariaLabel: string;
  /** 그림. **이모지가 아니라 선 아이콘 한 벌이다**(`RailIcon.tsx` 에 근거가 있다). */
  icon: RailIconName;
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
 * 홈이 받는다. **이모지가 아니라 선 아이콘이다**(2026-09-08): 문서가 "자리만 잡은
 * 글리프"라고 적어 둔 넷을 한 벌로 다시 그렸고, 그림 자체는 `RailIcon.tsx` 가 진다 —
 * 왜 이모지를 버렸는지(색·크기·플랫폼)가 그 파일에 있다.
 */
const RAIL_CELLS: RailCell[] = [
  { panel: 'home', label: 'Home', ariaLabel: 'Home', icon: 'home', testId: 'rail-home' },
  { panel: 'dm', label: 'DM', ariaLabel: 'Direct messages', icon: 'dm', testId: 'rail-dm' },
  { panel: 'agents', label: 'Agents', ariaLabel: 'Agents', icon: 'agents', testId: 'rail-agents' },
  { panel: null, label: 'Saved', ariaLabel: 'Saved messages', icon: 'saved', testId: 'rail-saved' },
];

/**
 * 칸의 포커스 표시. **`Menu.tsx` 의 `MENU_ITEM_FOCUS` 와 같은 조합이다**(#488 B3) —
 * 그 파일의 주석이 함정을 적어 뒀다: Tailwind v4 에서 `outline-none` 은
 * `--tw-outline-style: none` 을 남기고 `outline-2` 는 굵기만 정하면서 스타일을 그 변수에서
 * 읽으므로, 둘만 쓰면 `focus-visible` 에서도 링이 그려지지 않는다. `outline-solid` 로
 * 변수를 되돌리는 클래스가 있어야 2px 이 실제로 선다.
 *
 * 링은 안쪽에 그린다(`-outline-offset-2`). 레일은 폭 72px 에 칸이 꽉 차서 바깥으로 밀어낸
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
        **면이 `surface-rail` 이다**(#5). 전환기·레일·사이드바가 전부 `surface-sunken` 한
        값이었어서 세 기둥의 경계가 1px 선 하나뿐이었다 — 계단의 근거는 `index.css` 의
        그 토큰 옆에 있다.
      */
      className={`relative flex ${RAIL_W} shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-rail pb-1`}
    >
      {/*
        창 맨 위 한 줄 중 **레일이 지는 몫**(#4: "타이틀바의 색상을 통일해줘").
        브랜드 바(`Sidebar`)와 헤더(`Workspace`)는 이미 `TOP_BAR_H` 로 높이를 맞춰 한 줄처럼
        서 있었지만 레일은 그 줄에 참여하지 않았다 — 레일 쪽은 그냥 레일 색이었고, 그래서
        한 줄이 창을 가로지르는 대신 사이드바에서 시작하는 것처럼 보였다. 세 조각이 같은
        `bg-titlebar` 와 같은 `border-b` 를 쓰면 그 줄이 창 폭 전체에서 하나가 된다.

        **이것이 신호등 자리이기도 하다.** 전에는 레일 전체에 `pt-8` 을 줘서 세로로
        비웠는데(#270), 그 여백은 색이 없어서 신호등이 레일 면 위에 떠 있었다. 띠는 높이가
        36px(`TOP_BAR_H`)이라 신호등(지름 12px, 중심 y≈12px)을 품는다 — 여백을 잃은 것이
        아니라 **띠가 그 일까지 한다**.

        `data-tauri-drag-region` 은 자식이 없는 이 띠 자체가 대상이므로 그대로 창 손잡이가
        된다. macOS 가 아닌 곳에서도 그린다: 이 줄은 신호등을 피하는 여백이 아니라 앱이
        스스로 그리는 타이틀바이고, 다른 두 조각은 이미 모든 플랫폼에서 서 있다.
      */}
      <div
        data-testid="rail-titlebar"
        data-tauri-drag-region
        className={`w-full shrink-0 border-b border-border bg-titlebar ${TOP_BAR_H}`}
      />
      <CommunityMark onClick={onOpenCommunityMark} />
      {/* 네 칸만 스크롤한다 — 위아래 둘은 패널이 무엇을 보여주든 자리가 안 변한다
          (문서: "레일에서 그 둘만 고정이다"). */}
      <div className={`flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-2 ${RAIL_GUTTER}`}>
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

        레일은 72px 이라 메뉴가 그 폭에 갇히면 항목 글자가 잘린다. `left-0` 만 주고 오른쪽은
        놓아 메뉴가 자기 폭(`min-w-32`)으로 레일 밖으로 펼쳐지게 한다.
      */}
      <div className={`relative w-full pb-1 ${RAIL_GUTTER}`}>
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
        {/* 상태 고르기는 메뉴 항목이 **여는 것**이다. 레일 안에 두면 72px 에 눌려 입력칸이
            못 서므로 레일 오른쪽으로 띄운다 — 열려 있는 동안에만 그린다. */}
        {statusOpen && (
          <div className="absolute bottom-full left-full z-20 mb-1 w-64 rounded border border-border bg-surface-raised p-2 shadow-lg">
            <StatusPicker onDone={() => setStatusOpen(false)} />
          </div>
        )}
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
        **그림이 글자가 아니게 됐다.** 여기 `text-base` 로 크기를 정하는 이모지 `<span>` 이
        있었고, 그 줄은 "타이포 4단이 아니라 아이콘의 지름"이라는 근거와 함께
        `test/typeScale.test.ts` 의 `ALLOWED` 에 등록돼 있었다. 선 아이콘은 `viewBox` 가
        크기를 정하므로 그 예외가 필요 없다 — 등록도 함께 지웠다.

        20px(`h-5 w-5`)이다: 아래 라벨이 11px 이라 그림이 그보다 확실히 커야 레일이
        "그림 + 이름" 두 층으로 읽힌다. 색은 주지 않는다 — `currentColor` 로 그려서
        고른 칸(`text-fg`)과 안 고른 칸(`text-fg-muted`)의 구분을 그림도 함께 받는다.
        이모지는 자기 색을 들고 와서 그 절반을 못 받았다.
      */}
      <RailIcon name={cell.icon} />
      {/*
        라벨은 타이포 4단의 맨 아랫단(11px)이다. 9px 이었고, 72px 레일에서 잘릴까가
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
