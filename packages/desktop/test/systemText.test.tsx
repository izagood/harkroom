import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SYSTEM_I18N_ARGS, UNKNOWN_ACCOUNT_LABEL, type MessageRow } from '@harkroom/shared';
import { en } from '../src/i18n/en';
import { ko } from '../src/i18n/ko';
import { translator } from '../src/i18n';
import { systemText } from '../src/lib/systemText';
import { displayBody } from '../src/lib/mention';
import { usePrefsStore } from '../src/state/prefsStore';
import { useActiveStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

/**
 * 서버 시스템 줄의 번역 표지(`meta.i18n`)를 앱 언어로 그린다(i18n P5 ②). security C2·C3·C4·n2, designer 규칙 1.
 */
const accounts = { a1: { handle: 'mira' }, g1: { handle: 'jaebin' } };
const sys = (i18n: unknown, kind: MessageRow['kind'] = 'system') =>
  ({ kind, meta: { i18n } }) as Pick<MessageRow, 'kind' | 'meta'>;
const tEn = translator('en');
const tKo = translator('ko');

describe('사전과 서버 키 표가 맞는다', () => {
  const placeholders = (m: unknown) => new Set([...String(m).matchAll(/\{(\w+)(?::[^}]+)?\}/g)].map((x) => x[1]));
  it('서버 키 표의 모든 키가 en·ko 사전에 있고, 자리표시자가 그 키의 인자와 정확히 같다', () => {
    for (const [key, names] of Object.entries(SYSTEM_I18N_ARGS) as [string, readonly string[]][]) {
      for (const [lang, dict] of [['en', en], ['ko', ko]] as const) {
        expect(Object.hasOwn(dict, key), `${lang} ${key}`).toBe(true);
        expect([...placeholders((dict as Record<string, unknown>)[key])].sort(), `${lang} ${key}`).toEqual([...names].sort());
      }
    }
  });
});

describe('systemText', () => {
  it('키와 인자를 고른 언어의 문장으로 — id 는 지금 이름으로(C4)', () => {
    const m = sys({ key: 'system.member.added', args: { accountId: 'a1' } });
    expect(systemText(m, accounts, tEn)).toBe('mira was added to the channel.');
    expect(systemText(m, accounts, tKo)).toBe('mira님이 채널에 추가됐다.');
  });

  it('모르는 id 는 「알 수 없음」 — id 를 그대로 보이지 않는다(designer 규칙 1)', () => {
    const out = systemText(sys({ key: 'system.member.left', args: { accountId: 'zzz-uuid' } }), accounts, tEn)!;
    expect(out).toContain(UNKNOWN_ACCOUNT_LABEL);
    expect(out).not.toContain('zzz-uuid');
  });

  it('시스템 줄이 아니면 그리지 않는다(C2)', () => {
    expect(systemText(sys({ key: 'system.member.added', args: { accountId: 'a1' } }, 'user'), accounts, tEn)).toBeNull();
  });

  it('목록 밖 키·모양이 틀린 표지는 그리지 않는다(C3)', () => {
    for (const bad of [{ key: '__proto__', args: {} }, { key: 'constructor', args: {} },
      { key: 'system.member.added', args: {} }, { key: 'system.member.added', args: { accountId: { x: 1 } } }, 'x', null]) {
      expect(systemText(sys(bad), accounts, tEn), JSON.stringify(bad)).toBeNull();
    }
  });

  it('인자의 제어 문자·방향 바꿈 문자를 지운다(C4)', () => {
    const out = systemText(sys({ key: 'system.skill.proposed', args: { slug: 'evil‮gnp.exe\nnext' } }), accounts, tEn)!;
    expect(out).not.toMatch(/[‮\n]/);
  });

  it('막힘 사유 code 는 사전에 있는 것만 옮기고 모르는 것은 글자 그대로(security n2)', () => {
    const base = { agentId: 'a1', connector: 'lab', request: 'GET /x' };
    expect(systemText(sys({ key: 'system.apiBlocked', args: { ...base, code: 'not_granted' } }), accounts, tKo)).toContain('권한 없음');
    expect(systemText(sys({ key: 'system.apiBlocked', args: { ...base, code: 'weird_code' } }), accounts, tKo)).toContain('weird_code');
  });
});

describe('displayBody — 미리보기·알림도 앱 언어', () => {
  afterEach(() => usePrefsStore.getState().setLocale('system'));
  it('표지가 있으면 사전 문장, 없으면(옛 줄) 본문', () => {
    usePrefsStore.getState().setLocale('en');
    const withTag = { body: '{account}님이 채널에 추가되었습니다.', kind: 'system', meta: { accountId: 'a1', i18n: { key: 'system.member.added', args: { accountId: 'a1' } } } } as Pick<MessageRow, 'body' | 'kind' | 'meta'>;
    expect(displayBody(withTag, accounts)).toBe('mira was added to the channel.');
    const old = { ...withTag, meta: { accountId: 'a1' } } as Pick<MessageRow, 'body' | 'kind' | 'meta'>;
    expect(displayBody(old, accounts)).toBe('mira님이 채널에 추가되었습니다.');
  });
});

describe('MessageItem — 시스템 줄은 글로만 그린다(C4)', () => {
  afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });
  it('인자에 마크다운·링크가 있어도 렌더하지 않는다', () => {
    usePrefsStore.getState().setLocale('en');
    useActiveStore.getState().reset();
    useActiveStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me'), a1: acc('a1', 'mira') }, messages: { c1: [] } });
    const m = msg('s1', 'c1', 1, 'fallback', 'a1', {
      kind: 'system',
      meta: { i18n: { key: 'system.skill.proposed', args: { slug: '**bold** [x](https://evil.example)' } } },
    });
    render(<MessageItem message={m} />);
    const line = screen.getByTestId('system-i18n-line');
    expect(line.textContent).toBe('Skill proposed: **bold** [x](https://evil.example) — waiting for approval.');
    expect(line.querySelector('a, strong')).toBeNull();
  });
});
