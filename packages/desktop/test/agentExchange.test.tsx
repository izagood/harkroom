// Task 5 — 에이전트 둘 사이의 주고받기를 접는다(규칙 04).
//
// 접지 않으면 스레드는 **정확히 우리가 피하려던 그 로그**가 된다: forge ↔ codex 가 열 번
// 주고받으면 그 열 번이 그대로 흐르고, 사람이 읽어야 할 말이 그 사이에 묻힌다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AskMeta, MessageRow, ReportMeta } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentExchange } from '../src/components/AgentExchange';
import {
  groupAgentExchanges, exchangeParticipants, exchangeConclusion, EXCHANGE_CONCLUSION_MAX,
} from '../src/lib/agentExchange';
import { groupProgress } from '../src/lib/progressGroup';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';
const SCRIBE = 'a-scribe';

/**
 * 멘션 토큰(`<@id>`)은 **36 자 uuid 만** 받는다(`MENTION_TOKEN_PATTERN`). 위의 짧은 id 들은
 * 토큰으로 쓸 수 없으므로, 멘션을 보는 테스트만 uuid 를 따로 쓴다 — 짧은 id 로 쓰면
 * `mentionedIds` 가 아무것도 못 찾아 **테스트가 엉뚱한 이유로 통과한다.**
 */
const ME_UUID = '11111111-1111-4111-8111-111111111111';
const FORGE_UUID = '22222222-2222-4222-8222-222222222222';

const AGENTS = new Set([FORGE, CODEX, SCRIBE, FORGE_UUID]);
const isAgent = (id: string): boolean => AGENTS.has(id);

/** 슬롯으로 감싸는 헬퍼 — 실제 화면과 같은 순서(진행 먼저, 주고받기 나중)를 탄다. */
const slots = (messages: MessageRow[]) => groupAgentExchanges(groupProgress(messages), isAgent);

/**
 * 위임 메시지 하나(050). `to` 가 있어야 `readDelegationMeta` 가 알아본다 — 배열이 아니면
 * 평문으로 흘러 이 판정이 조용히 꺼진다.
 */
const delegateMsg = (id: string, authorId: string, to: string[]): MessageRow =>
  msg(id, 'c1', 2, '이렇게 나눴다', authorId, {
    meta: {
      kind: 'delegation',
      delegation: { to, unreachable: [], deadlineAt: '2026-09-11T00:00:00.000Z' },
    } as unknown as Record<string, unknown>,
  });

const askTo = (
  id: string, authorId: string, to: AskMeta['ask']['to'], answered = false,
): MessageRow => {
  const ask: AskMeta['ask'] = {
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    to,
    ...(answered ? { answeredWith: 'a', answeredBy: ME } : {}),
  };
  return msg(id, 'c1', 1, '고를까?', authorId, { meta: { kind: 'ask', ask } as unknown as Record<string, unknown> });
};

