import { useEffect, useRef, type ReactNode } from 'react';
import type { AccountView, AgentTeamRow, HandleGroupRow } from '@harkroom/shared';
import type { MentionQuery } from '../lib/mention';
import { GroupBadge, TeamBadge } from './Identity';

/**
 * 멘션 추천의 **후보와 목록**. 작성창(`Composer`)과 메시지 수정창(`MessageItem`)이 함께 쓴다.
 *
 * 한 파일로 뽑은 이유: 수정창에서 `@` 를 쳐도 추천이 안 떴다(2026-10-01 신고). 수정창에
 * 따로 후보 규칙을 적으면 비활성 계정 빼기·집합 자리 예약·팀과 집합의 이름 겹침 같은
 * 규칙이 두 곳에서 갈라진다 — 그때 같은 `@a` 가 두 상자에서 다른 상대를 내놓는다.
 * 그래서 **후보를 고르는 함수와 그리는 목록은 하나**이고, 두 상자는 키보드와 본문만 쥔다.
 */

/**
 * 목록에 담는 후보의 상한. **목록의 높이는 이 수가 아니라 상자가 정한다** — 아래
 * 후보 목록은 `max-h-*` + `overflow-y-auto` 로 스크롤되는 상자다.
 *
 * 8 이었다. 그때 이 수의 뜻은 "화면을 덮지 않을 만큼" 이었고, 그래서 계정이 아홉만
 * 있어도 아홉째부터는 **조용히 사라졌다** — 목록은 여덟 줄에서 끝나고 스크롤할 것도
 * 없으니, 있는 상대를 찾을 길이 화면에 남지 않았다(실측: 8 개만 보이고 스크롤이 안
 * 된다는 신고). 화면을 덮지 않게 하는 일은 상자의 높이가 이미 하고 있으므로 여기서
 * 두 번 하지 않는다. 이제 이 수는 **한 번에 그리는 항목 수의 상한**이다.
 */
export const MAX_SUGGESTIONS = 50;

/**
 * 후보 목록에서 집합에 **미리 떼어 두는 자리**(#285).
 *
 * 자리를 떼지 않으면 계정이 여덟 개 걸리는 흔한 질의(`@a`)에서 집합이 목록에 아예
 * 나타나지 않는다 — 있는데 안 보이는 것이 가장 나쁜 상태다. 반대로 양쪽을 각자
 * `MAX_SUGGESTIONS` 까지 담으면 목록이 두 배가 되어 위 주석의 약속(화면을 덮지 않는다)이
 * 깨진다. 그래서 총량은 그대로 두고 집합에 앞자리 몇 개를 예약한다.
 *
 * 집합이 없는 워크스페이스에서는 예약이 0 이므로 목록은 **글자 하나도 달라지지 않는다.**
 *
 * 3 이었다 — 목록 전체가 8 줄일 때의 몫이다. 목록이 스크롤되게 된 뒤로는 그 수가
 * **집합·팀을 감추는 쪽**으로만 일했다(팀이 넷인데 셋만 서는 화면). 그래서 뜻을 바꿔
 * 목록의 절반으로 둔다: 집합·팀이 목록을 다 차지하는 것은 막고(나머지 절반은 늘 계정
 * 자리다), 그 아래에서는 있는 것을 다 보인다.
 */
export const MAX_GROUP_SUGGESTIONS = MAX_SUGGESTIONS / 2;

/** 에이전트를 먼저 세운다 — harkroom 에서 @ 를 치는 주된 이유다. 그 안에서는 이름순. */
function rank(a: AccountView, b: AccountView): number {
  if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
  return a.handle.localeCompare(b.handle);
}

/**
 * **이 채널이 데리고 있는 에이전트를 맨 위에 세운다**(마이그레이션 048 의 `available`).
 *
 * 목록을 자르지 않고 순서만 바꾸는 이유: 다른 에이전트를 못 부르게 하는 것이 아니다
 * (멘션은 전역이고 그래야 한다). 이 채널에 처음 들어온 사람이 **여기서 누구를 부르면
 * 되는지**를 목록의 첫 줄에서 읽게 하는 것이 전부다.
 *
 * `channelHandles` 가 비면 비교가 늘 무승부라 `rank` 그대로다 — 자동 멘션이 없는 채널의
 * 목록은 글자 하나도 달라지지 않는다.
 */
