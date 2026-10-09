import { useState } from 'react';
import { readAskMeta, type AskAudience, type MessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { selectAccountNames } from '../lib/accountNames';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import type { Translate } from '../i18n';

/**
 * 선택 요청 카드 — 이 디자인 언어에서 **대화 안의 유일한 "상자"**다(상자 예산 1개).
 *
 * 지금까지 에이전트는 갈림길을 평문으로 쓰고 사람이 다시 타이핑해 답했다. 이 카드가
 * 그 왕복을 없앤다: 옵션이 고를 수 있는 형태로 렌더되고 클릭 한 번이 곧 답이다(규칙 05).
 *
 * ## 두 얼굴
 *
 * 같은 카드가 **수신자에 따라 다르게 대접받는다**(규칙 04). 나에게 온 것만 강조를 받고,
 * 에이전트끼리의 선택은 무채색으로 앉아 읽히기만 한다 — 진행을 막지만 나를 막지는 않기
 * 때문이다. 이 구별이 없으면 에이전트 셋이 도는 스레드는 상시 빨갛고, 빨강은 그 순간
 * 신호이기를 멈춘다.
 *
 * ## 모르는 형식은 그리지 않는다
 *
 * 판정은 `readAskMeta`(shared) 하나로 한다. 형식을 못 알아보면 `null` 을 돌려주고 이
 * 컴포넌트는 아무것도 그리지 않는다 — `MessageItem` 이 본문을 이미 그렸으므로 사람은
 * 평문으로 읽는다. **빈 상자는 "여기 뭔가 있다"는 거짓 신호다.**
 */
export function AskCard({ message }: { message: MessageRow }) {
  const t = useT();
  const myId = useActiveStore((s) => s.me?.id ?? null);
  // 이름 쪽만 구독한다 — 상태·아바타 이벤트에 행마다 다시 그려지지 않도록(`lib/accountNames`).
  const accounts = useActiveStore(selectAccountNames);
  const ask = readAskMeta(message.meta);
  // 카드를 닫은 사람 글(A′). 같은 채널 목록에서 찾는다 — 못 찾으면 인용 줄만 빠진다.
  // **같은 스레드의 지워지지 않은 글만** 인용한다: id 가 다른 스레드를 가리키거나 그 글이
  // 지워졌으면 인용 줄을 그리지 않는다(#1259 security 2b 확인 항목).
  const replyId = ask?.closedReason === 'replied' ? ask.replyMessageId ?? null : null;
  const replyBody = useActiveStore((s) => {
    if (!replyId) return null;
    const hit = s.messages[message.channelId]?.find((m) => m.id === replyId);
    if (!hit || hit.deletedAt) return null;
    const root = message.threadRootId ?? message.id;
    return (hit.threadRootId ?? hit.id) === root ? hit.body : null;
  });
  const [pickAnyway, setPickAnyway] = useState(false);
  if (!ask) return null;

  const answered = ask.answeredWith != null;
  /**
   * **답하지 않기로 했다**(2026-09-09). 고른 것이 없는 끝이다 — 답과 갈라 두는 이유는
   * 화면이 말할 것이 다르기 때문이다: 하나는 "이것으로 정해졌다", 다른 하나는 "이 물음은
   * 답 없이 닫혔다". 카드는 **지워지지 않는다** — 무엇을 물었는지는 기록이다.
   */
  const closed = ask.closedAt != null;
  /**
   * **글로 답했다**(A′, 2026-10-09). 사람이 카드를 누르지 않고 같은 스레드에 글을 써서 서버가
   * 닫은 카드다. 차례는 이미 물어본 쪽으로 넘어갔으므로 강조는 거두되, 고를 길은 남긴다
   * (「그래도 고르기」 — 서버는 이 사유로 닫힌 카드의 늦은 답을 받는다).
   */
  const replied = !answered && closed && ask.closedReason === 'replied';
  /** 물어본 쪽이 새 카드로 대신했다(`supersedes`). 한 줄로 접힌다 — 고를 것은 새 카드에 있다. */
  const superseded = !answered && closed && ask.closedReason === 'superseded';
  const forMe = isForMe(ask.to, myId);
  /**
   * 누를 수 있는가. **답이 이미 있으면 아무도 못 누른다** — 기록은 남되 다시 고를 수는
   * 없다. 나에게 온 것이 아니면 읽히되 누를 수 없다(옵션에 `disabled` 가 붙는다).
   * 닫힌 물음도 같다 — 그만두기로 한 것을 되돌리는 것은 새 물음이다.
   */
  const canChoose = !answered && !closed && forMe;
  // 늦게 고르기 — 펼친 뒤에만 누를 수 있다. 강조(내 차례)는 주지 않는다: 차례는 이미 넘어갔다.
  const canPickLate = replied && forMe && pickAnyway;

  const chosen = answered ? ask.options.find((o) => o.id === ask.answeredWith) : undefined;
  // 이름을 모르면 **이름 자리에 보통명사가 온다** — 그 낱말이 `common.someone` 에 있는
  // 이유이고, 조사는 번역기가 그것을 보고 고른다(`{name:이가}`).
  const answeredByName = ask.answeredBy
    ? (accounts[ask.answeredBy]?.handle ?? t('common.someone'))
    : null;
  const closedByName = ask.closedBy
    ? (accounts[ask.closedBy]?.handle ?? t('common.someone'))
    : null;

  /* 폭 상한을 여기서 다시 두지 않는다 — 부모(`MessageItem` 의 본문 열)가 이미 상한을 쥐고
     있고, 여기 `max-w-prose`(65ch)를 남기면 열을 넓혀도 이 카드만 옛 폭에 남아 한 화면에
     폭이 둘 선다(`messageWidth.test.tsx`). */
  return (
    <div
      data-testid="ask-card"
      data-for-me={forMe}
      data-answered={answered}
      data-closed={closed}
      data-closed-reason={closed && !answered ? (ask.closedReason ?? 'declined') : undefined}
      className={`mt-1.5 rounded-card border ${
        // 강조는 **답을 기다리는 내 차례**에만 간다. 답이 끝난 카드는 기록이므로 강조를
        // 거둔다 — 안 그러면 끝난 스레드가 계속 나를 부른다.
        canChoose ? 'border-state-turn bg-accent-surface' : 'border-border-agent bg-surface-agent'
      }`}
    >
      <div className="flex items-baseline gap-2 px-3 pt-2">
        <span
          className={`text-meta font-semibold ${canChoose ? 'text-state-turn' : 'text-fg-agent'}`}
        >
          {headline(ask.to, myId, accounts, answered, closed, t, ask.closedReason)}
        </span>
        {answered && answeredByName && (
          <span className="text-meta text-fg-subtle">{t('speech.ask.answeredBy', { name: answeredByName })}</span>
        )}
        {!answered && closed && !replied && !superseded && closedByName && (
          <span className="text-meta text-fg-subtle">{t('speech.ask.declinedBy', { name: closedByName })}</span>
        )}
        {replied && closedByName && <span className="text-meta text-fg-subtle">{closedByName}</span>}
      </div>
      {ask.prompt && !superseded && <p className="px-3 pt-1 text-body text-fg-muted">{ask.prompt}</p>}
      {replied && replyBody && (
        <p
          data-testid="ask-reply-quote"
          className="mx-3 mt-1.5 truncate border-l-2 border-border pl-2 text-meta text-fg-muted"
        >
          {quoteLine(replyBody)}
        </p>
      )}

      {replied && !pickAnyway && forMe && (
        <div className="px-2 pb-2 pt-1">
          <button
            type="button"
            data-testid="ask-pick-anyway"
            className="rounded-sm px-1 py-0.5 text-meta text-fg-subtle underline decoration-dotted
                       underline-offset-2 hover:bg-surface-hover hover:text-fg-muted"
            onClick={() => setPickAnyway(true)}
          >
            {t('speech.ask.pickAnyway', { n: ask.options.length })}
          </button>
        </div>
      )}
      <div className={`flex flex-col gap-1 ${closed && !canPickLate ? 'px-2 pb-1' : 'p-2'}`}>
        {ask.options.map((o) => {
          const isChosen = chosen?.id === o.id;
          // 답이 끝나면 고른 것만 남긴다 — 안 고른 선택지를 계속 보여 주면 무엇으로
          // 정해졌는지가 흐려진다. 기록은 남되 목록은 접힌다.
          if (answered && !isChosen) return null;
          // 닫힌 물음은 **선택지를 접는다** — 고른 것이 없으므로 남길 것이 없고, 남겨 두면
          // 아직 고를 수 있는 것처럼 보인다(누를 수는 없으니 더 나쁘다: 눌러 보고 안다).
          // 글로 답한 카드는 「그래도 고르기」를 펼쳤을 때만 다시 보인다.
          if (closed && !canPickLate) return null;
          return (
            <button
              key={o.id}
              type="button"
              disabled={!canChoose && !canPickLate}
              data-testid={`ask-option-${o.id}`}
              // 옵션은 **본문 크기**로 그린다 — 읽고 골라야 하는 글이지 라벨이 아니다.
              className={`rounded-row border px-2.5 py-1.5 text-left text-body ${
                canChoose || canPickLate
                  ? 'border-border bg-surface-raised hover:border-state-turn hover:bg-surface-hover'
                  : 'border-border-agent bg-transparent'
              }`}
              onClick={() => { void getController().answerAsk(message.id, o.id, message.channelId); }}
            >
              <span className={`font-medium ${canChoose || canPickLate ? 'text-fg' : 'text-fg-agent'}`}>{o.label}</span>
              {o.hint && <span className="ml-2 text-meta text-fg-subtle">{o.hint}</span>}
            </button>
          );
        })}
      </div>
      {/*
        **답하지 않는 길**(2026-09-09). 이것이 없으면 그 작업을 그만두기로 한 사람에게 남는
        수단이 **물음을 지우는 것**뿐이었고, 지우면 무엇을 물었는지까지 사라졌다. 턴을
        중단해도 이 물음은 그대로여서 대기 줄이 물어본 턴보다 오래 살았다.

        **선택지와 같은 무게로 그리지 않는다** — 이것은 여섯째 선택지가 아니라 이 물음을
        끝내는 다른 종류의 행동이다. 그래서 카드 바닥에 한 줄로, 밑줄만 두고 앉는다.
      */}
      {canChoose && (
        <div className="px-2 pb-2">
          <button
            type="button"
            data-testid="ask-decline"
            className="rounded-sm px-1 py-0.5 text-meta text-fg-subtle underline decoration-dotted
                       underline-offset-2 hover:bg-surface-hover hover:text-fg-muted"
            onClick={() => { void getController().closeAsk(message.id, message.channelId); }}
          >
            {t('speech.ask.decline')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 이 물음이 나를 막는가. `'human'` 은 **사람 아무나**이므로 사람인 나에게는 내 차례다 —
 * 특정인을 지목하고 싶으면 보내는 쪽이 `account` 로 싣는다.
 */
function isForMe(to: AskAudience, myId: string | null): boolean {
  if (!myId) return false;
  return to.kind === 'human' ? true : to.accountId === myId;
}

/** 머리글은 **누가 답해야 하는지**를 말한다. 그것이 이 카드가 답하는 유일한 질문이다. */
function headline(
  to: AskAudience,
  myId: string | null,
  accounts: Record<string, { handle: string } | undefined>,
  answered: boolean,
  closed: boolean,
  t: Translate,
  closedReason?: 'declined' | 'replied' | 'superseded',
): string {
  if (answered) return t('speech.ask.decided');
  if (closed && closedReason === 'replied') return t('speech.ask.replied');
  if (closed && closedReason === 'superseded') return t('speech.ask.superseded');
  // 답 없이 닫힌 물음. `decided` 를 쓸 수 없다 — 정해진 것이 없다.
  if (closed) return t('speech.ask.declined');
  if (isForMe(to, myId)) return t('speech.ask.pickOne');
  if (to.kind === 'account') {
    return t('speech.ask.agentPicks', {
      name: accounts[to.accountId]?.handle ?? t('speech.ask.unknownAgent'),
    });
  }
  return t('speech.ask.personPicks');
}

/**
 * 인용 한 줄 — 카드를 닫은 글의 첫 줄을 80자까지(designer 시안 6절). 멘션 토큰(`<@id>`)은
 * 화면이 이름으로 바꾸지 못하는 자리라 지운다 — 날 id 가 보이는 것보다 빠지는 편이 덜 틀리다.
 */
function quoteLine(body: string): string {
  const first = body.replace(/<@[0-9a-f-]{36}>\s*/g, '').split('\n').find((l) => l.trim() !== '') ?? '';
  const line = first.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
