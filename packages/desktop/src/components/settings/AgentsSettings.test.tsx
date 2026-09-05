import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AccountView, AgentView } from '@murmur/shared';
import { AgentsSettings } from './AgentsSettings';
import { setController, type Controller } from '../../state/controller';
import { resetCommunityRegistry, useActiveStore } from '../../state/communities';

/**
 * #428: 종료 요청 수령(`stopAckedAt`)이 화면에 반영되는지를 잰다.
 *
 * `requestStop` 이 받는 응답에는 `stopAckedAt` 이 없다 — 러너가 요청을 읽어 가는 것은
 * 그 뒤이기 때문이다(실측 4초). 이 테스트가 **응답 하나만 보면** 이 결함을 못 잡는다는
 * 것이 이슈의 지적이었다 — 그래서 여기서는 "요청 직후"와 "그 뒤 갱신"을 **따로** 잰다:
 * 1) 요청 직후 화면은 아직 '아직 읽어 가지 않았다'(두 번째 상태)를 보여야 하고,
 * 2) 그 뒤 목록 재조회가 `stopAckedAt` 을 채운 값을 돌려주면 화면이 '읽어 갔다'
 *    (세 번째 상태)로 바뀌어야 한다.
 */

const AGENT_ID = 'agent-alpha';
const ME_ID = 'admin-1';

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: AGENT_ID,
    handle: 'alpha',
    displayName: 'alpha',
    kind: 'agent',
    isAdmin: false,
    ownerAccountId: null,
    disabled: false,
    instructions: '',
    harness: 'claude',
    model: null,
    effort: null,
    workingDir: null,
    mentionPermission: 'auto',
    runnerVersion: null,
    stopRequestedAt: null,
    stopAckedAt: null,
    lastTurnAt: null,
    ...overrides,
  } as AgentView;
}

const ME: AccountView = {
  id: ME_ID,
  handle: 'admin',
  displayName: 'admin',
  kind: 'human',
  isAdmin: true,
  ownerAccountId: null,
  disabled: false,
  status: 'available',
  statusText: null,
  avatarAttachmentId: null,
};

describe('AgentsSettings — 종료 요청 수령 반영(#428)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetCommunityRegistry();
    useActiveStore.setState({ me: ME, accounts: { [ME_ID]: ME } });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setController(null);
  });

  it('요청 직후에는 stopAckedAt 이 없고, 이후 갱신에서 값이 생기면 세 번째 상태로 바뀐다', async () => {
    const requested = makeAgent({
      stopRequestedAt: '2026-09-05T04:01:11.003Z',
      stopAckedAt: null,
    });
    const acked = { ...requested, stopAckedAt: '2026-09-05T04:01:15.245Z' };

    let listCall = 0;
    const listAgents = vi.fn(async () => {
      listCall += 1;
      // 첫 조회(마운트)는 아직 수령 전. 그 뒤(폴링)부터는 수령된 값을 돌려준다.
      return [listCall === 1 ? requested : acked];
    });
    const requestAgentStop = vi.fn(async () => requested);
    const listPats = vi.fn(async () => []);
    const agentMemory = vi.fn(async () => []);
    const agentDefaults = vi.fn(async () => ({ harness: 'claude', model: null, effort: null }));

    setController({
      listAgents,
      requestAgentStop,
      listPats,
      agentMemory,
      agentDefaults,
    } as unknown as Controller);

    render(<AgentsSettings />);

    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1));

    const pickButton = await screen.findByRole('button', { name: /alpha/ });
    pickButton.click();

    await waitFor(() => expect(screen.getByRole('button', { name: '러너 종료 요청' })).toBeTruthy());

    const stopButton = screen.getByRole('button', { name: '러너 종료 요청' });
    stopButton.click();

    // 요청 직후: 응답에는 stopAckedAt 이 없다 — 화면은 두 번째 상태(아직 못 읽어감)여야 한다.
    await waitFor(() => expect(requestAgentStop).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByText(/러너가 아직 읽어 가지 않았다/)).toBeTruthy();
    });
    expect(screen.queryByText(/러너가 요청을 읽어 갔다/)).toBeNull();

    // 그 뒤 갱신(폴링)에서 stopAckedAt 이 채워진 목록이 온다.
    await vi.advanceTimersByTimeAsync(5_000);

    await waitFor(() => {
      expect(screen.getByText(/러너가 요청을 읽어 갔다/)).toBeTruthy();
    });
    expect(screen.queryByText(/러너가 아직 읽어 가지 않았다/)).toBeNull();
  });
});
