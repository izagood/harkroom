// 에이전트 목록이 **생존(presence)과 마지막 활동을 나란히** 보여 준다(#176).
//
// 왜 나란히인가: 둘은 다른 두 사실이다. 온라인은 러너가 지금 폴을 걸고 있다는 것이고
// (#124 의 인메모리 presence), 마지막 활동은 마지막으로 턴을 마친 시각이다. 하나로 합치면
// #124 가 닫은 결함(러너 없는 에이전트가 정상으로 보임)이 되살아난다 — 온라인인데 마지막
// 활동이 두 시간 전인 것은 정상이고(아무도 부르지 않았다), 그 반대도 봐야 하는 사실이다.
//
// 그리고 화면은 **모르는 것을 안다고 말하지 않는다**(docs/design.md §4): 활동 기록이 없으면
// '활동 없음'이고 '죽었다'가 아니며, 오래된 값도 '멈췄다'가 아니다. murmur 는 러너 프로세스를
// 보지 못한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings, lastTurnLabel } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null,
  // #176: 기본은 '아직 한 번도 턴을 돌린 적 없음' — 필요한 테스트가 덮는다.
  lastTurnAt: null,
  status: 'available', statusText: null, ...extra,
});

const fakeController = (agents: AgentView[], listFails = false) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => {
      if (listFails) throw new Error('down');
      return agents;
    }),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    updateAgent: vi.fn(async (_id: string, _patch: Partial<AgentConfig>) => agents[0]!),
  };
  setController(c as unknown as Controller);
  return c;
};

/** 러너가 실제로 붙어 있는 상태. 소켓이 끊겼으면 `online` 은 그냥 빈 배열이라 구분해야 한다. */
const connectedWith = (online: string[]) => {
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true), online, connected: true });
};

beforeEach(() => {
  useAppStore.getState().reset();
  connectedWith([]);
});
afterEach(() => cleanup());

describe('마지막 활동 표시 (#176)', () => {
  it('온라인 여부와 마지막 활동을 둘 다 보여 준다 — 하나가 다른 하나를 대체하지 않는다', async () => {
    // 두 사실이 서로 어긋나는 두 에이전트를 나란히 둔다. 한 필드로 뭉갠 화면은 이 둘을
    // 같은 표시로 그리게 되므로, 이 조합이 곧 "합치지 않았다"의 증거다.
    const idle = agent('idle', { lastTurnAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
    const gone = agent('gone', { lastTurnAt: new Date(Date.now() - 3 * 60_000).toISOString() });
    fakeController([idle, gone]);
    // idle 은 붙어 있지만 두 시간 동안 부르지 않았다. gone 은 3분 전까지 일했지만 지금 없다.
    connectedWith([idle.id]);

    render(<AgentsSettings />);

    const idlePresence = await screen.findByTestId(`agent-presence-${idle.id}`);
    expect(idlePresence.dataset.online).toBe('true');
    expect(idlePresence.textContent).toBe('온라인');
    expect(screen.getByTestId(`agent-last-turn-${idle.id}`).textContent).toBe('마지막 활동: 2시간 전');

    const gonePresence = screen.getByTestId(`agent-presence-${gone.id}`);
    expect(gonePresence.dataset.online).toBe('false');
    expect(gonePresence.textContent).toBe('오프라인');
    expect(screen.getByTestId(`agent-last-turn-${gone.id}`).textContent).toBe('마지막 활동: 3분 전');
  });

  it('lastTurnAt 이 null 이면 활동 없음이고, 죽었다·멈췄다고 쓰지 않는다', async () => {
    const fresh = agent('fresh');
    fakeController([fresh]);
    connectedWith([fresh.id]);

    render(<AgentsSettings />);

    expect((await screen.findByTestId(`agent-last-turn-${fresh.id}`)).textContent).toBe('활동 없음');
    // 온라인 표시는 그대로 살아 있다 — 활동 기록이 없는 것이 러너가 없다는 뜻은 아니다.
    expect(screen.getByTestId(`agent-presence-${fresh.id}`).textContent).toBe('온라인');
    // murmur 는 러너 프로세스를 보지 못하므로 이 문구들은 화면이 알 수 없는 것을 단정하는 말이다.
    for (const forbidden of ['죽었', '멈췄', '멈춤', '중단됨', '응답 없음']) {
      expect(document.body.textContent).not.toContain(forbidden);
    }
  });

  it('소켓이 끊겨 있으면 오프라인이라고 단정하지 않는다', async () => {
    // `online` 이 빈 배열인 것은 "아무도 안 붙어 있다"가 아니라 "스냅숏을 못 받았다"일 수 있다.
    // 그것을 오프라인으로 그리면 잘 돌고 있는 러너를 전부 죽은 것으로 표시한다.
    const bot = agent('bot', { lastTurnAt: new Date(Date.now() - 60_000 * 5).toISOString() });
    fakeController([bot]);
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true), online: [], connected: false });

    render(<AgentsSettings />);

    const presence = await screen.findByTestId(`agent-presence-${bot.id}`);
    expect(presence.dataset.online).toBe('unknown');
    expect(presence.textContent).toContain('알 수 없음');
    // 마지막 활동은 서버가 준 값이라 소켓과 무관하게 그대로 보인다.
    expect(screen.getByTestId(`agent-last-turn-${bot.id}`).textContent).toBe('마지막 활동: 5분 전');
  });

  it('목록 조회가 실패하면 빈 목록으로 삼키지 않고 사람에게 보인다', async () => {
    fakeController([], true);

    render(<AgentsSettings />);

    // 조용히 삼키면 '에이전트가 없다'와 '마지막 활동을 못 읽었다'가 같은 화면이 된다.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('에이전트 목록을 받지 못했다'));
  });
});

describe('lastTurnLabel', () => {
  const NOW = new Date('2026-09-03T12:00:00.000Z').getTime();
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('null 은 활동 없음이다 — 한 번도 안 돌린 것과 죽은 것을 구분할 수단이 없다', () => {
    expect(lastTurnLabel(null, NOW)).toBe('활동 없음');
  });

  it('분·시간·일 단위로 내림한다', () => {
    expect(lastTurnLabel(ago(30_000), NOW)).toBe('마지막 활동: 방금');
    expect(lastTurnLabel(ago(60_000), NOW)).toBe('마지막 활동: 1분 전');
    expect(lastTurnLabel(ago(59 * 60_000), NOW)).toBe('마지막 활동: 59분 전');
    expect(lastTurnLabel(ago(60 * 60_000), NOW)).toBe('마지막 활동: 1시간 전');
    expect(lastTurnLabel(ago(23 * 60 * 60_000), NOW)).toBe('마지막 활동: 23시간 전');
    expect(lastTurnLabel(ago(25 * 60 * 60_000), NOW)).toBe('마지막 활동: 1일 전');
  });

  it('미래 시각은 "N분 후" 같은 말을 만들지 않는다', () => {
    // 서버가 now() 를 찍으므로 정상적으로는 오지 않지만, 시계 보정으로 음수가 될 수 있다.
    expect(lastTurnLabel(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe('마지막 활동: 방금');
  });
});
