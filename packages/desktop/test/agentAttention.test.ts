import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { chan, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/**
 * 에이전트가 사람 손을 기다릴 때 앱이 터미널을 **자동으로** 여는 자리(2026-09-08).
 *
 * 왜 자동인가: 첫 실행 관문에 걸린 턴은 화면에 아무 신호도 남기지 않는다 — 답이 안 올
 * 뿐이다. 사람은 [터미널 열기]를 누를 이유조차 모른다. 개입 UI 는 이미 완성돼 있고,
 * 빠진 것은 그것을 **언제 띄울지 말해 주는 한 마디**뿐이었다.
 */
beforeEach(() => useAppStore.getState().reset());

async function 앱() {
  const api = fakeApi({ channels: vi.fn(async () => [chan('c1', 'general')]) });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs);
  await c.start();
  return { api, controller: c, callbacks };
}

const 부름 = {
  type: 'agent.attention' as const,
  sessionId: 's1',
  channelId: 'c1',
  threadRootId: 't1',
  agentAccountId: 'agent-1',
  agentHandle: 'murmur',
  accountLabel: 'aria',
};

describe('agent.attention 을 받은 데스크탑', () => {
  it('그 스레드의 터미널 패널을 연다', async () => {
    const { callbacks } = await 앱();
    callbacks.current!.onEvent(부름);

    const s = useAppStore.getState();
    expect(s.terminalTarget).toEqual({
      agentAccountId: 'agent-1', channelId: 'c1', threadRootId: 't1',
    });
  });

  it('터미널을 자동으로 열었으면 카드를 세우지 않는다 — 열린 터미널 위에 겹쳐 말하지 않는다', async () => {
    const { callbacks } = await 앱();
    callbacks.current!.onEvent(부름);
    expect(useAppStore.getState().gates).toEqual([]);
    // 실패 토스트로도 새지 않는다 — 관문은 실패가 아니다(2026-10-09 A안).
    expect(useAppStore.getState().notices).toEqual([]);
  });

  it('이미 그 스레드의 터미널이 열려 있으면 건드리지 않는다', async () => {
    const { callbacks } = await 앱();
    useAppStore.getState().set({
      terminalTarget: { agentAccountId: 'agent-1', channelId: 'c1', threadRootId: 't1' },
    });

    callbacks.current!.onEvent(부름);

    // 같은 자리를 다시 세우면 xterm 이 다시 붙으면서 화면이 깜빡이고, 사람이 치고 있던
    // 입력이 끊긴다 — 이미 보고 있는 사람에게 할 일이 없다.
    expect(useAppStore.getState().gates).toEqual([]);
  });

  it('다른 스레드의 터미널을 보고 있으면 빼앗지 않고 카드를 세운다 — 누가·어느 계정인지 싣는다', async () => {
    const { callbacks } = await 앱();
    const 보던것 = { agentAccountId: 'agent-9', channelId: 'c9', threadRootId: 't9' };
    useAppStore.getState().set({ terminalTarget: 보던것 });

    callbacks.current!.onEvent(부름);

    // 사람이 보던 화면을 갈아치우지 않는다. 그 사람은 지금 다른 것을 하고 있다.
    expect(useAppStore.getState().terminalTarget).toEqual(보던것);
    expect(useAppStore.getState().gates).toEqual([{
      sessionId: 's1', agentAccountId: 'agent-1', agentHandle: 'murmur', accountLabel: 'aria',
      channelId: 'c1', threadRootId: 't1', dismissed: false,
    }]);
  });

  it('스레드 루트가 없으면 열지 않고 카드만 세운다 — 열 자리가 없다', async () => {
    const { callbacks } = await 앱();
    callbacks.current!.onEvent({ ...부름, threadRootId: null });

    expect(useAppStore.getState().terminalTarget).toBeNull();
    expect(useAppStore.getState().gates.map((g) => g.agentHandle)).toEqual(['murmur']);
  });
});

describe('관문 카드가 내려가는 때 (2026-10-09 A안)', () => {
  const 보던것 = { agentAccountId: 'agent-9', channelId: 'c9', threadRootId: 't9' };

  it('그 터미널을 열면 내려간다 — 여는 문이 어디든', async () => {
    const { callbacks } = await 앱();
    useAppStore.getState().set({ terminalTarget: 보던것 });
    callbacks.current!.onEvent(부름);
    expect(useAppStore.getState().gates).toHaveLength(1);

    useAppStore.getState().set({ terminalTarget: { agentAccountId: 'agent-1', channelId: 'c1', threadRootId: 't1' } });
    expect(useAppStore.getState().gates).toEqual([]);
  });

  it('세션이 끝났다는 신호(agent.attention.cleared)로 내려간다', async () => {
    const { callbacks } = await 앱();
    useAppStore.getState().set({ terminalTarget: 보던것 });
    callbacks.current!.onEvent(부름);

    callbacks.current!.onEvent({
      type: 'agent.attention.cleared', sessionId: 's1', channelId: 'c1', threadRootId: 't1', agentAccountId: 'agent-1',
    });
    expect(useAppStore.getState().gates).toEqual([]);
  });

  it('[나중에]는 카드만 접는다 — 풀릴 때까지 대기 표시는 남는다', async () => {
    const { callbacks } = await 앱();
    useAppStore.getState().set({ terminalTarget: 보던것 });
    callbacks.current!.onEvent(부름);

    useAppStore.getState().dismissGate('s1');
    expect(useAppStore.getState().gates).toEqual([expect.objectContaining({ sessionId: 's1', dismissed: true })]);
    // 같은 세션이 다시 부르면 다시 편다.
    callbacks.current!.onEvent(부름);
    expect(useAppStore.getState().gates).toEqual([expect.objectContaining({ sessionId: 's1', dismissed: false })]);
  });
});

describe('실패 토스트 (2026-10-09 A안)', () => {
  it('덮어쓰지 않고 쌓는다 — 셋까지, 넘치면 오래된 것부터 밀린다', () => {
    const st = useAppStore.getState();
    for (const text of ['하나', '둘', '셋', '넷']) st.pushNotice(text);
    expect(useAppStore.getState().notices.map((n) => n.text)).toEqual(['둘', '셋', '넷']);
  });

  it('같은 글이 떠 있으면 또 쌓지 않는다', () => {
    const st = useAppStore.getState();
    st.pushNotice('같은 실패');
    st.pushNotice('같은 실패');
    expect(useAppStore.getState().notices).toHaveLength(1);
  });
});
