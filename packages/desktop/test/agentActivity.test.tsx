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
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings, lastTurnLabel } from '../src/components/settings/AgentsSettings';
import { lastTurnAgo } from '../src/lib/lastTurn';
import { acc } from './helpers/fakeApi';

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null,
  // #176: 기본은 '아직 한 번도 턴을 돌린 적 없음' — 필요한 테스트가 덮는다.
  lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
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

    /**
     * **Task 15-2 로 자리가 바뀌었다.** 두 사실은 카드가 아니라 **상세 헤더**에 나란히 선다
     * (문서: "카드는 조용하다"). 지키는 것은 자리가 아니라 **둘이 서로를 대체하지 않는다**
     * 이므로, 하나씩 골라 두 조합을 모두 확인한다.
     */
    fireEvent.click(await screen.findByTestId(`agent-card-${idle.handle}`));
    const idlePresence = await screen.findByTestId(`agent-presence-${idle.id}`);
    expect(idlePresence.dataset.online).toBe('true');
    expect(idlePresence.textContent).toBe('온라인');
    expect(screen.getByTestId(`agent-last-turn-${idle.id}`).textContent).toBe('마지막 활동: 2시간 전');

    // 붙어 있는데 오래 쉰 것 / 방금까지 일했는데 지금 없는 것 — 한 필드로 뭉갠 화면은
    // 이 둘을 같은 표시로 그린다. 그래서 이 조합이 곧 "합치지 않았다"의 증거다.
    // 상세가 그리드를 덮으므로 다른 카드를 고르려면 **먼저 돌아간다**(Task 15: 한 번에 한 화면).
    fireEvent.click(screen.getByTestId('agent-back'));
    fireEvent.click(await screen.findByTestId(`agent-card-${gone.handle}`));
    const gonePresence = await screen.findByTestId(`agent-presence-${gone.id}`);
    expect(gonePresence.dataset.online).toBe('false');
    expect(gonePresence.textContent).toBe('오프라인');
    expect(screen.getByTestId(`agent-last-turn-${gone.id}`).textContent).toBe('마지막 활동: 3분 전');
  });

  it('lastTurnAt 이 null 이면 활동 없음이고, 죽었다·멈췄다고 쓰지 않는다', async () => {
    const fresh = agent('fresh');
    fakeController([fresh]);
    connectedWith([fresh.id]);

    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId(`agent-card-${fresh.handle}`));

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
    // 카드는 **그리드에서** 본다 — 상세로 들어가면 그리드가 덮인다(Task 15: 한 번에 한 화면).
    //
    // `#443` 이 이 단언을 `'ok'` 에서 바꿨다. '모른다'를 회색으로 단정하지 않는 것은
    // 그대로 옳지만(끊긴 동안 40개가 전부 가라앉으면 그것도 거짓말이다), **초록으로
    // 단정하는 것도 같은 크기의 거짓말**이었다 — 실측(2026-09-06)에서 서버가 죽었는데
    // 에이전트 여섯이 전부 초록이었다. 바로 아래 상세 표시가 이미 `'unknown'` 을 말하고
    // 있었으므로, 같은 화면의 두 자리가 서로 다른 말을 하고 있었던 셈이다.
    const card = await screen.findByTestId(`agent-card-${bot.handle}`);
    expect(card.dataset.face).toBe('unknown');

    fireEvent.click(card);
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

  /**
   * **계산이 한 벌인 것을 잠근다** (`docs/desktop-agent-cards.pdf` 2쪽이 이 값을 카드에도
   * 올렸다).
   *
   * 계산은 `lib/lastTurn.ts` 의 `lastTurnAgo` 로 나갔고 이 함수는 접두만 붙인다. 나눈
   * 이유가 둘이다: ① 카드는 왼쪽에 `활동` 라벨을 이미 세워 두므로 접두가 붙으면 같은 말이
   * 두 번이고, ② `settings/AgentGrid.tsx` 는 이 파일에서 함수를 가져올 수 없다(이 파일이
   * `AgentGrid` 를 import 하므로 순환).
   *
   * 위 시험들이 문구를 그대로 지키므로 **이 시험은 두 함수가 갈라지지 않는 것**만 본다 —
   * 사본을 하나 더 만들면 문구는 맞는데 계산이 어긋나는 날이 온다(`faceState`·
   * `runnerVersions` 주석이 반복해서 경고한 그 모양이다).
   */
  it('접두를 뺀 것이 lastTurnAgo 다 — 계산이 두 벌이 아니다', () => {
    for (const ms of [30_000, 60_000, 59 * 60_000, 60 * 60_000, 25 * 60 * 60_000]) {
      expect(lastTurnLabel(ago(ms), NOW)).toBe(`마지막 활동: ${lastTurnAgo(ago(ms), NOW)}`);
    }
    // `null` 은 접두 규칙이 다르다 — `마지막 활동: 없음` 이 아니라 `활동 없음` 이다(`#176`).
    expect(lastTurnAgo(null, NOW)).toBe('없음');
    expect(lastTurnLabel(null, NOW)).toBe('활동 없음');
  });
});
