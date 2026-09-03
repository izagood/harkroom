import type { AgentConfig } from '@murmur/shared';
import { ApiClient } from './api';

/**
 * #251 회귀선 테스트: updateAgent 로 disabled 를 보내는 코드는 컴파일되면 안 된다.
 * 이 파일이 typecheck 를 통과하려면 (즉, @ts-expect-error 가 작동하려면)
 * updateAgent 호출에 disabled 를 넣으면 TypeScript 가 에러를 내야 한다.
 *
 * 이 테스트 파일을 지우면 위 조건이 깨지는 것이다 — 절대 지우지 마라.
 */

// AgentConfig 에 disabled 가 없음을 타입으로 확인한다
type _AgentConfigHasDisabled = AgentConfig extends { disabled: boolean } ? 'FAIL' : 'PASS';
// 이 타입이 'PASS' 여야 한다 — AgentConfig 에는 disabled 가 없다
const _check1: _AgentConfigHasDisabled = 'PASS';

// updateAgent 가 disabled 를 받지 않는지를 확인한다
const _api = new ApiClient('http://x', 't');
// @ts-expect-error disabled 는 updateAgent 의 patch 타입에 없으므로 오류다
_api.updateAgent('a1', { disabled: true });