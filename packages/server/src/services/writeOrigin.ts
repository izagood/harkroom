/**
 * 기억 쓰기의 출처(BG1). MCP 도구 한 번의 실행 동안 「어느 백그라운드 회차(run)·어느 턴」이 쓰는지를 들고 다닌다 —
 * `agent_memory_revision.run_id·turn_id` 에 적어 「이 회차가 무엇을 바꿨나」를 남긴다(설계 4절).
 *
 * 인자로 넘기지 않은 이유: 이전 판을 쓰는 자리가 `memory.ts`·`memoryCurate.ts` 에 흩어져 있고, 쓰는 함수마다
 * 꼬리 인자를 늘리면 사람 REST 경로까지 모두 고쳐야 한다. 출처를 모르는 쓰기(사람·정리 sweep)는 null 이다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface WriteOrigin {
  runId: string | null;
  turnId: string | null;
}

const store = new AsyncLocalStorage<WriteOrigin>();

export function withWriteOrigin<T>(origin: WriteOrigin, fn: () => T): T {
  return store.run(origin, fn);
}

/** 지금 쓰기의 출처. 바깥(사람 REST 등)이면 둘 다 null. */
export function writeOrigin(): WriteOrigin {
  return store.getStore() ?? { runId: null, turnId: null };
}
