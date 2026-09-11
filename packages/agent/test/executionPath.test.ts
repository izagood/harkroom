// **턴마다 다른 실행 경로** — 에이전트 설정이 환경변수를 이긴다(2026-09-12).
//
// ## 이 파일이 지키는 것
//
// 이설의 안전은 "한 에이전트만 새 경로로 돌려 보고 나머지는 옛 경로로 둔다"에 걸려 있다.
// 스위치가 환경변수뿐이면 그 비교를 하려고 데몬 전체를 재시작해야 하고, 그러면 **다른
// 에이전트의 도는 턴까지 같이 죽는다.** 그래서 값이 정의(`AgentView.executionPath`)에
// 실려 오고, 판정은 그 값을 먼저 본다.
//
// ## 왜 병렬을 따로 재는가
//
// 러너는 멘션 턴을 병렬로 돌린다. 값을 전역에 담았다면 이 파일의 마지막 테스트만 빨개진다
// — 나머지는 순차 호출이라 전역으로도 통과한다. 즉 **그 테스트가 이 설계의 이유 전부**다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { harnessAdaptersEnabled } from '../src/adapters/index.js';
import { currentExecutionPath, runWithExecutionPath } from '../src/executionPath.js';

let saved: string | undefined;
beforeEach(() => { saved = process.env.MURMUR_HARNESS_ADAPTERS; });
afterEach(() => {
  if (saved === undefined) delete process.env.MURMUR_HARNESS_ADAPTERS;
  else process.env.MURMUR_HARNESS_ADAPTERS = saved;
});

function setEnv(on: boolean): void {
  if (on) process.env.MURMUR_HARNESS_ADAPTERS = '1';
  else delete process.env.MURMUR_HARNESS_ADAPTERS;
}

describe('실행 경로 — 에이전트가 고른 것이 먼저다', () => {
  it('턴 밖에서는 환경변수가 답한다 — certify 같은 스크립트가 이 길로 온다', () => {
    expect(currentExecutionPath()).toBeNull();
    setEnv(false);
    expect(harnessAdaptersEnabled()).toBe(false);
    setEnv(true);
    expect(harnessAdaptersEnabled()).toBe(true);
  });

  it('고른 값이 환경변수를 **양방향으로** 이긴다', () => {
    // 한 방향만 재면 반쪽이다: 기본이 켜진 러너에서 한 에이전트만 되돌리는 것(legacy)이
    // 사고가 났을 때 실제로 쓰는 손잡이다.
    setEnv(true);
    expect(runWithExecutionPath('legacy', () => harnessAdaptersEnabled())).toBe(false);
    setEnv(false);
    expect(runWithExecutionPath('adapters', () => harnessAdaptersEnabled())).toBe(true);
  });

  it('null 은 "고르지 않음" 이다 — 러너 기본값으로 떨어진다', () => {
    setEnv(true);
    expect(runWithExecutionPath(null, () => harnessAdaptersEnabled())).toBe(true);
    setEnv(false);
    expect(runWithExecutionPath(null, () => harnessAdaptersEnabled())).toBe(false);
  });

  it('빠져나오면 값이 남지 않는다 — 다음 턴이 앞 턴의 경로로 돌면 안 된다', async () => {
    setEnv(false);
    await runWithExecutionPath('adapters', async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(harnessAdaptersEnabled()).toBe(true);
    });
    expect(currentExecutionPath()).toBeNull();
    expect(harnessAdaptersEnabled()).toBe(false);
  });

  it('병렬 턴이 서로의 값을 보지 않는다 — 이 설계의 이유', async () => {
    setEnv(false);
    // 일부러 엇갈리게 기다린다. 전역이었다면 나중에 시작한 쪽이 앞 쪽을 덮어, 깨어난 A 가
    // B 의 경로를 본다. 각자 **자기가 시작한 값**을 계속 보는지가 요점이다.
    const trace = async (path: 'legacy' | 'adapters', delays: number[]) =>
      runWithExecutionPath(path, async () => {
        const seen: boolean[] = [];
        for (const ms of delays) {
          await new Promise((r) => setTimeout(r, ms));
          seen.push(harnessAdaptersEnabled());
        }
        return seen;
      });

    const [a, b] = await Promise.all([
      trace('adapters', [0, 4, 8]),
      trace('legacy', [2, 6, 10]),
    ]);
    expect(a).toEqual([true, true, true]);
    expect(b).toEqual([false, false, false]);
  });
});
