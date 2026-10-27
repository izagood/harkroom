import { describe, it, expect } from 'vitest';
import { bringsNewArtifact, chainArtifacts, nextStallDepth } from '../src/chainStall.js';

describe('정체 홉 — 결과물 판정', () => {
  it('sha·PR 번호·메시지 링크·GitHub URL 을 결과물로 읽는다', () => {
    const a = chainArtifacts('head 4c3e7f2a 로 #1600 올림. harkroom://message/1e086e53-91c5-4745-99f4-446432722094 https://github.com/o/r/pull/1601');
    expect(a).toEqual(new Set([
      'sha:4c3e7f2', 'ref:#1600', 'msg:harkroom://message/1e086e53-91c5-4745-99f4-446432722094', 'ref:#1601',
    ]));
  });

  it('시각·날짜·숫자만 있는 낱말은 결과물이 아니다', () => {
    expect(chainArtifacts('10:15 KST, 2026-10-27 에 1234567 건 확인')).toEqual(new Set());
  });

  it('짧은 sha 와 긴 sha 는 같은 결과물이다 — 같은 head 를 되풀이하면 정체다', () => {
    expect(bringsNewArtifact('이미 4c3e7f2a 봤다', ['head 4c3e7f2a83f63b23bcde61b7e309c5aaa8ba14b4'])).toBe(false);
  });

  it('앞 줄에 없던 번호가 하나라도 있으면 새 결과물이다', () => {
    expect(bringsNewArtifact('#1600 다음으로 #1601 올림', ['#1600 올림'])).toBe(true);
  });

  it('첨부는 언제나 새 결과물이다', () => {
    expect(bringsNewArtifact('캡처', [], true)).toBe(true);
  });

  it('사슬 밖이면 0, 결과물이 나오면 0 으로, 아니면 앞 고리 + 1', () => {
    expect(nextStallDepth({ mentionDepth: 0, prevStall: 3, body: '확인', recentBodies: [] })).toBe(0);
    expect(nextStallDepth({ mentionDepth: 5, prevStall: 3, body: 'head abc1234 올림', recentBodies: [] })).toBe(0);
    expect(nextStallDepth({ mentionDepth: 5, prevStall: 3, body: '이미 봤다', recentBodies: [] })).toBe(4);
  });
});