/** 완료 보고 한 줄. 접힌 구간의 **결론**이 여기서 나온다(`ReportMeta.checks`). */
const reportMsg = (id: string, authorId: string, checks: string[]): MessageRow => {
  const report: ReportMeta['report'] = { checks };
  return msg(id, 'c1', 9, '끝냈다', authorId, {
    meta: { kind: 'report', report } as unknown as Record<string, unknown>,
  });
};

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  setController({} as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      [FORGE]: acc(FORGE, 'forge', 'agent'),
      [CODEX]: acc(CODEX, 'codex', 'agent'),
      [SCRIBE]: acc(SCRIBE, 'scribe', 'agent'),
    },
  });
});
// **언어를 고정한다**(이 묶음의 문구가 사전을 지나면서 기본이 영어가 됐다). 이 파일이
// 재는 것은 언어가 아니라 **그 언어로 표현된 규율**이다 — 언어를 재는 자리는
// `i18n.test.tsx` 하나이고, 두 곳에서 재면 문구를 고칠 때 한쪽만 고쳐진다
// (`gallery.test.tsx`·`skillsSettings.test.tsx`·`agentGrid.test.tsx` 와 같은 규약).
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('groupAgentExchanges — 무엇을 접는가', () => {
  it('에이전트 둘의 연속 구간을 한 자리로 접는다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'ws 는 내가 본다', FORGE),
      msg('m2', 'c1', 2, '스키마는 내가', CODEX),
      msg('m3', 'c1', 3, '그럼 넘긴다', FORGE),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('exchange');
    expect(out[0]!.kind === 'exchange' && out[0]!.messages).toHaveLength(3);
  });

  it('사람의 발화가 끼면 묶음이 갈린다 — 그 뒤 각 에이전트의 첫 답은 접히지 않는다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'a', FORGE), msg('m2', 'c1', 2, 'b', CODEX),
      msg('u1', 'c1', 3, '잠깐', ME),
      msg('m3', 'c1', 4, 'c', FORGE), msg('m4', 'c1', 5, 'd', CODEX),
    ]);
    // 앞 구간은 사람이 말한 적 없는 에이전트끼리의 로그라 예전대로 접힌다. 뒤 둘은 사람이
    // 말한 뒤 **각자의 첫 발화**라 각각 제자리에 남는다(2026-09-08 실측 결함).
    expect(out.map((s) => s.kind)).toEqual(['exchange', 'message', 'message', 'message']);
  });

  it('혼잣말은 주고받기가 아니다 — 한 에이전트만 있으면 접지 않는다', () => {
    const out = slots([msg('m1', 'c1', 1, 'a', FORGE), msg('m2', 'c1', 2, 'b', FORGE)]);
    expect(out.map((s) => s.kind)).toEqual(['message', 'message']);
  });

  it('한 줄짜리는 접지 않는다 — 접은 줄이 더 길면 접는 뜻이 없다', () => {
    const out = slots([msg('m1', 'c1', 1, 'a', FORGE)]);
    expect(out.map((s) => s.kind)).toEqual(['message']);
  });

  it('진행 묶음은 주고받기가 삼키지 않는다 — 두 규칙이 한 줄에 뭉치면 안 된다', () => {
    const out = slots([
      msg('p1', 'c1', 1, '읽는다', FORGE, { kind: 'progress' }),
      msg('p2', 'c1', 2, '돌린다', FORGE, { kind: 'progress' }),
      msg('m1', 'c1', 3, 'ws 는 내가', FORGE),
      msg('m2', 'c1', 4, '스키마는 내가', CODEX),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['progress', 'exchange']);
  });
});

/**
 * **접지 않는 예외.** 계획서는 이것을 "실패가 있으면 접지 않는다"로 적었지만 실패는 아직
 * 어휘가 없다(`kind` 는 `user|system|progress` 뿐). 그래서 지금 표현할 수 있는 같은 성질 —
 * *사람에게 온 막는 말* — 로 예외를 세운다. 접으면 "내 차례"가 접힌 줄 뒤로 사라진다.
 */
describe('groupAgentExchanges — 사람을 막는 말은 접지 않는다', () => {
  it('사람에게 온 미답 선택이 있으면 그 자리에서 갈린다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'a', FORGE),
      msg('m2', 'c1', 2, 'b', CODEX),
      askTo('ask1', FORGE, { kind: 'human' }),
      msg('m3', 'c1', 4, 'c', CODEX),
      msg('m4', 'c1', 5, 'd', FORGE),
    ]);
    // 사람을 부르는 말은 제자리에 남고, 앞뒤가 따로 접힌다.
    expect(out.map((s) => s.kind)).toEqual(['exchange', 'message', 'exchange']);
  });

  it('에이전트에게 간 선택은 접힌다 — 나를 막지 않는다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'a', FORGE),
      askTo('ask1', FORGE, { kind: 'account', accountId: CODEX }),
      msg('m2', 'c1', 3, 'b', CODEX),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['exchange']);
  });

  it('이미 답한 선택은 접힌다 — 기록일 뿐 아무도 막지 않는다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'a', FORGE),
      askTo('ask1', FORGE, { kind: 'human' }, true),
      msg('m2', 'c1', 3, 'b', CODEX),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['exchange']);
  });
});

/**
 * **사람에게 온 답이 접혀 사라졌다**(2026-09-08 실측).
 *
 * 사람이 한 스레드에서 에이전트 넷을 불러 정밀 검토를 시켰다. 넷이 각자 답을 올렸는데,
 * 그 답들이 연속이고 저자가 전부 에이전트라 `groupAgentExchanges` 가 통째로 접었다 —
 * 화면에 남은 글자가 `avcs ↔ avcs-server ↔ avcshub ↔ murmur · 12번 주고받음` 이었고,
 * 사람이 본 것은 문자 그대로 "에이전트끼리 대화만 했다" 였다.
 *
 * 원인은 판정에 **수신자가 없었다**는 것이다. 저자만 보면 "나에게 온 답"과 "자기들끼리 한
 * 말"이 같은 값이 된다. 그래서 사람의 발화를 기준선으로 둔다 — 그 뒤 각 에이전트의 첫
 * 발화는 답이고, 그 다음부터가 주고받기다.
 */
