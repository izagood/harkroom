// env 와 앱 설정 중 무엇이 이기는가. **판정이 한 벌이어야 한다** — 서버와 화면이 각자
// 판정하면 화면과 API 가 같은 상태를 다른 말로 부른다(projectionState 와 같은 이유).
import { describe, it, expect } from 'vitest';
import { resolveProjectionUrl } from '../src/index.js';

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
});
