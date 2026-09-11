// 하네스 사실 — **두 곳이 알아야 하는 것**이 어긋나지 않게(2026-09-11).
//
// `harnessHasAccountPool` 은 러너(턴에 계정 이름을 실을지)와 데스크탑(설정 화면에 풀
// 선택을 그릴지)이 **함께** 읽는다. 각자 `harness === 'claude-code'` 를 적으면 같은 사실이
// 두 벌이 되고, 하네스가 늘 때 한쪽만 고치는 사고가 난다.
//
// 러너 쪽 어댑터 표(`packages/agent/src/adapters/`)의 `account.pooled` 가 같은 사실이고,
// 둘이 일치하는지는 `packages/agent/test/adapterParity.test.ts` 가 지킨다(그쪽이 shared 를
// 가리킨다). 여기서는 이 함수 자체의 답을 못 박는다.
import { describe, expect, it } from 'vitest';
import { AGENT_HARNESSES, harnessHasAccountPool } from '../src/index.js';

describe('harnessHasAccountPool', () => {
  it('풀 관리 표면이 있는 하네스는 claude 하나다', () => {
    // 데몬 RPC 이름이 그 사실을 그대로 말한다(`claudeAccountsList`·`claudeAccountsUsage` …).
    // codex·opencode 는 계정 하나로 돈다 — 풀을 그리면 화면이 거짓말을 한다.
    const pooled = AGENT_HARNESSES.filter((h) => harnessHasAccountPool(h));
    expect(pooled).toEqual(['claude-code']);
  });
});
