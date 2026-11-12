// 관문 통지의 기계용 칸(2026-10-02, 관문 대응 안 2). **턴 시작 관문에만** account_gate 를 붙인다 —
// 턴 도중 권한 확인('gate')에 붙이면 명령마다 🙋 가 선다. 계정은 순번만(칩 ② — 이름은 사람 이름일 수 있다).
import { describe, expect, it } from 'vitest';
import { gateFailExtras } from '../src/mentionTurn.js';
import { gateNotice, gateRankLabel } from '../src/prompt.js';

describe('gateFailExtras', () => {
  it("'startup' 이면 account_gate · 그 턴의 멘션 · 풀·계정 순번", () => {
    expect(gateFailExtras('startup', 'm-1', { claudePoolRank: 2, claudeAccountRank: 1 }))
      .toEqual({ code: 'account_gate', mentionId: 'm-1', claudePoolRank: 2, claudeAccountRank: 1 });
  });
  it("턴 도중 권한 확인('gate')에는 아무것도 붙이지 않는다", () => {
    expect(gateFailExtras('gate', 'm-1', { claudePoolRank: 2, claudeAccountRank: 1 })).toEqual({});
  });
  it('시스템 기본 로그인·모름은 순번 없이 코드만', () => {
    expect(gateFailExtras('startup', 'm-1', { claudeAccountRank: null })).toEqual({ code: 'account_gate', mentionId: 'm-1' });
    expect(gateFailExtras('startup', 'm-1', {})).toEqual({ code: 'account_gate', mentionId: 'm-1' });
  });
  it('이름 칸(account)은 어떤 경우에도 싣지 않는다', () => {
    expect(Object.keys(gateFailExtras('startup', 'm-1', { claudeAccountRank: 3 }))).not.toContain('account');
  });
});

describe('gateNotice', () => {
  it('글의 계정 줄은 순번만 적는다', () => {
    expect(gateRankLabel({ claudePoolRank: 2, claudeAccountRank: 1 })).toBe('풀 2 · 계정 1');
    expect(gateRankLabel({ claudeAccountRank: 3 })).toBe('계정 3');
    expect(gateRankLabel({ claudeAccountRank: null })).toBe('기본 로그인');
    expect(gateRankLabel({})).toBe('모름');
    expect(gateNotice({ claudePoolRank: 2, claudeAccountRank: 1 })).toContain('계정: 풀 2 · 계정 1)');
  });
});
