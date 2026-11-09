import { readFailureMeta, readReportMeta, type DelegationClosedReason, type DelegationPrWatch, type InboxDelegationSummary, type InboxEntry } from '@harkroom/shared';

/**
 * 위임 표시(위임 재설계 v1 P6, designer 시안 v1 · 소유자 승인 2026-11-09).
 *
 * 재료는 서버가 inbox 항목에 싣는 위임 요약(`InboxEntry.delegations`) 하나다 — 앱이 위임을 따로 조회하면 서버의 판정과
 * 갈라진다. 스위치 `HARKROOM_DELEGATION_V2` 가 꺼진 서버·옛 서버는 요약을 싣지 않으므로, 그때 이 파일의 함수는 모두
 * 「없음」을 돌려주고 화면은 지금과 같다.
 */

/** 인박스 카드 앞의 위임 라벨 넷. `failed`·`stalled` 는 「막힘」 묶음으로 올라간다. */
export type DelegationLabel = 'update' | 'reported' | 'failed' | 'stalled';

/**
 * 「멈췄다」로 보는 조용한 시간. 결과가 아직 없는(`open`) 담당이 이만큼 아무 글도 없으면 막힌 것으로 올린다.
 * **서버 수명(P3)의 값을 따른다** — 시안은 4시간으로 그렸다. 유휴 닫힘(결과 뒤 6시간)보다 짧아야 닫히기 전에 사람이 본다.
 */
export const STALLED_MS = 4 * 3_600_000;

/** 위임 사유 — 이 사유로 온 항목은 위임 라벨을 단다. */
const DELEGATION_REASONS: ReadonlySet<InboxEntry['reason']> = new Set(['delegation_update', 'delegation_done', 'delegation_followup']);

/** 칩이 말하는 상태 넷. 옛 결말(`done`·`timeout`·`canceled`)은 닫힘으로 읽는다 — 스위치가 꺼진 동안 닫힌 위임이다. */
export type ChipState = 'open' | 'reported' | 'failed' | 'closed';

function chipState(state: string): ChipState {
  if (state === 'open' || state === 'reported' || state === 'failed') return state;
  return 'closed';
}

export interface CardDelegation {
  label: DelegationLabel;
  /** `stalled` 일 때 조용했던 시간(시, 내림). */
  quietHours: number | null;
  /** 이 카드에 묶인 진행 소식 수(`delegation_update` 항목). 2 이상일 때만 화면이 「소식 n」을 단다. */
  updates: number;
}

/** 넘긴 쪽으로서 본 요약들 — 라벨은 「내가 맡긴 일」의 소식이다. 담당 쪽 요약은 칩 줄에서만 쓴다. */
function delegatorSummaries(entries: InboxEntry[]): InboxDelegationSummary[] {
  for (const e of entries) {
    if (e.delegations && e.delegations.length > 0) return e.delegations.filter((d) => d.role === 'delegator');
  }
  return [];
}

/**
 * 카드(스레드 하나, 최근 항목이 앞)의 위임 라벨. 위임 사유로 온 항목도, 위임 요약도 없으면 null — 지금처럼 라벨이 없다.
 *
 * 순서가 규칙이다: **막힘 → 멈춤 → 결과 → 진행**. 실패한 담당이 하나라도 있으면 다른 담당의 결과보다 먼저 보여야 한다.
 */
export function cardDelegation(entries: InboxEntry[], nowMs: number): CardDelegation | null {
  const own = entries.filter((e) => DELEGATION_REASONS.has(e.reason));
  const summaries = delegatorSummaries(entries);
  if (own.length === 0 && summaries.length === 0) return null;
  const items = summaries.flatMap((d) => d.items);
  const updates = entries.filter((e) => e.reason === 'delegation_update').length;
  const latest = own[0] ?? null;

  if (items.some((i) => i.state === 'failed') || (latest != null && readFailureMeta(latest.meta) != null)) {
    return { label: 'failed', quietHours: null, updates };
  }
  // 멈춤: 결과가 아직 없는 담당이 오래 조용하다. 아직 아무 글이 없으면 위임을 연 시각으로 잰다 — 그 시각은 요약에 없으므로
  // 그때는 판정하지 않는다(모르는 것을 멈췄다고 하지 않는다).
  let quietMs = -1;
  for (const i of items) {
    if (i.state !== 'open' || i.lastActivityAt == null) continue;
    quietMs = Math.max(quietMs, nowMs - Date.parse(i.lastActivityAt));
  }
  if (quietMs >= STALLED_MS) return { label: 'stalled', quietHours: Math.floor(quietMs / 3_600_000), updates };
  if (items.some((i) => i.state === 'reported')
    || (latest != null && (latest.reason === 'delegation_done' || latest.reason === 'delegation_followup' || readReportMeta(latest.meta) != null))) {
    return { label: 'reported', quietHours: null, updates };
  }
  // 요약만 있고(사람 부름 등) 위임 사유 항목이 없으면 라벨을 달지 않는다 — 진행 소식은 담당의 글이 왔을 때만이다.
  if (own.length === 0) return null;
  return { label: 'update', quietHours: null, updates };
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

/**
 * 스레드 머리 아래 「맡긴 일」 칩 줄. 위임이 없으면 null — 줄 자체를 그리지 않는다.
 *
 * 순서는 막힘 → 결과 옴 → 하는 중 → 닫힘(시안). 같은 상태 안에서는 서버가 준 순서 그대로다.
 */
export function chipRow(summaries: InboxDelegationSummary[] | null | undefined): ChipRow | null {
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
  const shown = sorted.slice(0, MAX_VISIBLE_CHIPS);
  const rest = sorted.slice(MAX_VISIBLE_CHIPS);
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
