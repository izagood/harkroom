/**
 * 스레드에서 지금 도는 턴(R1)을 읽는 자리 — 진행 띠(R2)의 「도는 중」 칸의 재료다.
 *
 * 서버는 턴이 생기거나 사라질 때 값 없는 신호(`thread.turns.changed`)만 보낸다. 신호를 받으면 여기서 다시 읽는다.
 * 신호가 안 오는 경우(서버가 비정상으로 죽어 허브 줄이 TTL 로 사라질 때)가 있어 느린 폴도 함께 돈다 — 읽는 길이 정본이다.
 *
 * 모르는 것을 0 으로 말하지 않는다(`agentTurns.ts` 와 같은 규율): 못 읽으면 `unknown`, 읽는 길이 없는 서버면 `off`.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ThreadTurn, ThreadTurnsSnapshot } from './threadProgress';

/** 신호가 빠졌을 때를 메우는 주기. 신호가 정상이면 이 폴은 같은 답을 다시 받을 뿐이다. */
export const THREAD_TURNS_POLL_MS = 30_000;
/**
 * 신호를 묶는 창. 턴 여럿이 한꺼번에 뜨고 지면 신호가 줄지어 온다 — 신호마다 읽으면 그 수만큼 요청이 나간다.
 * 첫 신호에서 이만큼 기다렸다가 한 번만 읽는다(그 사이의 신호는 그 한 번에 담긴다).
 */
export const THREAD_TURNS_SIGNAL_MS = 1_000;

const bus = new Map<string, Set<() => void>>();

/** `thread.turns.changed` 를 받은 컨트롤러가 부른다. 그 스레드를 보고 있는 화면만 다시 읽는다. */
export function notifyThreadTurnsChanged(rootId: string): void {
  for (const wake of bus.get(rootId) ?? []) wake();
}

/** 읽는 길이 없다는 답(옛 서버·그 길을 안 띄운 서버). 그때는 다시 묻지 않는다. */
export function isRouteMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

export type AskThreadTurns = (rootId: string) => Promise<ThreadTurn[]>;

/** 스레드 하나에 딸린 읽기의 답. `0` 과 「모름」과 「읽는 길 없음」을 가른다. */
export type ThreadRead<T> =
  | { kind: 'checking' }
  | { kind: 'known'; value: T }
  | { kind: 'unknown' }
  | { kind: 'off' };

/**
 * 스레드에 딸린 것을 읽는 공통 자리 — 처음 한 번, 신호가 오면 묶어서 한 번, 그리고 느린 폴.
 * `ask` 가 `null` 이면 묻지 않는다(끊긴 동안 등) — 그때는 `checking` 이다.
 * 스레드를 바꾸면 앞 스레드의 답은 버린다. 늦게 온 답이 새 스레드의 값으로 서면 안 된다.
 */
export function useThreadRead<T>(ask: ((rootId: string) => Promise<T>) | null, rootId: string): ThreadRead<T> {
  const [snapshot, setSnapshot] = useState<ThreadRead<T>>({ kind: 'checking' });
  useEffect(() => {
    setSnapshot({ kind: 'checking' });
    if (!ask) return;
    let alive = true;
    let off = false;
    let round = 0;
    const read = () => {
      if (off) return;
      const mine = ++round;
      ask(rootId).then(
        (value) => { if (alive && mine === round) setSnapshot({ kind: 'known', value }); },
        (err: unknown) => {
          if (!alive || mine !== round) return;
          off = isRouteMissing(err);
          setSnapshot({ kind: off ? 'off' : 'unknown' });
        },
      );
    };
    let pending: ReturnType<typeof setTimeout> | null = null;
    const onSignal = () => {
      if (pending !== null) return;
      pending = setTimeout(() => { pending = null; read(); }, THREAD_TURNS_SIGNAL_MS);
    };
    const wakes = bus.get(rootId) ?? new Set<() => void>();
    bus.set(rootId, wakes);
    wakes.add(onSignal);
    read();
    const timer = setInterval(read, THREAD_TURNS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      if (pending !== null) clearTimeout(pending);
      wakes.delete(onSignal);
      if (wakes.size === 0) bus.delete(rootId);
    };
  }, [ask, rootId]);
  return snapshot;
}

export function useThreadTurns(ask: AskThreadTurns | null, rootId: string): ThreadTurnsSnapshot {
  const read = useThreadRead(ask, rootId);
  return useMemo(
    () => (read.kind === 'known' ? { kind: 'known', turns: read.value } : { kind: read.kind }),
    [read],
  );
}
