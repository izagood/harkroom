/**
 * `lib/scrollAnchor.ts` 의 계산만 잰다 — 부호 하나로 뒤집히는 자리라 순수 함수로 떼어 뒀다
 * (`stickyBottom.test.ts` 와 같은 이유).
 */
import { describe, it, expect } from 'vitest';
import { pickAnchor, anchoredScrollTop, needsAnchorFix } from '../src/lib/scrollAnchor';

const rows = [{ top: 0 }, { top: 100 }, { top: 250 }, { top: 600 }];

describe('pickAnchor', () => {
  it('시야에 걸친 첫 줄을 고른다', () => {
    // 120 을 보고 있으면 100 짜리 줄은 반쯤 지나갔다 — 다음 줄(250)이 시야의 첫 줄이다.
    expect(pickAnchor(rows, 120)).toEqual({ top: 250, offset: 130 });
  });

  it('줄의 맨 위에 정확히 서 있으면 그 줄을 고른다', () => {
    expect(pickAnchor(rows, 250)).toEqual({ top: 250, offset: 0 });
  });

  it('전부 위로 지나갔으면 마지막 줄을 고른다', () => {
    // 긴 메시지 하나가 화면을 다 채운 경우다. 붙잡을 것이 없다고 답하면 정작 가장 흔한
    // 자리에서 보정이 죽는다 — 그때도 그 줄이 기준이고, 음수 offset 이 그 사실을 담는다.
    expect(pickAnchor(rows, 900)).toEqual({ top: 600, offset: -300 });
  });

  it('줄이 없으면 붙잡지 않는다', () => {
    expect(pickAnchor([], 0)).toBeNull();
  });
});

describe('anchoredScrollTop', () => {
  it('그 줄이 같은 자리에 오도록 되돌린다', () => {
    // 위쪽에 30px 이 끼어들어 줄이 250 → 280 으로 밀렸다. 보던 자리를 지키려면 30 만큼 더 내린다.
    expect(anchoredScrollTop({ top: 250, offset: 130 }, 280)).toBe(150);
  });

  it('음수로 내려가지 않는다', () => {
    expect(anchoredScrollTop({ top: 100, offset: 300 }, 100)).toBe(0);
  });
});

describe('needsAnchorFix', () => {
  it('1px 미만은 건드리지 않는다', () => {
    expect(needsAnchorFix(100, 100.4)).toBe(false);
    expect(needsAnchorFix(100, 101)).toBe(true);
  });
});
