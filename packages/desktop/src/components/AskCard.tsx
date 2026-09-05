import { readAskMeta, type AskAudience, type MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';

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
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const accounts = useActiveStore((s) => s.accounts);
  const ask = readAskMeta(message.meta);
  if (!ask) return null;

  const answered = ask.answeredWith != null;
  const forMe = isForMe(ask.to, myId);
  /**
   * 누를 수 있는가. **답이 이미 있으면 아무도 못 누른다** — 기록은 남되 다시 고를 수는
   * 없다. 나에게 온 것이 아니면 읽히되 누를 수 없다(옵션에 `disabled` 가 붙는다).
   */
  const canChoose = !answered && forMe;

  const chosen = answered ? ask.options.find((o) => o.id === ask.answeredWith) : undefined;
  const answeredByName = ask.answeredBy
    ? (accounts[ask.answeredBy]?.handle ?? '누군가')
    : null;

  return (
    <div
      data-testid="ask-card"
      data-for-me={forMe}
      data-answered={answered}
      className={`mt-1.5 max-w-prose rounded-lg border ${
        // 강조는 **답을 기다리는 내 차례**에만 간다. 답이 끝난 카드는 기록이므로 강조를
        // 거둔다 — 안 그러면 끝난 스레드가 계속 나를 부른다.
        canChoose ? 'border-state-turn bg-accent-surface' : 'border-border-agent bg-surface-agent'
      }`}
    >
      <div className="flex items-baseline gap-2 px-3 pt-2">
        <span
          className={`text-[11px] font-semibold ${canChoose ? 'text-state-turn' : 'text-fg-agent'}`}
        >
          {headline(ask.to, myId, accounts, answered)}
        </span>
        {answered && answeredByName && (
          <span className="text-[11px] text-fg-subtle">{answeredByName} 이(가) 골랐다</span>
        )}
      </div>
      {ask.prompt && <p className="px-3 pt-1 text-[13px] text-fg-muted">{ask.prompt}</p>}

      <div className="flex flex-col gap-1 p-2">
        {ask.options.map((o) => {
          const isChosen = chosen?.id === o.id;
          // 답이 끝나면 고른 것만 남긴다 — 안 고른 선택지를 계속 보여 주면 무엇으로
          // 정해졌는지가 흐려진다. 기록은 남되 목록은 접힌다.
          if (answered && !isChosen) return null;
          return (
            <button
              key={o.id}
              type="button"
              disabled={!canChoose}
              data-testid={`ask-option-${o.id}`}
              // 옵션은 **본문 크기**로 그린다 — 읽고 골라야 하는 글이지 라벨이 아니다.
              className={`rounded border px-2.5 py-1.5 text-left text-[13px] ${
                canChoose
                  ? 'border-border bg-surface-raised hover:border-state-turn hover:bg-surface-hover'
                  : 'border-border-agent bg-transparent'
              }`}
              onClick={() => { void getController().answerAsk(message.id, o.id, message.channelId); }}
            >
              <span className={`font-medium ${canChoose ? 'text-fg' : 'text-fg-agent'}`}>{o.label}</span>
              {o.hint && <span className="ml-2 text-[11px] text-fg-subtle">{o.hint}</span>}
            </button>
          );
        })}
      </div>
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
): string {
  if (answered) return '정해졌다';
  if (isForMe(to, myId)) return '골라 줘';
  if (to.kind === 'account') return `${accounts[to.accountId]?.handle ?? '다른 에이전트'} 가 고른다`;
  return '사람이 고른다';
}
