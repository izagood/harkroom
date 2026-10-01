import { readFailureMeta, type MessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { TerminalChip } from './TerminalChip';
import { useT } from '../i18n/useT';
import { getController } from '../state/controller';
import { threadRowFor } from '../lib/threadModels';

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
  const t = useT();
  const author = useActiveStore((s) => s.accounts[message.authorId]);
  const setDraft = useActiveStore((s) => s.setDraft);
  const failure = readFailureMeta(message.meta);
  const rootId = message.threadRootId ?? message.id;
  // 이 스레드에 그 에이전트의 모델 지정이 살아 있나(079). 있으면 실패 원인일 수 있다 — 하네스가
  // 그 모델을 거절했으면 러너가 재시도하지 않고 여기로 온다(결정 6).
  const modelRow = useActiveStore((s) => threadRowFor(s.threadAgentModels[rootId], message.authorId));
  if (!failure) return null;
  const scope = inThread ? `thread:${rootId}` : message.channelId;

  /* 폭 상한을 여기서 다시 두지 않는다 — 부모(`MessageItem` 의 본문 열)가 이미 상한을 쥐고
     있고, 여기 `max-w-prose`(65ch)를 남기면 열을 넓혀도 이 카드만 옛 폭에 남아 한 화면에
     폭이 둘 선다(`messageWidth.test.tsx`). */
  return (
    <div
      data-testid="failure-card"
      data-retryable={failure.retryable}
      className="mt-1.5 rounded-lg border border-state-stuck bg-danger-surface"
    >
      <div className="flex items-baseline gap-2 px-3 pt-2">
        <span className="text-meta font-semibold text-state-stuck">{t('speech.failure.title')}</span>
        {failure.what && <span className="text-meta text-fg-muted">{failure.what}</span>}
      </div>
      {/* 이유는 **사람이 읽는 말**이다 — 스택트레이스가 아니다. 자세한 것은 터미널이 답한다. */}
      {failure.reason && <p className="px-3 pt-1 text-body text-fg-muted">{failure.reason}</p>}

      <div className="flex items-center gap-2 p-2 pt-1.5">
        <TerminalChip account={author} message={message} />
        {/*
          다시 부르기는 **작성창을 채우는 방식**으로 둔다(완료 보고의 다음 제안 칩과 같은 규약):
          누르자마자 보내면 사람이 무엇이 나갈지 보지 못한 채 러너가 또 돈다. 한 번의 확인을 남긴다.
        */}
        {failure.retryable && author && (
          <button
            data-testid="failure-retry"
            className="rounded border border-border bg-surface-raised px-2 py-0.5 text-meta
                       font-medium text-fg hover:bg-surface-hover"
            onClick={() => setDraft(
              // 작성창의 scope 는 채널이면 채널 id, 스레드면 `thread:<rootId>` 다
              // (`ChannelPane`·`ThreadPanel` 의 `scopeKey`). 여기서 다른 식을 쓰면 채운 초안이
              // 아무 작성창에도 안 나타난다.
              inThread ? `thread:${message.threadRootId ?? message.id}` : message.channelId,
              // **초안이지 화면 문구가 아니다** — 사람이 보내기 전에 읽고 고칠 글이라
              // 사전에서도 부탁의 말투를 진다.
              t('speech.failure.retryDraft', { handle: author.handle }),
            )}
          >
            {t('speech.failure.callAgain')}
          </button>
        )}
        {/*
          **기본으로 되돌리고 다시 부르기**(결정 6 · designer 구체화). 버튼 하나로 묶는다 — 되돌리기만
          두면 사람은 다시 부르는 것을 잊고, 다시 부르기만 두면 같은 모델로 또 실패한다. 다시 부르기는
          위 버튼과 같은 규약이다: 보내지 않고 작성창만 채운다.
        */}
        {modelRow && !modelRow.stale && author && (
          <button
            data-testid="failure-reset-model"
            className="rounded border border-border bg-surface-raised px-2 py-0.5 text-meta
                       font-medium text-fg hover:bg-surface-hover"
            onClick={() => {
              void getController().setThreadAgentModel(message.channelId, rootId, message.authorId, null, null)
                .then(() => setDraft(scope, t('speech.failure.retryDraft', { handle: author.handle })))
                .catch(() => { /* 실패하면 칩이 옛 값을 그대로 보여 준다 — 사람이 칩에서 다시 고친다 */ });
            }}
          >
            {t('failure.resetModelAndRetry')}
          </button>
        )}
      </div>
    </div>
  );
}
