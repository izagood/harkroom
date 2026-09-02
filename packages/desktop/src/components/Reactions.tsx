import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

/**
 * 피커에 올려 둘 이모지. 전체 이모지 검색은 별개 작업이고, 실제로 쓰이는 것은 소수다 —
 * 스크린샷의 👀·💬 가 여기 있어야 한다.
 */
const QUICK = ['👀', '💬', '👍', '🎉', '✅', '🔥', '🤔', '😄'];

/**
 * 리액션을 **추가하는** 표면. `MessageItem` 의 호버 툴바가 이것을 쓴다(#121).
 *
 * 칩(`Reactions`)과 나눠 둔 이유: 추가 버튼이 툴바로 올라가면서 두 곳에 같은 것이 생기면
 * 접근성 이름(`Add reaction`)이 중복돼 스크린리더와 테스트가 어느 것인지 가리지 못한다
 * (초판이 그렇게 복사돼 리액션 테스트 4개가 깨졌다). QUICK 목록과 토글 규칙은 여기 하나다.
 */
export function ReactionPicker({ message }: { message: MessageRow }) {
  const myId = useAppStore((s) => s.me?.id ?? null);
  const [picking, setPicking] = useState(false);

  const toggle = (emoji: string, on: boolean) => {
    setPicking(false);
    // 실패는 조용히 넘긴다 — 서버가 받아들인 뒤에만 화면이 바뀌므로 화면은 언제나 서버와 같다.
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  if (picking) {
    return (
      <div className="flex items-center gap-0.5 rounded-full border border-zinc-300 bg-white px-1 shadow-sm">
        {QUICK.map((e) => (
          <button
            key={e}
            aria-label={e}
            className="rounded px-1 hover:bg-zinc-100"
            onClick={() => toggle(e, !message.reactions.find((r) => r.emoji === e)?.accountIds.includes(myId ?? ''))}
          >
            {e}
          </button>
        ))}
        <button
          aria-label="Close reaction picker"
          className="rounded px-1 text-[11px] text-zinc-400 hover:bg-zinc-100"
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
      className="rounded-full border border-zinc-200 px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-100"
      onClick={() => setPicking(true)}
    >
      ＋
    </button>
  );
}

/** 달린 리액션 칩. 추가는 `ReactionPicker`(툴바)가 맡는다 — 같은 것을 두 곳에 두지 않는다. */
export function Reactions({ message }: { message: MessageRow }) {
  const accounts = useAppStore((s) => s.accounts);
  const myId = useAppStore((s) => s.me?.id ?? null);

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
              mine ? 'border-indigo-400 bg-indigo-50 text-indigo-800' : 'border-zinc-200 bg-zinc-50 text-zinc-600'
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
