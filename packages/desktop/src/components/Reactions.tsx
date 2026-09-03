import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';

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
          className="rounded px-1 text-[11px] text-fg-muted hover:bg-surface-sunken"
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
      className="rounded-full border border-border px-1.5 text-[11px] text-fg-subtle hover:bg-surface-sunken"
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
            className={`rounded px-1 text-[11px] ${
              mine ? 'bg-accent-surface text-accent' : 'text-fg-subtle hover:bg-surface-sunken'
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

  const toggle = (emoji: string, on: boolean) => {
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  const nameOf = (id: string) => accounts[id]?.handle ?? '…';

  if (!message.reactions.length) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reactions">
      {message.reactions.map((r) => {
        const mine = myId !== null && r.accountIds.includes(myId);
        return (
          <button
            key={r.emoji}
            // 이모지 문자만으로는 스크린리더가 무엇인지 읽을 수 없다 — 누가 눌렀는지 함께 준다.
            aria-label={`${r.emoji} — ${r.accountIds.map(nameOf).join(', ')}`}
            aria-pressed={mine}
            className={`flex items-center gap-1 rounded-full border px-1.5 text-[11px] ${
              mine ? 'border-accent bg-accent-surface text-accent' : 'border-border bg-surface text-fg-muted'
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
