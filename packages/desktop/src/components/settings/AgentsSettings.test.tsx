import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AccountView, AgentView } from '@murmur/shared';
import { AgentsSettings } from './AgentsSettings';
import { setController, type Controller } from '../../state/controller';
import { resetCommunityRegistry, useActiveStore } from '../../state/communities';
import { usePrefsStore } from '../../state/prefsStore';

/**
 * **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고, 그
 * 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다 — 세 상태(요청 전 ·
 * 미수령 · 수령)를 접지 않는 것, 생사를 단정하지 않는 것. 영어가 원본이 되면서 기본값이
 * 영어가 됐으므로, 한국어를 재려면 한국어라고 말해야 한다.
 *
 * 이 파일은 `describe` 마다 제 훅이 있어 **맨 위에 한 쌍을 더 둔다** — 각 `describe` 의
 * 훅에 끼워 넣으면 새 `describe` 가 그것을 빠뜨린 채 추가된다.
 * 두 언어로 다 뜨는지는 `test/i18n.test.tsx` 가 잰다.
 */
beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { usePrefsStore.getState().setLocale('system'); });

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
    // #493: 마운트 시점은 **중지 전**이어야 한다 — 버튼이 한 자리로 접히면서 이 자리에
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
 * #427 → #493: 켜는 길과 끄는 길이 **한 자리**에 있는지.
 *
 * `#427` 의 증상은 "되돌릴 수 없다"가 아니라 "되돌리는 길을 찾을 수 없다"였다 — 사람이
 * "설정에서 껐으니 설정에서 켜겠지"로 읽고 그 자리를 봤는데 없었고, 그래서 DB 를 고치러
 * 갔다. `#485` 는 그 길을 요청 버튼 **옆에** 뒀지만, 이름이 `요청 되돌리기` 라는 서버 API
 * 의 어휘였다. 사람은 "내가 보낸 요청을 취소한다"고 생각하지 않고 "이 에이전트를 다시
 * 켠다"고 생각한다 — 그래서 `#493` 이 버튼 자리를 하나로 접고 이름을 실행/중지로 바꿨다.
 *
 * 단언을 지우지 않고 **이름만 갈아끼운다** — 지우면 이 자리가 통째로 사라져도 초록이 된다.
 * 그래서 재는 것도 그대로 넷이다: 없을 때 보이는 것 / 있을 때 보이는 것 / 수령 뒤에도 있는
 * 것 / 실패를 삼키지 않는 것.
 */
