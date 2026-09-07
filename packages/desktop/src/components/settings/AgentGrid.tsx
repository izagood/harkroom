import { useMemo, useState } from 'react';
import type { AccountView } from '@murmur/shared';
import { Identity } from '../Identity';
import type { RunnerState } from '../../lib/runnerLauncher';
// B1 의 세 얼굴 규칙은 `lib/faceState.ts` 하나가 낸다 — DM 목록도 같은 판정을 쓴다
// (`docs/desktop-rail.html` 2단계). 여기 사본을 두면 두 화면이 같은 러너를 다르게 그린다.
import { faceState } from '../../lib/faceState';

/**
 * 이 격자가 카드 하나를 그리는 데 **실제로 필요한 것**. `AgentView` 를 요구하지 않는 이유가
 * `docs/desktop-rail.html` 3단계에 있다 — 사이드바의 에이전트 칸이 같은 카드를 쓰는데, 그
 * 칸이 손에 든 것은 스토어의 `accounts`(`AccountView`)뿐이다. `AgentView` 를 요구하면
 * 사이드바가 그 칸을 그리려고 `listAgents()` 를 한 번 더 왕복해야 하고, 그때부터 같은
 * 에이전트 목록이 **두 곳에 유지된다** — 이 저장소가 반복 결함으로 지목한 그 모양이다.
 *
 * `instructions` 만 옵셔널이다: 검색이 역할 설명까지 훑는 것은 설정 화면의 값이고
 * (*"배포 담당이 누구였더라"*), 스토어의 계정 목록에는 그 필드가 없다. 없으면 이름만
 * 훑는다 — **기능이 조용히 줄어드는 것을 타입이 드러낸다**는 것이 옵셔널로 두는 이유다.
 * `AgentView` 는 `AccountView` 를 확장하고 `instructions` 를 필수로 가지므로 설정 화면의
 * 호출은 한 글자도 안 바뀐다.
 */
export type AgentCardSubject = AccountView & { instructions?: string };

/**
 * 이 격자가 서는 **자리**(`docs/desktop-rail.html` 3단계). 값이 둘인 것은 호출자가 둘이기
 * 때문이고, 그 이상으로 늘릴 축이 아니다 — 늘어나기 시작하면 카드가 다시 두 벌이 된다.
 *
 * **기본값이 `settings` 인 것이 계약이다** — 설정 › 에이전트는 이 prop 을 넘기지 않고,
 * 그래서 그 화면의 모양은 이 축이 생기기 전과 한 픽셀도 다르지 않다(회귀선:
 * `agentsPanelGrid.test.tsx` 의 *"자리를 안 주면 설정의 그 격자다"*).
 *
 * ## 자리마다 갈리는 것은 둘 — 크기와 **바닥색**
 *
 * ### 크기 (실측 2026-09-07)
 *
 * 사이드바 패널의 폭은 `MIN_SIDEBAR_WIDTH`(180) ~ 기본 240px(`DEFAULT_PREFS.sidebarWidth`)
 * 이고 `nav` 의 `p-2` 가 좌우 8px 씩 먹으므로 **내용 폭은 164 ~ 224px** 이다.
 * `auto-fill` 이 채우는 열 수는 `트랙 × n + 간격 × (n-1) ≤ 내용 폭` 을 만족하는 최대 n 이다:
 *
 * | 내용 폭 | `settings`(86px 트랙 · 24px 간격) | `sidebar`(64px 트랙 · 12px 간격) |
 * |---|---|---|
 * | 164px (최소) | **1열** — 78px 이 남는다 | 2열 |
 * | 224px (기본) | 2열 | 3열 |
 * | 464px (최대 480 − 16) | 4열 | 6열 |
 *
 * 넘쳐서 깨지지는 않는다 — 카드가 고정 폭이고 이름은 `truncate` 다. 문제는 다른 것이다:
 * **최소 폭에서 한 열이면 그것은 그리드가 아니라 목록**이고, 문서가 목록을 그리드로 바꾸라고
 * 한 자리에서 목록이 되돌아온다.
 *
 * 트랙과 아바타를 **함께** 줄인다. 트랙만 줄이면 56px 아바타가 64px 칸에 갇혀 좌우 4px
 * 밖에 안 남고, 그 폭에서는 `ring-2` 선택 테가 옆 카드에 닿는다. 40px 아바타 + 64px
 * 트랙이면 좌우 12px 이 남는다.
 *
 * ### 바닥색
 *
 * 검색줄은 `sticky` 라 **자기 바닥을 직접 칠해야** 스크롤한 카드가 그 뒤로 지나간다.
 * 그런데 두 자리의 바닥이 다르다 — 설정 화면은 `surface-raised`(카드 면)이고 사이드바는
 * `surface-sunken`(`Sidebar` 의 `aside`)이다. 한쪽 값을 박아 두면 다른 쪽에서 **검색줄만
 * 다른 색인 띠**가 되고, 그것은 하드코딩 색과 같은 종류의 결함이다: 토큰을 쓰고 있어도
 * 자리와 맞지 않으면 틀린 색이다. 선택 테의 `ring-offset` 도 같은 이유로 함께 간다.
 */