describe('groupAgentExchanges — 사람이 부른 뒤의 첫 답은 접지 않는다', () => {
  it('사람의 요청에 세 에이전트가 각자 답하면 하나도 접히지 않는다', () => {
    const out = slots([
      msg('u1', 'c1', 1, '@forge @codex @scribe 이거 검토해', ME),
      msg('m1', 'c1', 2, 'forge 검토 결과', FORGE),
      msg('m2', 'c1', 3, 'codex 검토 결과', CODEX),
      msg('m3', 'c1', 4, 'scribe 검토 결과', SCRIBE),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['message', 'message', 'message', 'message']);
  });

  it('첫 답들 뒤에 이어지는 에이전트끼리의 주고받기는 접힌다 — 그것은 그들 것이다', () => {
    const out = slots([
      msg('u1', 'c1', 1, '검토해', ME),
      msg('m1', 'c1', 2, 'forge 답', FORGE),
      msg('m2', 'c1', 3, 'codex 답', CODEX),
      // 여기부터는 둘 다 이미 답했다 — 사람에게 온 말이 아니라 서로에게 하는 말이다.
      msg('m3', 'c1', 4, '그건 네 쪽이 맞다', FORGE),
      msg('m4', 'c1', 5, '그럼 넘긴다', CODEX),
      msg('m5', 'c1', 6, '받았다', FORGE),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['message', 'message', 'message', 'exchange']);
    const folded = out[3]!;
    expect(folded.kind === 'exchange' && folded.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5']);
  });

  it('같은 에이전트의 두 번째 발화부터 접힌다 — 첫 답만 예외다', () => {
    const out = slots([
      msg('u1', 'c1', 1, '검토해', ME),
      msg('m1', 'c1', 2, 'forge 답', FORGE),
      msg('m2', 'c1', 3, 'forge 덧붙임', FORGE),
      msg('m3', 'c1', 4, 'codex 답', CODEX),
      msg('m4', 'c1', 5, 'codex 덧붙임', CODEX),
    ]);
    // m2 는 접을 것이 하나뿐이라(혼잣말) 제자리로 돌아가고, m4 도 같다.
    expect(out.map((s) => s.kind)).toEqual(['message', 'message', 'message', 'message', 'message']);
  });

  it('진행 묶음은 사람의 차례를 닫지 않는다 — 그 뒤의 결과 발화가 여전히 첫 답이다', () => {
    const out = slots([
      msg('u1', 'c1', 1, '검토해', ME),
      msg('p1', 'c1', 2, '읽는다', FORGE, { kind: 'progress' }),
      msg('p2', 'c1', 3, '읽는다', CODEX, { kind: 'progress' }),
      msg('m1', 'c1', 4, 'forge 답', FORGE),
      msg('m2', 'c1', 5, 'codex 답', CODEX),
    ]);
    expect(out.map((s) => s.kind))
      .toEqual(['message', 'progress', 'progress', 'message', 'message']);
  });

  it('사람이 말한 적 없는 목록은 예전대로 접힌다 — 기준선이 없으면 답이라 부를 것이 없다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'ws 는 내가', FORGE),
      msg('m2', 'c1', 2, '스키마는 내가', CODEX),
      msg('m3', 'c1', 3, '넘긴다', FORGE),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['exchange']);
  });
});

/**
 * **사람을 이름으로 부른 말은 접지 않는다.** `packages/agent/src/prompt.ts` 가 최종 답에
 * 요청자를 `@handle` 로 부르라고 지시하고, 이 판정이 그 짝이다 — 지시와 판정이 갈라지면
 * 이름을 부른 답이 그대로 접힌다.
 */
describe('groupAgentExchanges — 사람을 멘션한 말은 접지 않는다', () => {
  it('본문이 사람 계정을 멘션하면 그 자리에서 갈린다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'a', FORGE),
      msg('m2', 'c1', 2, 'b', CODEX),
      msg('m3', 'c1', 3, `<@${ME_UUID}> 결과입니다`, FORGE),
      msg('m4', 'c1', 4, 'c', CODEX),
      msg('m5', 'c1', 5, 'd', FORGE),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['exchange', 'message', 'exchange']);
  });

  it('동료 에이전트를 멘션한 말은 접힌다 — 나에게 온 말이 아니다', () => {
    const out = slots([
      msg('m1', 'c1', 1, `<@${FORGE_UUID}> 이거 봐줘`, CODEX),
      msg('m2', 'c1', 2, `<@${FORGE_UUID}> 다시 봐줘`, SCRIBE),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['exchange']);
  });

  it('코드 안의 토큰은 부름이 아니다 — 서버(#298)와 같은 규칙이다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'a', FORGE),
      msg('m2', 'c1', 2, `\`<@${ME_UUID}>\` 를 그대로 쓰면 된다`, CODEX),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['exchange']);
  });
});

