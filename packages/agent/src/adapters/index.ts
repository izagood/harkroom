// 어댑터 등록부와 **전환 스위치**.
//
// ## 옛 경로를 남긴다 (2026-09-10 결정)
//
// claude-code 가 안 돌면 murmur 앱 자체를 쓸 수 없다. 그래서 이 표를 들이는 것과 호출부를
// 이 표로 옮기는 것을 **분리한다**:
//
// 1. (이 커밋) 표를 만들고, 표의 값이 지금 프로덕션과 **같은 답을 내는지** 패리티 테스트로
//    대조한다. 호출부는 하나도 바뀌지 않는다 — claude 경로는 글자 하나 안 바뀐다.
// 2. (다음) 호출부를 하나씩 `harnessAdaptersEnabled()` 뒤로 옮긴다. 기본값이 꺼짐이므로
//    켜지 않은 러너는 계속 옛 경로로 돈다.
// 3. 실물 검증(멘션 턴 왕복·인터랙티브·중단·계정 전환)이 끝난 뒤 기본값을 켜고, 그다음
//    릴리스에서 옛 분기를 걷는다.
//
// **스위치를 1단계에 함께 넣는 이유**: 나중에 넣으면 그 커밋이 "표를 읽게 바꾸는 것"과
// "스위치를 만드는 것" 두 변경을 겹치게 되고, 문제가 났을 때 어느 쪽 탓인지 가릴 수 없다.
import type { AgentHarness } from '@murmur/shared';

import { CLAUDE_CODE_ADAPTER } from './claudeCode.js';
import { CODEX_ADAPTER } from './codex.js';
import type { HarnessAdapter } from './contract.js';

export type { HarnessAdapter, ExecutionModel, TrustLedger, TranscriptSource, AccountAxis } from './contract.js';
export { GATE_PATTERN } from './gate.js';

/**
 * 하네스별 어댑터. `'unsupported'` 는 **이름은 스키마에 있으나 구현이 없다**는 뜻이고,
 * `turn.ts::PRESETS` 의 같은 값과 짝을 이룬다 — 두 표가 어긋나면 패리티 테스트가 잡는다.
 */
export const ADAPTERS: Record<AgentHarness, HarnessAdapter | 'unsupported'> = {
  'claude-code': CLAUDE_CODE_ADAPTER,
  codex: CODEX_ADAPTER,
  // `-r` 이 UUID 를 받지 못해 `--session-id` 와 짝을 이루지 못한다(실측, task-1).
  gemini: 'unsupported',
};

/**
 * 이 하네스의 어댑터. 구현이 없으면 **던진다** — 호출자가 `RUNNABLE_HARNESSES` 를 확인하지
 * 않은 결함이라는 뜻이고, 조용히 기본값을 지어내면 그 결함이 엉뚱한 자리에서 드러난다
 * (`turn.ts::buildTurnCommand` 가 같은 규율을 쓴다).
 */
export function adapterFor(harness: AgentHarness): HarnessAdapter {
  const adapter = ADAPTERS[harness];
  if (adapter === 'unsupported') {
    throw new Error(
      `adapterFor: ${harness} 는 어댑터가 없다 — 호출자가 RUNNABLE_HARNESSES 를 확인하지 않았다`,
    );
  }
  return adapter;
}

/**
 * 러너가 **어댑터 표를 읽어 동작할 것인가**. 기본값은 **꺼짐**이다.
 *
 * 켜는 방법은 `MURMUR_HARNESS_ADAPTERS=1`(러너 env). 데몬이 러너 env 를 통째로 상속시키므로
 * 운영자가 데몬 환경에 넣으면 그 기계의 모든 러너가 새 경로로 돈다 — 한 기계에서 먼저
 * 켜 보고 넘어가는 것이 이 설계가 의도한 검증 순서다.
 *
 * `'1'`·`'true'` 만 켜짐으로 읽는다. 오타로 켜지지 않게 하려는 것이다 — 이 스위치가
 * 실수로 켜지면 claude 경로가 통째로 바뀐다.
 */
export function harnessAdaptersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MURMUR_HARNESS_ADAPTERS;
  return raw === '1' || raw === 'true';
}
