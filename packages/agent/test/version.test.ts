import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `version.ts` 는 **모듈 로드 시점에** env 를 읽는다. 그래서 import 후에 env 를 바꿔도
 * 값이 안 바뀐다 — `resetModules` + 동적 import 로 매번 새로 읽게 해야 실제로 env 에서
 * 온다는 것을 검증할 수 있다.
 *
 * 앞선 초안은 `expect(VERSION).not.toBe('0.1.0')` 였는데, 테스트에서 값이 `unknown` 이라
 * **자동으로 통과했다** — 누가 아무 문자열을 하드코딩해도 통과하는 테스트였다.
 */
const loadVersion = async (): Promise<string> => {
  vi.resetModules();
  const mod = await import('../src/version.js');
  return mod.VERSION;
};

const original = process.env.AGENT_VERSION;
beforeEach(() => { delete process.env.AGENT_VERSION; });
afterEach(() => {
  if (original === undefined) delete process.env.AGENT_VERSION;
  else process.env.AGENT_VERSION = original;
});

describe('러너 버전', () => {
  it('AGENT_VERSION 에서 온다', async () => {
    process.env.AGENT_VERSION = 'abc1234';
    expect(await loadVersion()).toBe('abc1234');
  });

  it('커밋이 다르면 값이 다르다 — 이게 이 이슈의 요구 전체다', async () => {
    process.env.AGENT_VERSION = 'aaaaaaa';
    const first = await loadVersion();
    process.env.AGENT_VERSION = 'bbbbbbb';
    const second = await loadVersion();
    expect(first).not.toBe(second);
  });

  // 거짓 버전을 보내지 않는다 — docs/design.md 4절.
  it('값이 없으면 unknown 이다', async () => {
    expect(await loadVersion()).toBe('unknown');
  });

  it('빈 문자열도 unknown 으로 떨어지지 않는다면 그 사실이 드러나야 한다', async () => {
    process.env.AGENT_VERSION = '';
    // `??` 는 빈 문자열을 통과시킨다. 배포가 실수로 빈 값을 넣으면 "버전 있음"으로
    // 보이게 되므로, 현재 동작을 명시해 둔다(바꾸려면 이 테스트가 먼저 빨개진다).
    expect(await loadVersion()).toBe('');
  });
});
