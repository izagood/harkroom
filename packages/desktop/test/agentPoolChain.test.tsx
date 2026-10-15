// 계정 풀 순서 목록 화면(2026-10-15 풀 n개). 판정은 러너와 같은 식(`poolChainState`)에서 오고, 화면은
// 그 값을 그대로 말해야 한다 — designer 확인 항목(모름·리셋 지남·소진·없는 풀·턴 칩)을 여기서 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentSessionView } from '@harkroom/shared';

import { MAX_AGENT_POOLS } from '@harkroom/shared/claudePools';

import { AgentPoolChain, clock } from '../src/components/settings/AgentPoolChain';
import { agentPoolChainState } from '../src/components/settings/useAgentPool';
import { assignAgentPools, type ClaudeAccountsSnapshot } from '../src/lib/claudeAccounts';
import type { ProviderUsageSnapshot } from '../src/lib/providerUsage';
import { AgentTurns } from '../src/components/AgentTurns';
import { usePrefsStore } from '../src/state/prefsStore';

// jsdom 에는 PointerEvent 가 없다 — 좌표가 실리도록 MouseEvent 를 물려 만든다(imageLightbox.test 와 같다).
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const NOW = Date.UTC(2026, 9, 15, 6, 0);
const H = 3600_000;

const snap: ClaudeAccountsSnapshot = {
  root: '/r', mode: 'pools', defaultPool: 'work', agents: {}, strays: [],
  pools: [
    { name: 'work', accounts: [{ name: 'w1', status: { loggedIn: true } as never }, { name: 'w2', status: { loggedIn: true } as never }] },
    { name: 'personal', accounts: [{ name: 'p1', status: { loggedIn: true } as never }] },
  ],
};

