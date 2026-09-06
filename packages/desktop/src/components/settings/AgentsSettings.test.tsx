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
    // #491: 마운트 시점은 **중지 전**이어야 한다 — 버튼이 한 자리로 접히면서 이 자리에
    // 어느 버튼이 서는지가 `stopRequestedAt` 으로 갈리기 때문이다. 이 테스트가 누르려는
    // 것은 '중지'이므로 첫 조회는 요청이 없는 값을 돌려줘야 한다(앞 판본은 이미 중지된
    // 값을 돌려주면서 중지 버튼을 눌렀다 — 그때는 버튼이 항상 둘 다 서 있어 드러나지 않았다).
    const fresh = makeAgent();

    let listCall = 0;
    const listAgents = vi.fn(async () => {
      listCall += 1;
      // 첫 조회(마운트)는 중지 전. 그 뒤(폴링)부터는 수령된 값을 돌려준다.
      return [listCall === 1 ? fresh : acked];
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

    await waitFor(() => expect(screen.getByRole('button', { name: '러너 중지' })).toBeTruthy());

    const stopButton = screen.getByRole('button', { name: '러너 중지' });
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
 * #427 → #491: 켜는 길과 끄는 길이 **한 자리**에 있는지.
 *
 * `#427` 의 증상은 "되돌릴 수 없다"가 아니라 "되돌리는 길을 찾을 수 없다"였다 — 사람이
 * "설정에서 껐으니 설정에서 켜겠지"로 읽고 그 자리를 봤는데 없었고, 그래서 DB 를 고치러
 * 갔다. `#485` 는 그 길을 요청 버튼 **옆에** 뒀지만, 이름이 `요청 되돌리기` 라는 서버 API
 * 의 어휘였다. 사람은 "내가 보낸 요청을 취소한다"고 생각하지 않고 "이 에이전트를 다시
 * 켠다"고 생각한다 — 그래서 `#491` 이 버튼 자리를 하나로 접고 이름을 실행/중지로 바꿨다.
 *
 * 단언을 지우지 않고 **이름만 갈아끼운다** — 지우면 이 자리가 통째로 사라져도 초록이 된다.
 * 그래서 재는 것도 그대로 넷이다: 없을 때 보이는 것 / 있을 때 보이는 것 / 수령 뒤에도 있는
 * 것 / 실패를 삼키지 않는 것.
 */
describe('AgentsSettings — 러너 실행·중지 토글(#427, #491)', () => {
  beforeEach(() => {
    resetCommunityRegistry();
    useActiveStore.setState({ me: ME, accounts: { [ME_ID]: ME } });
  });

  afterEach(() => {
    cleanup();
    setController(null);
  });

  /**
   * 버튼 자리가 하나라 마운트 뒤에 어느 이름이 서 있는지가 **상태에 따라 다르다.**
   * 그래서 기다릴 이름을 넘겨받는다 — 늘 `러너 중지` 를 기다리면 중지가 걸린 에이전트에서
   * 영영 못 찾고, 늘 `러너 실행` 을 기다리면 그 반대가 된다.
   */
  const mount = async (agent: AgentView, extra: Partial<Controller> = {}) => {
    const undoAgentStopRequest = vi.fn(async () => ({ ...agent, stopRequestedAt: null, stopAckedAt: null }));
    const requestAgentStop = vi.fn(async () => agent);
    setController({
      listAgents: vi.fn(async () => [agent]),
      requestAgentStop,
      undoAgentStopRequest,
      listPats: vi.fn(async () => []),
      agentMemory: vi.fn(async () => []),
      agentDefaults: vi.fn(async () => ({ harness: 'claude', model: null, effort: null })),
      ...extra,
    } as unknown as Controller);

    render(<AgentsSettings />);
    const pickButton = await screen.findByRole('button', { name: /alpha/ });
    pickButton.click();
    const expected = agent.stopRequestedAt ? '러너 실행' : '러너 중지';
    await waitFor(() => expect(screen.getByRole('button', { name: expected })).toBeTruthy());
    return { undoAgentStopRequest, requestAgentStop };
  };

  /**
   * **대조군.** 이것이 없으면 아래 "중지가 걸리면 실행이 보인다"가 "언제나 실행만 보인다"
   * 로도 통과한다 — 한 자리 토글에서 그 실패는 눈에 띄지 않는다.
   */
  it('중지가 걸려 있지 않으면 그 자리에 중지 버튼이 선다 — 실행은 없다', async () => {
    await mount(makeAgent());
    expect(screen.getByRole('button', { name: '러너 중지' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '러너 실행' })).toBeNull();
  });

  it('중지를 누르면 requestAgentStop 을 부른다 — undo 가 아니다', async () => {
    const { requestAgentStop, undoAgentStopRequest } = await mount(makeAgent());

    screen.getByRole('button', { name: '러너 중지' }).click();

    await waitFor(() => expect(requestAgentStop).toHaveBeenCalledWith(AGENT_ID));
    expect(undoAgentStopRequest).not.toHaveBeenCalled();
  });

  it('중지가 걸려 있으면 같은 자리가 실행 버튼이 되고, 누르면 undoAgentStopRequest 를 부른다', async () => {
    const requested = makeAgent({ stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: null });
    const { undoAgentStopRequest, requestAgentStop } = await mount(requested);

    // 중지가 걸린 동안에는 중지 버튼이 남아 있으면 안 된다 — 이미 성립한 상태를 다시
    // 시키는 버튼이고, 사람이 "껐는데 왜 또 끄라고 하지"로 읽는다.
    expect(screen.queryByRole('button', { name: '러너 중지' })).toBeNull();

    screen.getByRole('button', { name: '러너 실행' }).click();

    await waitFor(() => expect(undoAgentStopRequest).toHaveBeenCalledWith(AGENT_ID));
    // 실행이 stop 을 부르면 눌렀는데 더 확실히 꺼지는 셈이다 — 방향이 뒤집힌 것을 잡는다.
    expect(requestAgentStop).not.toHaveBeenCalled();

    // 응답으로 온 정의를 그대로 갈아끼우므로 화면이 곧바로 첫 상태로 돌아간다 —
    // 누른 사람이 자기 조작의 결과를 목록 재조회 없이 봐야 한다.
    await waitFor(() => expect(screen.getByText(/중지를 걸어 둔 적이 없다/)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: '러너 중지' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: '러너 실행' })).toBeNull();
  });

  it('러너가 읽어 간 뒤에도 실행으로 다시 켤 수 있다 — 그 뒤가 오히려 다시 켤 일이 생기는 자리다', async () => {
    // 수령까지 끝난 상태로 두면 자동 기동이 이 에이전트를 영영 건너뛴다.
    await mount(makeAgent({
      stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: '2026-09-05T04:01:15.245Z',
    }));
    expect(screen.getByRole('button', { name: '러너 실행' })).toBeTruthy();
  });

  /**
   * #491: 버튼은 둘로 접혔지만 **상태 표시는 셋을 가른다.** `stopAckedAt` 이 없는 동안은
   * 요청이 아직 러너에게 닿지 않았다는 뜻이고, 그건 사람이 알아야 할 사실이다 — 접어
   * 버리면 "눌렀는데 왜 안 멈추지"를 알 길이 없다. 두 상태가 같게 보이면 RED 다.
   */
  it('수령 전과 수령 뒤가 화면에서 다르게 보인다 — 버튼이 같아도 상태 표시는 셋을 가른다', async () => {
    const notAcked = makeAgent({ stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: null });
    await mount(notAcked);
    expect(screen.getByText(/러너가 아직 읽어 가지 않았다/)).toBeTruthy();
    expect(screen.queryByText(/러너가 요청을 읽어 갔다/)).toBeNull();
    cleanup();
    setController(null);

    const acked = makeAgent({
      stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: '2026-09-05T04:01:15.245Z',
    });
    await mount(acked);
    expect(screen.getByText(/러너가 요청을 읽어 갔다/)).toBeTruthy();
    expect(screen.queryByText(/러너가 아직 읽어 가지 않았다/)).toBeNull();
  });

  it('되돌리지 못하면 사유를 말한다 — 실패를 삼키고 켜진 척하지 않는다', async () => {
    const requested = makeAgent({ stopRequestedAt: '2026-09-05T04:01:11.003Z', stopAckedAt: null });
    await mount(requested, {
      undoAgentStopRequest: vi.fn(async () => { throw new Error('boom'); }),
    } as unknown as Partial<Controller>);

    screen.getByRole('button', { name: '러너 실행' }).click();

    await waitFor(() => expect(screen.getByText(/종료 요청을 되돌리지 못했다/)).toBeTruthy());
    // 실패했으므로 중지는 그대로 걸려 있어야 한다 — 화면이 켜진 척하면 사람은 다시 눌러 볼
    // 생각을 못 한다.
    expect(screen.getByRole('button', { name: '러너 실행' })).toBeTruthy();
  });
});
