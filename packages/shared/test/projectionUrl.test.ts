// env 와 앱 설정 중 무엇이 이기는가. **판정이 한 벌이어야 한다** — 서버와 화면이 각자
// 판정하면 화면과 API 가 같은 상태를 다른 말로 부른다(projectionState 와 같은 이유).
import { describe, it, expect } from 'vitest';
import { resolveProjectionUrl, canonicalAvcsBaseUrl } from '../src/index.js';

describe('resolveProjectionUrl', () => {
  it('앱 값이 있으면 env 를 무시한다', () => {
    expect(resolveProjectionUrl('http://env', 'http://app'))
      .toEqual({ url: 'http://app', source: 'app' });
  });

  it('앱 값이 없으면 env 를 쓴다', () => {
    expect(resolveProjectionUrl('http://env', null))
      .toEqual({ url: 'http://env', source: 'env' });
  });

  /** 출처 없는 값에 출처를 붙이지 않는다 — 'env' 라고 답하면 화면이 없는 설정을 있다고 말한다. */
  it('둘 다 없으면 url 도 source 도 null 이다', () => {
    expect(resolveProjectionUrl(null, null)).toEqual({ url: null, source: null });
  });

  /** 빈 문자열은 '없음'이다. 이것을 값으로 받으면 지우기와 오타 저장이 같은 값이 된다. */
  it('빈 문자열은 값으로 세지 않는다', () => {
    expect(resolveProjectionUrl('http://env', '')).toEqual({ url: 'http://env', source: 'env' });
    expect(resolveProjectionUrl('', null)).toEqual({ url: null, source: null });
  });

  /**
   * Minor 3 회귀선 — **"절반만 닫힌다"를 막는 단언이 이것이다.** 표준형을 PUT 스키마에만
   * 넣으면 env 값은 손대지 않은 채 그대로 `baseUrl` → 키로 흘러간다. `AVCS_BASE_URL=
   * http://a:3000/` 로 뜬 서버와 앱에서 `http://a:3000` 을 저장한 서버가 여전히 다른
   * 행을 쓰게 된다 — 그러니 env 쪽도 표준형으로 나오는지 반드시 확인해야 한다.
   */
  it('env 쪽도 표준형으로 돌아온다 — 앱 값만 표준화하면 env 경유 URL 은 여전히 겉모습이 다르다', () => {
    expect(resolveProjectionUrl('http://ENV.example:80/a/', null))
      .toEqual({ url: 'http://env.example/a', source: 'env' });
  });

  it('앱 값도 표준형으로 돌아온다', () => {
    expect(resolveProjectionUrl(null, 'http://APP.example:80/a/'))
      .toEqual({ url: 'http://app.example/a', source: 'app' });
  });

  /** 표준형이 null(URL 형태가 아님)이면 값이 없는 것으로 보고 다음 출처로 떨어진다. */
  it('앱 값이 URL 형태가 아니면 env 로 떨어진다', () => {
    expect(resolveProjectionUrl('http://env', 'not-a-url'))
      .toEqual({ url: 'http://env', source: 'env' });
  });
});

describe('canonicalAvcsBaseUrl', () => {
  it('후행 슬래시 하나를 자른다', () => {
    expect(canonicalAvcsBaseUrl('http://a:3000/')).toBe('http://a:3000');
  });

  it('후행 슬래시 여러 개도 전부 자른다', () => {
    expect(canonicalAvcsBaseUrl('http://a:3000///')).toBe('http://a:3000');
  });

  it('스킴·호스트를 소문자화한다', () => {
    expect(canonicalAvcsBaseUrl('HTTP://A.EXAMPLE:3000')).toBe('http://a.example:3000');
  });

  it('명시적 기본 포트(80/443)를 접는다', () => {
    expect(canonicalAvcsBaseUrl('http://a:80')).toBe('http://a');
    expect(canonicalAvcsBaseUrl('https://a:443')).toBe('https://a');
  });

  it('비기본 포트는 남긴다', () => {
    expect(canonicalAvcsBaseUrl('http://a:3000')).toBe('http://a:3000');
  });

  it('경로 대소문자는 보존한다 — 경로는 실제로 대소문자를 구분한다', () => {
    expect(canonicalAvcsBaseUrl('http://a/Org/Repo')).toBe('http://a/Org/Repo');
  });

  it('ftp: 등 형태가 다르면 null 이다', () => {
    expect(canonicalAvcsBaseUrl('ftp://a:3000')).toBeNull();
    expect(canonicalAvcsBaseUrl('not-a-url')).toBeNull();
  });
});
