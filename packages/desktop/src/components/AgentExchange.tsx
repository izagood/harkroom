import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { exchangeParticipants, exchangeConclusion } from '../lib/agentExchange';
import { MessageItem } from './MessageItem';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

/**
 * 에이전트 둘 사이의 주고받기를 **접힌 한 줄**로 그린다(규칙 04 · 계획 Task 5).
 *
 * `forge ↔ codex · 끝냈다 타입체크 통과 · 4번 주고받음 · 마지막 4:09`
 *
 * 이것이 없으면 스레드는 정확히 우리가 피하려던 그 로그가 된다 — 에이전트 둘이 열 번
 * 주고받으면 그 열 번이 그대로 흐르고, 사람이 읽어야 할 말이 그 사이에 묻힌다.
 *
 * ## 줄은 결론을 먼저 말한다(#488 C1)
 *
 * 처방: *"접힌 줄은 결론을 담는다. 둘이 주고받아 **무엇이 정해졌는지**가 접힘의 값이다.
 * 횟수는 그 뒤에 붙는 부수적인 숫자다."* 그전 줄은 `2번 주고받음 · 마지막 오후 12:57` 이라
 * **횟수뿐**이었고, 문서는 그것을 답글 스택의 이름 나열과 같은 문제로 짚었다 — *"열어야
 * 하나"에 답하지 않는다.*
 *
 * 결론은 `exchangeConclusion` 이 이미 있는 `meta` 에서 낸다. **횟수를 지우지 않는다** —
 * 순서를 바꾼 것이고, 그래서 결론이 없는 구간에서도 횟수는 그대로 남는다.
 *
 * **펼침은 기기의 속성이다** — 로컬 상태로만 두고 서버에 동기화하지 않는다. 내가 펼쳐 본
 * 것이 남의 화면에서도 펼쳐질 이유가 없다.
 *
 * 색은 강조가 아니라 `fg-agent`·`border-agent` 다. 진행을 막지만 나를 막지는 않으므로
 * 무채색이고, 회색이 아니라 채도 낮춘 청록인 이유는 '비활성'이 아니라 **남의 일**이기 때문이다.
 */
export function AgentExchange({ messages, onOpenDirectory, onOpenSettings, inThread = false }: {
  messages: MessageRow[];
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
  inThread?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const accounts = useActiveStore((s) => s.accounts);

  const names = exchangeParticipants(messages).map((id) => accounts[id]?.handle ?? '…');
  const last = messages[messages.length - 1]!;
  const lastTime = new Date(last.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const conclusion = exchangeConclusion(messages);

  if (open) {
    return (
      <div data-testid="agent-exchange" data-open="true">
        <button
          data-testid="agent-exchange-toggle"
          aria-expanded
          className="mx-4 my-0.5 rounded px-1 text-meta text-fg-agent hover:bg-surface-hover"
          onClick={() => setOpen(false)}
        >
          {names.join(' ↔ ')} · {t('speech.exchange.collapse')}
        </button>
        {/* 펼치면 **평소의 메시지 그대로** 보인다 — 접힘은 표시 단계의 일이고, 펼친 뒤에는
            다른 말과 같은 대접을 받아야 한다(별도 조판을 두면 어휘가 하나 더 늘어난다). */}
        <div className="border-l-2 border-border-agent">
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              inThread={inThread}
              onOpenDirectory={onOpenDirectory}
              onOpenSettings={onOpenSettings}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="agent-exchange" data-open="false" className="px-4 py-0.5">
      {/*
        **줄 전체가 손잡이다.** 문서: *"지금은 긴 메타 줄 맨 끝의 세 글자가 유일한
        손잡이다."* 실측하면 이 `<button>` 은 처음부터 줄 전체를 감쌌으므로 클릭 자체는
        되고 있었다 — 문서가 본 증상의 원인은 **`펼치기` 라는 글자**였다. 손잡이처럼
        보이는 세 글자가 줄 끝에 있으면 사람은 그것만 손잡이라고 배우고, 눌러 보지 않은
        나머지 줄은 눌리지 않는다고 믿는다. 그래서 그 세 글자를 **지웠다** — 줄 전체가
        손잡이인데 일부만 손잡이처럼 그리면 그것이 거짓 신호다.

        `w-full` 을 주는 것이 그 대신의 처방이다: hover 배경이 줄 끝까지 차서 **어디까지
        눌리는지**를 색이 말한다. 글자로 알려 주지 않고 면으로 알려 준다.
      */}
      <button
        data-testid="agent-exchange-toggle"
        aria-expanded={false}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-meta
                   text-fg-agent hover:bg-surface-hover"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-sm bg-border-agent" />
        <span className="shrink-0 font-medium">{names.join(' ↔ ')}</span>
        {conclusion ? (
          <>
            {/*
              머리말은 **결론의 종류**를 말한다 — `AskCard` 가 답한 카드에 쓰는 `정해졌다`
              와 `inboxRow` 가 보고에 쓰는 `끝냈다` 를 그대로 가져온다. 같은 사실을 세
              화면이 다른 말로 부르면 어휘가 그만큼 늘어난다.
            */}
            <span className="shrink-0 text-fg-subtle">
              · {t(conclusion.source === 'ask' ? 'speech.exchange.decided' : 'speech.exchange.finished')}
            </span>
            {/*
              결론만 `text-fg-muted` 다 — 이 줄에서 **읽으라고 있는 유일한 글자**이므로
              옆의 회색보다 한 단 진하다. 강조색은 아니다: 접힌 대화는 나를 막지 않고
              (막으면 `addressesHuman` 이 애초에 접지 않는다), 규칙 04 는 강조를 나를 막는
              것에만 쓴다.

              `truncate` 는 글자 수 상한(`EXCHANGE_CONCLUSION_MAX`) 뒤의 두 번째 겹이다 —
              좁은 스레드 패널에서 40 자도 넘치는 경우를 여기서 받는다. `min-w-0` 이
              없으면 flex 자식은 줄어들지 않아 `truncate` 가 듣지 않는다.
            */}
            <span data-testid="exchange-conclusion" className="min-w-0 truncate text-fg-muted">
              {conclusion.text}
            </span>
          </>
        ) : (
          /*
            결론이 없는 구간이 실제로 있다 — 서로 자리를 나누기만 하고 아무것도 정하지
            않은 경우다. 그때 본문 첫 줄을 결론처럼 싣지 않고 **정해진 것이 없다고
            말한다**: 이것도 "열어야 하나"에 대한 답이고(열 이유가 약하다), 마지막 발언을
            결론으로 내세우는 것보다 정직하다.
          */
          <span className="shrink-0 text-fg-subtle">· {t('speech.exchange.undecided')}</span>
        )}
        {/* 횟수와 시각은 **결론 뒤**다. 지우지 않는다 — 문서가 "부수적인 숫자"라고 한 것은
            없애라는 말이 아니라 앞자리를 내주라는 말이다. `ml-auto` 로 줄 끝에 붙여
            결론이 짧을 때도 두 숫자가 같은 자리에서 읽히게 한다. */}
        <span className="ml-auto shrink-0 text-fg-subtle">
          · {t('speech.exchange.count', { count: messages.length })}
        </span>
        {/* 시각은 `toLocaleTimeString` 이 그 언어로 낸다 — 사전은 앞의 낱말만 진다. */}
        <span className="shrink-0 text-fg-subtle">· {t('speech.exchange.last', { time: lastTime })}</span>
      </button>
    </div>
  );
}
