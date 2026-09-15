// **새 경로가 옛 경로와 무엇이 같고 무엇이 달라야 하는가** — 턴의 세 사실(2026-09-11 개정).
//
// `mentionTurn` 4자리 + `interactiveTurn` 3자리가 실은 **세 질문**이었다:
//
//   1. 멘션 턴을 TUI 로 띄우는가        (`usesTuiForMention`)
//   2. 계정 풀 표면이 있는가            (`hasAccountPool`)
//   3. 첫 턴 뒤 세션 id 를 발견하는가   (`discoversSessionIdAfterTurn`)
//
// 세 함수가 스위치를 품고 있으므로 **그 함수들이 곧 갈림길**이다.
//
// ## 스위치는 실행 방식을 바꾸지 않는다 (2026-09-11, jaebin 의 순서)
//
// 앞 판본은 "codex 는 `usesTui` 만 다르다"를 재고 있었다 — 실행 방식을 **새 경로에만** 넣었기
// 때문이다. 그러면 스위치를 켜는 순간 *경로*와 *실행 방식*이 동시에 바뀌고, codex 턴이
// 깨졌을 때 어느 쪽 탓인지 가릴 수 없다. 그래서 순서를 갈랐다:
//
//   ① 기존 경로에서 codex 를 headless → TUI 로 올린다   ← 실행 방식은 스위치 **밖**이다
//   ② 그다음 기존 경로 → 새 경로로 옮긴다               ← 스위치는 순수 리팩터가 된다
//
// 그래서 이 파일은 다시 **두 경로가 모든 하네스에서 같은 답을 내는지**를 잰다. 값이 옛것과
// 달라진 것(codex 의 `usesTui`)은 ①이 한 일이고, 스위치는 그것을 건드리지 않는다.

import { describe, expect, it } from 'vitest';
import { RUNNABLE_HARNESSES, type AgentHarness } from '@harkroom/shared';

import {
  discoversSessionIdAfterTurn,
  hasAccountPool,
  usesTuiForMention,
} from '../src/adapters/index.js';
import { runWithExecutionPath } from '../src/executionPath.js';

const RUNNABLE = RUNNABLE_HARNESSES as readonly AgentHarness[];

/**
 * 켬·끔을 **턴 컨텍스트로** 표현한다(2026-09-15). env 를 지우고 넣는 방법은 기본값이
 * 켜짐으로 바뀐 순간 **같은 경로를 두 번 재는 것**이 된다 — "지웠으니 옛 경로겠지" 가
 * 조용히 거짓이 되고, 패리티 테스트는 그대로 초록이다. `executionPath`(#790)는 그
 * 기본값이 무엇이든 두 경로를 **직접** 가리키므로 그 함정이 없다.
 */
function facts(harness: AgentHarness, enabled: boolean) {
  return runWithExecutionPath(enabled ? 'adapters' : 'legacy', () => ({
    usesTui: usesTuiForMention(harness),
    pooled: hasAccountPool(harness),
    discovers: discoversSessionIdAfterTurn(harness),
  }));
}

describe('턴의 세 사실 — 스위치는 아무것도 바꾸지 않는다', () => {
  for (const harness of RUNNABLE) {
    it(`${harness}: 세 답이 두 경로에서 같다`, () => {
      expect(facts(harness, true)).toEqual(facts(harness, false));
    });
  }

  /**
   * 지금 프로덕션이 도는 모양 — **두 경로가 같으므로 경로를 나누지 않는다.**
   *
   * `codex.usesTui: true` 가 ①(headless → TUI)이 한 일이다. 되돌릴 일이 생기면 이 기대값의
   * diff 가 리뷰에 보인다.
   */
  const EXPECTED: Record<string, { usesTui: boolean; pooled: boolean; discovers: boolean }> = {
    'claude-code': { usesTui: true, pooled: true, discovers: false },
    codex: { usesTui: true, pooled: false, discovers: true },
  };

  for (const harness of RUNNABLE) {
    it(`${harness}: 답이 옳다 — 양쪽이 나란히 틀리는 것을 막는다`, () => {
      for (const enabled of [false, true]) {
        expect(facts(harness, enabled)).toEqual(EXPECTED[harness]);
      }
    });
  }

  it('세 사실이 서로 독립이다 — 셋이 같은 값이면 이 테스트가 헐렁하다', () => {
    // claude (true,true,false) / codex (true,false,true). 실수로 한 함수를 다른 함수로
    // 부르면 값이 겹쳐 드러난다.
    const claude = facts('claude-code', true);
    const codex = facts('codex', true);
    expect(claude.pooled).not.toBe(codex.pooled);
    expect(claude.discovers).not.toBe(codex.discovers);
  });

  it('opencode 는 계정·세션 사실만 스위치로 갈린다 — 실행 방식은 갈리지 않는다', () => {
    // 실행 방식은 스위치 밖이므로 두 경로가 같다. 계정 축·세션 발견은 아직 스위치 뒤에 있어
    // 갈리는데, RUNNABLE 이 아니라 러너가 그 턴을 만들지 않으므로 안전하다.
    expect(facts('opencode', true).usesTui).toBe(facts('opencode', false).usesTui);
    expect(facts('opencode', false).discovers).toBe(false);
    expect(facts('opencode', true).discovers).toBe(true);
  });
});
