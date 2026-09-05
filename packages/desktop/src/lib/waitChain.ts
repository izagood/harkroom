import { readAskMeta, type MessageRow } from '@murmur/shared';
import type { Liveness } from './threadState';

/**
 * 대기 사슬의 한 마디 — **누가 누구를 기다리는가**.
 *
 * `waiter` 가 `blockedBy` 의 답을 기다린다. `blockedBy` 가 `null` 이면 사람 아무나를
 * 기다린다는 뜻이다(`AskAudience` 의 `'human'`).
 */
export interface WaitLink {
  /** 기다리는 쪽 — 그 물음을 낸 계정. */
  waiter: string;
  /** 답해야 하는 쪽. `null` 은 '사람 아무나'. */
  blockedBy: string | null;
  /** 이 마디를 만든 미답 ask. 경과와 본문이 필요할 때 쓴다. */
  message: MessageRow;
}

/**
 * 사슬의 끝이 무엇인가 — **사람이 다음에 할 일을 정하는 값이다.**
 *
 * - `me`       내가 답하면 풀린다
 * - `deadlock` 아무 데도 안 닿는다. 사람만이 풀 수 있으므로 실패와 같은 대접(규칙 04)
 * - `other`    남을 기다린다. 나를 막지는 않는다
 * - `none`     기다리는 것이 없다
 */
export type ChainEnd = 'me' | 'deadlock' | 'other' | 'none';

export interface WaitChain {
  links: WaitLink[];
  end: ChainEnd;
  /**
   * **내가 한 번 답하면 몇 개가 풀리는가.** 사람이 답할 이유가 이 숫자다 —
   * "골라 줘"보다 "답하면 codex 도 풀린다"가 사람을 움직인다(규칙 05).
   */
  unblocks: number;
  /** 교착이면 그 이유. 화면이 무엇을 고쳐야 하는지 말할 수 있어야 한다. */
  deadlockReason?: 'cycle' | 'dead-runner';
}

export interface WaitChainInput {
  messages: MessageRow[];
  myAccountId: string | null;
  /** 지금 살아 있는 에이전트들. `null` 은 '모른다' — `threadState` 와 같은 규약이다. */
  live: Liveness;
}

/**
 * 미답 ask 들을 이어 대기 사슬을 만든다(규칙 04 · 계획 Task 7).
 *
 * 사람이 "왜 아무것도 안 움직이지"를 묻지 않게 하는 것이 이 계산의 목적이다.
 * 에이전트끼리 주고받는 물음도 진행을 막지만 나를 막지는 않으므로, 강조가 아니라
 * **사슬**로 표시한다.
 *
 * ## 무엇을 잇는가
 *
 * 각 미답 ask 는 `낸 사람 → 답할 사람` 한 마디다. 그 마디들을 **답할 사람이 다시 무언가를
 * 기다리고 있으면** 이어 붙인다: `codex → forge → 나`.
 *
 * ## 순환은 즉시 끊는다
 *
 * A→B→A 는 방문 집합으로 막는다. **없으면 렌더에서 무한 루프가 터진다** — 이것이 이
 * 함수에서 가장 위험한 부분이고, 그래서 테스트로 고정한다.
 *
 * ## 죽은 러너를 기다리는 것도 교착이다
 *
 * 사슬의 끝이 **죽었다고 아는** 에이전트면 그 사슬은 아무 데도 닿지 않는다. `live` 가
 * `null`(모른다)이면 교착으로 부르지 않는다 — `threadState` 와 같은 이유로, 모른다는
 * 이유로 붉게 칠하는 것도 거짓말이다.
 */
export function waitChain(input: WaitChainInput): WaitChain {
  const { messages, myAccountId, live } = input;

  /** 계정 → 그 계정이 지금 내고 답을 못 받은 물음. 뒤엣것이 이긴다(가장 최근 물음). */
  const pendingByWaiter = new Map<string, WaitLink>();
  /** 답해야 하는 쪽 → 그를 기다리는 마디들. **사슬을 거꾸로 타기 위한 색인이다.** */
  const waitersOf = new Map<string, WaitLink[]>();
  const links: WaitLink[] = [];

  for (const m of messages) {
    const ask = readAskMeta(m.meta);
    if (!ask || ask.answeredWith != null) continue;
    const link: WaitLink = {
      waiter: m.authorId,
      blockedBy: ask.to.kind === 'human' ? null : ask.to.accountId,
      message: m,
    };
    pendingByWaiter.set(m.authorId, link);
    if (link.blockedBy !== null) {
      const bucket = waitersOf.get(link.blockedBy) ?? [];
      bucket.push(link);
      waitersOf.set(link.blockedBy, bucket);
    }
    links.push(link);
  }

  if (links.length === 0) return { links: [], end: 'none', unblocks: 0 };

  /**
   * 사슬을 따라간다. 시작은 **가장 최근 물음** — 지금 무엇이 멈춰 있는지를 묻는 것이므로
   * 마지막에 난 물음에서 출발하는 것이 맞다.
   */
  const chain: WaitLink[] = [];
  const seen = new Set<string>();
  let cursor: WaitLink | undefined = links[links.length - 1];
  let end: ChainEnd | null = null;
  let reason: WaitChain['deadlockReason'];

  while (cursor) {
    // **순환 방지.** 이 줄이 없으면 A→B→A 에서 무한 루프가 돈다.
    if (seen.has(cursor.waiter)) { end = 'deadlock'; reason = 'cycle'; break; }
    seen.add(cursor.waiter);
    chain.push(cursor);

    const next: string | null = cursor.blockedBy;
    // 사람 아무나를 기다린다 — 내가 사람이면 여기가 내 차례다.
    if (next === null) { end = myAccountId ? 'me' : 'other'; break; }
    if (next === myAccountId) { end = 'me'; break; }
    // 답해야 하는 쪽이 죽었다고 **알면** 사슬이 아무 데도 닿지 않는다.
    if (live !== null && !live.has(next)) { end = 'deadlock'; reason = 'dead-runner'; break; }
    // 그 계정도 무언가를 기다리고 있으면 사슬이 이어진다.
    cursor = pendingByWaiter.get(next);
  }

  if (end === 'deadlock') return { links: chain, end, unblocks: 0, deadlockReason: reason };
  if (end === 'me') {
    /**
     * **내가 답하면 몇 개가 풀리는가.** 사슬을 앞으로 탄 것(`chain`)만 세면 부족하다 —
     * 내가 답할 그 계정을 *기다리고 있던* 쪽들도 함께 풀리기 때문이다.
     * 그래서 답할 지점에서 **거꾸로** 훑어 도달 가능한 마디를 전부 센다.
     */
    const answerTarget = chain[chain.length - 1]!;
    const counted = new Set<WaitLink>(chain);
    const queue = [answerTarget.waiter];
    const visited = new Set<string>();
    while (queue.length) {
      const who = queue.shift()!;
      if (visited.has(who)) continue;
      visited.add(who);
      for (const l of waitersOf.get(who) ?? []) {
        counted.add(l);
        queue.push(l.waiter);
      }
    }
    return { links: chain, end, unblocks: counted.size };
  }
  if (end === 'other') return { links: chain, end, unblocks: 0 };

  // 사슬 끝이 아무것도 안 기다린다 — 그 사람이/에이전트가 답할 차례다(나는 아니다).
  return { links: chain, end: 'other', unblocks: 0 };
}
