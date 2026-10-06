import { describe, it, expect } from 'vitest';
import { addRange, coversSeq } from '../src/lib/seqCoverage';

describe('seqCoverage — 받아 온 seq 구간', () => {
  it('구간 하나를 적고 안팎을 가른다', () => {
    const r = addRange([], { lo: 1001, hi: Infinity });
    expect(coversSeq(r, 1001)).toBe(true);
    expect(coversSeq(r, 99_999)).toBe(true);
    expect(coversSeq(r, 1000)).toBe(false);
  });

  it('겹치거나 맞닿은 구간은 하나로 합친다', () => {
    let r = addRange([], { lo: 1001, hi: Infinity });
    // `before: 1001` 페이지 — 1000 까지를 말한 것이므로 맞닿았다.
    r = addRange(r, { lo: 800, hi: 1000 });
    expect(r).toEqual([{ lo: 800, hi: Infinity }]);
    // 점프 창이 그 아래 따로 선다.
    r = addRange(r, { lo: 201, hi: 400 });
    expect(r).toEqual([{ lo: 201, hi: 400 }, { lo: 800, hi: Infinity }]);
    expect(coversSeq(r, 300)).toBe(true);
    expect(coversSeq(r, 500)).toBe(false);
    // 둘 사이를 메우는 페이지가 오면 셋이 하나가 된다.
    r = addRange(r, { lo: 350, hi: 799 });
    expect(r).toEqual([{ lo: 201, hi: Infinity }]);
  });

  it('빈 구간(lo > hi)은 아무것도 적지 않는다', () => {
    expect(addRange([{ lo: 5, hi: 9 }], { lo: 10, hi: 9 })).toEqual([{ lo: 5, hi: 9 }]);
  });
});
