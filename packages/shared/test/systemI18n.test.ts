import { describe, expect, it } from 'vitest';
import {
  SYSTEM_I18N_ARGS, SYSTEM_I18N_MAX_ARG_LENGTH, SYSTEM_I18N_MAX_ARGS, isSystemI18nKey, parseSystemI18n,
} from '../src/systemI18n.js';

/**
 * 시스템 줄 번역 표지의 **읽기 규칙**(i18n P5, security C3·C4). 서버는 쓸 때, 앱은 그릴 때 이 함수를 지난다 —
 * 어긋난 표지는 `null` 이고, 그러면 화면은 본문으로 물러난다.
 */
describe('parseSystemI18n', () => {
  it('목록의 키와 그 키의 인자를 받는다', () => {
    expect(parseSystemI18n({ key: 'system.member.added', args: { accountId: 'a1' } }))
      .toEqual({ key: 'system.member.added', args: { accountId: 'a1' } });
    expect(parseSystemI18n({ key: 'system.merge.failed', args: { repo: 'o/r', number: 12, head: 'abc' } }))
      .toEqual({ key: 'system.merge.failed', args: { repo: 'o/r', number: 12, head: 'abc' } });
  });

  it('목록 밖 키는 버린다 — 프로토타입의 이름도 키가 아니다', () => {
    for (const key of ['system.nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 42, null]) {
      expect(parseSystemI18n({ key, args: {} }), String(key)).toBeNull();
      expect(isSystemI18nKey(key), String(key)).toBe(false);
    }
  });

  it('인자가 빠지거나 남거나 이름이 다르면 버린다', () => {
    expect(parseSystemI18n({ key: 'system.member.added', args: {} })).toBeNull();
    expect(parseSystemI18n({ key: 'system.member.added', args: { accountId: 'a', extra: 'x' } })).toBeNull();
    expect(parseSystemI18n({ key: 'system.member.added', args: { account: 'a' } })).toBeNull();
  });

  it('인자는 원시값만 — 객체·배열·불·null·무한대는 버린다', () => {
    for (const v of [{}, [], true, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseSystemI18n({ key: 'system.member.added', args: { accountId: v } }), String(v)).toBeNull();
    }
  });

  it('긴 문자열 인자는 버린다(상한 길이)', () => {
    expect(parseSystemI18n({ key: 'system.member.added', args: { accountId: 'x'.repeat(SYSTEM_I18N_MAX_ARG_LENGTH) } })).not.toBeNull();
    expect(parseSystemI18n({ key: 'system.member.added', args: { accountId: 'x'.repeat(SYSTEM_I18N_MAX_ARG_LENGTH + 1) } })).toBeNull();
  });

  it('모양이 아닌 값은 버린다', () => {
    for (const v of [null, undefined, 'system.member.added', [], 1, { key: 'system.member.added' }, { key: 'system.member.added', args: [] }]) {
      expect(parseSystemI18n(v)).toBeNull();
    }
  });

  it('키 표의 어느 키도 인자 상한을 넘지 않는다', () => {
    for (const [key, names] of Object.entries(SYSTEM_I18N_ARGS) as [string, readonly string[]][]) {
      expect(names.length, key).toBeLessThanOrEqual(SYSTEM_I18N_MAX_ARGS);
      expect(new Set(names).size, key).toBe(names.length);
    }
  });
});