export function rankWithChannelFirst(channelHandles: readonly string[]) {
  return (a: AccountView, b: AccountView): number => {
    const inA = channelHandles.includes(a.handle.toLowerCase());
    const inB = channelHandles.includes(b.handle.toLowerCase());
    if (inA !== inB) return inA ? -1 : 1;
    return rank(a, b);
  };
}

/**
 * 후보 하나. 계정과 집합이 **한 목록에 섞여 서고 키보드도 하나**이므로, 어느 쪽에서 온
 * 항목인지를 목록을 만들 때 태그로 붙인다.
 *
 * 렌더 시점에 필드 유무(`'createdAt' in item` 같은 것)로 되짚지 않는 이유: 계정에 같은
 * 이름의 필드가 하나 생기는 순간 판정이 조용히 갈리고, 그때 깨지는 것은 타입이 아니라
 * 화면이다. 태그는 컴파일러가 지킨다.
 */
export type Candidate =
  | { kind: 'account'; id: string; handle: string; account: AccountView }
  | { kind: 'group'; id: string; handle: string; group: HandleGroupRow }
  // 에이전트 팀(#172). 집합과 나란히 선다 — 둘 다 "한 이름으로 여럿을 부른다"이고,
  // 부를 수 있는 이름이 후보에 없으면 사람은 그것을 배울 방법이 없다.
  | { kind: 'team'; id: string; handle: string; team: AgentTeamRow };

export const asAccountCandidates = (list: AccountView[]): Candidate[] =>
  list.map((a) => ({ kind: 'account', id: a.id, handle: a.handle, account: a }));

export const asGroupCandidates = (list: HandleGroupRow[]): Candidate[] =>
  list.map((g) => ({ kind: 'group', id: g.id, handle: g.handle, group: g }));

// 팀은 `name` 을 handle 자리에 넣는다 — 서버가 그 이름을 계정 handle 과 **같은
// 네임스페이스**에 두고 같은 문법으로 검사하므로(`teamRoutes.ts` 의 `HANDLE_PATTERN`),
// 멘션으로 쓰이는 문자열은 이것 하나다.
export const asTeamCandidates = (list: AgentTeamRow[]): Candidate[] =>
  list.map((t) => ({ kind: 'team', id: t.id, handle: t.name, team: t }));

export interface MentionDirectory {
  accounts: Record<string, AccountView>;
  groups: HandleGroupRow[];
  teams: AgentTeamRow[];
  myId: string | undefined;
  /** 이 채널이 데리고 있는 에이전트 handle(소문자). 맨 위에 선다(`rankWithChannelFirst`). */
  channelHandles: readonly string[];
}

