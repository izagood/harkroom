/**
 * 멘션 하나에 중계 세션 하나 — 계정을 바꿔 다시 시도해도 세션은 멘션 내내 산다. 그래서 시도 **사이**에 사람이 누른
 * [중단] 도 받는다: 받은 [중단] 은 멘션 단위로 남기고, 다음 시도가 세션을 잡는 순간 그 시도의 `onCancel` 로 먼저
 * 넘긴다 → 그 시도는 띄우기 전에 접힌다(`canceledBeforeSpawn`).
 *
 * 시도는 `openSession` 으로 손잡이를 받는다(멘션 턴 코드는 그대로). 첫 시도가 진짜 세션을 열고, 뒤 시도는 같은 세션에
 * 다시 붙어 계정 칩(순번만)을 고친다. 시도의 `close()` 는 세션을 닫지 않고 그 시도를 뗀다(입력 통로를 놓고, 그 뒤 온
 * 입력은 버린다). 진짜 닫기는 멘션이 끝날 때 `close()` 하나다.
 */
import type { TurnRelay } from './mentionTurn.js';

type SessionInput = Parameters<TurnRelay['openSession']>[0];
type Session = ReturnType<TurnRelay['openSession']>;
type Ranks = { claudePoolRank?: number; claudeAccountRank?: number | null };
/** 진짜 세션 — 멘션 단위로 쓰려면 입력 통로 놓기·칩 고치기가 있어야 한다(`relay.ts`). */
type RealSession = Session & { unbindInput?(): void; restate?(ranks: Ranks): void };

export interface MentionRelay extends TurnRelay {
  /** 이 멘션에서 처음 [중단] 한 사람. */
  canceledBy(): string | null;
  /** 멘션이 끝났다 — 세션을 닫는다. 두 번째 호출은 아무 일도 하지 않는다. */
  close(): void;
}

interface Attempt {
  onCancel?: (byHandle: string) => void;
  onViewerCount?: (count: number) => void;
}

export function createMentionRelay(relay: { openSession(input: SessionInput): RealSession }): MentionRelay {
  let real: RealSession | null = null;
  let current: Attempt | null = null;
  let canceledBy: string | null = null;
  let closed = false;

  const onCancel = (byHandle: string): void => {
    if (canceledBy === null) canceledBy = byHandle;
    // 도는 시도가 있으면 바로 그 시도로(죽이는 것은 그 턴의 일이다). 없으면 다음 시도가 붙을 때 넘긴다.
    current?.onCancel?.(byHandle);
  };
  const onViewerCount = (count: number): void => {
    current?.onViewerCount?.(count);
  };

  return {
    openSession(input: SessionInput): Session {
      const ranks: Ranks = {
        ...(input.claudeAccountRank !== undefined ? { claudeAccountRank: input.claudeAccountRank } : {}),
        ...(input.claudePoolRank !== undefined ? { claudePoolRank: input.claudePoolRank } : {}),
      };
      if (real === null) {
        real = relay.openSession({ ...input, onCancel, onViewerCount });
      } else {
        real.restate?.(ranks);
      }
      const session = real;
      const me: Attempt = { onCancel: input.onCancel, onViewerCount: input.onViewerCount };
      current = me;
      let detached = false;
      // 시도 사이에 온 [중단] — 이 시도가 띄우기 전에 받는다.
      if (canceledBy !== null) me.onCancel?.(canceledBy);
      return {
        sessionId: session.sessionId,
        push(chunk) {
          if (!detached) session.push(chunk);
        },
        bindInput(writer) {
          if (!detached) session.bindInput(writer);
        },
        needsAttention(screen, r) {
          if (!detached) session.needsAttention(screen, r);
        },
        close() {
          if (detached) return;
          detached = true;
          session.unbindInput?.();
          if (current === me) current = null;
        },
      };
    },
    canceledBy: () => canceledBy,
    close() {
      if (closed) return;
      closed = true;
      current = null;
      real?.close();
    },
  };
}