export type AgentGridPlace = 'settings' | 'sidebar';

/**
 * 자리별 클래스. 한 곳에 모아 두는 이유: 네 자리(트랙·카드 폭·아바타·▶ 덮개)가 **맞물린
 * 숫자**를 쓴다 — 하나만 고치면 글리프가 얼굴을 벗어나거나 이름이 옆 칸을 침범한다.
 */
const PLACE: Record<AgentGridPlace, {
  /** 격자의 트랙과 간격 — 열 수를 정하는 숫자다. */
  grid: string;
  /** 카드 한 칸의 폭. 트랙과 **같아야** 한다: 다르면 이름이 옆 칸을 침범한다. */
  card: string;
  /** 아바타 상자(그리고 `+` 의 점선 원). */
  face: string;
  /** 아바타 안의 이니셜·글리프 크기. 상자만 줄이면 40px 원에 18px 글자가 갇힌다. */
  faceText: string;
  /** ▶ · ↻ 덮개. **아바타와 같은 크기**여야 얼굴을 정확히 덮는다. */
  glyph: string;
  /** `sticky` 검색줄의 바닥과 선택 테의 오프셋. 자리의 바닥색과 같아야 한다(위 주석). */
  bg: string;
  ringOffset: string;
}> = {
  settings: {
    grid: 'grid-cols-[repeat(auto-fill,86px)] gap-x-6 gap-y-5',
    card: 'w-[86px]',
    face: 'h-14 w-14',
    faceText: 'text-lg',
    glyph: 'h-14 w-14 text-xl',
    bg: 'bg-surface-raised',
    ringOffset: 'ring-offset-surface-raised',
  },
  sidebar: {
    grid: 'grid-cols-[repeat(auto-fill,64px)] gap-x-3 gap-y-4',
    card: 'w-[64px]',
    face: 'h-10 w-10',
    faceText: 'text-sm',
    glyph: 'h-10 w-10 text-base',
    bg: 'bg-surface-sunken',
    ringOffset: 'ring-offset-surface-sunken',
  },
};

/**
 * ▶ · ↻ 의 포커스 표시. **`Menu.tsx` 의 `MENU_ITEM_FOCUS`·`Rail.tsx` 의 `RAIL_FOCUS` 와
 * 같은 조합이다** — 그 파일들이 Tailwind v4 의 함정을 적어 뒀다: `outline-none` 은
 * `--tw-outline-style: none` 을 남기고 `outline-2` 는 굵기만 정하면서 스타일을 그 변수에서
 * 읽으므로, 둘만 쓰면 `focus-visible` 에서도 링이 그려지지 않는다.
 *
 * 이 글리프가 특히 포커스 링을 필요로 하는 이유: **평소 `opacity-50` 으로 숨어 있다.**
 * `focus-visible:opacity-100` 만으로는 "지금 이것이 눌린다"가 아니라 그냥 조금 진해진
 * 글리프이고, 키보드로 격자를 훑는 사람은 카드와 이 버튼 중 어디에 서 있는지 알 수 없다.
 * 링은 안쪽에 그린다 — 얼굴을 정확히 덮는 원이라 바깥으로 밀면 옆 카드와 겹친다.
 */
