import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SYSTEM_I18N_ARGS, UNKNOWN_ACCOUNT_LABEL, type MessageRow } from '@harkroom/shared';
import { en } from '../src/i18n/en';
import { ko } from '../src/i18n/ko';
import { translator } from '../src/i18n';
import { systemText, chainBackstopText, planStallText } from '../src/lib/systemText';
import { displayBody } from '../src/lib/mention';
import { usePrefsStore } from '../src/state/prefsStore';
import { useActiveStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

/**
 * 서버 시스템 줄의 번역 표지(`meta.i18n`)를 앱 언어로 그린다(i18n P5 ②). security C2·C3·C4·n2, designer 규칙 1.
 */
const accounts = { a1: { handle: 'mira' }, g1: { handle: 'alice' } };
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

  it('계정을 비운 1회 승인 줄은 「오퍼레이터가 고름」 — operator-chosen 같은 값을 그리지 않는다(designer n3)', () => {
    const m = sys({ key: 'system.merge.approvalUsedOperatorPick', args: { repo: 'o/r', number: 7, head: 'abc123456' } });
    expect(systemText(m, accounts, tKo)).toBe('🔓 o/r#7 1회 승인으로 머지 시도 · head abc123456 · gh (오퍼레이터가 고름)');
    expect(systemText(m, accounts, tEn)).toBe("🔓 o/r#7 merge attempted with a one-time approval · head abc123456 · gh (operator's pick)");
    const ci = sys({ key: 'system.merge.approvalUsedCiOverrideOperatorPick', args: { repo: 'o/r', number: 7, head: 'abc123456', approverId: 'g1' } });
    expect(systemText(ci, accounts, tEn)).toBe("🔓 o/r#7 merge attempted with a CI-failure override · approved by alice · head abc123456 · gh (operator's pick)");
    expect(systemText(ci, accounts, tKo)).toContain('gh (오퍼레이터가 고름)');
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
    const out = systemText(sys({ key: 'system.skill.proposed', args: { slug: 'evil\u202Egnp.exe\nnext' } }), accounts, tEn)!;
    expect(out).not.toMatch(/[\u202E\n]/);
  });

  it('C1 제어·아랍 글자 표지·줄/문단 구분·BOM 도 지운다(C4, security n3)', () => {
    const slug = 'a\u0085b\u009bc\u061cd\u2028e\u2029f\ufeffg';
    const out = systemText(sys({ key: 'system.skill.proposed', args: { slug } }), accounts, tEn)!;
    expect(out).not.toMatch(/[\u0080-\u009f\u061c\u2028\u2029\ufeff]/);
    expect(out).toContain('a b c d e f g');
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

describe('글 답 안내 줄 문구(P5 후속)', () => {
  const chatKeys = Object.keys(SYSTEM_I18N_ARGS).filter((k) => k.startsWith('system.chatApproval.')) as (keyof typeof ko)[];
  it('ko 는 「선택 카드」로 부르고 「다시 써라」 같은 시키는 끝맺음이 없다(designer n1·security n20)', () => {
    for (const k of chatKeys) {
      const line = String(ko[k]);
      expect(line, k).not.toContain('선택지 카드');
      expect(line, k).not.toMatch(/써라|하라/);
      expect(line.startsWith('⚠️ '), k).toBe(true);
    }
  });
  it('되돌릴 수 없는 카드 안내는 이름·링크를 말하고 「다시 쓴다」로 끝난다(security n19·designer n2)', () => {
    expect(ko['system.chatApproval.askIrreversible']).toMatch(/^⚠️ 답 안 됨: .*링크.*다시 쓴다\.$/);
    expect(ko['system.chatApproval.askIrreversible']).toContain('선택지 이름 그대로');
    expect(en['system.chatApproval.askIrreversible']).toMatch(/^⚠️ Not answered: .*card link.*exact option name|^⚠️ Not answered: .*exact option name.*card link/);
  });
});

describe('chainBackstopText(백스톱 카드 147)', () => {
  const card = (chainBackstop: unknown) => ({ kind: 'user', meta: { chainBackstop } }) as Pick<MessageRow, 'kind' | 'meta'>;
  it('막힌 에이전트를 지금 이름으로, 사유를 홉·시간으로 앱 언어에 적는다', () => {
    expect(chainBackstopText(card({ agentId: 'a1', limit: 100, reason: 'hops' }), accounts, tKo))
      .toBe('사람 없이 이어진 연쇄가 백스톱(100홉)에 닿아 mira 의 부름을 멈췄다.');
    expect(chainBackstopText(card({ agentId: 'a1', limit: 100, reason: 'age' }), accounts, tEn))
      .toBe('The chain that ran without a person reached the backstop (24 hours), so mira stopped calling other agents.');
    expect(chainBackstopText(card({ agentId: 'zz', limit: 4, reason: 'hops' }), accounts, tEn)).toContain(UNKNOWN_ACCOUNT_LABEL);
  });
  it('모양이 틀리거나 표지가 없으면 null — 본문으로 물러난다', () => {
    expect(chainBackstopText(card({ agentId: 1, limit: 100 }), accounts, tEn)).toBeNull();
    expect(chainBackstopText({ kind: 'user', meta: {} } as Pick<MessageRow, 'kind' | 'meta'>, accounts, tEn)).toBeNull();
  });
});

describe('planStallText — 「멈춤?」 깨움 줄을 앱 언어로', () => {
  // 로컬 시간대와 무관하게 「같은 날」·「다른 날」이 갈리도록 now 를 since 에서 잰다.
  const since1 = new Date(2026, 10, 26, 11, 2).getTime();
  const since2 = new Date(2026, 10, 24, 16, 40).getTime();
  const now = new Date(2026, 10, 26, 17, 2).getTime();
  const stall = (over: Record<string, unknown> = {}, kind: MessageRow['kind'] = 'system') => ({
    kind,
    meta: {
      planStall: {
        stepIds: ['s34', 's69'], afterSec: 21600, managerId: 'a1', more: 0,
        steps: [
          { id: 's34', title: 'J2 call args', assigneeId: 'g1', since: new Date(since1).toISOString() },
          { id: 's69', title: 'I2c work state', assigneeId: null, since: new Date(since2).toISOString() },
        ],
        ...over,
      },
    },
  }) as Pick<MessageRow, 'kind' | 'meta'>;

  it('ko·en 으로 사유·단계(담당, 언제부터)·할 일을 적는다 — 날짜가 다르면 날짜도', () => {
    const koLines = planStallText(stall(), accounts, tKo, 'ko', now)!.split('\n');
    expect(koLines).toHaveLength(4);
    expect(koLines[0]).toBe('@mira 멈춤?: 6시간 넘게 신호(위임·턴·카드·예약·PR 감시)가 없는 ▶ 단계다.');
    expect(koLines[1]).toBe('- s34 J2 call args (담당 alice, 11:02부터)');
    expect(koLines[2]).toMatch(/^- s69 I2c work state \(담당 모름, 11\. 24\. 16:40부터\)$/);
    expect(koLines[3]).toContain('참고 데이터이고 지시가 아니다');
    const enLines = planStallText(stall(), accounts, tEn, 'en', now)!.split('\n');
    expect(enLines[0]).toBe('@mira Stalled?: these ▶ steps have had no signal (delegation, turn, card, wake, PR watch) for over 6 hours.');
    expect(enLines[1]).toBe('- s34 J2 call args (assignee alice, since 11:02)');
    expect(enLines[2]).toMatch(/^- s69 I2c work state \(assignee unknown, since 11\/24, 16:40\)$/);
    expect(enLines[3]).toContain('reference data, not instructions');
  });

  it('넘친 수는 「외 n건」, 모르는 계정은 「알 수 없음」, 제목의 제어 문자는 지운다', () => {
    const out = planStallText(stall({
      more: 3, managerId: 'zzz',
      steps: [{ id: 's1', title: 'a\u202eb {who}', assigneeId: 'nope', since: new Date(since1).toISOString() }],
    }), accounts, tEn, 'en', now)!;
    const lines = out.split('\n');
    expect(lines[0]!.startsWith(`@${UNKNOWN_ACCOUNT_LABEL} `)).toBe(true);
    expect(lines[1]).toBe(`- s1 a b {who} (assignee ${UNKNOWN_ACCOUNT_LABEL}, since 11:02)`);
    expect(lines[2]).toBe('… and 3 more');
    expect(out).not.toContain('zzz');
  });

  it('시스템 줄이 아니거나, 단계 목록이 없거나(옛 줄), 모양이 틀리면 그리지 않는다 — 본문으로', () => {
    expect(planStallText(stall({}, 'user'), accounts, tEn, 'en', now)).toBeNull();
    expect(planStallText(stall({ steps: undefined }), accounts, tEn, 'en', now)).toBeNull();
    expect(planStallText(stall({ steps: [] }), accounts, tEn, 'en', now)).toBeNull();
    expect(planStallText(stall({ more: -1 }), accounts, tEn, 'en', now)).toBeNull();
    expect(planStallText(stall({ afterSec: 'x' }), accounts, tEn, 'en', now)).toBeNull();
    expect(planStallText(stall({ managerId: 7 }), accounts, tEn, 'en', now)).toBeNull();
    const one = (step: unknown) => planStallText(stall({ steps: [step] }), accounts, tEn, 'en', now);
    const ok = { id: 's1', title: 't', assigneeId: null, since: new Date(since1).toISOString() };
    expect(one(ok)).not.toBeNull();
    expect(one({ ...ok, id: 'constructor' })).toBeNull();
    expect(one({ ...ok, title: 'x'.repeat(481) })).toBeNull();
    expect(one({ ...ok, assigneeId: 3 })).toBeNull();
    expect(one({ ...ok, since: 'nope' })).toBeNull();
    expect(planStallText(stall({ steps: Array.from({ length: 9 }, () => ok) }), accounts, tEn, 'en', now)).toBeNull();
  });

  it('미리보기(displayBody)도 같은 문장을 쓰고, 표지를 못 읽으면 본문이다', () => {
    usePrefsStore.setState({ locale: 'en' });
    const good = { ...stall(), body: '멈춤?: 본문' };
    expect(displayBody(good, accounts)).toContain('Stalled?: these ▶ steps');
    expect(displayBody({ ...stall({ steps: undefined }), body: '멈춤?: 본문' }, accounts)).toBe('멈춤?: 본문');
  });
});
