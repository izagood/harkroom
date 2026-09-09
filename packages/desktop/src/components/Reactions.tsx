import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import { reactorNames } from '../lib/reactionNames';

/**
 * 피커에 올려 둘 이모지. 전체 이모지 검색은 별개 작업이고, 실제로 쓰이는 것은 소수다 —
 * 스크린샷의 👀·💬 가 여기 있어야 한다.
 *
 * #145: 인라인 버튼(툴바에 바로 보이는 3개)은 👀💬 를 제외한다 — 그 둘은 에이전트 상태 신호로 쓰이고,
 * 사람이 그걸 흉내 내면 신호의 의미가 무너진다.
 */
const QUICK = ['👀', '💬', '👍', '🎉', '✅', '🔥', '🤔', '😄'];

/**
 * 에이전트가 상태 신호로 쓰는 이모지. 인라인 버튼에서 제외하는 근거가 이 목록이다.
 * #144 를 보라 — 사람이 이것을 흉내 내면 신호의 의미가 무너진다.
 */
export const STATUS_SIGNAL_EMOJI = ['👀', '💬'];

/**
 * 인라인에 낼 3개를 **규칙으로** 고른다. 인덱스로 자르면(`QUICK.slice(2, 5)`) QUICK 의
 * 순서가 바뀌는 순간 상태 신호 이모지가 조용히 인라인으로 새어 들어온다 — 바로 위
 * 주석이 금지한 것이 그것이다. 규칙을 코드로 적으면 순서가 바뀌어도 성립한다.
 */
export function pickInline(quick: string[]): string[] {
  return quick.filter((e) => !STATUS_SIGNAL_EMOJI.includes(e)).slice(0, 3);
}

const INLINE = pickInline(QUICK);

/**
 * 리액션을 **추가하는** 표면. `MessageItem` 의 호버 툴바가 이것을 쓴다(#121).
 *
 * 칩(`Reactions`)과 나눠 둔 이유: 추가 버튼이 툴바로 올라가면서 두 곳에 같은 것이 생기면
 * 접근성 이름(`Add reaction`)이 중복돼 스크린리더와 테스트가 어느 것인지 가리지 못한다
 * (초판이 그렇게 복사돼 리액션 테스트 4개가 깨졌다). QUICK 목록과 토글 규칙은 여기 하나다.
 */
