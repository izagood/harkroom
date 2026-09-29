// 오퍼레이터가 hello 에 싣는 버전 — 화면의 러너 뒤처짐 판정 기준이다(`src/version.ts`).
import { describe, it, expect } from 'vitest';
import { operatorVersion } from '../src/version.js';

describe('operatorVersion', () => {
  it('앱·env 가 준 값이 먼저다 — 러너에 AGENT_VERSION 으로 심는 값이 그것이다', () => {
    expect(operatorVersion('0.3.47', '0.3.40')).toBe('0.3.47');
  });
  it('주어진 값이 없으면(헤드리스, env 없음) 번들에 구운 값으로 물러선다', () => {
    expect(operatorVersion(undefined, '0.3.45')).toBe('0.3.45');
    expect(operatorVersion(null, '0.3.45')).toBe('0.3.45');
    expect(operatorVersion('', '0.3.45')).toBe('0.3.45');
  });
  it('둘 다 없으면 null — 거짓 버전을 보내지 않는다', () => {
    expect(operatorVersion(undefined, null)).toBeNull();
    // 소스에서 도는 테스트 환경에는 구운 값이 없다.
    expect(operatorVersion(undefined)).toBeNull();
  });
});
