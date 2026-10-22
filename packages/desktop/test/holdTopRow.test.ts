/**
 * **위쪽이 바뀐 만큼만 창을 옮긴다**(`lib/holdTopRow.ts`). 과거가 붙거나 자리표시가 섰다 빠질 때
 * 그 전 첫 줄이 새 목록에서 내려간 거리가 곧 옮길 거리다.
 */
import { describe, it, expect } from 'vitest';
import { topRowShift } from '../src/lib/holdTopRow';

describe('topRowShift', () => {
  const starts: Record<string, number> = { m50: 3600, m0: 0 };
  const startOf = (k: string) => (k in starts ? starts[k]! : null);

  it('처음 그릴 때(그 전 줄이 없다)는 옮기지 않는다', () => {
    expect(topRowShift(null, startOf)).toBe(0);
  });
  it('과거가 앞에 붙으면 그 전 첫 줄이 내려간 만큼 옮긴다', () => {
    expect(topRowShift({ key: 'm50', start: 0 }, startOf)).toBe(3600);
  });
  it('자리표시가 빠지면 위로 올라간 만큼(음수) 옮긴다', () => {
    expect(topRowShift({ key: 'm0', start: 216 }, startOf)).toBe(-216);
  });
  it('그 전 첫 줄이 사라졌으면 기준이 없으니 옮기지 않는다', () => {
    expect(topRowShift({ key: 'gone', start: 0 }, startOf)).toBe(0);
  });
});
