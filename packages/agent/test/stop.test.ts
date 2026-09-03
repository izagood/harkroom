// 종료 요청 판정(#129). 시각 비교가 왜 필요한지를 고정한다 — 이 규칙이 없으면 요청이
// 컬럼에 남아 있는 한 새 러너가 뜰 때마다 곧바로 죽는다.
import { describe, expect, it } from 'vitest';
import { stopRequestedForRunner } from '../src/stop.js';

const STARTED = Date.parse('2026-09-03T10:00:00.000Z');

describe('stopRequestedForRunner', () => {
  it('요청이 없으면 물러나지 않는다', () => {
    expect(stopRequestedForRunner(null, STARTED)).toBe(false);
  });

  it('기동 뒤에 온 요청이면 물러난다', () => {
    expect(stopRequestedForRunner('2026-09-03T10:00:01.000Z', STARTED)).toBe(true);
  });

  it('기동 전에 남아 있던 요청으로는 물러나지 않는다 — 앞 러너에게 한 요청이다', () => {
    // 이것이 없으면 종료 요청 한 번이 그 에이전트를 영구히 못 뜨게 만든다:
    // 운영자가 다시 띄울 때마다 새 러너가 같은 값을 읽고 즉시 죽는다.
    expect(stopRequestedForRunner('2026-09-03T09:59:59.000Z', STARTED)).toBe(false);
  });

  it('읽을 수 없는 값으로는 물러나지 않는다', () => {
    // 종료는 사람이 손으로 되돌려야 하는 동작이다(murmur 는 러너를 띄우지 못한다).
    expect(stopRequestedForRunner('언젠가', STARTED)).toBe(false);
  });
});
