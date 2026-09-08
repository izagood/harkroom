import { describe, it, expect } from 'vitest';
import { GUIDE, guideFor } from '../src/mcp/guide.js';

/**
 * 2026-09-08 사고의 회귀선. 경위는 `src/mcp/guide.ts` 머리에 있다 — 요약하면, 러너가 띄운
 * 턴에게 상주 에이전트용 poll 계약을 주었더니 그 턴이 인박스를 한 번 더 보고 **남의 앵커의
 * 요청**을 대신 했다. 같은 기능 PR 이 셋 나오고 요청 둘이 답 없이 남았다.
 */
describe('워크스페이스 가이드의 두 판본 (2026-09-08 앵커 이탈 사고)', () => {
  it('러너 턴 판본에는 inbox.poll 루프 지시가 없다 — 이 한 줄이 사고의 원인이었다', () => {
    const turn = guideFor('turn');
    expect(turn).not.toMatch(/## 깨어나기/);
    expect(turn).not.toMatch(/## poll 루프 계약/);
    expect(turn).not.toMatch(/루프\*{0,2}로 걸어라/);
  });

  it('러너 턴 판본은 inbox.read 를 금지한다 — 남의 항목을 읽음 처리하면 그 요청의 턴이 영영 안 뜬다', () => {
    const turn = guideFor('turn');
    expect(turn).toMatch(/inbox\.read/);
    expect(turn).toMatch(/영영 띄우지 않는다/);
  });

  it('러너 턴 판본은 앵커 하나가 이 턴의 일 전부라고 말한다', () => {
    const turn = guideFor('turn');
    expect(turn).toMatch(/threadRootId/);
    expect(turn).toMatch(/손대지 마라/);
  });

  it('상주 판본은 poll 계약을 그대로 지킨다 — 러너 밖 에이전트의 생존이 여기 걸려 있다', () => {
    const resident = guideFor('resident');
    expect(resident).toMatch(/## 깨어나기/);
    expect(resident).toMatch(/## poll 루프 계약/);
    expect(resident).toMatch(/빈 결과/);
    expect(resident).toMatch(/백오프/);
  });

  it('두 판본 다 avcs 경계와 turn.wake 를 담는다 — 가른 것은 인박스뿐이다', () => {
    for (const mode of ['resident', 'turn'] as const) {
      const g = guideFor(mode);
      expect(g, mode).toMatch(/## avcs 사용 경계/);
      expect(g, mode).toMatch(/## 기다림은 예약한다/);
      expect(g, mode).toMatch(/## 작업 경과 알리기/);
    }
  });

  it('옛 이름 GUIDE 는 상주 판본과 글자 그대로 같다 — 모드를 모르는 호출자의 계약이 바뀌면 안 된다', () => {
    expect(GUIDE).toBe(guideFor('resident'));
  });
});