function usage(rows: { pool: string; account: string; s: number; w?: number; reset?: number; error?: string; at?: number }[]): ProviderUsageSnapshot {
  return {
    measuredAtMs: NOW,
    accounts: rows.map((r) => ({
      pool: r.pool, account: r.account,
      session: { usedPercent: r.s, resetsAtMs: r.reset ?? NOW + H },
      weekly: { usedPercent: r.w ?? 10, resetsAtMs: NOW + 72 * H },
      fetchedAtMs: r.at ?? NOW - 60_000,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}

function show(chain: string[], u: ProviderUsageSnapshot | null) {
  const state = agentPoolChainState(snap, chain, u, NOW);
  render(<AgentPoolChain chain={chain} pools={['work', 'personal']} defaultPool="work" state={state} ready onChange={() => {}} />);
  return state;
}

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('AgentPoolChain', () => {
  it('평소 — 1번을 쓰는 중, 2번은 대기', () => {
    show(['work', 'personal'], usage([{ pool: 'work', account: 'w1', s: 20 }, { pool: 'work', account: 'w2', s: 30 }]));
    expect(screen.getByTestId('agent-pool-chain-status').textContent).toMatch(/1번 work 을 쓰는 중/);
    expect(screen.getByTestId('agent-pool-chain-chip-work').textContent).toBe('쓰는 중');
    expect(screen.getByTestId('agent-pool-chain-chip-personal').textContent).toBe('대기');
  });

  it('앞 풀이 모두 기준에 닿으면 2번 — 상태 줄이 언제 돌아가는지 말한다', () => {
    const state = show(['work', 'personal'], usage([{ pool: 'work', account: 'w1', s: 90 }, { pool: 'work', account: 'w2', s: 88 }]));
    expect(state?.activeIndex).toBe(1);
    const status = screen.getByTestId('agent-pool-chain-status');
    // 왜(designer s2) — 어느 풀이 어느 창 때문에, 언제 돌아가나. 칸 색(s3)은 경고.
    expect(status.textContent).toMatch(/2번 personal 을 쓰는 중 — 1번 work 은 5시간 한도에 닿았다\. .+ 에 풀리면/);
    expect(status.dataset.tone).toBe('warning');
    expect(screen.getByTestId('agent-pool-chain-chip-work').textContent).toMatch(/^소진 · /);
    expect(screen.getByTestId('agent-pool-chain-chip-personal').textContent).toBe('쓰는 중');
  });

  it('사용량을 모르는(오류·낡은) 계정은 소진이 아니다 — 막대는 비고 「?」', () => {
    show(['work', 'personal'], usage([
      { pool: 'work', account: 'w1', s: 99, error: 'timeout' },
      { pool: 'work', account: 'w2', s: 99, at: NOW - 30 * 60_000 },
    ]));
    expect(screen.getByTestId('agent-pool-chain-chip-work').textContent).toBe('쓰는 중');
    expect(screen.getByTestId('pool-chain-account-w1').textContent).toMatch(/\?$/);
    expect(screen.getByTestId('pool-chain-account-w2').textContent).toMatch(/\?$/);
  });

  it('리셋 시각이 지난 풀은 다시 재기 전이라도 「소진」으로 남지 않는다', () => {
    show(['work', 'personal'], usage([
      { pool: 'work', account: 'w1', s: 95, reset: NOW - 60_000 },
      { pool: 'work', account: 'w2', s: 95, reset: NOW - 60_000 },
    ]));
    expect(screen.getByTestId('agent-pool-chain-chip-work').textContent).toBe('쓰는 중');
  });

  it('모든 풀 소진 — 가장 먼저 풀리는 풀로 보낸다고 말한다', () => {
    show(['work', 'personal'], usage([
      { pool: 'work', account: 'w1', s: 90, reset: NOW + 3 * H },
      { pool: 'work', account: 'w2', s: 90, reset: NOW + 3 * H },
      { pool: 'personal', account: 'p1', s: 90, reset: NOW + H },
    ]));
    expect(screen.getByTestId('agent-pool-chain-status').textContent).toMatch(/모든 풀이 소진됐다 — 가장 먼저 풀리는 2번 personal/);
  });

  it('목록이 상한(MAX_AGENT_POOLS)에 닿으면 「＋ 풀 추가」를 그리지 않는다(security n3)', () => {
    const full = Array.from({ length: MAX_AGENT_POOLS }, (_, i) => `p${i}`);
    render(<AgentPoolChain chain={full} pools={[...full, 'extra']} defaultPool="work" state={null} ready onChange={() => {}} />);
    expect(screen.queryByTestId('agent-pool-chain-add')).toBeNull();
    cleanup();
    render(<AgentPoolChain chain={full.slice(1)} pools={[...full, 'extra']} defaultPool="work" state={null} ready onChange={() => {}} />);
    expect(screen.getByTestId('agent-pool-chain-add')).toBeTruthy();
  });

  it('상태 줄의 이유는 소진 원인(주간·관문)과 없는 풀을 말한다', () => {
    show(['work', 'personal'], usage([{ pool: 'work', account: 'w1', s: 10, w: 98 }, { pool: 'work', account: 'w2', s: 10, w: 99 }]));
    expect(screen.getByTestId('agent-pool-chain-status').textContent).toMatch(/1번 work 은 주간 한도에 닿았다/);
    cleanup();
    show(['ghost', 'work'], null);
    expect(screen.getByTestId('agent-pool-chain-status').textContent).toMatch(/1번 ghost 은 이 기기에 없다/);
  });

  it('평소는 조용한 줄, 모두 소진은 위험 칸', () => {
    show(['work', 'personal'], usage([{ pool: 'work', account: 'w1', s: 20 }]));
    expect(screen.getByTestId('agent-pool-chain-status').dataset.tone).toBe('quiet');
    cleanup();
    show(['work', 'personal'], usage([
      { pool: 'work', account: 'w1', s: 90 }, { pool: 'work', account: 'w2', s: 90 }, { pool: 'personal', account: 'p1', s: 90 },
    ]));
    expect(screen.getByTestId('agent-pool-chain-status').dataset.tone).toBe('danger');
  });

  it('넘어갈 풀이 없으면(풀 1개) 그것을 미리 말한다', () => {
    show(['work'], usage([{ pool: 'work', account: 'w1', s: 20 }]));
    expect(screen.getByTestId('agent-pool-chain-status').textContent).toBe('1번 work 을 쓰는 중 — 넘어갈 풀이 없다. 다 쓰면 가장 먼저 풀리는 계정으로 보낸다.');
    cleanup();
    show(['work', 'personal'], usage([{ pool: 'work', account: 'w1', s: 20 }]));
    expect(screen.getByTestId('agent-pool-chain-status').textContent).toBe('1번 work 을 쓰는 중.');
  });

  it('「쓰는 중」 칩은 초록, 「소진」만 빨강(designer s4)', () => {
    show(['work', 'personal'], usage([{ pool: 'work', account: 'w1', s: 90 }, { pool: 'work', account: 'w2', s: 90 }]));
    expect(screen.getByTestId('agent-pool-chain-chip-personal').className).toMatch(/text-success/);
    expect(screen.getByTestId('agent-pool-chain-chip-work').className).toMatch(/text-danger/);
  });

  it('풀을 다 넣으면 「추가」 자리에 그 사실을 한 줄 남긴다', () => {
    show(['work', 'personal'], null);
    expect(screen.queryByTestId('agent-pool-chain-add')).toBeNull();
    expect(screen.getByTestId('agent-pool-chain-add-none').textContent).toBe('모든 풀을 넣었다.');
  });

  it('이 기기에 없는 풀은 건너뛰되 목록에서 빼지 않는다', () => {
    show(['ghost', 'work'], null);
    expect(screen.getByTestId('agent-pool-chain-chip-ghost').textContent).toBe('이 기기에 없음');
    expect(screen.getByTestId('agent-pool-chain-chip-work').textContent).toBe('쓰는 중');
  });
});

describe('clock — 풀리는 시각', () => {
  it('오늘이면 시각만, 아니면 날짜를 붙인다(주간 한도가 오늘로 읽히지 않게)', () => {
    const base = new Date(2026, 9, 15, 9, 0).getTime();
    expect(clock(base + 2 * H, 'ko', base)).toBe('11:00');
    expect(clock(new Date(2026, 9, 18, 9, 0).getTime(), 'ko', base)).toBe('10/18 09:00');
  });
});

describe('AgentTurns — 「↓ N번 풀」 칩', () => {
  const turn = (pool: string): AgentSessionView => ({
    sessionId: `s-${pool}`, agentAccountId: 'agent-1', channelId: 'c1', threadRootId: 't1',
    harness: 'claude-code', startedAt: new Date(NOW).toISOString(), claudeAccount: 'a', claudePool: pool,
  } as unknown as AgentSessionView);

  it('2번 풀에서 돌면 붙고, 1번 풀에서는 붙지 않는다', () => {
    render(
      <AgentTurns
        snapshot={{ kind: 'known', turns: [turn('work'), turn('personal')] } as never}
        handleOf={(id) => id} channelLabel={(id) => id} onOpenThread={() => {}} now={NOW}
        poolChainOf={() => ['work', 'personal']}
      />,
    );
    expect(screen.queryByTestId('agent-turn-pool-fallback-s-work')).toBeNull();
    expect(screen.getByTestId('agent-turn-pool-fallback-s-personal').textContent).toBe('↓ 2번 풀');
  });

  // f3: 원격 오퍼레이터의 턴은 이 기기의 순서와 다를 수 있다 — 러너가 실은 번호가 이긴다.
  it('러너가 실은 순서 번호가 이 기기의 순서보다 먼저다', () => {
    render(
      <AgentTurns
        snapshot={{ kind: 'known', turns: [
          { ...turn('work'), claudePoolRank: 3 },
          { ...turn('personal'), claudePoolRank: 1 },
          { ...turn('remote-only'), claudePoolRank: 2 },
        ] } as never}
        handleOf={(id) => id} channelLabel={(id) => id} onOpenThread={() => {}} now={NOW}
        poolChainOf={() => ['work', 'personal']}
      />,
    );
    expect(screen.getByTestId('agent-turn-pool-fallback-s-work').textContent).toBe('↓ 3번 풀');
    expect(screen.queryByTestId('agent-turn-pool-fallback-s-personal')).toBeNull();
    // 이 기기에는 없는 풀이어도 러너의 번호로 붙는다.
    expect(screen.getByTestId('agent-turn-pool-fallback-s-remote-only').textContent).toBe('↓ 2번 풀');
  });

  it('형식이 틀린 번호는 버리고 이 기기의 순서로 잰다', () => {
    render(
      <AgentTurns
        snapshot={{ kind: 'known', turns: [
          { ...turn('personal'), claudePoolRank: 0 },
          { ...turn('work'), sessionId: 's-w2', claudePoolRank: 1.5 },
          { ...turn('work'), sessionId: 's-w3', claudePoolRank: 99 },
          { ...turn('work'), sessionId: 's-w4', claudePoolRank: '2' },
        ] } as never}
        handleOf={(id) => id} channelLabel={(id) => id} onOpenThread={() => {}} now={NOW}
        poolChainOf={() => ['work', 'personal']}
      />,
    );
    expect(screen.getByTestId('agent-turn-pool-fallback-s-personal').textContent).toBe('↓ 2번 풀');
    for (const id of ['s-w2', 's-w3', 's-w4']) expect(screen.queryByTestId(`agent-turn-pool-fallback-${id}`)).toBeNull();
  });
});

describe('AgentPoolChain — 끌어 순서 바꾸기(f1)', () => {
  const ROW_H = 40;
  /** 줄 i 를 y = i*40 ~ i*40+40 에 둔다(jsdom 은 배치를 하지 않는다). */
  function layout(chain: string[]) {
    chain.forEach((pool, i) => {
      const el = screen.getByTestId(`agent-pool-chain-row-${pool}`);
      el.getBoundingClientRect = () => ({
        top: i * ROW_H, bottom: i * ROW_H + ROW_H, height: ROW_H, left: 0, right: 200, width: 200, x: 0, y: i * ROW_H,
        toJSON: () => ({}),
      }) as DOMRect;
    });
  }
  function mount(chain: string[], ready = true) {
    const onChange = vi.fn();
    render(<AgentPoolChain chain={chain} pools={chain} defaultPool={null} state={null} ready={ready} onChange={onChange} />);
    layout(chain);
    return onChange;
  }
  const chain = ['a', 'b', 'c'];

  it('손잡이를 끌어 놓으면 새 순서를 ↑↓ 와 같은 onChange 로 넘긴다', () => {
    const onChange = mount(chain);
    const h = screen.getByTestId('agent-pool-chain-handle-a');
    expect(h.getAttribute('aria-label')).toBe('a 을 끌어 순서 바꾸기');
    expect(h.className).toMatch(/touch-none/);
    expect(h.className).toMatch(/cursor-grab/);
    fireEvent.pointerDown(h, { pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: 110 }); // c 의 가운데(100) 아래
    expect(screen.getByTestId('agent-pool-chain-row-a').dataset.dragging).toBe('true');
    // 아래로 옮기면 놓일 자리(c) 아래에 선이 선다.
    expect(screen.getByTestId('agent-pool-chain-row-c').querySelector('[data-testid="agent-pool-chain-drop"]')).toBeTruthy();
    fireEvent.pointerUp(h, { pointerId: 1, clientY: 110 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['b', 'c', 'a']);
    expect(screen.queryByTestId('agent-pool-chain-drop')).toBeNull();
  });

  it('위로 끌기 — c 를 맨 위로', () => {
    const onChange = mount(chain);
    const h = screen.getByTestId('agent-pool-chain-handle-c');
    fireEvent.pointerDown(h, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: 5 });
    expect(screen.getByTestId('agent-pool-chain-row-a').querySelector('[data-testid="agent-pool-chain-drop"]')).toBeTruthy();
    fireEvent.pointerUp(h, { pointerId: 1, clientY: 5 });
    expect(onChange).toHaveBeenCalledWith(['c', 'a', 'b']);
  });

  it('pointercancel 이면 쓰지 않는다', () => {
    const onChange = mount(chain);
    const h = screen.getByTestId('agent-pool-chain-handle-a');
    fireEvent.pointerDown(h, { pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: 110 });
    fireEvent.pointerCancel(h, { pointerId: 1 });
    fireEvent.pointerUp(h, { pointerId: 1, clientY: 110 });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-pool-chain-row-a').dataset.dragging).toBeUndefined();
  });

  it('Escape 면 거둔다', () => {
    const onChange = mount(chain);
    const h = screen.getByTestId('agent-pool-chain-handle-a');
    fireEvent.pointerDown(h, { pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: 110 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(h, { pointerId: 1, clientY: 110 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('제자리에 놓으면 쓰지 않는다', () => {
    const onChange = mount(chain);
    const h = screen.getByTestId('agent-pool-chain-handle-b');
    fireEvent.pointerDown(h, { pointerId: 1, clientY: 60 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: 110 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: 58 });
    fireEvent.pointerUp(h, { pointerId: 1, clientY: 58 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('저장할 수 없으면(ready=false) 손잡이도 ↑↓ 처럼 잠긴다', () => {
    const onChange = mount(chain, false);
    const h = screen.getByTestId('agent-pool-chain-handle-a') as HTMLButtonElement;
    expect(h.disabled).toBe(true);
    fireEvent.pointerDown(h, { pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: 110 });
    fireEvent.pointerUp(h, { pointerId: 1, clientY: 110 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('줄이 하나면 손잡이를 그리지 않는다', () => {
    mount(['a']);
    expect(screen.queryByTestId('agent-pool-chain-handle-a')).toBeNull();
  });
});

describe('assignAgentPools — 쓰기 줄 세우기(f4)', () => {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: unknown };
  afterEach(() => { delete g.__TAURI_INTERNALS__; });

  /** 읽고-쓰기가 각각 기다리는 가짜 데몬. 읽기는 빠르고 첫 쓰기는 느리다 — 줄이 없으면 엇갈린다. */
  function fakeDaemon(opts: { failFirstWrite?: boolean } = {}) {
    const log: string[] = [];
    let stored: Record<string, string[]> = {};
    let writes = 0;
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
    g.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { config: { agents: Record<string, string[]> } }) => {
        if (cmd === 'claude_accounts_list') {
          log.push('list');
          await tick(1);
          return { ...snap, agents: { ...stored } };
        }
        if (cmd === 'claude_accounts_configure') {
          const n = ++writes;
          log.push(`write:${n}:start`);
          await tick(n === 1 ? 20 : 1);
          log.push(`write:${n}:end`);
          if (n === 1 && opts.failFirstWrite) throw new Error('boom');
          stored = { ...args!.config.agents };
          return undefined;
        }
        throw new Error(`unexpected ${cmd}`);
      },
    };
    return { log, get stored() { return stored; } };
  }

  it('빠르게 두 번 부르면 차례로 돌고, 마지막 순서가 남는다', async () => {
    const d = fakeDaemon();
    const p1 = assignAgentPools('ag', ['work', 'personal']);
    const p2 = assignAgentPools('ag', ['personal', 'work']);
    await Promise.all([p1, p2]);
    // 두 번째 읽기는 첫 쓰기가 끝난 **뒤에** 온다.
    expect(d.log).toEqual(['list', 'write:1:start', 'write:1:end', 'list', 'write:2:start', 'write:2:end']);
    expect(d.stored.ag).toEqual(['personal', 'work']);
  });

  it('앞 쓰기가 실패해도 줄은 이어지고, 실패는 그 호출에만 간다', async () => {
    const d = fakeDaemon({ failFirstWrite: true });
    const p1 = assignAgentPools('ag', ['work']);
    const p2 = assignAgentPools('ag', ['personal']);
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBeUndefined();
    expect(d.stored.ag).toEqual(['personal']);
  });
});
