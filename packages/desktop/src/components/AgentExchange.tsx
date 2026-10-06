import { useEffect, useState } from 'react';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import {
  exchangeParticipants, exchangeConclusion, exchangeLastLine, isSpeech,
} from '../lib/agentExchange';
import type { Slot } from '../lib/progressGroup';
import { elapsedMs } from '../lib/progressGroup';
import { selectAccountNames } from '../lib/accountNames';
import { displayBody } from '../lib/mention';
import { durationLabel } from '../lib/time';
import { useMinuteTick } from '../lib/useMinuteTick';
import { MessageItem } from './MessageItem';
import { ProgressRow } from './ProgressRow';
import type { SectionId } from './settings/sections';
import { useT, useLocale } from '../i18n/useT';
import { stampLabel } from '../lib/day';

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
const NO_TEAMS_FALLBACK: never[] = [];

export function AgentExchange({ messages, items, onOpenDirectory, onOpenSettings, inThread = false }: {
  /** 구간의 말(예약 줄 포함). 횟수·참여자·마지막 말은 이 가운데 **말**만 센다(`isSpeech`). */
  messages: MessageRow[];
  /**
   * 구간의 자리 전부 — 진행 묶음까지 원래 순서로(`groupAgentExchanges` 가 낸다). 없으면
   * `messages` 만으로 그린다(견본 화면처럼 진행이 없는 자리).
   */
  items?: Slot[];
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
  inThread?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  /**
   * **강조 점프(saved·검색·링크)의 대상이 이 안에 있으면 펼친다**(2026-10-01, Saved 클릭 이동이
   * 중간에 멈춤 — 원인 3). 접힌 줄은 `MessageItem` 을 그리지 않으므로 그 말의 강조도
   * `scrollIntoView` 도 일어나지 않았다 — 점프가 아무 데도 닿지 않고 패널은 열 때 간 바닥에
   * 남았다. 에이전트 답을 담아 두는 일이 많고, 그 답은 흔히 이 접힌 구간 안에 있다.
   *
   * 고르는 값은 불리언이라 다른 강조·스토어 변화에는 다시 그려지지 않는다. 처음부터 강조된
   * 채로 마운트되면(창 밖에서 들어온 줄) 첫 렌더부터 펼친다 — 접힌 한 프레임을 건너뛴다.
   * 강조가 풀려도 **다시 접지 않는다** — 사람은 아직 그것을 읽는 중이고, 접고 펴는 것은
   * 그 뒤로 사람의 손이다.
   */
  const slots: Slot[] = items ?? messages.map((m) => ({ kind: 'message' as const, message: m }));
  const holdsHighlight = useActiveStore((s) =>
    s.highlightedMessageId !== null && slots.some((it) => (it.kind === 'message'
      ? it.message.id === s.highlightedMessageId
      : it.messages.some((m) => m.id === s.highlightedMessageId))));
  const [open, setOpen] = useState(holdsHighlight);
  useEffect(() => { if (holdsHighlight) setOpen(true); }, [holdsHighlight]);
  const accounts = useActiveStore((s) => s.accounts);
  const names = useActiveStore(selectAccountNames);
  const groups = useActiveStore((s) => s.groups);
  const teams = useActiveStore((s) => s.teams) ?? NO_TEAMS_FALLBACK;

  const speech = messages.filter(isSpeech);
  const participants = exchangeParticipants(messages).map((id) => accounts[id]?.handle ?? '…');
  // 시각도 **마지막 말**의 것이다 — 뒤에 붙은 예약 줄이 "마지막"을 끌고 가지 않게.
  const last = speech[speech.length - 1] ?? messages[messages.length - 1]!;
  const lastTime = stampLabel(last.createdAt, locale);
  const conclusion = exchangeConclusion(messages);
  const lastLine = conclusion ? null : exchangeLastLine(messages, (m) => displayBody(m, names, groups, teams));
  /**
   * 구간 안에서 **아직 도는** 진행(판정 ③). 끝난 진행은 접힌 줄에 흔적을 남기지 않는다 —
   * 펼치면 원래 자리에 보인다. 도는 것만 말하는 이유: 그것이 "지금 기다리는 중인가"에 대한
   * 답이고, 끝난 진행 줄 셋은 그 답에 보탤 것이 없다.
   */
  const running = slots.flatMap((it) => (it.kind === 'progress' && it.endedAt === null ? [it] : []));
  // 칩의 「N분」도 `ProgressRow` 와 같은 틱으로 간다. 펼친 뒤에는 진행 줄이 스스로 구독한다.
  useMinuteTick(!open && running.length > 0);

  function runningChip(first: MessageRow, handle: string): string {
    const ms = elapsedMs(first.createdAt, Date.now());
    return ms === null
      ? t('speech.exchange.running', { handle })
      : t('speech.exchange.runningFor', { handle, duration: durationLabel(ms, locale, 'coarse') });
  }

  if (open) {
    return (
      <div data-testid="agent-exchange" data-open="true">
        <button
          data-testid="agent-exchange-toggle"
          aria-expanded
          className="mx-4 my-0.5 rounded-sm px-1 text-meta text-fg-agent hover:bg-surface-hover"
          onClick={() => setOpen(false)}
        >
          {participants.join(' ↔ ')} · {t('speech.exchange.collapse')}
        </button>
        {/* 펼치면 **평소의 메시지 그대로** 보인다 — 접힘은 표시 단계의 일이고, 펼친 뒤에는
            다른 말과 같은 대접을 받아야 한다(별도 조판을 두면 어휘가 하나 더 늘어난다). */}
        <div className="border-l-2 border-border-agent">
          {/* 진행은 원래 자리에 **평소의 진행 줄** 그대로 선다(판정 ③) — 따로 조판하지 않는다. */}
          {slots.map((it) => (it.kind === 'progress'
            ? <ProgressRow key={it.messages[0]!.id} messages={it.messages} endedAt={it.endedAt} />
            : (
              <MessageItem
                key={it.message.id}
                message={it.message}
                inThread={inThread}
                onOpenDirectory={onOpenDirectory}
                onOpenSettings={onOpenSettings}
              />
            )))}
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
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-meta
                   text-fg-agent hover:bg-surface-hover"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-sm bg-border-agent" />
        <span className="shrink-0 font-medium">{participants.join(' ↔ ')}</span>
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
        ) : lastLine && (
          /*
            결론이 없으면 **마지막 말의 첫 줄**을 `handle: 첫 줄` 로 싣는다(2026-10-06, designer
            판정 ②). 예전에는 「아직 정해진 것 없음」이었는데, 에이전트가 거의 `message.post`
            로만 말해서 접힌 줄 거의 전부가 그 문구였다 — "열어야 하나"에 아무것도 답하지
            못했다. 동사 머리말을 붙이지 않는 것이 결론과의 경계다: 이름과 글만 있으면
            "정해졌다"로 읽히지 않는다. 색은 결론과 같다(이름은 subtle, 글은 muted).
          */
          <>
            <span className="shrink-0 text-fg-subtle">
              · {accounts[lastLine.authorId]?.handle ?? '…'}:
            </span>
            <span data-testid="exchange-last-line" className="min-w-0 truncate text-fg-muted">
              {'text' in lastLine
                ? lastLine.text
                : t('speech.exchange.attachments', { count: lastLine.attachments })}
            </span>
          </>
        )}
        {/* 횟수와 시각은 **결론 뒤**다. 지우지 않는다 — 문서가 "부수적인 숫자"라고 한 것은
            없애라는 말이 아니라 앞자리를 내주라는 말이다. `ml-auto` 로 줄 끝에 붙여
            결론이 짧을 때도 두 숫자가 같은 자리에서 읽히게 한다. */}
        {/*
          **아직 도는 진행이 있을 때만** 칩 하나(판정 ③). 점은 `ProgressRow` 와 같은
          `state-running` 이다 — 같은 상태를 두 자리가 같은 색으로 말한다. 여럿이면 이름 대신
          수로 합친다: 칩이 이름을 줄줄이 늘어놓으면 참여자 줄과 겹쳐 읽힌다.
        */}
        {running.length > 0 && (
          <span data-testid="exchange-running" className="ml-auto flex shrink-0 items-center gap-1 text-fg-muted">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-state-running" />
            {running.length === 1
              ? runningChip(running[0]!.messages[0]!, accounts[running[0]!.messages[0]!.authorId]?.handle ?? '…')
              : t('speech.exchange.runningMany', { count: running.length })}
          </span>
        )}
        {/* 횟수는 **말만** 센다 — 진행·예약 줄은 주고받은 말이 아니다(판정 ③). */}
        <span className={`${running.length > 0 ? '' : 'ml-auto '}shrink-0 text-fg-subtle`}>
          · {t('speech.exchange.count', { count: speech.length })}
        </span>
        {/* 시각은 `stampLabel` 이 그 언어로 낸다 — 사전은 앞의 낱말만 진다. */}
        <span className="shrink-0 text-fg-subtle">· {t('speech.exchange.last', { time: lastTime })}</span>
      </button>
    </div>
  );
}
