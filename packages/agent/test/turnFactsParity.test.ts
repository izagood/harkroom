// **옛 경로와 새 경로가 같은 답을 내는가** — 턴이 하네스에 대해 묻는 세 사실(이설 3/N).
//
// `mentionTurn` 4자리 + `interactiveTurn` 3자리가 실은 **세 질문**이었다:
//
//   1. 멘션 턴을 TUI 로 띄우는가        (`usesTuiForMention`)
//   2. 계정 풀 표면이 있는가            (`hasAccountPool`)
//   3. 첫 턴 뒤 세션 id 를 발견하는가   (`discoversSessionIdAfterTurn`)
//
// 세 함수가 스위치를 품고 있으므로 **그 함수들이 곧 갈림길**이다. 여기서 양쪽을 돌려
// 답을 맞추는 것이 이 이설의 패리티다.
//
// ## 값을 맞추는 것만으로는 부족하다
//
// 두 경로가 같은 답을 낸다는 것과 **그 답이 옳다**는 것은 다른 문제다. 표의 값을 잘못
// 적으면 양쪽이 나란히 틀리는 것은 아니지만(옛 경로는 이름을 보므로), 새 경로만 틀린 채
// "같다" 를 재면 그 차이가 드러난다 — 그래서 하네스별 기대값을 따로 못 박는다. 그 표가
// 곧 "지금 프로덕션이 이렇게 돈다"의 기록이다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNABLE_HARNESSES, type AgentHarness } from '@murmur/shared';

import {
  discoversSessionIdAfterTurn,
  hasAccountPool,
  usesTuiForMention,
} from '../src/adapters/index.js';

const RUNNABLE = RUNNABLE_HARNESSES as readonly AgentHarness[];

let savedFlag: string | undefined;
beforeEach(() => { savedFlag = process.env.MURMUR_HARNESS_ADAPTERS; });
afterEach(() => {
  // 플래그를 되돌린다 — 남기면 이 파일 뒤에 도는 테스트가 새 경로로 돈다.
  if (savedFlag === undefined) delete process.env.MURMUR_HARNESS_ADAPTERS;
  else process.env.MURMUR_HARNESS_ADAPTERS = savedFlag;
});

function facts(harness: AgentHarness, enabled: boolean) {
  if (enabled) process.env.MURMUR_HARNESS_ADAPTERS = '1';
  else delete process.env.MURMUR_HARNESS_ADAPTERS;
  return {
    usesTui: usesTuiForMention(harness),
    pooled: hasAccountPool(harness),
    discovers: discoversSessionIdAfterTurn(harness),
  };
}

describe('턴의 세 사실 — 옛 경로와 새 경로가 같다', () => {
  for (const harness of RUNNABLE) {
    it(`${harness}: 세 답이 모두 같다`, () => {
      expect(facts(harness, true)).toEqual(facts(harness, false));
    });
  }

  /**
   * 지금 프로덕션이 도는 모양. **`codex.usesTui: false` 는 목표가 아니라 현재 상태다** —
   * 새 경로가 먼저 "같아야" 하고, codex 를 TUI 로 바꾸는 것은 그다음 결정이다. 바꾸는 날
   * 고칠 곳은 어댑터 표 한 줄이고 이 기대값도 함께 바뀐다(그 diff 가 리뷰에 보인다).
   */
  const EXPECTED: Record<string, { usesTui: boolean; pooled: boolean; discovers: boolean }> = {
    'claude-code': { usesTui: true, pooled: true, discovers: false },
    codex: { usesTui: false, pooled: false, discovers: true },
  };

  for (const harness of RUNNABLE) {
    it(`${harness}: 답이 옳다 — 양쪽이 나란히 틀리는 것을 막는다`, () => {
      for (const enabled of [false, true]) {
        expect(facts(harness, enabled)).toEqual(EXPECTED[harness]);
      }
    });
  }

  it('세 사실이 서로 독립이다 — 한 하네스에서 셋이 같은 값이면 이 테스트가 헐렁하다', () => {
    // claude 는 (true, true, false), codex 는 (false, false, true) 다. 세 질문이 같은
    // 비교에서 나왔으므로, 실수로 한 함수를 다른 함수로 부르면 값이 겹쳐 드러난다.
    const claude = facts('claude-code', true);
    expect(claude.discovers).not.toBe(claude.usesTui);
    const codex = facts('codex', true);
    expect(codex.discovers).not.toBe(codex.usesTui);
  });

  it('opencode 는 셋 다 표에서 나온다 — 새 경로에서만 뜻이 있는 값이다', () => {
    // 옛 경로는 이름을 보므로 `usesTui:false, pooled:false, discovers:false` 를 준다.
    // 새 경로는 표를 읽어 `discovers:true` 를 준다(세션 사전 할당이 불가하다는 실측).
    // **이것이 두 경로가 갈리는 유일한 자리이고, 그래도 안전하다** — opencode 는
    // `RUNNABLE_HARNESSES` 에 없어 러너가 그 턴을 만들지 않는다.
    expect(facts('opencode', false).discovers).toBe(false);
    expect(facts('opencode', true).discovers).toBe(true);
  });
});
