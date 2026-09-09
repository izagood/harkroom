import { readAskMeta, type AskAudience, type MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
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
  const accounts = useActiveStore((s) => s.accounts);
  const ask = readAskMeta(message.meta);
  if (!ask) return null;

  const answered = ask.answeredWith != null;
  /**
   * **답하지 않기로 했다**(2026-09-09). 고른 것이 없는 끝이다 — 답과 갈라 두는 이유는
   * 화면이 말할 것이 다르기 때문이다: 하나는 "이것으로 정해졌다", 다른 하나는 "이 물음은
   * 답 없이 닫혔다". 카드는 **지워지지 않는다** — 무엇을 물었는지는 기록이다.
   */
  const closed = ask.closedAt != null;
  const forMe = isForMe(ask.to, myId);
  /**
   * 누를 수 있는가. **답이 이미 있으면 아무도 못 누른다** — 기록은 남되 다시 고를 수는
   * 없다. 나에게 온 것이 아니면 읽히되 누를 수 없다(옵션에 `disabled` 가 붙는다).
   * 닫힌 물음도 같다 — 그만두기로 한 것을 되돌리는 것은 새 물음이다.
   */
  const canChoose = !answered && !closed && forMe;

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
      className={`mt-1.5 rounded-lg border ${
        // 강조는 **답을 기다리는 내 차례**에만 간다. 답이 끝난 카드는 기록이므로 강조를
        // 거둔다 — 안 그러면 끝난 스레드가 계속 나를 부른다.
        canChoose ? 'border-state-turn bg-accent-surface' : 'border-border-agent bg-surface-agent'
      }`}
    >
      <div className="flex items-baseline gap-2 px-3 pt-2">
        <span
          className={`text-meta font-semibold ${canChoose ? 'text-state-turn' : 'text-fg-agent'}`}
        >
          {headline(ask.to, myId, accounts, answered, closed, t)}
        </span>
        {answered && answeredByName && (
          <span className="text-meta text-fg-subtle">{t('speech.ask.answeredBy', { name: answeredByName })}</span>
        )}
        {!answered && closed && closedByName && (
          <span className="text-meta text-fg-subtle">{t('speech.ask.declinedBy', { name: closedByName })}</span>
        )}
      </div>
      {ask.prompt && <p className="px-3 pt-1 text-body text-fg-muted">{ask.prompt}</p>}

      <div className="flex flex-col gap-1 p-2">
        {ask.options.map((o) => {
          const isChosen = chosen?.id === o.id;
          // 답이 끝나면 고른 것만 남긴다 — 안 고른 선택지를 계속 보여 주면 무엇으로
          // 정해졌는지가 흐려진다. 기록은 남되 목록은 접힌다.
          if (answered && !isChosen) return null;
          // 닫힌 물음은 **선택지를 접는다** — 고른 것이 없으므로 남길 것이 없고, 남겨 두면
          // 아직 고를 수 있는 것처럼 보인다(누를 수는 없으니 더 나쁘다: 눌러 보고 안다).
          if (closed) return null;
          return (
            <button
              key={o.id}
              type="button"
              disabled={!canChoose}
              data-testid={`ask-option-${o.id}`}
              // 옵션은 **본문 크기**로 그린다 — 읽고 골라야 하는 글이지 라벨이 아니다.
              className={`rounded border px-2.5 py-1.5 text-left text-body ${
                canChoose
                  ? 'border-border bg-surface-raised hover:border-state-turn hover:bg-surface-hover'
                  : 'border-border-agent bg-transparent'
              }`}
              onClick={() => { void getController().answerAsk(message.id, o.id, message.channelId); }}
            >
              <span className={`font-medium ${canChoose ? 'text-fg' : 'text-fg-agent'}`}>{o.label}</span>
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
            className="rounded px-1 py-0.5 text-meta text-fg-subtle underline decoration-dotted
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
): string {
  if (answered) return t('speech.ask.decided');
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
