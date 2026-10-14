// 계정 풀 순서 목록 화면(2026-10-15 풀 n개). 판정은 러너와 같은 식(`poolChainState`)에서 오고, 화면은
// 그 값을 그대로 말해야 한다 — designer 확인 항목(모름·리셋 지남·소진·없는 풀·턴 칩)을 여기서 잰다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AgentSessionView } from '@harkroom/shared';

import { MAX_AGENT_POOLS } from '@harkroom/shared/claudePools';

import { AgentPoolChain, clock } from '../src/components/settings/AgentPoolChain';
import { agentPoolChainState } from '../src/components/settings/useAgentPool';
import type { ClaudeAccountsSnapshot } from '../src/lib/claudeAccounts';
import type { ProviderUsageSnapshot } from '../src/lib/providerUsage';
import { AgentTurns } from '../src/components/AgentTurns';
import { usePrefsStore } from '../src/state/prefsStore';

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
});
