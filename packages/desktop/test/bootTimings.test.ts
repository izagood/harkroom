/**
 * 콜드 스타트 계측(0단계) — 지점은 프로세스에서 한 번만 찍히고, 이름과 밀리초만 남는다.
 * 릴리스 번들에는 개발자 도구가 없어 `localStorage` 에서 읽으므로 그 모양을 못 박는다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BOOT_TIMINGS_KEY, markBoot, resetBootTimingsForTest } from '../src/lib/bootTimings';

beforeEach(() => {
  localStorage.clear();
  resetBootTimingsForTest();
});

describe('bootTimings', () => {
  it('지점마다 한 번만 찍고 localStorage 에 이름→밀리초로 남긴다', () => {
    markBoot('boot');
    markBoot('start:done');
    const first = JSON.parse(localStorage.getItem(BOOT_TIMINGS_KEY)!);
    markBoot('start:done');
    const second = JSON.parse(localStorage.getItem(BOOT_TIMINGS_KEY)!);
    expect(second.marks['start:done']).toBe(first.marks['start:done']);
    expect(Object.keys(second.marks).sort()).toEqual(['boot', 'start:done']);
    expect(typeof second.at).toBe('string');
    for (const v of Object.values(second.marks)) expect(Number.isInteger(v)).toBe(true);
  });
});
