import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { communityLabel, useActiveStore, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { getController } from '../state/controller';
import { Identity, StatusMark } from './Identity';
import { Menu } from './Menu';
import { StatusPicker } from './StatusPicker';
import { isMacOS } from '../lib/platform';
import type { SectionId } from './settings/sections';

/**
 * 레일이 고른 칸. **북마크가 없다** — 북마크는 패널이 아니라 오버레이(`SavedMessages`)를
 * 열고 곧 원래 칸으로 돌아온다. 칸을 만들면 "북마크 패널"이라는 없는 화면을 타입이
 * 약속하게 된다.
 */
export type RailPanel = 'home' | 'dm' | 'agents';

/**
 * 레일 폭. **문서가 62px 로 못 박았고**(「치르는 값 · 가로 62px」) 그 숫자가 손해 계산의
 * 근거이기도 하다 — "본문이 그만큼 좁아진다". Tailwind 의 척도(`w-14` = 56px,
 * `w-16` = 64px)에 62 가 없어 임의값을 쓴다: 문서의 숫자를 화면에서 반올림해 버리면
 * 문서가 계산해 둔 값과 실제 값이 갈린다.
 */
const RAIL_W = 'w-[62px]';

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
  /** 접근성 이름. 글리프는 `aria-hidden` 이라 이름을 여기서 준다. */
  ariaLabel: string;
  glyph: string;
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
 * 글리프는 문서가 그려 둔 것을 따른다 — DM 은 말풍선, 북마크는 책갈피, Inbox 트레이는
 * 홈이 받는다. 문서 스스로 "홈과 에이전트는 아직 자리만 잡은 글리프"라고 적었으므로
 * 여기서도 대체 글리프를 쓴다: 없는 그림을 지어내는 것보다 자리를 비워 두는 편이 낫다.
 */
const RAIL_CELLS: RailCell[] = [
  { panel: 'home', label: 'Home', ariaLabel: 'Home', glyph: '🏠', testId: 'rail-home' },
  { panel: 'dm', label: 'DM', ariaLabel: 'Direct messages', glyph: '💬', testId: 'rail-dm' },
  { panel: 'agents', label: 'Agents', ariaLabel: 'Agents', glyph: '🤖', testId: 'rail-agents' },
  { panel: null, label: 'Saved', ariaLabel: 'Saved messages', glyph: '🔖', testId: 'rail-saved' },
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
  /**
   * 레일이 그려지면 **레일이 창의 좌상단**이 되므로 macOS 신호등이 커뮤니티 마크를 덮는다.
   * `CommunityRail` 이 같은 문제를 이미 세로 여백으로 풀었고(그 파일 주석: 레일은 신호등
   * 3개(78px)보다 좁아 가로 여백으로는 피할 수 없다) 같은 방법을 쓴다.
   *
   * 커뮤니티 레일이 함께 서 있으면 **그쪽이 좌상단**이라 여백은 그쪽 몫이다 — 두 곳이
   * 동시에 비우면 여백이 두 번 든다(`Sidebar` 의 `macTrafficLightRoom` 이 접힘 여부로
   * 같은 판정을 하는 이유와 같다).
   */
  const communityCount = useCommunityRegistry((r) => r.entries.length);
  const macTrafficLightRoom = useMemo(() => isMacOS() && communityCount < 2, [communityCount]);

  /**
   * 홈 칸의 배지 — **나를 막는 것만 센다**(문서: "배지는 나를 막는 것만 센다").
   * 안 읽음까지 세면 배지가 늘 켜져 있어서 아무 말도 하지 않게 된다.
   *
   * 값은 스토어의 `unread`(`InboxEntry[]`, 안 읽은 것만 담긴다)에서 **`mention`·`dm`
   * 만** 센다: 이 앱에서 내 답을 기다린다고 서버가 판정한 것이 그 둘이고, 나머지 사유는
   * "새 대화가 있다"에 가깝다. 사이드바의 채널별 `UnreadBadge` 와 같은 배열을 쓰므로
   * 두 표시가 갈라지지 않는다.
   *
   * **이 배지가 홈 칸에 있는 것이 문서의 요구다** — Inbox 는 홈 패널 맨 위 한 줄로
   * 내려가고 배지만 레일이 대신 받는다. 그래야 어느 칸에 있든 "나를 기다리는 것 2개"가
   * 계속 보인다.
   */
  const blockingCount = useActiveStore(
    (s) => s.unread.filter((e) => !e.readAt && (e.reason === 'mention' || e.reason === 'dm')).length,
  );

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
      aria-label="주 목록"
      className={`relative flex ${RAIL_W} shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-sunken pb-1 ${
        macTrafficLightRoom ? 'pt-8' : 'pt-2'
      }`}
    >
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
              ? `담아 둔 메시지 ${savedCount}개`
              : undefined}
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
              aria-label={me ? `${me.handle} — 내 계정 메뉴` : '내 계정 메뉴'}
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
            { label: '내 프로필', onSelect: () => onOpenSettings('profile') },
            { label: '상태 바꾸기', onSelect: () => setStatusOpen(true) },
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
function RailButton({ cell, active, badge, countInName, onClick }: {
  cell: RailCell;
  active: boolean;
  badge: number;
  /** 배지 없이 이름에만 싣는 수치(북마크 개수). 없으면 이름은 칸 이름 그대로다. */
  countInName?: string;
  onClick: () => void;
}) {
  const name = badge > 0
    ? `${cell.ariaLabel} — 나를 기다리는 것 ${badge}개`
    : countInName ? `${cell.ariaLabel} — ${countInName}` : cell.ariaLabel;
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
        **이 글리프는 타이포 4단이 아니다 — 그림이다.** `aria-hidden` 이고 내용이 이모지라
        여기서 크기가 정하는 것은 글자의 읽힘이 아니라 **아이콘의 지름**이다. 4단으로
        끌어내리면(13px) 아래 11px 라벨과 2px 차이가 되어 아이콘과 글자가 한 덩어리로
        보이고, 레일이 "그림 + 이름" 두 층이라는 사실이 화면에서 사라진다.
        `Identity` 의 아바타 머리글자와 같은 예외이고(그 파일에 근거가 길게 있다),
        `test/typeScale.test.ts` 의 `ALLOWED` 에 줄 단위로 적혀 있다.
      */}
      <span aria-hidden="true" className="text-base leading-none">{cell.glyph}</span>
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
  const connected = useStore(entry.store, (s) => s.connected);
  const label = communityLabel(entry);
  // 이니셜은 **코드 포인트 단위**로 자른다 — `label[0]` 은 이모지를 반쪽만 잘라 깨진 글자를
  // 그린다(`CommunityRail` 이 같은 실수를 이미 고쳤다).
  const initial = Array.from(label)[0]?.toUpperCase() ?? '?';
  return (
    <button
      type="button"
      data-testid="rail-community-mark"
      aria-label={`${label} — ${connected ? '연결됨' : '연결 끊김'}`}
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