describe('exchangeParticipants', () => {
  it('등장 순서를 지킨다 — 먼저 말한 쪽이 먼저 읽힌다', () => {
    expect(exchangeParticipants([
      msg('m1', 'c1', 1, 'a', CODEX), msg('m2', 'c1', 2, 'b', FORGE), msg('m3', 'c1', 3, 'c', CODEX),
    ])).toEqual([CODEX, FORGE]);
  });
});

/**
 * **접힌 줄이 결론을 말한다**(#488 C1).
 *
 * 문서의 진단: *"컨셉의 '접힘'이 구현돼 있는 셈인데, 말하는 것은 횟수뿐이다. 답글 스택에서
 * 이름 나열을 버린 이유와 같은 문제다 — '열어야 하나'에 답하지 않는다."*
 *
 * 결론은 **새 어휘 없이** 이미 있는 `meta` 에서 나온다(`AskMeta.answeredWith`·`ReportMeta`).
 * 그것이 이 함수가 순수 함수인 이유이기도 하다 — 판정은 여기서 한 번만 하고 화면은 그린다.
 */
describe('exchangeConclusion — 결론을 무엇에서 내는가', () => {
  it('답한 선택의 옵션 라벨이 결론이다 — 무엇으로 정해졌는지가 접힘의 값이다', () => {
    const c = exchangeConclusion([
      msg('m1', 'c1', 1, 'a', FORGE),
      askTo('ask1', FORGE, { kind: 'account', accountId: CODEX }, true),
      msg('m2', 'c1', 3, 'b', CODEX),
    ]);
    expect(c).toEqual({ source: 'ask', text: 'A' });
  });

  it('보고의 첫 확인이 결론이다 — 주고받기 끝의 보고가 곧 결론이다', () => {
    const c = exchangeConclusion([
      msg('m1', 'c1', 1, 'a', FORGE),
      reportMsg('r1', CODEX, ['스키마 마이그레이션 통과', '타입체크 통과']),
    ]);
    expect(c).toEqual({ source: 'report', text: '스키마 마이그레이션 통과' });
  });

  it('보고가 답한 선택보다 뒤면 보고가 이긴다 — 마지막에 정해진 것이 결론이다', () => {
    const c = exchangeConclusion([
      askTo('ask1', FORGE, { kind: 'account', accountId: CODEX }, true),
      reportMsg('r1', CODEX, ['옮겼다']),
    ]);
    expect(c).toEqual({ source: 'report', text: '옮겼다' });
  });

  it('답한 선택이 보고보다 뒤면 선택이 이긴다', () => {
    const c = exchangeConclusion([
      reportMsg('r1', CODEX, ['옮겼다']),
      askTo('ask1', FORGE, { kind: 'account', accountId: CODEX }, true),
    ]);
    expect(c).toEqual({ source: 'ask', text: 'A' });
  });

  it('아무것도 정해지지 않았으면 null 이다 — 없는 결론을 지어내지 않는다', () => {
    expect(exchangeConclusion([
      msg('m1', 'c1', 1, 'ws 는 내가 본다', FORGE),
      msg('m2', 'c1', 2, '스키마는 내가', CODEX),
    ])).toBeNull();
  });

  it('미답 선택은 결론이 아니다 — 아직 정해진 것이 없다', () => {
    expect(exchangeConclusion([
      msg('m1', 'c1', 1, 'a', FORGE),
      askTo('ask1', FORGE, { kind: 'account', accountId: CODEX }),
    ])).toBeNull();
  });

  it('형식을 못 갖춘 보고는 결론이 아니다 — 모르는 meta 는 평문으로 흐른다', () => {
    expect(exchangeConclusion([
      msg('m1', 'c1', 1, 'a', FORGE),
      msg('r1', 'c1', 2, '끝', CODEX, { meta: { kind: 'report', report: { checks: [] } } }),
    ])).toBeNull();
  });

  it('긴 결론은 자른다 — 줄 하나가 대화를 두 번 그리는 자리가 되면 접은 뜻이 없다', () => {
    const long = '가'.repeat(80);
    const c = exchangeConclusion([msg('m1', 'c1', 1, 'a', FORGE), reportMsg('r1', CODEX, [long])]);
    expect(c!.text.length).toBeLessThanOrEqual(EXCHANGE_CONCLUSION_MAX + 1);
    expect(c!.text.endsWith('…')).toBe(true);
  });
});

