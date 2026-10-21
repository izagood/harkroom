// 이 맥에서 API 키로 도는 에이전트 — 터미널 진입점을 꺼 두는 근거(designer v3 ⑥).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { TerminalChip } from '../src/components/TerminalChip';
import { resetLocalLanesForTest } from '../src/lib/localLanes';
import { acc, msg } from './helpers/fakeApi';

const BASE = 'https://example.test';
const ME = 'u-me';
const LANE = 'a-lane';
const PLAIN = 'a-plain';

function stubOperator(agents: Record<string, unknown>) {
  (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd !== 'operator_agents_list') throw new Error(cmd);
      return { communities: [{ baseUrl: BASE, registered: true, operatorId: 'op', agents }], laneStatus: {} };
    },
  };
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  resetLocalLanesForTest();
  setController({ api: { baseUrl: BASE } } as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'alice'),
    accounts: {
      [ME]: acc(ME, 'alice'),
      [LANE]: acc(LANE, 'lane', 'agent', false, { ownerAccountId: ME }),
      [PLAIN]: acc(PLAIN, 'plain', 'agent', false, { ownerAccountId: ME }),
    },
  });
  stubOperator({
    [LANE]: { providerLane: { baseUrl: 'https://gw.example', secret: 'KEY' } },
    [PLAIN]: {},
  });
});
afterEach(() => {
  cleanup();
  resetLocalLanesForTest();
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  usePrefsStore.getState().setLocale('system');
});

describe('TerminalChip — API 키 연결 에이전트', () => {
  it('이 맥에서 API 키로 도는 에이전트는 꺼진 문과 까닭을 보인다', async () => {
    const m = msg('m1', 'c1', 1, 'x', LANE);
    render(<TerminalChip account={useAppStore.getState().accounts[LANE]} message={m} />);
    const b = await waitFor(() => screen.getByTestId('terminal-chip-lane-blocked'));
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.getAttribute('title')).toBe('API 키로 도는 에이전트는 아직 터미널 열기를 지원하지 않는다.');
  });

  it('API 키를 안 쓰는 에이전트는 그대로 열린다', async () => {
    const m = msg('m2', 'c1', 2, 'x', PLAIN);
    render(<TerminalChip account={useAppStore.getState().accounts[PLAIN]} message={m} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('terminal-chip-lane-blocked')).toBeNull();
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });
});
