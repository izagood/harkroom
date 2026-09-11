// **이 턴을 어느 코드 경로로 돌리는가** — 턴 단위 컨텍스트(2026-09-12).
//
// ## 왜 전역 변수가 아닌가
//
// 러너는 멘션 턴을 **병렬로** 돌린다. 전역에 담으면 나중에 시작한 턴이 앞 턴의 값을 덮고,
// 두 턴이 서로의 경로로 도는 일이 생긴다 — 그 사고는 조용하다(둘 다 "그럴듯하게" 돈다).
// 그래서 값이 **그 턴의 비동기 흐름에만** 묶여야 하고, 그것이 `AsyncLocalStorage` 다.
//
// ## 왜 인자로 넘기지 않는가
//
// 읽는 자리가 호출 사슬의 **깊은 끝**에 흩어져 있다(`workspaceTrust` 의 장부 선택,
// 어댑터 표의 네 판정 …). 그 전부에 인자를 더하면 이설이 끝나 스위치를 지울 때 그 인자들도
// 다시 걷어야 한다 — 임시 스위치가 영구 배선을 남기는 모양이다. 컨텍스트는 **한 곳에서
// 깔고 한 곳에서 읽으므로**, 지울 때도 두 곳만 지운다.
//
// ## 없으면 무엇인가
//
// `null` 은 '이 러너의 기본값을 따른다'이다 — 턴 밖에서(예: `certify` 스크립트) 읽으면
// 그 상태가 되고, 그때는 환경변수가 답한다(`adapters/index.ts::harnessAdaptersEnabled`).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentExecutionPath } from '@harkroom/shared';

const store = new AsyncLocalStorage<AgentExecutionPath | null>();

/** 이 턴의 실행 경로를 깔고 본체를 돈다. 안에서 뜬 모든 비동기 작업이 같은 값을 본다. */
export function runWithExecutionPath<T>(path: AgentExecutionPath | null, fn: () => T): T {
  return store.run(path, fn);
}

/** 지금 흐름의 실행 경로. 턴 밖이면 `null`(= 러너 기본값을 따른다). */
export function currentExecutionPath(): AgentExecutionPath | null {
  return store.getStore() ?? null;
}
