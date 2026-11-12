// 계정 관문 [터미널 열기]가 무엇을 열지(2026-10-02, 관문 대응 PR-4 · 칩 ② 2026-11-12). 카드에는 이름이 없고 순번만
// 온다 — 이 기기의 실제 계정 목록에서 러너와 같은 순서로 그 자리를 찾는다(security). 열 수 없는 곳은 "<오퍼레이터>에서 열기"다.
import { describe, expect, it } from 'vitest';
import { resolveGateTerminalTarget, type GateTerminalFacts } from '../src/lib/gateTerminal';
import type { ClaudeAccountsSnapshot } from '../src/lib/claudeAccounts';

const snap = (pools: Record<string, string[]>, extra: Partial<ClaudeAccountsSnapshot> = {}): ClaudeAccountsSnapshot => ({
  root: '/r', mode: 'pools', defaultPool: 'work', agents: {}, strays: [],
  pools: Object.entries(pools).map(([name, accts]) => ({ name, accounts: accts.map((a) => ({ name: a, status: { loggedIn: true } as never })) })),
  ...extra,
});
const facts = (o: Partial<GateTerminalFacts>): GateTerminalFacts => ({
  accountRank: 1, agentId: 'ag', hasLocalSurface: true, agentIsLocal: true, operatorName: null,
  snapshot: snap({ work: ['acct-1', 'plum'], alice: ['max'] }), ...o,
});

describe('resolveGateTerminalTarget', () => {
  it('풀 순서가 없으면 기본 풀에서 계정 순번 자리를 연다', () => {
    expect(resolveGateTerminalTarget(facts({}))).toEqual({ kind: 'open', pool: 'work', account: 'acct-1' });
    expect(resolveGateTerminalTarget(facts({ accountRank: 2 }))).toEqual({ kind: 'open', pool: 'work', account: 'plum' });
  });
  it('에이전트의 풀 순서에서 풀 순번 → 그 풀의 계정 순번', () => {
    const s = snap({ work: ['acct-1', 'plum'], alice: ['lime', 'max'] }, { agents: { ag: ['alice', 'work'] } });
    expect(resolveGateTerminalTarget(facts({ snapshot: s, poolRank: 1, accountRank: 2 }))).toEqual({ kind: 'open', pool: 'alice', account: 'max' });
    expect(resolveGateTerminalTarget(facts({ snapshot: s, poolRank: 2, accountRank: 1 }))).toEqual({ kind: 'open', pool: 'work', account: 'acct-1' });
  });
  it('이 기기의 풀 순서에 없는 자리는 바깥 순번이라도 이웃 풀로 새지 않는다', () => {
    // 이 기기에 없는 풀(gone)은 러너처럼 건너뛴다 — 그래서 2번은 work 다.
    const s = snap({ work: ['acct-1'], alice: ['max'] }, { agents: { ag: ['alice', 'gone', 'work'] } });
    expect(resolveGateTerminalTarget(facts({ snapshot: s, poolRank: 2 }))).toEqual({ kind: 'open', pool: 'work', account: 'acct-1' });
  });
  it('pools.json 의 order 가 있으면 러너처럼 그 순서(나머지는 이름순)로 센다 — 스냅숏 계정은 이름순이다', () => {
    const s = snap({ work: ['acct-1', 'plum', 'zed'] }, { order: { work: ['zed', 'acct-1', 'gone'] } });
    expect(resolveGateTerminalTarget(facts({ snapshot: s, accountRank: 1 }))).toEqual({ kind: 'open', pool: 'work', account: 'zed' });
    expect(resolveGateTerminalTarget(facts({ snapshot: s, accountRank: 2 }))).toEqual({ kind: 'open', pool: 'work', account: 'acct-1' });
    expect(resolveGateTerminalTarget(facts({ snapshot: s, accountRank: 3 }))).toEqual({ kind: 'open', pool: 'work', account: 'plum' });
    expect(resolveGateTerminalTarget(facts({ snapshot: s, accountRank: 4 }))).toEqual({ kind: 'missing' });
  });
  it('목록 밖 순번이면 열지 않는다 — 에이전트가 고른 값을 믿지 않는다', () => {
    expect(resolveGateTerminalTarget(facts({ accountRank: 9 }))).toEqual({ kind: 'missing' });
    expect(resolveGateTerminalTarget(facts({ poolRank: 5 }))).toEqual({ kind: 'missing' });
  });
  it('로컬 지정 풀이 있으면 그 풀에서 센다', () => {
    expect(resolveGateTerminalTarget(facts({ localPool: 'alice' }))).toEqual({ kind: 'open', pool: 'alice', account: 'max' });
  });
  it('웹·모바일(로컬 표면 없음)·다른 오퍼레이터의 에이전트면 elsewhere — 오퍼레이터 이름을 싣는다', () => {
    expect(resolveGateTerminalTarget(facts({ hasLocalSurface: false, operatorName: 'studio-mac' })))
      .toEqual({ kind: 'elsewhere', operatorName: 'studio-mac' });
    expect(resolveGateTerminalTarget(facts({ agentIsLocal: false }))).toEqual({ kind: 'elsewhere', operatorName: null });
  });
  it('목록을 아직 못 읽었으면 unknown — 아무것도 그리지 않는다', () => {
    expect(resolveGateTerminalTarget(facts({ snapshot: null })).kind).toBe('unknown');
    expect(resolveGateTerminalTarget(facts({ agentIsLocal: null })).kind).toBe('unknown');
  });
});
