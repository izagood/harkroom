import { describe, expect, it } from 'vitest';
import { isRunnerLinkNotice } from '../src/runnerLink.js';

/**
 * `runner.pollStopped` 의 `done`(2026-10-03, L2) — 생략 가능(옛 러너), 있으면 정수 배열이어야 한다.
 * 되돌려 RED: 검증기가 `done` 을 모르면 셋째 단언(잘못된 done 거절)이 깨지고, 필수로 만들면 첫째가 깨진다.
 */
describe('isRunnerLinkNotice — runner.pollStopped.done', () => {
  it('done 없이도(옛 러너) 받는다', () => {
    expect(isRunnerLinkNotice({ type: 'runner.pollStopped', holding: [1, 2] })).toBe(true);
  });
  it('done 이 정수 배열이면 받는다', () => {
    expect(isRunnerLinkNotice({ type: 'runner.pollStopped', holding: [], done: [7, 8] })).toBe(true);
  });
  it('done 이 배열이 아니거나 정수가 아니면 거절한다', () => {
    expect(isRunnerLinkNotice({ type: 'runner.pollStopped', holding: [], done: 'x' })).toBe(false);
    expect(isRunnerLinkNotice({ type: 'runner.pollStopped', holding: [], done: [1.5] })).toBe(false);
  });
});
