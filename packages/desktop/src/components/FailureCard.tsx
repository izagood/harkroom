import { readFailureMeta, type MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { TerminalChip } from './TerminalChip';

/**
 * 실패 카드 — 에이전트가 **스스로 못 끝냈다**(규칙 03).
 *
 * 여덟 가지 말 중 유일하게 에이전트가 먼저 사람을 부르는 말이고, 그래서 **언제나 강조를
 * 받는다.** 수신자를 따질 필요가 없다: 실패의 수신자는 언제나 사람이다.
 *
 * 강조는 `state-stuck`(= danger 축)이다. `state-turn`(주황)과 갈라 두는 이유는 뜻이 다르기
 * 때문이다 — "네 차례다"와 "망가졌다"는 사람이 해야 할 일이 다르다.
 *
 * ## 고치는 경로가 같은 자리에
 *
 * 디자인 문서의 요구다. 실패를 알리기만 하고 다음 수를 사람이 찾아 헤매게 하면 개입 비용이
 * 올라가고, 사람은 스레드 대신 터미널로 도망간다(규칙 05).
 *
 * - **터미널** — `TerminalChip` 을 그대로 재사용한다. 소유자가 아니면 스스로 렌더하지 않는다
 * - **다시 부르기** — `retryable` 일 때만. 눌러도 안 되는 버튼은 없는 문을 그리는 것이다(규칙 06)
 *
 * 형식을 못 알아보면 아무것도 그리지 않는다 — `MessageItem` 이 본문을 이미 그렸으므로
 * 사람은 평문으로 읽는다. 빈 상자는 거짓 신호다.
 */
export function FailureCard({ message, inThread = false }: {
  message: MessageRow;
  /** 스레드 안이면 작성창의 scope 가 다르다 — 채널 작성창을 채우면 사람이 그것을 못 본다. */
  inThread?: boolean;
}) {
  const author = useActiveStore((s) => s.accounts[message.authorId]);
  const setDraft = useActiveStore((s) => s.setDraft);
  const failure = readFailureMeta(message.meta);
  if (!failure) return null;

  return (
    <div
      data-testid="failure-card"
      data-retryable={failure.retryable}
      className="mt-1.5 max-w-prose rounded-lg border border-state-stuck bg-danger-surface"
    >
      <div className="flex items-baseline gap-2 px-3 pt-2">
        <span className="text-[11px] font-semibold text-state-stuck">끝내지 못했다</span>
        {failure.what && <span className="text-[11px] text-fg-muted">{failure.what}</span>}
      </div>
      {/* 이유는 **사람이 읽는 말**이다 — 스택트레이스가 아니다. 자세한 것은 터미널이 답한다. */}
      {failure.reason && <p className="px-3 pt-1 text-[13px] text-fg-muted">{failure.reason}</p>}

      <div className="flex items-center gap-2 p-2 pt-1.5">
        <TerminalChip account={author} message={message} />
        {/*
          다시 부르기는 **작성창을 채우는 방식**으로 둔다(완료 보고의 다음 제안 칩과 같은 규약):
          누르자마자 보내면 사람이 무엇이 나갈지 보지 못한 채 러너가 또 돈다. 한 번의 확인을 남긴다.
        */}
        {failure.retryable && author && (
          <button
            data-testid="failure-retry"
            className="rounded border border-border bg-surface-raised px-2 py-0.5 text-[11px]
                       font-medium text-fg hover:bg-surface-hover"
            onClick={() => setDraft(
              // 작성창의 scope 는 채널이면 채널 id, 스레드면 `thread:<rootId>` 다
              // (`ChannelPane`·`ThreadPanel` 의 `scopeKey`). 여기서 다른 식을 쓰면 채운 초안이
              // 아무 작성창에도 안 나타난다.
              inThread ? `thread:${message.threadRootId ?? message.id}` : message.channelId,
              `@${author.handle} 다시 해 줘`,
            )}
          >
            다시 부르기
          </button>
        )}
      </div>
    </div>
  );
}
