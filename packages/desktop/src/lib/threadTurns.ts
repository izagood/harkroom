/**
 * 스레드에서 지금 도는 턴(R1)을 읽는 자리 — 진행 띠(R2)의 「도는 중」 칸의 재료다.
 *
 * 서버는 턴이 생기거나 사라질 때 값 없는 신호(`thread.turns.changed`)만 보낸다. 신호를 받으면 여기서 다시 읽는다.
 * 신호가 안 오는 경우(서버가 비정상으로 죽어 허브 줄이 TTL 로 사라질 때)가 있어 느린 폴도 함께 돈다 — 읽는 길이 정본이다.
 *
 * 모르는 것을 0 으로 말하지 않는다(`agentTurns.ts` 와 같은 규율): 못 읽으면 `unknown`, 읽는 길이 없는 서버면 `off`.
 */
import { useEffect, useState } from 'react';
import type { ThreadTurn, ThreadTurnsSnapshot } from './threadProgress';

/** 신호가 빠졌을 때를 메우는 주기. 신호가 정상이면 이 폴은 같은 답을 다시 받을 뿐이다. */
export const THREAD_TURNS_POLL_MS = 30_000;

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

/**
 * `ask` 가 `null` 이면 묻지 않는다(끊긴 동안 등) — 그때는 `checking` 이다.
 * 스레드를 바꾸면 앞 스레드의 답은 버린다. 늦게 온 답이 새 스레드의 수로 서면 안 된다.
 */
export function useThreadTurns(ask: AskThreadTurns | null, rootId: string): ThreadTurnsSnapshot {
  const [snapshot, setSnapshot] = useState<ThreadTurnsSnapshot>({ kind: 'checking' });
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
        (turns) => { if (alive && mine === round) setSnapshot({ kind: 'known', turns }); },
        (err: unknown) => {
          if (!alive || mine !== round) return;
          off = isRouteMissing(err);
          setSnapshot({ kind: off ? 'off' : 'unknown' });
        },
      );
    };
    const wakes = bus.get(rootId) ?? new Set<() => void>();
    bus.set(rootId, wakes);
    wakes.add(read);
    read();
    const timer = setInterval(read, THREAD_TURNS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      wakes.delete(read);
      if (wakes.size === 0) bus.delete(rootId);
    };
  }, [ask, rootId]);
  return snapshot;
}