/** `@` 뒤에 친 글자로 고른 후보. 질의가 없으면 빈 목록이다. */
export function mentionMatches(query: MentionQuery | null, dir: MentionDirectory): Candidate[] {
  if (!query) return [];
  const { accounts, groups, teams, myId, channelHandles } = dir;
  const q = query.query.toLowerCase();
  const groupMatches = groups
    .filter((g) => g.handle.toLowerCase().startsWith(q))
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .slice(0, MAX_GROUP_SUGGESTIONS);
  /**
   * 팀도 같은 예약 자리를 쓴다(#172). 집합과 **합쳐서** `MAX_GROUP_SUGGESTIONS` 개다 —
   * 각자 세 자리를 주면 총량이 늘어 `MAX_GROUP_SUGGESTIONS` 주석의 약속(목록이 화면을
   * 덮지 않는다)이 깨진다. 팀이 뒤 자리를 받는 것은 아래 정렬 순서와 같은 이유다.
   *
   * **이름이 집합과 겹치면 팀을 후보에서 뺀다.** 세 네임스페이스가 배타가 아니라는 것을
   * 서버 테스트가 고정했고(`teamMention.test.ts`), 겹친 이름을 부르면 서버는 집합을
   * 펼친다(`services/messages.ts` 의 해석 순서: 계정 → 집합 → 팀). 그때 후보에 팀이
   * 서면 그것을 골라 보낸 사람은 자기가 부른 것과 다른 명단이 깨는 것을 본다 — 후보는
   * 알림이 가는 쪽을 따라야 한다(`bodyRecipients` 의 같은 원칙).
   */
  const groupNames = new Set(groups.map((g) => g.handle.toLowerCase()));
  const teamMatches = teams
    .filter((t) => t.name.toLowerCase().startsWith(q) && !groupNames.has(t.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_GROUP_SUGGESTIONS - groupMatches.length);
  const reserved = groupMatches.length + teamMatches.length;
  const accountMatches = Object.values(accounts)
    // 비활성 계정은 부를 수 없다 — 디렉터리에는 남아 있다(과거 메시지의 작성자 이름을
    // 풀어야 하므로). 후보에서 빼는 것이 이쪽 책임이다(shared 의 AccountView.disabled 주석).
    .filter((a) => a.id !== myId && !a.disabled && a.handle.toLowerCase().startsWith(q))
    .sort(rankWithChannelFirst(channelHandles))
    .slice(0, MAX_SUGGESTIONS - reserved);
  // 계정이 먼저, 집합·팀이 뒤다 — 사람·에이전트를 부르는 것이 흔한 쪽이고, 여럿을
  // 부르는 이름은 목록 아래에 모여 있어야 "이 아래는 여러 명"이라고 한눈에 읽힌다.
  return [
    ...asAccountCandidates(accountMatches),
    ...asGroupCandidates(groupMatches),
    ...asTeamCandidates(teamMatches),
  ];
}

interface ListProps {
  /** 목록의 DOM id. 입력칸의 `aria-controls`·`aria-activedescendant` 가 이것과 `${id}-${i}` 를 가리킨다. */
  id: string;
  label: string;
  options: Candidate[];
  active: number;
  onActive: (i: number) => void;
  onChoose: (handle: string) => void;
  /**
   * 입력칸의 어느 쪽에 열지. 작성창은 화면 맨 아래라 위(`above`)다. 수정창은 대화 **안**에
   * 있어서 아래(`below`)다 — 스크롤 상자의 위쪽으로 넘친 것은 스크롤로 닿지 않으므로
   * (음수 방향 넘침은 스크롤 영역이 되지 않는다), 맨 위 메시지를 고칠 때 목록이 잘린다.
   */
  placement: 'above' | 'below';
  /**
   * 계정 후보 줄 오른쪽에 덧붙일 것(있을 때만). 스레드 작성창이 그 스레드의 모델 지정을 옅게
   * 적는 자리다(스레드별 모델 지정 결정 13). 지정이 없는 상대에는 `null` 을 돌려 아무것도
   * 붙이지 않는다 — #455(사람과 에이전트를 가르지 않는다)를 지정 없는 줄에서까지 깨지 않는다.
   */
  trailing?: (item: Extract<Candidate, { kind: 'account' }>) => ReactNode;
}

/** 후보 목록. 열지 말지는 부르는 쪽이 정한다 — 이 컴포넌트는 그려지면 열린 것이다. */
export function MentionSuggestList({ id, label, options, active, onActive, onChoose, placement, trailing }: ListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  /**
   * 키보드로 옮긴 후보를 목록 안으로 끌어온다.
   *
   * 목록은 넘치면 스크롤되는 상자이고 강조는 `active` 라는 숫자다 — 끌어오지 않으면
   * ↓ 를 계속 누른 사람은 **화면 밖의 항목이 골라진 상태로** Enter 를 누른다. 무엇이
   * 골라졌는지 보이지 않으니 목록이 여덟 줄에서 멈춘 것처럼 읽히고(실측 신고), 마지막
   * 항목에서 첫 항목으로 돌아가는 순환(`% options.length`)도 화면에는 나타나지 않는다.
   *
   * `block: 'nearest'` 여서 **이미 보이는 항목에는 아무 일도 하지 않는다** — 마우스를
   * 목록 위로 굴리면 hover 가 `active` 를 바꾸는데(`onMouseEnter`), 여기서 매번
   * 스크롤하면 손으로 굴린 것을 코드가 되돌려 목록이 떨린다.
   *
   * jsdom 에는 `scrollIntoView` 가 없다 — 없는 환경에서 목록이 죽지 않게 옵셔널로 부른다.
   */
  useEffect(() => {
    const item = listRef.current?.children[active] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: 'nearest' });
  }, [active, options.length]);

  return (
    <ul
      id={id}
      role="listbox"
      aria-label={label}
      ref={listRef}
      /* 상자가 목록의 높이를 정한다 — 후보 수는 `MAX_SUGGESTIONS` 까지 늘어나고
         넘치는 것은 여기서 스크롤된다. `vh` 를 함께 두는 이유: 고정 높이만 두면
         창이 낮을 때 목록이 화면 위로 잘려 나가고, 잘린 쪽은 스크롤로도 닿지 않는다.
         `overscroll-contain` 은 목록의 끝에서 굴린 것이 뒤의 대화를 밀지 않게 한다. */
      className={`absolute ${placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 z-10 max-h-[min(22rem,60vh)] w-72 overflow-y-auto overscroll-contain rounded border border-border bg-surface-raised py-1 shadow-lg`}
    >
      {options.map((item, i) => (
        <li key={item.id}>
          <button
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            type="button"
            // 핸들을 속성으로 노출한다. 테스트가 textContent 에서 핸들을 뽑으면
            // 장식(에이전트 표시 등)이 하나 늘 때마다 깨진다 — 실제로 그랬다.
            data-handle={item.handle}
            // 계정인지 집합인지 팀인지도 속성으로 노출한다(#285·#172). 같은 이유다:
            // 배지 문구가 바뀌면 문구로 종류를 확인하던 테스트가 깨진다.
            data-kind={item.kind}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? 'bg-accent-surface' : ''}`}
            // mousedown 을 막지 않으면 클릭 전에 textarea 가 blur 되어 커서 위치가 사라진다.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onActive(i)}
            onClick={() => onChoose(item.handle)}
          >
            <span className="font-medium">@{item.handle}</span>
            {item.kind === 'group' ? (
              <>
                <GroupBadge group={item.group} className="ml-1" />
                {/* 집합에는 표시 이름을 함께 보인다 — `@release` 만으로는 그것이 무엇을
                    묶은 것인지 알 수 없고, 부르기 직전이 그것을 확인하는 자리다. 계정에는
                    붙이지 않는다: 사람·에이전트는 핸들이 곧 이름으로 통한다. */}
                <span className="ml-1 truncate text-meta text-fg-subtle">{item.group.displayName}</span>
              </>
            ) : item.kind === 'team' ? (
              /**
               * 팀(#172)에는 배지만 붙인다 — 팀에는 표시 이름이 없다(`AgentTeamRow` 는
               * `name` 하나뿐이고, 그 이름이 곧 부르는 문자열이다). 없는 필드를 위해
               * 빈 칸을 두지 않는다(규칙 06).
               */
              <TeamBadge team={item.team} className="ml-1" />
            ) : (
              /* 계정 후보에는 아무것도 덧붙이지 않는다. 여기 있던 `Identity`
                 배지(🤖 + 소유자 @핸들)를 뺐다 — 화면은 부르려는 상대가 사람인지
                 에이전트인지 말하지 않는다(design doc 2, #455). 사람 후보는 이미
                 핸들만 서 있었고(#365), 이제 둘이 같은 줄로 선다. 소유자를 확인해야
                 하면 프로필(#475)을 연다. 덧붙임(`trailing`)은 부르는 쪽이 정한다. */
              trailing?.(item) ?? null
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