const GLYPH_FOCUS = 'outline-none focus-visible:opacity-100 focus-visible:outline-solid'
  + ' focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2';

/**
 * 에이전트 그리드 + 검색(identity 문서 · Task 15-2).
 *
 * ## 카드는 조용하다
 *
 * 남는 것은 **아바타와 이름 둘뿐**이다. 하네스·소유자·마지막 활동은 전부 상세로 내려간다.
 * 전제가 바뀌었기 때문이다 — **에이전트는 계속 늘어난다.** 40개가 되면 카드마다 붙은 두 줄
 * 설명은 정보가 아니라 **벽**이 되고, 찾는 방법은 훑기가 아니라 검색이 된다.
 *
 * 문서의 마지막 경고를 그대로 지킨다: *"이 화면에서는 정보를 더하는 쪽이 항상 지는 쪽이다."*
 *
 * ## 상태는 사진이 말한다
 *
 * 상태 점도 상태 글자도 없다 — **아바타 자체가 세 가지로 갈린다.** 그래서 카드에 줄이 늘지
 * 않는다. 정상이 기본값이므로 정상에는 아무 장식도 붙이지 않는다(40개 중 38개가 그 모습이면
 * 화면이 조용하다).
 *
 * ## 검색은 이름만 훑지 않는다
 *
 * `@handle` 과 **역할 설명**(`instructions`)을 함께 훑는다 — "배포 담당이 누구였더라"를
 * 이름을 모르는 채로 찾을 수 있어야 검색이 목록을 대신한다. 설명은 카드에 안 보이지만
 * 찾을 때는 쓰인다.
 *
 * ## 두 자리가 이 컴포넌트를 쓴다 (`docs/desktop-rail.html` 3단계)
 *
 * 설정 › 에이전트와 **레일의 에이전트 칸**이다. 문서가 그 순서를 못 박았다: *"설정 ›
 * 에이전트 재설계가 먼저 들어가야 카드 컴포넌트를 두 번 그리지 않는다."* 그래서 두 자리가
 * 갈리는 곳은 넷뿐이고, 전부 **prop 으로 명시된다** — 자리(`place`: 크기와 바닥색), 카드를
 * 누르면 무엇이 열리는가(`onPick`), 만들기 문을 여는가(`canCreate`), 누가 ▶ 를 받는가
 * (`canRelaunch`). 나머지(가나다 순서 · 검색 · 세 얼굴 · 사유 글자)는 두 화면에서 같아야
 * 하므로 여기 한 벌만 있다.
 */