describe('AgentsSettings — 러너 실행·중지 토글(#427, #493)', () => {
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
   * #493: 버튼은 둘로 접혔지만 **상태 표시는 셋을 가른다.** `stopAckedAt` 이 없는 동안은
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

/**
 * 에이전트별 계정 풀 지정.
 *
 * **이 값은 서버로 가지 않는다.** 풀은 이 기기에만 존재하는 자원이므로(디렉터리와 그 안의
 * 자격증명) 서버에 두면 없는 풀을 가리키는 설정이 다른 기기로 전파된다 — 저장소에 같은
 * 판례가 있다("설정값은 기기 로컬이 의미론적으로 맞다"). 그래서 `AgentConfig` 의 다른
 * 필드들과 **저장 경로가 다르고**, 그 사실이 화면에 적혀 있어야 한다: 안 적으면 사용자는
 * 다른 기기에서 안 보이는 것을 버그로 읽는다.
 */
describe('AgentsSettings — 에이전트별 계정 풀', () => {
  const AGENT = makeAgent();
  let invoked: { cmd: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    resetCommunityRegistry();
    useActiveStore.setState({ me: ME, accounts: { [ME_ID]: ME } });
    invoked = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        invoked.push({ cmd, args });
        if (cmd === 'claude_accounts_list') {
          return {
            root: '/r', mode: 'pools', defaultPool: 'work',
            agents: {}, strays: [],
            pools: [
              { name: 'work', accounts: [] },
              { name: 'personal', accounts: [] },
            ],
          };
        }
        return {};
      }),
    });
    setController({
      listAgents: vi.fn(async () => [AGENT]),
      listPats: vi.fn(async () => []),
      agentMemory: vi.fn(async () => ({ profile: null, entries: [] })),
      agentDefaults: vi.fn(async () => ({ harness: 'claude', model: null, effort: null })),
    } as unknown as Controller);
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  async function openDetail(): Promise<void> {
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
  }

  it('실행 묶음에 풀 선택이 있고 기본은 기본 풀 사용이다', async () => {
    await openDetail();
    const select = await screen.findByLabelText(/account pool/i);
    // 배정이 없으면 빈 값 — "기본 풀 사용"이다. 그 상태가 표현되지 않으면 사용자가
    // 배정을 지울 방법이 없다.
    expect((select as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/default pool/i)).toBeTruthy();
  });

  it('풀 목록을 계정 스냅샷에서 읽는다 — 지어내지 않는다', async () => {
    await openDetail();
    await screen.findByLabelText(/account pool/i);
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('work');
    expect(options).toContain('personal');
  });

  it('이 기기에만 저장된다는 사실을 적는다', async () => {
    // 안 적으면 사용자는 다른 기기에서 안 보이는 것을 버그로 읽는다.
    await openDetail();
    await screen.findByLabelText(/account pool/i);
    expect(screen.getByText(/this machine only/i)).toBeTruthy();
  });

  it('고르면 계정 설정 경로로 쓴다 — 에이전트 저장 버튼을 거치지 않는다', async () => {
    // `AgentConfig` 의 다른 필드와 저장 경로가 다르다. 같은 저장 버튼에 묶으면 서버
    // PATCH 에 이 값이 실려 가거나, 반대로 저장을 눌러야 반영되는 것으로 오해된다.
    await openDetail();
    const select = await screen.findByLabelText(/account pool/i);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(select, { target: { value: 'personal' } });

    await waitFor(() => {
      const call = invoked.find((c) => c.cmd === 'claude_accounts_configure');
      const config = call?.args?.config as { agents?: Record<string, string> } | undefined;
      expect(config?.agents).toEqual({ [AGENT.id]: 'personal' });
    });
  });

  it('기본 풀 사용으로 되돌리면 배정을 지운다', async () => {
    await openDetail();
    const select = await screen.findByLabelText(/account pool/i);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(select, { target: { value: 'personal' } });
    await waitFor(() => expect(invoked.some((c) => c.cmd === 'claude_accounts_configure')).toBe(true));
    invoked = [];
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      const call = invoked.find((c) => c.cmd === 'claude_accounts_configure');
      const config = call?.args?.config as { agents?: Record<string, string> } | undefined;
      expect(config?.agents).toEqual({});
    });
  });

  it('목록 조회가 실패해도 칸을 감추지 않고 왜 못 골랐는지 적는다', async () => {
    // 실패를 "기능 없음"으로 그리면 사람은 이 앱에 그런 기능이 아예 없다고 읽는다 —
    // 실제로 그렇게 읽힌 적이 있다. 데몬이 대답을 못 한 것과 이 빌드에 표면이 없는 것은
    // 다른 사실이고, 화면이 그 둘을 같은 모습으로 그리면 안 된다.
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === 'claude_accounts_list') throw new Error('데몬이 죽었다');
        return {};
      }),
    });
    await openDetail();
    const select = await screen.findByLabelText(/account pool/i);
    // 잠근다 — 읽지 못한 목록에서 고르게 두면 배정이 스냅샷 없이 쓰여 순서·기본 풀이 지워진다.
    expect((select as HTMLSelectElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByText(/데몬이 죽었다/)).toBeTruthy());
  });

  it('Tauri 표면이 없으면 풀 선택을 그리지 않는다', async () => {
    // 그려 두면 고를 수 있는데 아무 일도 안 난다.
    vi.unstubAllGlobals();
    await openDetail();
    await screen.findByLabelText(/agent harness/i);
    expect(screen.queryByLabelText(/account pool/i)).toBeNull();
  });
});

/**
 * 만들기 화면의 계정 풀 선택.
 *
 * **왜 상세와 따로 재나:** 두 화면은 쓸 대상이 다르다 — 상세에는 에이전트 id 가 있어
 * 고르는 즉시 데몬에 쓰지만, 만들기에는 id 가 없어 쓸 곳이 없다. 앞 판본은 그 차이를
 * `available` 에 `agentId !== null` 로 접어 넣어 **만들기 화면에서는 칸이 아예 사라졌다** —
 * 사람은 에이전트를 만든 뒤 상세로 다시 들어가야 풀을 고를 수 있었고, 그 사이 러너는
 * 이미 기본 풀로 떠 있었다.
 */
