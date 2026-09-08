/**
 * 바닥 판정의 경계. 부호 하나로 뒤집히는 계산이라 값으로 못 박아 둔다
 * (컴포넌트 회귀선은 `jumpToBottom.test.tsx`).
 */
import { describe, it, expect } from 'vitest';
import { NEAR_BOTTOM_PX, distanceFromBottom, isNearBottom } from '../src/lib/stickyBottom';

describe('stickyBottom', () => {
  it('바닥까지 남은 거리를 재고, 고무줄 스크롤은 0 으로 접는다', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 })).toBe(1500);
    expect(distanceFromBottom({ scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 })).toBe(0);
    // 관성 스크롤이 바닥을 넘긴 순간(음수)에도 "바닥"이어야 한다.
    expect(distanceFromBottom({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 500 })).toBe(0);
  });

  it('여유 안쪽은 바닥으로 치고, 한 줄 이상 떨어지면 아니다', () => {
    const at = (top: number) => isNearBottom({ scrollTop: top, scrollHeight: 2000, clientHeight: 500 });
    expect(at(1500)).toBe(true);
    expect(at(1500 - NEAR_BOTTOM_PX)).toBe(true);
    expect(at(1500 - NEAR_BOTTOM_PX - 1)).toBe(false);
    expect(at(0)).toBe(false);
  });

  it('스크롤이 없는 상자와 레이아웃이 없는 환경(jsdom)은 바닥이다', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });
});
