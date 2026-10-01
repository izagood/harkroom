// 계정 관문 [터미널 열기]가 무엇을 열지(2026-10-02, 관문 대응 PR-4). meta 의 이름표를 그대로 믿지 않고
// 이 기기의 실제 계정 목록과 맞춰 본다(security). 열 수 없는 곳은 "<오퍼레이터>에서 열기"다.
import { describe, expect, it } from 'vitest';
import { resolveGateTerminalTarget, type GateTerminalFacts } from '../src/lib/gateTerminal';
import type { ClaudeAccountsSnapshot } from '../src/lib/claudeAccounts';

const snap = (pools: Record<string, string[]>, extra: Partial<ClaudeAccountsSnapshot> = {}): ClaudeAccountsSnapshot => ({
  root: '/r', mode: 'pools', defaultPool: 'work', agents: {}, strays: [],
  pools: Object.entries(pools).map(([name, accts]) => ({ name, accounts: accts.map((a) => ({ name: a, status: { loggedIn: true } as never })) })),
  ...extra,
});
const facts = (o: Partial<GateTerminalFacts>): GateTerminalFacts => ({
  label: 'acct-1', agentId: 'ag', hasLocalSurface: true, agentIsLocal: true, operatorName: null,
  snapshot: snap({ work: ['acct-1', 'plum'], jaebin: ['max'] }), ...o,
});

describe('resolveGateTerminalTarget', () => {
  it('이 기기에 그 계정이 있으면 (풀, 계정) 이름만 연다', () => {
    expect(resolveGateTerminalTarget(facts({}))).toEqual({ kind: 'open', pool: 'work', account: 'acct-1' });
  });
  it('이 기기에 없는 이름이면 열지 않는다 — 에이전트가 고른 값을 믿지 않는다', () => {
    expect(resolveGateTerminalTarget(facts({ label: 'nope' }))).toEqual({ kind: 'missing' });
  });
  it('문법 밖 이름표(경로·이메일 꼴)는 열지 않는다', () => {
    expect(resolveGateTerminalTarget(facts({ label: '../acct-1' })).kind).toBe('missing');
    expect(resolveGateTerminalTarget(facts({ label: 'me@example.com' })).kind).toBe('missing');
  });
  it('웹·모바일(로컬 표면 없음)·다른 오퍼레이터의 에이전트면 elsewhere — 오퍼레이터 이름을 싣는다', () => {
    expect(resolveGateTerminalTarget(facts({ hasLocalSurface: false, operatorName: 'studio-mac' })))
      .toEqual({ kind: 'elsewhere', operatorName: 'studio-mac' });
    expect(resolveGateTerminalTarget(facts({ agentIsLocal: false }))).toEqual({ kind: 'elsewhere', operatorName: null });
  });
  it('같은 이름이 여러 풀에 있으면 그 에이전트의 풀로 고르고, 못 고르면 ambiguous', () => {
    const two = snap({ work: ['dup'], home: ['dup'] }, { defaultPool: null });
    expect(resolveGateTerminalTarget(facts({ label: 'dup', snapshot: two, localPool: 'home' })))
      .toEqual({ kind: 'open', pool: 'home', account: 'dup' });
    expect(resolveGateTerminalTarget(facts({ label: 'dup', snapshot: two }))).toEqual({ kind: 'ambiguous' });
    expect(resolveGateTerminalTarget(facts({ label: 'home/dup', snapshot: two })))
      .toEqual({ kind: 'open', pool: 'home', account: 'dup' });
  });
  it('목록을 아직 못 읽었으면 unknown — 아무것도 그리지 않는다', () => {
    expect(resolveGateTerminalTarget(facts({ snapshot: null })).kind).toBe('unknown');
    expect(resolveGateTerminalTarget(facts({ agentIsLocal: null })).kind).toBe('unknown');
  });
});
