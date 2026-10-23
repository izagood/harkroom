// 이 맥에서 API 키로 도는 에이전트 — 터미널 진입점을 꺼 두는 근거(designer v3 ⑥).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { TerminalChip } from '../src/components/TerminalChip';
import { FailureCard } from '../src/components/FailureCard';
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
    // `disabled` 가 아니라 `aria-disabled` — 키보드로 포커스해 까닭에 닿을 수 있어야 한다(designer n2).
    expect((b as HTMLButtonElement).disabled).toBe(false);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('title')).toBe('API 키로 도는 에이전트는 아직 터미널 열기를 지원하지 않는다.');
    const reason = document.getElementById(b.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('API 키로 도는 에이전트는 아직 터미널 열기를 지원하지 않는다.');
    b.click();
    expect(useAppStore.getState().terminalTarget ?? null).toBeNull();
  });

  it('API 키를 안 쓰는 에이전트는 그대로 열린다', async () => {
    const m = msg('m2', 'c1', 2, 'x', PLAIN);
    render(<TerminalChip account={useAppStore.getState().accounts[PLAIN]} message={m} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('terminal-chip-lane-blocked')).toBeNull();
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });
});

// designer n17: API 키로 도는 에이전트의 그 밖의 실패(키는 받았는데 API 오류 등)에는 그 연결을 가리키는 한 줄과 설정 열기.
describe('FailureCard — API 키로 도는 에이전트의 실패', () => {
  const failed = (author: string) => msg('mf', 'c1', 3, 'x', author, {
    meta: { kind: 'failure', failure: { retryable: true, what: '하네스 API 에러' } } as unknown as Record<string, unknown>,
  });
  it('이 맥에서 API 키로 도는 에이전트면 「API 주소 확인」 한 줄과 [에이전트 설정 열기](실행 탭)', async () => {
    const opened: (string | undefined)[] = [];
    render(<FailureCard message={failed(LANE)} onOpenSettings={(_s, target) => opened.push(target)} />);
    const hint = await waitFor(() => screen.getByTestId('lane-agent-hint'));
    expect(hint.textContent).toContain('API 주소');
    screen.getByTestId('lane-open-settings').click();
    expect(opened).toEqual([`${LANE}#run`]);
  });
  it('API 키를 안 쓰는 에이전트에는 붙이지 않는다', async () => {
    render(<FailureCard message={failed(PLAIN)} onOpenSettings={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('lane-agent-hint')).toBeNull();
    expect(screen.queryByTestId('lane-open-settings')).toBeNull();
  });
});
