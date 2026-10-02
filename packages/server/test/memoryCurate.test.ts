import { describe, expect, it } from 'vitest';
import { bodyTokens, coreSections, pickExpiringJournals, refTokens } from '../src/services/memory.js';

// C1 의 순수 부분 — pg 없이 돈다.
describe('coreSections', () => {
  it('절(## 제목) 단위 길이를 긴 것부터, 머리는 "(머리)"', () => {
    const v = `포인터 줄\n## 저장소\n${'a'.repeat(50)}\n## 규칙\n${'b'.repeat(200)}\n### 하위\ncc`;
    expect(coreSections(v)).toEqual([
      { heading: '규칙', chars: 207 },
      { heading: '저장소', chars: 58 },
      { heading: '하위', chars: 10 },
      { heading: '(머리)', chars: 6 },
    ]);
  });
  it('제목이 없으면 머리 하나, limit 으로 자른다', () => {
    expect(coreSections('abc')).toEqual([{ heading: '(머리)', chars: 4 }]);
    expect(coreSections('# a\nx\n# b\nyy\n# c\nzzz', 2).map((s) => s.heading)).toEqual(['c', 'b']);
  });
});

describe('pickExpiringJournals', () => {
  const j = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `mem/j${String(i).padStart(2, '0')}`, updatedAt: new Date(1_000_000 + i * 1000) }));
  it('55개 이하면 비어 있다', () => {
    expect(pickExpiringJournals(j(55))).toEqual([]);
  });
  it('56개부터 가장 오래된 것부터 (개수−55)개', () => {
    expect(pickExpiringJournals(j(56))).toEqual(['mem/j00']);
    expect(pickExpiringJournals(j(60))).toEqual(['mem/j00', 'mem/j01', 'mem/j02', 'mem/j03', 'mem/j04']);
  });
});

describe('bodyTokens / refTokens', () => {
  it('두 글자 이상 낱말, 소문자, 중복 없음', () => {
    expect([...bodyTokens('A a 러너는 러너는 x PR #802')].sort()).toEqual(['802', 'pr', '러너는']);
  });
  it('#번호는 세 자리 이상만, 낱말에 붙은 # 은 아니다', () => {
    expect([...refTokens('PR #802 와 #1126, 목록 #1 #22, a#999 는 아님, 색 #fff 도 아님')].sort()).toEqual(['#1126', '#802']);
  });
});
