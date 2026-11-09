import { describe, it, expect } from 'vitest';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createPrWatchPoller } from '../src/prWatchPoller.js';
import type { ExecResult } from '../src/turnMerge.js';
import { pickMergeGhUser } from '../src/localMerge.js';

// PR 감시 폴러(P5) — due 가 비면 gh 를 부르지 않고, 읽은 고정 칸을 보고하고, 한 감시의 실패로 멈추지 않는다.
const SHA = 'a'.repeat(40);
const REPO = 'example-org/example-repo';

function setup(due: unknown[], opts: { viewFails?: boolean } = {}) {
  const forwards: { agentId: string; req: RunnerLinkRequest }[] = [];
  const execs: string[][] = [];
  const logs: string[] = [];
  const exec = async (_f: string, args: string[]): Promise<ExecResult> => {
    execs.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: 'tok\n', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      return opts.viewFails ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: JSON.stringify({
        state: 'OPEN', isDraft: false, headRefOid: SHA, baseRefName: 'main', mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const forward = async (agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse> => {
    forwards.push({ agentId, req });
    if (req.type !== 'http.forward') throw new Error('unexpected');
    if (req.method === 'GET') return { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ watches: due }) };
    return { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ changed: true, state: 'done' }) };
  };
  const poller = createPrWatchPoller({
    forward, agentIds: () => ['a1'], log: (l) => logs.push(l), ghPath: '/usr/bin/gh', home: '/home/x',
    ghUserFor: async (repo: string) => pickMergeGhUser({ byScope: { 'example-org/*': 'alice' } }, repo), firstSeen: new Map(), exec, now: () => Date.parse('2026-11-09T00:00:00Z'),
  });
  return { poller, forwards, execs, logs };
}

describe('prWatchPoller', () => {
  it('due 가 비면(스위치 꺼짐) gh 를 부르지 않는다', async () => {
    const t = setup([]);
    await t.poller.tick();
    expect(t.execs).toEqual([]);
    expect(t.forwards.map((f) => (f.req as { path: string }).path)).toEqual(['/agent/pr-watches/due']);
  });

  it('감시마다 gh 로 읽어 고정 칸을 보고한다', async () => {
    const t = setup([{ id: 'w1', repo: REPO, number: 7, head: SHA, until: 'checks' }]);
    await t.poller.tick();
    const post = t.forwards.find((f) => (f.req as { method: string }).method === 'POST')!;
    expect((post.req as { path: string }).path).toBe('/agent/pr-watches/w1/status');
    expect(JSON.parse((post.req as { body: string }).body)).toEqual({ state: 'OPEN', headRefOid: SHA, checks: [{ name: 'test', conclusion: 'SUCCESS' }] });
  });

  it('gh 실패는 로그만 남기고 넘긴다', async () => {
    const t = setup([{ id: 'w1', repo: REPO, number: 7, head: SHA, until: 'checks' }], { viewFails: true });
    await expect(t.poller.tick()).resolves.toBeUndefined();
    expect(t.forwards.some((f) => (f.req as { method: string }).method === 'POST')).toBe(false);
    expect(t.logs.some((l) => l.includes('실패'))).toBe(true);
  });
});
