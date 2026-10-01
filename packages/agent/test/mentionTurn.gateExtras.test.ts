// 관문 통지의 기계용 칸(2026-10-02, 관문 대응 안 2). **턴 시작 관문에만** account_gate 를 붙인다 —
// 턴 도중 권한 확인('gate')에 붙이면 명령마다 🙋 가 선다. 계정은 id 만(풀 이름은 사람 이름일 수 있다).
import { describe, expect, it } from 'vitest';
import { gateFailExtras } from '../src/mentionTurn.js';

describe('gateFailExtras', () => {
  it("'startup' 이면 account_gate · 그 턴의 멘션 · 계정 id", () => {
    expect(gateFailExtras('startup', 'm-1', 'acct-ddb9b523'))
      .toEqual({ code: 'account_gate', mentionId: 'm-1', account: 'acct-ddb9b523' });
  });
  it("턴 도중 권한 확인('gate')에는 아무것도 붙이지 않는다", () => {
    expect(gateFailExtras('gate', 'm-1', 'acct-ddb9b523')).toEqual({});
  });
  it('풀 없는 러너(계정 없음)는 이름표 없이 코드만', () => {
    expect(gateFailExtras('startup', 'm-1', null)).toEqual({ code: 'account_gate', mentionId: 'm-1' });
  });
});
