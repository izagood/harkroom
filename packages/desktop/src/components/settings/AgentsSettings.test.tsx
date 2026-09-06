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

/**
 * #427: 되돌리는 길이 **요청과 같은 자리**에 있는지.
 *
 * 이 이슈의 증상은 "되돌릴 수 없다"가 아니라 "되돌리는 길을 찾을 수 없다"였다 — 사람이
 * "설정에서 껐으니 설정에서 켜겠지"로 읽고 그 자리를 봤는데 없었고, 그래서 DB 를 고치러
 * 갔다. 그러니 재야 할 것은 컨트롤러 호출만이 아니라 **그 버튼이 이 자리에 보이는가**다.
 */
describe('AgentsSettings — 종료 요청 되돌리기(#427)', () => {
  beforeEach(() => {
    resetCommunityRegistry();
    useActiveStore.setState({ me: ME, accounts: { [ME_ID]: ME } });
  });

  afterEach(() => {
    cleanup();
    setController(null);
  });

  const mount = async (agent: AgentView, extra: Partial<Controller> = {}) => {
    const undoAgentStopRequest = vi.fn(async () => ({ ...agent, stopRequestedAt: null, stopAckedAt: null }));
    setController({
      listAgents: vi.fn(async () => [agent]),
      requestAgentStop: vi.fn(async () => agent),
      undoAgentStopRequest,
      listPats: vi.fn(async () => []),
      agentMemory: vi.fn(async () => []),
      agentDefaults: vi.fn(async () => ({ harness: 'claude', model: null, effort: null })),
      ...extra,
    } as unknown as Controller);

    render(<AgentsSettings />);
    const pickButton = await screen.findByRole('button', { name: /alpha/ });
    pickButton.click();
    await waitFor(() => expect(screen.getByRole('button', { name: '러너 종료 요청' })).toBeTruthy());
    return { undoAgentStopRequest };
  };

  it('요청이 없으면 되돌리기 버튼이 없다 — 누를 것이 없는 버튼은 있지도 않은 요청을 암시한다', async () => {
    await mount(makeAgent());
    expect(screen.queryByRole('button', { name: '종료 요청 되돌리기' })).toBeNull();
  });

  it('요청이 있으면 종료 요청과 같은 자리에 되돌리기 버튼이 뜨고, 누르면 값이 지워진다', async () => {
    const requested = makeAgent({ stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: null });
    const { undoAgentStopRequest } = await mount(requested);

    const undoButton = screen.getByRole('button', { name: '종료 요청 되돌리기' });
    undoButton.click();

    await waitFor(() => expect(undoAgentStopRequest).toHaveBeenCalledWith(AGENT_ID));
    // 응답으로 온 정의를 그대로 갈아끼우므로 화면이 곧바로 첫 상태로 돌아간다 —
    // 누른 사람이 자기 조작의 결과를 목록 재조회 없이 봐야 한다.
    await waitFor(() => expect(screen.getByText(/종료를 요청한 적이 없다/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: '종료 요청 되돌리기' })).toBeNull();
  });

  it('러너가 읽어 간 뒤에도 되돌릴 수 있다 — 그 뒤가 오히려 되돌리기가 필요한 자리다', async () => {
    // 수령까지 끝난 상태로 두면 자동 기동이 이 에이전트를 영영 건너뛴다.
    await mount(makeAgent({
      stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: '2026-09-05T04:01:15.245Z',
    }));
    expect(screen.getByRole('button', { name: '종료 요청 되돌리기' })).toBeTruthy();
  });

  it('되돌리지 못하면 사유를 말한다 — 실패를 삼키고 지워진 척하지 않는다', async () => {
    const requested = makeAgent({ stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: null });
    await mount(requested, {
      undoAgentStopRequest: vi.fn(async () => { throw new Error('boom'); }),
    } as unknown as Partial<Controller>);

    screen.getByRole('button', { name: '종료 요청 되돌리기' }).click();

    await waitFor(() => expect(screen.getByText(/종료 요청을 되돌리지 못했다/)).toBeTruthy());
    // 실패했으므로 요청은 그대로 있어야 한다 — 화면이 지워진 척하면 사람은 다시 눌러 볼
    // 생각을 못 한다.
    expect(screen.getByRole('button', { name: '종료 요청 되돌리기' })).toBeTruthy();
  });
});
