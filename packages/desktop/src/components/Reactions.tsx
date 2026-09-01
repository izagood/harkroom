import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

/**
 * 피커에 올려 둘 이모지. 전체 이모지 검색은 별개 작업이고, 실제로 쓰이는 것은 소수다 —
 * 스크린샷의 👀·💬 가 여기 있어야 한다.
 */
const QUICK = ['👀', '💬', '👍', '🎉', '✅', '🔥', '🤔', '😄'];

export function Reactions({ message }: { message: MessageRow }) {
  const accounts = useAppStore((s) => s.accounts);
  const myId = useAppStore((s) => s.me?.id ?? null);
  const [picking, setPicking] = useState(false);

  const toggle = (emoji: string, on: boolean) => {
    setPicking(false);
    // 실패는 조용히 넘긴다 — 서버가 받아들인 뒤에만 화면이 바뀌므로 화면은 언제나 서버와 같다.
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  const nameOf = (id: string) => accounts[id]?.handle ?? '…';

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

      {picking ? (
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
      ) : (
        <button
          aria-label="Add reaction"
          // 리액션이 하나도 없을 때는 호버로만 드러낸다. opacity 로 숨기는 이유는
          // visibility:hidden 이 접근성 트리에서 요소를 지워 키보드 경로를 없애기 때문이다.
          className={`rounded-full border border-zinc-200 px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-100 ${
            message.reactions.length ? '' : 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100'
          }`}
          onClick={() => setPicking(true)}
        >
          ＋
        </button>
      )}
    </div>
  );
}