describe('AgentsSettings — 만들 때 계정 풀을 고른다', () => {
  let createAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetCommunityRegistry();
    useActiveStore.setState({ me: ME, accounts: { [ME_ID]: ME } });
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === 'claude_accounts_list') {
          return {
            root: '/r', mode: 'pools', defaultPool: 'work',
            agents: {}, strays: [],
            pools: [{ name: 'work', accounts: [] }, { name: 'personal', accounts: [] }],
          };
        }
        return {};
      }),
    });
    createAgent = vi.fn(async () => ({
      agent: makeAgent({ id: 'agent-new', handle: 'beta' }), pat: 'murp_new', poolError: null,
    }));
    setController({
      listAgents: vi.fn(async () => []),
      listPats: vi.fn(async () => []),
      agentMemory: vi.fn(async () => ({ profile: null, entries: [] })),
      agentDefaults: vi.fn(async () => ({ harness: 'claude', model: null, effort: null })),
      createAgent,
    } as unknown as Controller);
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); setController(null); });

  async function openCreate(): Promise<void> {
    render(<AgentsSettings />);
    (await screen.findByTestId('agent-create')).click();
  }

  it('만들기 화면에도 풀 선택이 있다 — 만든 뒤 상세로 다시 들어가게 만들지 않는다', async () => {
    await openCreate();
    const select = await screen.findByLabelText(/account pool/i);
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('work');
    expect(options).toContain('personal');
    expect((select as HTMLSelectElement).value).toBe('');
  });

  it('고른 풀을 생성 호출에 실어 보낸다 — 러너가 뜨기 전에 쓰여야 첫 러너가 그 풀로 돈다', async () => {
    await openCreate();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(await screen.findByLabelText(/account pool/i), { target: { value: 'personal' } });
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'beta' } });
    screen.getByRole('button', { name: '에이전트 만들기' }).click();

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    // 배정을 생성 **뒤에** 쓰면 `startCreated` 가 이미 기본 풀로 러너를 띄운다 —
    // 그래서 값이 생성 호출 자체에 실려야 한다.
    expect(createAgent.mock.calls[0]![1]).toEqual({ claudePool: 'personal' });
  });

  it('기본 풀 사용이면 아무것도 실어 보내지 않는다', async () => {
    await openCreate();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'beta' } });
    screen.getByRole('button', { name: '에이전트 만들기' }).click();

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0]![1]).toBeUndefined();
  });

  it('풀 배정만 실패하면 생성 실패라고 말하지 않는다 — PAT 는 그대로 보여 준다', async () => {
    // 그렇게 적지 않으면 사람은 PAT 상자를 무효한 것으로 읽고 버린다. 그 토큰은 다시 볼 수 없다.
    createAgent = vi.fn(async () => ({
      agent: makeAgent({ id: 'agent-new', handle: 'beta' }),
      pat: 'murp_new',
      poolError: '데몬이 죽었다',
    }));
    setController({
      listAgents: vi.fn(async () => []),
      listPats: vi.fn(async () => []),
      agentMemory: vi.fn(async () => ({ profile: null, entries: [] })),
      agentDefaults: vi.fn(async () => ({ harness: 'claude', model: null, effort: null })),
      createAgent,
    } as unknown as Controller);

    await openCreate();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'beta' } });
    screen.getByRole('button', { name: '에이전트 만들기' }).click();

    await waitFor(() => expect(screen.getByText(/에이전트는 만들어졌지만/)).toBeTruthy());
    expect(screen.getByText('murp_new')).toBeTruthy();
    expect(screen.queryByText(/만들지 못했다/)).toBeNull();
  });

  /**
   * 토큰 **자체**를 복사하는 버튼. 러너 명령 복사와 둘 다 필요한 이유: 토큰이 가는 곳이
   * 명령만이 아니다(다른 기기의 `.env`·비밀 저장소·CI 변수). 버튼이 없으면 사람은 명령을
   * 복사해 앞뒤를 손으로 잘라내야 하고, 한 글자를 흘리면 인증만 조용히 실패한다.
   */
  it('PAT 옆에 토큰만 복사하는 버튼이 있다', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true, writable: true,
    });
    await openCreate();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'beta' } });
    screen.getByRole('button', { name: '에이전트 만들기' }).click();

    const copy = await screen.findByLabelText('토큰 복사');
    copy.click();
    // 명령 껍데기가 아니라 **토큰 원문**이 클립보드로 가야 한다.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('murp_new'));
  });
});
