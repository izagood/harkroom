import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { exchangeParticipants } from '../lib/agentExchange';
import { MessageItem } from './MessageItem';
import type { SectionId } from './settings/sections';

/**
 * 에이전트 둘 사이의 주고받기를 **접힌 한 줄**로 그린다(규칙 04 · 계획 Task 5).
 *
 * `forge ↔ codex · 4번 주고받음 · 마지막 4:09 · 펼치기`
 *
 * 이것이 없으면 스레드는 정확히 우리가 피하려던 그 로그가 된다 — 에이전트 둘이 열 번
 * 주고받으면 그 열 번이 그대로 흐르고, 사람이 읽어야 할 말이 그 사이에 묻힌다.
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
  const [open, setOpen] = useState(false);
  const accounts = useActiveStore((s) => s.accounts);

  const names = exchangeParticipants(messages).map((id) => accounts[id]?.handle ?? '…');
  const last = messages[messages.length - 1]!;
  const lastTime = new Date(last.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (open) {
    return (
      <div data-testid="agent-exchange" data-open="true">
        <button
          data-testid="agent-exchange-toggle"
          aria-expanded
          className="mx-4 my-0.5 rounded px-1 text-[11px] text-fg-agent hover:bg-surface-hover"
          onClick={() => setOpen(false)}
        >
          {names.join(' ↔ ')} · 접기
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
      <button
        data-testid="agent-exchange-toggle"
        aria-expanded={false}
        className="flex items-center gap-1.5 rounded px-1 text-[11px] text-fg-agent hover:bg-surface-hover"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-sm bg-border-agent" />
        <span className="font-medium">{names.join(' ↔ ')}</span>
        <span className="text-fg-subtle">· {messages.length}번 주고받음</span>
        <span className="text-fg-subtle">· 마지막 {lastTime}</span>
        <span className="text-fg-subtle">· 펼치기</span>
      </button>
    </div>
  );
}
