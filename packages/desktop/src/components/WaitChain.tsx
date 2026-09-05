import { useActiveStore } from '../state/communities';
import { elapsedLabel } from '../lib/progressGroup';
import type { WaitChain as Chain } from '../lib/waitChain';

/**
 * 대기 사슬 한 줄 — **사람이 "왜 아무것도 안 움직이지"를 묻지 않게 하는 것**이 목적이다
 * (규칙 04 · 계획 Task 7).
 *
 * 에이전트끼리 주고받는 물음도 진행을 막지만 나를 막지는 않으므로 강조가 아니라 사슬로
 * 표시한다. 다만 **사슬의 끝이 나이거나 아무 데도 닿지 않으면** 이야기가 다르다:
 *
 * - 끝이 나 → 답하면 풀린다. **몇 개가 풀리는지**를 말한다 — 그것이 사람이 답할 이유다(규칙 05)
 * - 교착 → 사람만이 풀 수 있으므로 실패와 같은 대접(강조)
 * - 끝이 남 → 무채색 한 줄. 읽히면 된다
 *
 * `none` 이면 아무것도 그리지 않는다 — 기다리는 것이 없는데 "아무도 안 기다림"을 그리면
 * 그것이 규칙 06 이 말하는 0 을 그리는 짓이다.
 */
export function WaitChainLine({ chain }: { chain: Chain }) {
  const accounts = useActiveStore((s) => s.accounts);
  if (chain.end === 'none' || chain.links.length === 0) return null;

  const name = (id: string | null): string => (id === null ? '사람' : accounts[id]?.handle ?? '…');
  const head = chain.links[0]!;
  const elapsed = elapsedLabel(head.message.createdAt, Date.now());

  if (chain.end === 'deadlock') {
    return (
      <div
        data-testid="wait-chain"
        data-end="deadlock"
        data-reason={chain.deadlockReason}
        className="mx-4 my-1 rounded border border-state-stuck bg-danger-surface px-2 py-1
                   text-[11px] text-state-stuck"
      >
        <span className="font-semibold">교착</span>
        <span className="ml-1.5 text-fg-muted">
          {chain.deadlockReason === 'cycle'
            // 서로를 기다리는 것과 죽은 러너를 기다리는 것은 **사람이 할 일이 다르다**.
            ? `${chain.links.map((l) => name(l.waiter)).join(' ↔ ')} 가 서로를 기다린다 — 사람만이 풀 수 있다`
            : `${name(head.waiter)} 가 ${name(head.blockedBy)} 를 기다리는데 응답이 없다`}
        </span>
      </div>
    );
  }

  const mine = chain.end === 'me';
  return (
    <div
      data-testid="wait-chain"
      data-end={chain.end}
      data-unblocks={chain.unblocks}
      className={`mx-4 my-1 px-1 text-[11px] ${mine ? 'text-state-turn' : 'text-fg-muted'}`}
    >
      <span>
        {chain.links.map((l) => `${name(l.waiter)} 가 ${name(l.blockedBy)} 의 답을 기다린다`).join(' · ')}
      </span>
      {elapsed && <span className="ml-1 text-fg-subtle">· {elapsed}</span>}
      {/*
        **몇 개가 풀리는지가 사람이 답할 이유다.** 둘 이상일 때만 말한다 — 하나뿐이면
        "답하면 1개가 풀린다"는 정보가 아니라 잡음이고, 그 물음 자체가 이미 그 말을 하고 있다.
      */}
      {mine && chain.unblocks > 1 && (
        <span className="ml-1 font-medium">— 답하면 {chain.unblocks}개가 풀린다</span>
      )}
    </div>
  );
}
