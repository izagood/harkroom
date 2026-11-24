import { type DelegationClosedReason, type DelegationPrWatch, type InboxDelegationSummary, type InboxEntry } from '@harkroom/shared';

/**
 * 위임 표시(위임 재설계 v1 P6, designer 시안 v1 · 소유자 승인 2026-11-09).
 *
 * 재료는 서버가 inbox 항목에 싣는 위임 요약(`InboxEntry.delegations`) 하나다 — 앱이 위임을 따로 조회하면 서버의 판정과
 * 갈라진다. 스위치 `HARKROOM_DELEGATION_V2` 가 꺼진 서버·옛 서버는 요약을 싣지 않으므로, 그때 이 파일의 함수는 모두
 * 「없음」을 돌려주고 화면은 지금과 같다.
 */

/** 칩이 말하는 상태 넷. 옛 결말(`done`·`timeout`·`canceled`)은 닫힘으로 읽는다 — 스위치가 꺼진 동안 닫힌 위임이다. */
export type ChipState = 'open' | 'reported' | 'failed' | 'closed';

function chipState(state: string): ChipState {
  if (state === 'open' || state === 'reported' || state === 'failed') return state;
  return 'closed';
}

/** 칩 하나 = 담당 하나(위임 하나에 담당이 여럿이면 여럿). PR 감시 칩은 그 위임의 첫 칩 바로 뒤에 붙는다. */
export type DelegationChip =
  | {
    kind: 'item';
    key: string;
    delegationId: string;
    /** 누르면 가는 곳 — 그 위임을 연 글. */
    messageId: string;
    handle: string;
    state: ChipState;
    closedReason: DelegationClosedReason | null;
    planStepId: string | null;
  }
  | { kind: 'pr'; key: string; delegationId: string; watch: DelegationPrWatch };

const ORDER: Record<ChipState, number> = { failed: 0, reported: 1, open: 2, closed: 3 };

export interface ChipRow {
  /** `delegator` 면 「맡긴 일」, `delegate` 면 「맡은 일 · {넘긴 쪽}」. 둘 다면 넘긴 쪽이 이긴다(내가 고를 일이 더 많다). */
  role: 'delegator' | 'delegate';
  /** 담당 쪽일 때 넘긴 쪽 handle. */
  delegatorHandle: string | null;
  chips: DelegationChip[];
  /** 접힌 칩 수와 그중 닫힌 수. */
  hidden: DelegationChip[];
  hiddenClosed: number;
}

/** 펼쳐 둘 담당 칩 수. 넘치면 뒤(닫힌 것부터)를 「+n」으로 접는다. 시안의 「두 줄까지」를 칩 수로 근사한다. */
export const MAX_VISIBLE_CHIPS = 4;
/** 좁은 칩 줄(@sm 컨테이너 미만, 시안 360px)에서 펼쳐 둘 담당 칩 수 — 4개면 네 줄이 되어 대화를 밀어낸다(designer). */
export const MAX_VISIBLE_CHIPS_NARROW = 2;

/**
 * 스레드 머리 아래 「맡긴 일」 칩 줄. 위임이 없으면 null — 줄 자체를 그리지 않는다.
 *
 * 순서는 막힘 → 결과 옴 → 하는 중 → 닫힘(시안). 같은 상태 안에서는 서버가 준 순서 그대로다.
 */
export function chipRow(summaries: InboxDelegationSummary[] | null | undefined, maxVisible: number = MAX_VISIBLE_CHIPS): ChipRow | null {
  if (!summaries || summaries.length === 0) return null;
  const asDelegator = summaries.filter((d) => d.role === 'delegator');
  const use = asDelegator.length > 0 ? asDelegator : summaries;
  const role = asDelegator.length > 0 ? 'delegator' : 'delegate';
  type Unit = { item: Extract<DelegationChip, { kind: 'item' }>; prs: DelegationChip[] };
  const units: Unit[] = [];
  for (const d of use) {
    d.items.forEach((i, n) => {
      units.push({
        item: {
          kind: 'item',
          key: `${d.id}:${i.handle}`,
          delegationId: d.id,
          messageId: d.messageId,
          handle: i.handle,
          state: chipState(i.state),
          closedReason: i.state === 'closed' ? i.closedReason ?? null : null,
          planStepId: d.planStepId,
        },
        // 감시는 위임에 걸린다 — 첫 담당 칩 뒤에만 한 번 붙인다.
        prs: n === 0 ? d.prWatches.map((w) => ({ kind: 'pr' as const, key: `${d.id}:pr:${w.repo}#${w.number}`, delegationId: d.id, watch: w })) : [],
      });
    });
  }
  if (units.length === 0) return null;
  const sorted = units
    .map((u, idx) => ({ u, idx }))
    .sort((a, b) => ORDER[a.u.item.state] - ORDER[b.u.item.state] || a.idx - b.idx)
    .map(({ u }) => u);
  const shown = sorted.slice(0, maxVisible);
  const rest = sorted.slice(maxVisible);
  return {
    role,
    delegatorHandle: role === 'delegate' ? use[0]!.delegatorHandle : null,
    chips: shown.flatMap((u) => [u.item, ...u.prs]),
    hidden: rest.flatMap((u) => [u.item, ...u.prs]),
    hiddenClosed: rest.filter((u) => u.item.state === 'closed').length,
  };
}

/**
 * 스레드 하나의 위임 요약 — 그 스레드로 온 inbox 항목 가운데 **가장 최근에 요약을 실은 것**의 것. 요약은 서버가 항목을
 * 만들 때의 사진이라 최근 것이 지금에 가장 가깝다.
 */
export function threadDelegations(entries: readonly InboxEntry[], rootId: string): InboxDelegationSummary[] | null {
  let best: InboxEntry | null = null;
  for (const e of entries) {
    if ((e.threadRootId ?? e.messageId) !== rootId || !e.delegations || e.delegations.length === 0) continue;
    if (!best || Date.parse(e.createdAt) > Date.parse(best.createdAt)) best = e;
  }
  return best?.delegations ?? null;
}
