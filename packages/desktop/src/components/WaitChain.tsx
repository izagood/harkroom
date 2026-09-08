import { useActiveStore } from '../state/communities';
import { elapsedMs } from '../lib/progressGroup';
import { runningLabel } from '../lib/time';
import { useT, useLocale } from '../i18n/useT';
import {
  chainSentences, deadlockSentence, unblocksSentence, type WaitChain as Chain,
} from '../lib/waitChain';

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
 *
 * ## 문장은 이 파일이 안 만든다
 *
 * 조사도 어순도 여기 없다. **`lib/waitChain.ts` 가 문장을 내고 이 파일은 그리기만
 * 한다** — 같은 사슬을 인박스(`WaitChainSection`)도 그리므로, 문장 조립이 화면에 있으면
 * 두 곳이 조용히 갈라진다. 그것이 이 저장소가 판정을 `lib/` 에 두는 이유 그대로다.
 */
export function WaitChainLine({ chain }: { chain: Chain }) {
  const accounts = useActiveStore((s) => s.accounts);
  const t = useT();
  const locale = useLocale();
  if (chain.end === 'none' || chain.links.length === 0) return null;

  const name = (id: string | null): string => (id === null ? t('common.someone') : accounts[id]?.handle ?? '…');
  const head = chain.links[0]!;
  // **`askedAt` 을 쓴다** — 집계로 만든 사슬에는 메시지가 없다(#488 A3-b). 채널 목록은
  // 답글을 싣지 않으므로 서버가 두 계정과 시각만 준다.
  // 기다림은 **아직 도는 중**이라 `runningLabel` 이다 — `3분` 이 아니라 `3분째` 여야
  // 이 줄이 말하는 사실("지금 멈춰 있다")이 온다(`lib/time.ts` 의 상[aspect] 주석).
  const waitedMs = elapsedMs(head.askedAt, Date.now());
  const elapsed = waitedMs === null ? null : runningLabel(waitedMs, locale, t);

  if (chain.end === 'deadlock') {
    return (
      <div
        data-testid="wait-chain"
        data-end="deadlock"
        data-reason={chain.deadlockReason}
        className="mx-4 my-1 rounded border border-state-stuck bg-danger-surface px-2 py-1
                   text-meta text-state-stuck"
      >
        <span className="font-semibold">{t('waitChain.deadlock')}</span>
        {/* 서로를 기다리는 것과 죽은 러너를 기다리는 것은 **사람이 할 일이 다르다** —
            그 갈림은 `deadlockSentence` 가 들고 있다. */}
        <span className="ml-1.5 text-fg-muted">{deadlockSentence(chain, name, t)}</span>
      </div>
    );
  }

  const mine = chain.end === 'me';
  const unblocks = unblocksSentence(chain, t);
  return (
    <div
      data-testid="wait-chain"
      data-end={chain.end}
      data-unblocks={chain.unblocks}
      className={`mx-4 my-1 px-1 text-meta ${mine ? 'text-state-turn' : 'text-fg-muted'}`}
    >
      <span>{chainSentences(chain, name, t).join(' · ')}</span>
      {elapsed && <span className="ml-1 text-fg-subtle">· {elapsed}</span>}
      {/*
        **몇 개가 풀리는지가 사람이 답할 이유다.** 둘 이상일 때만 나온다 — 그 문턱은
        `unblocksSentence` 가 들고 있어(하나뿐이면 `null`) 인박스와 여기가 갈라지지 않는다.

        이어 붙이는 `—` 는 **화면의 것**이다. 사전에는 문장만 있다 — 같은 문장을 인박스는
        `· ` 뒤에 놓는다.
      */}
      {unblocks && <span className="ml-1 font-medium">— {unblocks}</span>}
    </div>
  );
}
