/**
 * 투영 설정을 부르는 두 창구와, **저장 직후 상태를 다시 읽는 창구**(설계 §6).
 *
 * 세 번째가 중요하다: 앱은 투영 상태를 60 초 주기로 갱신한다(`controller.ts` 의
 * `projectionRefreshInterval`). 그 주기에 맡기면 방금 켠 투영이 최대 1 분 동안 꺼진
 * 것처럼 보이고, 사용자는 저장이 실패했다고 읽는다.
 *
 * `ApiClient` 는 fetch 를 주입받지 않고 전역을 쓴다 — `api.test.ts` 의 `stubFetch`
 * 관용구를 그대로 베낀다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProjectionConfigView } from '@harkroom/shared';
import { ApiClient } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const view: ProjectionConfigView = {
  url: 'http://app.example:5000', source: 'app',
  appUrl: 'http://app.example:5000', envUrl: 'http://env.example:4000',
};

describe('ApiClient — 투영 설정', () => {
  it('GET /settings/projection 을 부른다', async () => {
    const fn = stubFetch(200, view);
    const api = new ApiClient('http://x:3400', 'tok');

    expect(await api.projectionConfig()).toEqual(view);

    const [url] = fn.mock.calls[0]! as unknown as [string];
    expect(url).toBe('http://x:3400/settings/projection');
  });

  /**
   * 지우기는 **명시적 null** 이다. 빈 문자열로 보내면 서버가 400 을 내고, 키를 빼면
   * `JSON.stringify` 가 통째로 버려 '손대지 않음' 이 된다.
   */
  it('지우기를 null 로 보낸다', async () => {
    const fn = stubFetch(200, { url: null, source: null, appUrl: null, envUrl: null });
    const api = new ApiClient('http://x:3400', 'tok');

    await api.setProjectionConfig(null);

    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://x:3400/settings/projection');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ url: null });
  });

  /** admin 이 아니면 403 이다. 삼키지 않고 던져야 호출부가 그것을 가릴 수 있다. */
  it('403 을 삼키지 않는다', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'nope' } });
    const api = new ApiClient('http://x:3400', 'tok');

    await expect(api.projectionConfig()).rejects.toMatchObject({ status: 403 });
  });
});