export function ReactionPicker({ message }: { message: MessageRow }) {
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const [picking, setPicking] = useState(false);

  const toggle = (emoji: string, on: boolean) => {
    setPicking(false);
    // 실패는 조용히 넘긴다 — 서버가 받아들인 뒤에만 화면이 바뀌므로 화면은 언제나 서버와 같다.
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  if (picking) {
    return (
      <div className="flex items-center gap-0.5 rounded-full border border-border bg-surface-raised px-1 shadow-sm">
        {QUICK.map((e) => (
          <button
            key={e}
            aria-label={e}
            className="rounded px-1 hover:bg-surface-sunken"
            onClick={() => toggle(e, !message.reactions.find((r) => r.emoji === e)?.accountIds.includes(myId ?? ''))}
          >
            {e}
          </button>
        ))}
        <button
          aria-label="Close reaction picker"
          className="rounded px-1 text-meta text-fg-muted hover:bg-surface-sunken"
          onClick={() => setPicking(false)}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <button
      aria-label="Add reaction"
      className="rounded-full border border-border px-1.5 text-meta text-fg-subtle hover:bg-surface-sunken"
      onClick={() => setPicking(true)}
    >
      ＋
    </button>
  );
}

/**
 * #145: 툴바에 바로 보이는 인라인 이모지 버튼 3개.
 * 👀💬는 에이전트 상태 신호로 쓰이므로, 사람이 누를 수 있는 인라인 버튼에 포함하지 않는다.
 * 토글 가능하고, 내가 누른 리액션은 눌린 상태로 표시한다.
 */
export function InlineReactionButtons({ message }: { message: MessageRow }) {
  const myId = useActiveStore((s) => s.me?.id ?? null);

  const toggle = (emoji: string, on: boolean) => {
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  return (
    <>
      {INLINE.map((emoji) => {
        const existing = message.reactions.find((r) => r.emoji === emoji);
        const mine = myId !== null && existing?.accountIds.includes(myId);
        return (
          <button
            key={emoji}
            // 이름을 피커의 이모지 버튼(`aria-label={e}`)과 **구분**한다. 같으면 피커를 연
            // 순간 같은 접근 가능한 이름이 둘이 되어 스크린리더와 테스트가 어느 것인지
            // 가리지 못한다 — 이 파일 위쪽 주석이 기록한 그 사고다(테스트 4개가 깨졌다).
            // 눌림 여부는 이름이 아니라 `aria-pressed` 가 전한다. 이름은 상태에 따라
            // 바뀌지 않아야 포커스가 그 버튼에 머문 채로도 읽히는 이름이 흔들리지 않는다.
            aria-label={`React with ${emoji}`}
            aria-pressed={mine}
            className={`rounded px-1 text-meta ${
              mine ? 'bg-surface-sunken font-medium text-fg' : 'text-fg-subtle hover:bg-surface-sunken'
            }`}
            onClick={() => toggle(emoji, !mine)}
          >
            {emoji}
          </button>
        );
      })}
    </>
  );
}

/** 달린 리액션 칩. 추가는 `ReactionPicker`(툴바)가 맡는다 — 같은 것을 두 곳에 두지 않는다. */
export function Reactions({ message }: { message: MessageRow }) {
  const accounts = useActiveStore((s) => s.accounts);
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const t = useT();

  const toggle = (emoji: string, on: boolean) => {
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  /**
   * **모르는 계정에 `null` 을 돌려준다.** 앞판은 `'…'` 를 돌려줬는데, 그러면 목록에
   * 이름처럼 생긴 자리가 서서 사람이 그것을 이름으로 읽는다 — 그 자리에 낱말
   * (`reactions.unknown`)을 넣을 판단은 `reactorNames` 에 있다.
   *
   * 핸들이 아니라 `displayName` 을 앞에 두는 이유: 이 줄은 **사람이 읽는 이름**을 묻는
   * 자리다(`@` 로 부르는 자리가 아니다). 이름줄·디렉터리가 이미 그 이름을 그리므로
   * 툴팁만 핸들을 말하면 같은 사람을 두 이름으로 부르게 된다. 에이전트는 둘이 같다.
   */
  const nameOf = (id: string) => {
    const a = accounts[id];
    if (!a) return null;
    return a.displayName || a.handle;
  };

  if (!message.reactions.length) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reactions">
      {message.reactions.map((r) => {
        const mine = myId !== null && r.accountIds.includes(myId);
        // 호버(`title`)와 스크린리더(`aria-label`)가 **같은 목록**을 말한다. 갈라 두면
        // 한쪽만 고쳐지고, 그러면 눈으로 본 것과 읽힌 것이 다르다.
        const who = reactorNames(r.accountIds, nameOf, myId, t);
        return (
          <button
            key={r.emoji}
            data-testid={`reaction-${r.emoji}`}
            data-mine={mine ? 'true' : 'false'}
            /*
              **호버로 누가 달았는지 보여 준다**(2026-09-09).

              칩에 이모지와 수만 있던 동안 화면에는 그 수가 누구인지 알 방법이 아예
              없었다 — `👀`·`💬` 는 "누가 이 말을 읽었나"가 신호의 뜻 전부인데
              (`STATUS_SIGNAL_EMOJI`) 화면은 몇 명인지만 말했다.

              문구를 문장으로 짜지 않고 **이름 목록만** 두는 이유: 이모지는 칩에 이미
              그려져 있으므로 문장은 그것을 한 번 더 말하는 것이고, `title` 은 OS 가
              그리는 평문이라 길어지면 우리가 접을 수 없다. 호버가 묻는 것은 "누구"다.
            */
            title={who}
            // 이모지 문자만으로는 스크린리더가 무엇인지 읽을 수 없다 — 누가 눌렀는지 함께 준다.
            aria-label={`${r.emoji} — ${who}`}
            aria-pressed={mine}
            /*
              **내가 단 것은 선으로도 구별한다**(2026-09-09, 요청자 jaebin).

              앞판은 면과 굵기만 갈랐다(#488 B2: *"테두리는 양쪽이 같다 — 선까지 갈라
              두면 칩이 셋만 붙어도 줄이 시끄러워진다"*). 실사용에서 그 구별이 안 읽혔다:
              `bg-surface-sunken` 과 `bg-surface` 는 면 한 단계 차이라, 칩이 본문 아래
              작게 붙어 있으면 내가 누른 것인지 알아보려고 **눌러 보게 된다** — 그리고
              누르면 취소된다.

              **선에만 `border-accent-brand` 를 쓰고 면·글자에는 강조를 안 쓴다.** 그
              토큰이 `index.css` 에서 *"글자를 얹지 않는 자리에만 쓴다 —
              선(`border-accent-brand`), 상태 점"* 으로 정의된 자리다. 강조 예산(#488 B2)이
              걱정한 것은 채운 면과 글자이고 `accentBudget.test.tsx` 가 그 둘을 계속
              막는다. 선은 칩이 몇 개 붙든 한 겹이므로 "줄이 시끄러워진다"는 그 걱정에
              닿지 않는다.
            */
            className={`flex items-center gap-1 rounded-full border px-1.5 text-meta ${
              mine
                ? 'border-accent-brand bg-surface-sunken font-medium text-fg'
                : 'border-border bg-surface text-fg-muted'
            }`}
            onClick={() => toggle(r.emoji, !mine)}
          >
            <span>{r.emoji}</span>
            <span>{r.accountIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}