describe('AgentExchange — 접힌 한 줄', () => {
  const three = [
    msg('m1', 'c1', 1, 'ws 는 내가 본다', FORGE),
    msg('m2', 'c1', 2, '스키마는 내가', CODEX),
    msg('m3', 'c1', 3, '그럼 넘긴다', FORGE),
  ];

  it('결론이 있으면 횟수보다 먼저 말한다 — 횟수는 그 뒤에 붙는 부수적인 숫자다', () => {
    render(<AgentExchange messages={[...three, reportMsg('r1', CODEX, ['옮겼다'])]} />);
    const line = screen.getByTestId('agent-exchange-toggle');
    expect(screen.getByTestId('exchange-conclusion').textContent).toBe('옮겼다');
    // **순서**가 처방의 실질이다 — 결론이 횟수 앞에 온다.
    const text = line.textContent!;
    expect(text.indexOf('옮겼다')).toBeLessThan(text.indexOf('4번 주고받음'));
  });

  it('결론이 없으면 횟수로 떨어진다 — 정해진 것이 없다고 말하는 것이 정직하다', () => {
    render(<AgentExchange messages={three} />);
    expect(screen.queryByTestId('exchange-conclusion')).toBeNull();
    expect(screen.getByText(/아직 정해진 것 없음/)).toBeTruthy();
    expect(screen.getByText(/3번 주고받음/)).toBeTruthy();
  });

  it('줄 전체가 손잡이다 — 맨 끝 세 글자가 유일한 손잡이면 안 된다', () => {
    render(<AgentExchange messages={three} />);
    const line = screen.getByTestId('agent-exchange-toggle');
    expect(line.tagName).toBe('BUTTON');
    // 참여자·결론·횟수가 모두 그 버튼 **안**에 있어야 줄 전체가 눌린다.
    expect(line.textContent).toContain('forge ↔ codex');
    expect(line.textContent).toContain('3번 주고받음');
    // 누르는 곳이 줄 전체이므로 '펼치기'라는 별도 손잡이 글자는 필요 없다.
    expect(line.textContent).not.toContain('펼치기');
  });

  it('참여자와 요약만 말하고 본문은 감춘다', () => {
    render(<AgentExchange messages={three} />);
    expect(screen.getByTestId('agent-exchange').dataset.open).toBe('false');
    expect(screen.getByText('forge ↔ codex')).toBeTruthy();
    expect(screen.getByText(/3번 주고받음/)).toBeTruthy();
    // 접힘의 요점은 본문이 흐르지 않는 것이다.
    expect(screen.queryByText('ws 는 내가 본다')).toBeNull();
  });

  it('펼치면 평소의 메시지 그대로 보인다', () => {
    render(<AgentExchange messages={three} />);
    fireEvent.click(screen.getByTestId('agent-exchange-toggle'));
    expect(screen.getByTestId('agent-exchange').dataset.open).toBe('true');
    expect(screen.getByText('ws 는 내가 본다')).toBeTruthy();
    expect(screen.getByText('스키마는 내가')).toBeTruthy();

    // 다시 접힌다 — 펼침은 기기의 속성이라 되돌릴 수 있어야 한다.
    fireEvent.click(screen.getByTestId('agent-exchange-toggle'));
    expect(screen.getByTestId('agent-exchange').dataset.open).toBe('false');
  });
});

