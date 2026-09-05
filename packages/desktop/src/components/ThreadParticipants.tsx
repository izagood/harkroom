import { useState } from 'react';
import type { AccountView, MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { Identity } from './Identity';
import type { Liveness } from './../lib/threadState';

/**
 * 이 스레드에 참여 중인 에이전트 줄 + 터미널 선택자(계획 Task 8 Step 3·4).
 *
 * ## 아바타의 세 얼굴
 *
 * 도는 자는 진하게, 응답 없는 자는 흐리게. **생존을 모를 때(`live === null`)는 전부 진하게**
 * 둔다 — `threadState`·`waitChain` 과 같은 규약이다. 모른다는 이유로 흐리게 그리면 소켓이
 * 잠깐 끊긴 동안 멀쩡한 에이전트가 죽은 것처럼 보인다.
 *
 * ## 터미널이 왜 여기 있는가
 *
 * 세션은 **(에이전트, 스레드)당 하나**이므로 문은 스레드에 달린다. 여럿이 일하면 문도
 * 여럿이라 손잡이는 버튼이 아니라 **선택자**여야 한다(규칙 06).
 *
 * 소유자·admin 이 아닌 에이전트는 그 목록에 **아예 없다** — 비활성이 아니라 부재다.
 * 고를 것이 하나도 없으면 손잡이 자체를 그리지 않는다: 0 은 자리를 차지하지 않는다.
 *
 * 메시지의 `TerminalChip` 은 남겨 둔다 — 작은 화면에서 헤더가 먼저 접힌다.
 */
export function ThreadParticipants({ messages, live }: { messages: MessageRow[]; live: Liveness }) {
  const accounts = useActiveStore((s) => s.accounts);
  const me = useActiveStore((s) => s.me);
  const set = useActiveStore((s) => s.set);
  const [open, setOpen] = useState(false);

  // 등장 순서를 지킨다 — 먼저 말한 쪽이 먼저 선다.
  const seen: string[] = [];
  for (const m of messages) {
    if (!seen.includes(m.authorId) && accounts[m.authorId]?.kind === 'agent') seen.push(m.authorId);
  }
  const agents = seen.map((id) => accounts[id]).filter((a): a is AccountView => a != null);
  if (agents.length === 0) return null;

  /**
   * 터미널을 열 수 있는 에이전트만 목록에 든다. 판정은 `TerminalChip` 과 **같아야 한다** —
   * 서버의 `checkOwnerOrAdmin` 이 진짜 게이트이고, 화면이 더 넓으면 눌러서 403 을 받고
   * 더 좁으면 admin 이 열 수 있는 문을 못 찾는다.
   */
  const openable = agents.filter((a) => {
    if (!me) return false;
    const isOwner = a.ownerAccountId !== null && a.ownerAccountId === me.id;
    return me.isAdmin || isOwner;
  });

  /** 이 스레드에서 그 에이전트의 마지막 메시지 — 세션의 스레드 키를 그것으로 낸다. */
  const lastOf = (id: string): MessageRow =>
    [...messages].reverse().find((m) => m.authorId === id)!;

  return (
    <div data-testid="thread-participants" className="flex items-center gap-1.5">
      <span className="flex -space-x-1" aria-hidden="true">
        {agents.map((a) => (
          <span
            key={a.id}
            data-testid={`participant-${a.handle}`}
            // 모를 때는 흐리게 하지 않는다(위 주석).
            data-alive={live === null ? 'unknown' : live.has(a.id)}
            className={`ring-1 ring-surface-raised ${live !== null && !live.has(a.id) ? 'opacity-40' : ''}`}
          >
            <Identity account={a} className="h-5 w-5 text-[9px]" variant="avatar" />
          </span>
        ))}
      </span>

      {openable.length > 0 && (
        <div className="relative">
          <button
            data-testid="terminal-picker"
            aria-expanded={open}
            className="rounded px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-surface-hover"
            onClick={() => setOpen((v) => !v)}
          >
            터미널 ▾
          </button>
          {open && (
            <ul
              data-testid="terminal-picker-menu"
              className="absolute right-0 z-10 mt-1 min-w-32 rounded border border-border
                         bg-surface-raised py-1 shadow-lg"
            >
              {openable.map((a) => (
                <li key={a.id}>
                  <button
                    data-testid={`terminal-open-${a.handle}`}
                    className="w-full px-3 py-1 text-left text-[11px] hover:bg-surface-hover"
                    onClick={() => {
                      const m = lastOf(a.id);
                      set({
                        terminalTarget: {
                          agentAccountId: a.id,
                          channelId: m.channelId,
                          // #98 앵커식 — `TerminalChip` 과 같은 식이어야 러너가 만든 세션을 찾는다.
                          threadRootId: m.threadRootId ?? m.id,
                        },
                      });
                      setOpen(false);
                    }}
                  >
                    @{a.handle}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
