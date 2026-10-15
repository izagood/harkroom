import { describe, expect, it } from 'vitest';
import { authWarningKey, authWarnings } from '../src/lib/authWarnings';
import type { ClaudeAccountsSnapshot } from '../src/lib/claudeAccounts';

const acct = (name: string, failAt?: number) => ({
  name, status: { loggedIn: true },
  ...(failAt !== undefined ? { authFailure: { atMs: failAt } } : {}),
});
const snap = (pools: { name: string; accounts: ReturnType<typeof acct>[] }[], agents: Record<string, string[]> = {}, defaultPool: string | null = 'work'): ClaudeAccountsSnapshot =>
  ({ root: '/r', mode: 'pools', defaultPool, agents, pools } as unknown as ClaudeAccountsSnapshot);
const none = new Map<string, number>();

describe('authWarnings (로그인 끊김 경고 S1/S2, 2026-10-15)', () => {
  it('풀린 계정이 없으면 아무것도 없다', () => {
    expect(authWarnings(snap([{ name: 'work', accounts: [acct('a'), acct('b')] }]), none)).toEqual([]);
    expect(authWarnings(null, none)).toEqual([]);
  });

  it('일부만 풀리면 계정마다 S1 — 남은 수를 센다', () => {
    const w = authWarnings(snap([{ name: 'work', accounts: [acct('a'), acct('b', 5), acct('c')] }]), none);
    expect(w).toEqual([{ kind: 's1', pool: 'work', account: 'b', left: 2, total: 3, atMs: 5 }]);
  });

  it('풀 전부 풀리면 S2 — 그 풀만 쓰는 에이전트(순서 없음=기본 풀)가 멈춘다', () => {
    const w = authWarnings(snap(
      [{ name: 'work', accounts: [acct('a', 7), acct('b', 3)] }, { name: 'home', accounts: [acct('p')] }],
      { forge: ['work'], design: ['work', 'home'] },
    ), none);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: 's2', pool: 'work', account: 'a', total: 2, atMs: 3 });
    // design 은 다음 풀(home)이 살아 있어 멈추지 않는다.
    expect((w[0] as { agentIds: string[] }).agentIds).toEqual(['forge']);
  });

  it('S2 가 S1 보다 앞이다', () => {
    const w = authWarnings(snap([
      { name: 'home', accounts: [acct('p', 1), acct('q')] },
      { name: 'work', accounts: [acct('a', 9)] },
    ]), none);
    expect(w.map((x) => x.kind)).toEqual(['s2', 's1']);
  });

  it('러너가 로그인 사유로 물러났는데 풀을 모르면 풀 없는 S2 하나로 모은다', () => {
    const w = authWarnings(snap([{ name: 'work', accounts: [acct('a')] }]), new Map([['forge', 11]]));
    expect(w).toEqual([{ kind: 's2', pool: null, account: null, total: 0, agentIds: ['forge'], atMs: 11 }]);
  });

  it('열쇠는 상태가 나빠지면 바뀐다 — [나중에] 뒤 다시 선다', () => {
    const one = authWarnings(snap([{ name: 'work', accounts: [acct('a', 1), acct('b')] }]), none)[0]!;
    const two = authWarnings(snap([{ name: 'work', accounts: [acct('a', 1), acct('b', 2)] }]), none)[0]!;
    expect(authWarningKey(one)).not.toBe(authWarningKey(two));
  });
});