export function AgentGrid<T extends AgentCardSubject>({
  agents, selectedId, runnerStates, online, connected, onPick, onCreate, canCreate, onRelaunch,
  canRelaunch, place = 'settings',
}: {
  agents: T[];
  selectedId: string | null;
  runnerStates: Record<string, RunnerState>;
  /** 지금 붙어 있는 에이전트들. `connected` 가 false 면 이 목록은 '모른다'다. */
  online: string[];
  connected: boolean;
  onPick(agent: T): void;
  onCreate(): void;
  canCreate: boolean;
  /** ▶ · ↻ 가 부르는 것. 없으면 그 자리를 그리지 않는다(권한 없는 사람에게는 문이 없다). */
  onRelaunch?(agent: T): void;
  /**
   * **이 카드가 ▶ 를 받는가.** 없으면 `onRelaunch` 가 있는 모든 카드가 받는다 — 그것이
   * 설정 화면의 오늘 동작이고 기본값으로 남는다.
   *
   * 왜 `onRelaunch` 의 유무만으로 안 되는가: 콜백은 격자 전체에 **하나뿐인 값**이라
   * 카드마다 다르게 줄 수 없다. 그런데 띄울 권한은 카드마다 갈린다(관리자이거나 내가
   * 소유한 에이전트). 이 술어가 없으면 하나라도 띄울 수 있는 사람에게는 **띄울 수 없는
   * 카드에도 ▶ 가 그려지고**, `AgentGrid` 가 세운 규칙(*"권한 없는 사람에게는 문이
   * 없다"*)이 "권한 없는 카드에는" 으로는 지켜지지 않는다.
   */
  canRelaunch?(agent: T): boolean;
  /** 이 격자가 선 자리. 기본값 `settings` 가 설정 화면의 오늘 모양이다(`AgentGridPlace` 주석). */
  place?: AgentGridPlace;
}) {
  const [query, setQuery] = useState('');
  const s = PLACE[place];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? agents.filter((a) =>
        a.handle.toLowerCase().includes(q)
        || a.displayName.toLowerCase().includes(q)
        // 설명은 카드에 안 보이지만 찾을 때는 쓰인다(문서). 없는 자리(사이드바의 계정
        // 목록)에서는 이름만 훑는다 — `AgentCardSubject` 주석에 그 이유가 있다.
        || (a.instructions ?? '').toLowerCase().includes(q))
      : agents;
    // **가나다 고정**(문서가 정한 것). 상태순으로 정렬하면 켜지고 꺼질 때마다 카드가 자리를
    // 옮겨 위치로 기억하는 것이 불가능해진다 — 상태는 이미 사진이 말하고 있다.
    return [...matched].sort((a, b) => a.handle.localeCompare(b.handle));
  }, [agents, query]);

  return (
    <div className="flex min-h-0 flex-col">
      {/* 검색은 **화면 맨 위 고정**이다 — 목록이 길어져도 찾는 수단이 스크롤 밖으로 나가지 않는다. */}
      <div className={`sticky top-0 z-10 ${s.bg} pb-4`}>
        <div className="relative">
          <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle">⌕</span>
          <input
            data-testid="agent-search"
            aria-label="에이전트 검색"
            className="w-full rounded-lg border border-border bg-field py-2 pl-8 pr-14 text-sm
                       text-fg placeholder-fg-subtle"
            placeholder="이름으로 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* 개수는 **검색창 안**이다(목업) — 몇 개를 뒤지고 있는지가 찾기 전에 보여야 한다. */}
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fg-subtle">
            {shown.length}개
          </span>
        </div>
      </div>

      <div data-testid="agent-grid" className={`grid ${s.grid} overflow-y-auto`}>
        {/*
          `+` 는 **맨 앞**이다. "그리드의 마지막 칸"으로 두면 40개일 때 그 칸이 스크롤 끝이라
          찾아가야 한다. 맨 앞이면 개수와 무관하게 자리가 고정되고, 검색으로 목록이 비어도
          `+` 는 그대로 있다.
        */}
        {canCreate && (
          <button
            data-testid="agent-create"
            className={`group flex ${s.card} flex-col items-center gap-2`}
            onClick={onCreate}
          >
            {/* 목업처럼 **점선도 원**이다 — 사각 점선은 옆의 둥근 얼굴들과 다른 종류로 읽힌다. */}
            <span
              className={`flex ${s.face} items-center justify-center rounded-full border border-dashed
                         border-border text-fg-subtle group-hover:border-fg-subtle group-hover:text-fg`}
            >
              <span aria-hidden="true" className={`${s.faceText} leading-none`}>+</span>
            </span>
            <span className="text-[11px] text-fg-muted">새 에이전트</span>
          </button>
        )}

        {shown.map((a) => {
          const face = faceState(a.id, runnerStates, online, connected);
          return (
            <div key={a.id} className="group relative flex flex-col items-center">
              <button
                data-testid={`agent-card-${a.handle}`}
                data-selected={selectedId === a.id}
                data-face={face}
                // **얼굴이 주인공이다**(문서: "얼굴만 남긴다"). 카드 상자를 그리지 않는다 —
                // 목업에는 테두리도 면도 없고 **원과 이름**만 있다. 상자를 두면 26개가 깔릴 때
                // 격자 선이 얼굴보다 먼저 눈에 들어온다.
                className={`group flex ${s.card} flex-col items-center gap-2`}
                onClick={() => onPick(a)}
              >
                <span
                  className={`relative block rounded-full ${
                    face === 'failed' ? 'ring-2 ring-state-stuck' : ''
                  } ${selectedId === a.id ? `ring-2 ring-accent ring-offset-2 ${s.ringOffset}` : ''}`}
                >
                  {/*
                    멈춘 사진은 **색이 빠진다** — 장식을 더하는 것이 아니라 덜어 낸다.
                    `grayscale` 만으로는 부족하다: 어두운 색(예: blue-500)은 회색조로 바꿔도
                    **거의 검정**이 되어 목업의 중간 회색과 달라지고, 흰 글리프가 그 위에서
                    과하게 도드라진다. 그래서 밝기를 함께 올려 **중간 회색**으로 모은다.
                  */}
                  {/* `#443`: `unknown` 도 색이 빠진다 — 초록으로 두는 것이 이 이슈다.
                      `stopped` 와 **같은 회색**인 것은 의도다: 다른 회색을 하나 더 만들면
                      사람이 두 회색을 구분해 외워야 하고, 그 부담은 이 정보의 무게보다 크다.
                      두 상태를 가르는 것은 색이 아니라 **▶ 의 유무와 글자**다(아래). */}
                  <span
                    className={face === 'stopped' || face === 'unknown'
                      ? 'block grayscale brightness-[1.7] contrast-[0.55] opacity-90'
                      : 'block'}
                  >
                    <Identity account={a} className={`${s.face} ${s.faceText}`} variant="avatar" />
                  </span>
                </span>
                <span
                  className={`w-full truncate text-center text-[11px] ${
                    face === 'ok' ? 'text-fg' : 'text-fg-subtle'
                  }`}
                >
                  {a.handle}
                </span>
              </button>

              {/*
                **▶ · ↻ 는 카드와 다른 동작이다.** 카드를 누르면 설정이 열리고 이것을 누르면
                러너가 뜬다 — 겹쳐 두면 실행이 우연히 눌린다. 그래서 카드 위에 따로 얹는다.
                정상(`running`·`external`)에는 아무것도 없다: 정상이 기본값이므로 표시를
                붙이지 않는다(40개 중 38개가 그 모습이면 화면이 조용하다).
              */}
              {/* `#443`: `unknown` 에는 ▶ 를 **달지 않는다.** ▶ 는 "눌러서 켜라"인데,
                  지금 도는지 모르는 것을 켜라고 권하면 이미 도는 러너를 하나 더 띄우게
                  된다 — `#430` 의 중복이 바로 그 모양이었다. 모를 때 화면이 할 일은
                  행동을 권하는 것이 아니라 **모른다고 말하는 것**이다. */}
              {/* `canRelaunch` 를 안 준 호출자에게는 오늘 동작 그대로다(그 prop 주석). */}
              {onRelaunch && (canRelaunch?.(a) ?? true) && face !== 'ok' && face !== 'unknown' && (
                /*
                  **글리프는 사진 안에 있다**(문서: "실행하기 버튼도 사라진다 — 사진 안으로
                  들어간다"). 그래서 뱃지가 아니라 얼굴을 덮는 원이고, 평소에는 **옅게** 얹혀
                  사진을 가리지 않는다. 마우스를 올리면 또렷해진다 — 누를 수 있다는 것이
                  그때 분명해지면 충분하고, 26개가 깔린 화면에서 26개의 진한 글리프는 소음이다.

                  카드와 **다른 동작**이라는 것은 그대로다: 카드를 누르면 설정이 열리고
                  이것을 누르면 러너가 뜬다.
                */
                <button
                  data-testid={`agent-relaunch-${a.handle}`}
                  aria-label={`${a.handle} ${face === 'failed' ? '다시 띄우기' : '실행하기'}`}
                  className={`absolute left-1/2 top-0 flex ${s.glyph} -translate-x-1/2 items-center
                              justify-center rounded-full leading-none opacity-50 transition
                              group-hover:opacity-100 ${GLYPH_FOCUS} ${
                                face === 'failed' ? 'text-state-stuck' : 'text-fg'
                              }`}
                  onClick={(e) => { e.stopPropagation(); onRelaunch(a); }}
                >
                  <span aria-hidden="true">{face === 'failed' ? '\u21bb' : '\u25b6'}</span>
                </button>
              )}
            </div>
          );
        })}

        {/* 검색 결과가 비었을 때. 목록이 비어 있는 것과 **못 찾은 것**은 다른 사실이다. */}
        {shown.length === 0 && (
          <p className="col-span-full py-6 text-center text-xs text-fg-muted">
            {query.trim() ? `"${query.trim()}" 에 맞는 에이전트가 없다` : '아직 에이전트가 없다'}
          </p>
        )}
      </div>

      {/*
        **실패만 글자를 받는다.** 문서: "유일하게 글자가 늘어나는 상태다. #368 이 사이드바에서
        겪었듯 사유가 title 툴팁에만 있으면 사람은 그것을 찾지 못한다. 예외에만 글자를 쓴다."
      */}
      {shown.filter((a) => runnerStates[a.id]?.status === 'failed').map((a) => (
        <p
          key={a.id}
          data-testid={`agent-runner-failed-${a.id}`}
          className="mt-2 whitespace-normal text-[11px] text-danger"
        >
          @{a.handle} 기동 실패{runnerStates[a.id]?.message ? ` — ${runnerStates[a.id]!.message}` : ''}
        </p>
      ))}

      {/*
        `#476`: **하네스가 없어 물러난 러너도 글자를 받는다.**

        `#473` 이 사유 문구를 만들었지만 그것이 닿는 자리는 사이드바 하나였고, 이 격자는
        `needs_harness` 를 `failed` 로도 안 쳐서 얼굴조차 멀쩡했다. **새 사용자의 기본
        상태가 이것이다**(`claude`·`codex` 는 사용자가 직접 설치한다, 2026-09-06 결정) —
        가장 흔한 상태가 화면에서 가장 조용했다.

        `실패`(danger)와 색을 가르는 이유: 이것은 고장이 아니라 **설치가 아직 안 된 것**이고,
        사람이 할 일이 분명하다. `RunnerStatus.tsx` 의 `TONE` 이 같은 판단을 이미 적어 뒀다.
      */}
      {shown.filter((a) => runnerStates[a.id]?.status === 'needs_harness').map((a) => (
        <p
          key={a.id}
          data-testid={`agent-runner-harness-${a.id}`}
          className="mt-2 whitespace-normal text-[11px] text-warning"
        >
          @{a.handle} {runnerStates[a.id]?.message ?? '하네스를 찾을 수 없다'}
        </p>
      ))}

      {/*
        `#443`: **모른다는 것도 글자로 말한다.**

        얼굴에서 색을 빼는 것만으로는 `stopped`(꺼졌다)와 구분되지 않고, 사람은 회색을
        보면 켜려 한다. 무엇을 모르는지, 그리고 **왜 모르는지**를 한 줄로 준다 —
        사유를 알면 사람은 러너를 뒤지는 대신 연결을 본다.

        한 줄로 묶는 이유: 끊기면 남의 러너가 **전부** 이 상태가 된다. 40줄이 깔리면
        그것이 곧 소음이고, 소음은 읽히지 않는다.
      */}
      {(() => {
        const unknown = shown.filter((a) => faceState(a.id, runnerStates, online, connected) === 'unknown');
        if (unknown.length === 0) return null;
        return (
          <p data-testid="agent-presence-unknown" className="mt-2 whitespace-normal text-[11px] text-fg-muted">
            서버와 끊겨 {unknown.length}개 에이전트의 생사를 알 수 없다 — 마지막으로 본 상태이지 지금 상태가 아니다.
            다시 붙으면 갱신된다.
          </p>
        );
      })()}
    </div>
  );
}
