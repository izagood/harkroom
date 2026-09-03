import type { AgentConfig } from '@murmur/shared';
import { ApiClient } from '../src/lib/api';

/**
 * #251 타입 수준 회귀선. **런타임 테스트가 아니다** — 이 파일은 `pnpm typecheck` 가
 * 검사하고 vitest 는 수집하지 않는다(파일 이름이 `*.test.ts` 가 아니다).
 *
 * 지키는 것: `disabled` 는 설정이 아니라 감사 대상 생애주기 상태라서 `AgentConfig` 에
 * 들어가지 않고, 따라서 `updateAgent` 의 patch 로도 보낼 수 없다. 보내는 길이 열리면
 * 설정 저장이 조용히 계정을 끄게 되고, 감사 로그가 "누가 언제 껐나"를 답하지 못한다.
 *
 * `@ts-expect-error` 는 **오류가 없어지면 그 자체로 오류**가 되므로, `AgentConfig` 에
 * `disabled` 가 생기는 순간 typecheck 가 빨개진다. 이 파일을 지우면 그 안전망이 사라진다.
 *
 * `src/` 가 아니라 `test/` 에 두는 이유: 앱 번들에 시험용 파일을 남기지 않는다.
 * `tsconfig.json` 의 include 에 `test` 가 있으므로 typecheck 범위는 그대로다.
 */

// `AgentConfig` 에 `disabled` 가 없음을 조건부 타입으로 못 박는다. 생기면 'FAIL' 이 되어
// 아래 대입이 컴파일되지 않는다.
type AgentConfigHasDisabled = AgentConfig extends { disabled: boolean } ? 'FAIL' : 'PASS';
const configHasNoDisabled: AgentConfigHasDisabled = 'PASS';

/**
 * `updateAgent` 가 `disabled` 를 받지 않는지 확인한다. **부르지 않는 함수 안**에 둔다 —
 * 모듈 최상위에 두면 이 파일을 실수로 import 하는 순간 실제 요청이 나간다.
 */
function updateAgentRejectsDisabled(api: ApiClient) {
  // @ts-expect-error disabled 는 updateAgent 의 patch 타입에 없으므로 오류다
  return api.updateAgent('a1', { disabled: true });
}

// 두 단언을 값으로 내보낸다 — 미사용으로 지워지지 않게 하는 것이 목적이다.
export const agentDisabledTypeGuards = { configHasNoDisabled, updateAgentRejectsDisabled };
