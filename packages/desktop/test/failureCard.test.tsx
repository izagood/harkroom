// 실패 어휘 — 여덟 가지 말 중 유일하게 **에이전트가 먼저 사람을 부르는** 말이다.
//
// 계획서에 이 어휘를 세우는 Task 가 없어 Task 5 가 우회해 두었던 자리를 여기서 닫는다
// (`lib/agentExchange.ts::blocksHuman`). Task 6(`stuck`)·Task 7(교착)이 이것을 전제로 한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { FailureMeta, MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { groupAgentExchanges } from '../src/lib/agentExchange';
import { groupProgress } from '../src/lib/progressGroup';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';
const AGENTS = new Set([FORGE, CODEX]);

const failMeta = (over: Partial<FailureMeta['failure']> = {}): Record<string, unknown> => ({
  kind: 'failure',
  failure: { retryable: true, ...over },
} as unknown as Record<string, unknown>);

const failMsg = (meta: Record<string, unknown>, authorId = FORGE): MessageRow =>
  msg('m-fail', 'c1', 1, '마이그레이션을 끝내지 못했다', authorId, { meta });

beforeEach(() => {
  useAppStore.getState().reset();
  setController({} as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      // 소유자가 나인 에이전트 — 터미널 진입점이 뜬다.
      [FORGE]: acc(FORGE, 'forge', 'agent', false, { ownerAccountId: ME }),
      [CODEX]: acc(CODEX, 'codex', 'agent'),
    },
  });
});
afterEach(() => cleanup());

describe('FailureCard', () => {
  it('강조와 함께 무엇을·왜를 말한다', () => {
    render(<MessageItem message={failMsg(failMeta({ what: '008 적용', reason: '스테이징 DB 에 붙지 못했다' }))} />);
    expect(screen.getByTestId('failure-card')).toBeTruthy();
    expect(screen.getByText('끝내지 못했다')).toBeTruthy();
    expect(screen.getByText('008 적용')).toBeTruthy();
    expect(screen.getByText('스테이징 DB 에 붙지 못했다')).toBeTruthy();
  });

  it('retryable 이면 다시 부르기가 작성창을 채운다 — 바로 보내지 않는다', () => {
    render(<MessageItem message={failMsg(failMeta({ retryable: true }))} />);
    fireEvent.click(screen.getByTestId('failure-retry'));
    // 한 번의 확인을 남긴다: 누르자마자 보내면 무엇이 나갈지 못 보고 러너가 또 돈다.
    expect(useAppStore.getState().drafts['c1']).toBe('@forge 다시 해 줘');
  });

  it('retryable 이 아니면 다시 부르기가 없다 — 눌러도 안 되는 버튼은 없는 문이다', () => {
    render(<MessageItem message={failMsg(failMeta({ retryable: false }))} />);
    expect(screen.getByTestId('failure-card').dataset.retryable).toBe('false');
    expect(screen.queryByTestId('failure-retry')).toBeNull();
  });

  it('소유자가 아니면 터미널 진입점이 없다', () => {
    render(<MessageItem message={failMsg(failMeta(), CODEX)} />);
    expect(screen.queryByText('터미널 보기')).toBeNull();
  });

  it('형식을 못 알아보면 상자를 그리지 않고 본문만 남는다', () => {
    for (const meta of [{}, { kind: 'failure' }, { kind: 'failure', failure: { retryable: 'yes' } }]) {
      cleanup();
      render(<MessageItem message={failMsg(meta as Record<string, unknown>)} />);
      expect(screen.queryByTestId('failure-card')).toBeNull();
      expect(screen.getByText(/마이그레이션을 끝내지 못했다/)).toBeTruthy();
    }
  });
});

/**
 * Task 5 가 남겨 둔 자리를 닫는다. 계획서의 원래 요구가 **"구간 안에 실패가 있으면 접지
 * 않는다"** 였고, 이제 실패 어휘가 생겼으므로 그대로 지킬 수 있다.
 */
describe('실패는 에이전트 주고받기에 접히지 않는다', () => {
  it('구간 안의 실패에서 묶음이 갈린다', () => {
    const out = groupAgentExchanges(groupProgress([
      msg('m1', 'c1', 1, 'a', FORGE),
      msg('m2', 'c1', 2, 'b', CODEX),
      msg('f1', 'c1', 3, '못 끝냈다', FORGE, { meta: failMeta() }),
      msg('m3', 'c1', 4, 'c', CODEX),
      msg('m4', 'c1', 5, 'd', FORGE),
    ]), (id) => AGENTS.has(id));
    // 실패는 제자리에 남고 앞뒤가 따로 접힌다 — 접으면 사람이 그것을 못 본다.
    expect(out.map((s) => s.kind)).toEqual(['exchange', 'message', 'exchange']);
  });
});
