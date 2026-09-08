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
  delete (globalThis as Record<string, unknown>).__AGENT_VERSION__;
});

/**
 * 번들에 구워진 값을 흉내낸다.
 *
 * 실제 배포에서는 esbuild `define` 이 `__AGENT_VERSION__` 을 **문자열 리터럴로 치환**
 * 하므로 전역 같은 것은 관여하지 않는다(`packages/desktop/scripts/sidecar.mjs`).
 * 테스트에서는 치환할 수 없으므로 같은 이름의 전역을 두어 bare 식별자가 그것을 가리키게
 * 한다 — `version.ts` 가 그 식별자를 `typeof` 로만 만지기 때문에 이 흉내가 성립한다.
 */
const bake = (value: string) => {
  (globalThis as Record<string, unknown>).__AGENT_VERSION__ = value;
};

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

  /**
   * **앱 밖에서 뜬 러너도 자기 버전을 안다.** env 는 누가 띄웠는가에 달린 값이라, 앱이
   * 띄우지 않은 러너(사람이 직접 띄운 것, 앞 세대가 남긴 것)에는 아무도 심어 주지
   * 않는다. 구운 값은 "어느 번들에서 나왔나"라서 그 러너도 답할 수 있다.
   */
  it('env 가 없으면 번들에 구워진 값을 쓴다', async () => {
    bake('0.1.80');
    expect(await loadVersion()).toBe('0.1.80');
  });

  it('env 가 구운 값을 덮는다 — 오버라이드가 아래에 있으면 오버라이드가 아니다', async () => {
    bake('0.1.80');
    process.env.AGENT_VERSION = 'abc1234';
    expect(await loadVersion()).toBe('abc1234');
  });

  it('구운 값이 빈 문자열이면 없는 것으로 본다 — 치환이 실패한 것과 같다', async () => {
    bake('');
    expect(await loadVersion()).toBe('unknown');
  });

  it('빈 문자열도 unknown 으로 떨어지지 않는다면 그 사실이 드러나야 한다', async () => {
    process.env.AGENT_VERSION = '';
    // `??` 는 빈 문자열을 통과시킨다. 배포가 실수로 빈 값을 넣으면 "버전 있음"으로
    // 보이게 되므로, 현재 동작을 명시해 둔다(바꾸려면 이 테스트가 먼저 빨개진다).
    expect(await loadVersion()).toBe('');
  });
});
