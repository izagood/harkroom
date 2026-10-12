import { describe, expect, it } from 'vitest';
import { guardMetaI18n, systemI18n } from '../src/services/systemI18n.js';

/**
 * 시스템 줄 번역 표지의 **쓰기 규칙**(i18n P5 ①). DB 없이 도는 판정만 잰다 — 실제 게시·백필은
 * `systemI18nMessages.test.ts`.
 */
describe('guardMetaI18n — 사람·에이전트 글에는 표지가 남지 않는다(security C1)', () => {
  const i18n = { key: 'system.member.added', args: { accountId: 'a1' } };

  it('user·progress·wake 글의 meta.i18n 은 지운다 — 다른 칸은 그대로', () => {
    for (const kind of [undefined, 'user', 'progress', 'wake']) {
      expect(guardMetaI18n(kind, { i18n, ask: { x: 1 } }), String(kind)).toEqual({ ask: { x: 1 } });
    }
  });

  it('system 줄도 모양이 틀린 표지는 지운다', () => {
    expect(guardMetaI18n('system', { i18n: { key: 'constructor', args: {} }, accountId: 'a1' })).toEqual({ accountId: 'a1' });
    expect(guardMetaI18n('system', { i18n: { key: 'system.member.added', args: { accountId: {} } } })).toEqual({});
  });

  it('system 줄의 올바른 표지는 남긴다', () => {
    expect(guardMetaI18n('system', { i18n, accountId: 'a1' })).toEqual({ i18n, accountId: 'a1' });
  });

  it('표지가 없으면 손대지 않는다', () => {
    const meta = { accountId: 'a1' };
    expect(guardMetaI18n('user', meta)).toBe(meta);
    expect(guardMetaI18n('user', undefined)).toBeUndefined();
  });
});

describe('systemI18n — 서버 빌더', () => {
  it('키 표와 맞으면 표지를 낸다', () => {
    expect(systemI18n('system.skill.proposed', { slug: 'deploy' })).toEqual({ key: 'system.skill.proposed', args: { slug: 'deploy' } });
  });

  it('긴 문자열 인자는 잘라서 싣는다 — 표지 전체를 잃지 않는다', () => {
    const out = systemI18n('system.apiCall.unreachable', { connector: 'c', method: 'GET', path: `/${'x'.repeat(500)}` });
    expect((out.args.path as string).length).toBe(200);
  });

  it('인자가 키 표와 어긋나면 던진다 — 서버 코드의 실수를 조용히 넘기지 않는다', () => {
    // 타입이 먼저 막는다(n1-a) — 실행 중 검사도 남아 있는지 `as never` 로 우회해 잰다.
    expect(() => systemI18n('system.member.added', {} as never)).toThrow();
    expect(() => systemI18n('system.member.added', { accountId: 'a', more: 'b' } as never)).toThrow();
  });
});
