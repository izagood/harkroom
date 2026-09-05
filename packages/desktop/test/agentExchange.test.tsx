// Task 5 — 에이전트 둘 사이의 주고받기를 접는다(규칙 04).
//
// 접지 않으면 스레드는 **정확히 우리가 피하려던 그 로그**가 된다: forge ↔ codex 가 열 번
// 주고받으면 그 열 번이 그대로 흐르고, 사람이 읽어야 할 말이 그 사이에 묻힌다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AskMeta, MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { AgentExchange } from '../src/components/AgentExchange';
import { groupAgentExchanges, exchangeParticipants } from '../src/lib/agentExchange';
import { groupProgress } from '../src/lib/progressGroup';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';

const AGENTS = new Set([FORGE, CODEX]);
const isAgent = (id: string): boolean => AGENTS.has(id);

/** 슬롯으로 감싸는 헬퍼 — 실제 화면과 같은 순서(진행 먼저, 주고받기 나중)를 탄다. */
const slots = (messages: MessageRow[]) => groupAgentExchanges(groupProgress(messages), isAgent);

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

beforeEach(() => {
  useAppStore.getState().reset();
  setController({} as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      [FORGE]: acc(FORGE, 'forge', 'agent'),
      [CODEX]: acc(CODEX, 'codex', 'agent'),
    },
  });
});
afterEach(() => cleanup());

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

  it('사람의 발화가 끼면 두 묶음으로 갈린다', () => {
    const out = slots([
      msg('m1', 'c1', 1, 'a', FORGE), msg('m2', 'c1', 2, 'b', CODEX),
      msg('u1', 'c1', 3, '잠깐', ME),
      msg('m3', 'c1', 4, 'c', FORGE), msg('m4', 'c1', 5, 'd', CODEX),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['exchange', 'message', 'exchange']);
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

describe('exchangeParticipants', () => {
  it('등장 순서를 지킨다 — 먼저 말한 쪽이 먼저 읽힌다', () => {
    expect(exchangeParticipants([
      msg('m1', 'c1', 1, 'a', CODEX), msg('m2', 'c1', 2, 'b', FORGE), msg('m3', 'c1', 3, 'c', CODEX),
    ])).toEqual([CODEX, FORGE]);
  });
});

describe('AgentExchange — 접힌 한 줄', () => {
  const three = [
    msg('m1', 'c1', 1, 'ws 는 내가 본다', FORGE),
    msg('m2', 'c1', 2, '스키마는 내가', CODEX),
    msg('m3', 'c1', 3, '그럼 넘긴다', FORGE),
  ];

  it('참여자와 횟수만 말하고 본문은 감춘다', () => {
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