/**
 * **위임 뒤는 팀 안의 이야기다**(050 · 3-2).
 *
 * 예외 ②("사람이 말한 뒤 각 에이전트의 첫 발화는 접지 않는다")가 위임에서는 반대로
 * 작동한다: 팀장이 둘에게 넘기면 그 둘의 보고가 **저마다 사람 뒤의 첫 발화**라 하나도
 * 접히지 않고, 그러면 창구를 팀장 하나로 좁힌 뜻이 화면에서 사라진다.
 *
 * 되돌려 RED: `groupAgentExchanges` 의 위임 분기를 지우면 1번이 빨개진다(보고 둘이 각각
 * 제 줄로 선다).
 */
describe('위임은 사람의 차례를 닫는다 (050)', () => {
  it('1. 팀장이 나눈 뒤 팀원들의 보고는 접힌다', () => {
    const out = slots([
      msg('m1', 'c1', 1, '@release 배포 준비해라', ME),
      delegateMsg('m2', FORGE, ['codex', 'scribe']),
      msg('m3', 'c1', 3, '서버 쪽 끝났다', CODEX),
      msg('m4', 'c1', 4, '화면 쪽 끝났다', SCRIBE),
    ]);

    // 사람의 말 · 팀장의 위임 · 접힌 보고 구간.
    expect(out.map((s) => s.kind)).toEqual(['message', 'message', 'exchange']);
    const folded = out[2] as { kind: 'exchange'; messages: MessageRow[] };
    expect(folded.messages.map((m) => m.id)).toEqual(['m3', 'm4']);
  });

  it('2. 위임 메시지 자신은 접히지 않는다 — 사람에게 하는 답이다', () => {
    const out = slots([
      msg('m1', 'c1', 1, '@release 해줘', ME),
      delegateMsg('m2', FORGE, ['codex']),
      msg('m3', 'c1', 3, '보고', CODEX),
      msg('m4', 'c1', 4, '보고 둘', CODEX),
    ]);
    // "이렇게 나눴다"는 사람이 봐야 하는 말이다 — 접히면 사람은 무엇이 넘어갔는지 모른다.
    expect(out[1]).toMatchObject({ kind: 'message', message: { id: 'm2' } });
  });

  it('3. 팀장의 최종 답과 팀원의 실패는 여전히 펼쳐진다', () => {
    const fail = msg('m4', 'c1', 4, '못 했다', CODEX, {
      meta: { kind: 'failure', failure: { retryable: false } } as unknown as Record<string, unknown>,
    });
    const out = slots([
      msg('m1', 'c1', 1, '@release 해줘', ME_UUID),
      delegateMsg('m2', FORGE_UUID, ['codex', 'scribe']),
      msg('m3', 'c1', 3, '보고다', CODEX),
      // 접힘은 **둘 이상**일 때만 생긴다(혼잣말은 주고받기가 아니다) — 그래서 보고를 둘 둔다.
      msg('m3b', 'c1', 4, '나도 보고다', SCRIBE),
      fail,
      // 팀장이 사람을 부르며 최종 답을 쓴다 — `addressesHuman` 의 멘션 갈래.
      msg('m5', 'c1', 5, `<@${ME_UUID}> 취합하면 이렇다`, FORGE_UUID),
    ]);
    const kinds = out.map((s) => s.kind);
    // 실패와 최종 답은 접힌 구간 **밖**에 선다.
    expect(kinds.filter((k) => k === 'exchange')).toHaveLength(1);
    const ids = out.flatMap((s) => (s.kind === 'message' ? [s.message.id] : []));
    expect(ids).toContain('m4');
    expect(ids).toContain('m5');
  });

  it('4. 사람이 다시 말하면 기준선이 열린다', () => {
    const out = slots([
      msg('m1', 'c1', 1, '@release 해줘', ME),
      delegateMsg('m2', FORGE, ['codex']),
      msg('m3', 'c1', 3, '보고', CODEX),
      msg('m4', 'c1', 4, '하나 더 물어보자', ME),
      msg('m5', 'c1', 5, '답', CODEX),
      msg('m6', 'c1', 6, '답 둘', SCRIBE),
    ]);
    // 사람이 말한 뒤의 첫 답들은 예외 ② 그대로 펼쳐진다 — 위임 분기가 그 규칙을 지우지 않는다.
    const ids = out.flatMap((s) => (s.kind === 'message' ? [s.message.id] : []));
    expect(ids).toContain('m5');
    expect(ids).toContain('m6');
  });
});
