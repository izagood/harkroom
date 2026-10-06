import { describe, it, expect, beforeEach } from 'vitest';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createTurnMerge, ghEnv, parseMergeArgs, type ExecResult, type TurnMerge } from '../src/turnMerge.js';

// 에이전트 머지 래퍼(PR 2/3) — 오퍼레이터 쪽 판정·gh 호출. 설계·security F3 는 스레드 3deac356.
const SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const GH = '/opt/homebrew/bin/gh';

const mergeCall = (args: Record<string, unknown>, cause: string | undefined = 'cause-1', id = 9): RunnerLinkRequest => ({
  type: 'mcp.request', id: 'link-1', cause,
  payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'repo.merge', arguments: args } },
});
const resultOf = (res: RunnerLinkResponse | null) => {
  if (!res || res.type !== 'mcp.response') throw new Error('expected mcp.response');
  const msg = res.messages[0] as { id: number; result: { content: { text: string }[]; isError?: boolean } };
  return { id: msg.id, isError: msg.result.isError === true, body: JSON.parse(msg.result.content[0]!.text) };
};

describe('parseMergeArgs (F3)', () => {
  it('정해진 네 가지만 받고 그 밖은 거절한다 — --admin·--auto·-R 은 문법에 없다', () => {
    expect(parseMergeArgs(['Izagood/Harkroom', '12', '--head', SHA])).toEqual({ repo: 'izagood/harkroom', number: 12, headSha: SHA });
    for (const bad of [
      ['o/r', '12', '--head', SHA, '--admin'],
      ['o/r', '12', '--head', SHA, '--auto'],
      ['o/r', '12', '-R', 'x/y', '--head', SHA],
      ['o/r', '12', '--head', SHA, '--head', SHA],
      ['o/r', '12', '--head', 'abc'],
      ['o/r', '12'],
      ['o/r', '0', '--head', SHA],
      ['o/r', '1.5', '--head', SHA],
      ['o r', '1', '--head', SHA],
      ['o/r;rm', '1', '--head', SHA],
      // P3: --approval 은 받지 않는다 — 서버가 cause 메시지로 판정하지 에이전트가 고른 id 가 아니다.
      ['o/r', '1', '--head', SHA, '--approval', '11111111-2222-4333-8444-555555555555'],
    ]) expect(parseMergeArgs(bad), bad.join(' ')).toHaveProperty('error');
  });
});

describe('ghEnv', () => {
  it('상속하지 않는다 — PATH 는 고정, GH_REPO·GH_HOST 가 들어올 자리가 없고 토큰은 있을 때만', () => {
    const env = ghEnv('/Users/x', null);
    expect(Object.keys(env).sort()).toEqual(['GH_NO_UPDATE_NOTIFIER', 'GH_PAGER', 'GH_PROMPT_DISABLED', 'HOME', 'NO_COLOR', 'PATH']);
    expect(ghEnv('/Users/x', 'tok').GH_TOKEN).toBe('tok');
  });
});

describe('turnMerge', () => {
  let forwards: RunnerLinkRequest[];
  let execs: { file: string; args: string[]; env: Record<string, string> }[];
  let checkStatus: number | null;
  let pr: Record<string, unknown>;
  let mergeCode: number;
  let mergeStderr: string;
  let viewStderr: string | null;
  let denialBody: Record<string, unknown>;
  let ghUser: string | undefined;
  let lease: { leaseId: string; token: string; agentId: string } | null;
  let tm: TurnMerge;

  beforeEach(() => {
    forwards = []; execs = []; checkStatus = 200; mergeCode = 0; mergeStderr = 'GraphQL: Base branch was modified'; viewStderr = null; denialBody = { error: { code: 'not_granted' } }; ghUser = 'izagood';
    lease = { leaseId: 'lease-1', token: 'tok-1', agentId: 'a1' };
    pr = { state: 'OPEN', isDraft: false, headRefOid: SHA, baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] };
    tm = createTurnMerge({
      ghPath: GH, home: '/Users/x', log: () => {},
      ghUser: async () => ghUser,
      lookupLease: (runnerId, cause) => (runnerId === 'r1' && cause === 'cause-1' ? lease : null),
      forward: async (_agentId, req) => {
        forwards.push(req);
        if (req.type !== 'http.forward') throw new Error('unexpected');
        if (checkStatus === null) return { type: 'http.response', id: req.id, status: 0, body: 'down' };
        if (req.path === '/agent/merge-checks') {
          return checkStatus === 200
            ? { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ allowed: true, grantedBy: 'owner-1', causeByHuman: true }) }
            : { type: 'http.response', id: req.id, status: checkStatus, body: JSON.stringify(denialBody) };
        }
        return { type: 'http.response', id: req.id, status: 201, body: '{"messageId":"m1"}' };
      },
      exec: async (file, args, env): Promise<ExecResult> => {
        execs.push({ file, args, env });
        if (args[0] === 'auth') return ghUser === 'broken' ? { code: 1, stdout: '', stderr: 'no oauth token' } : { code: 0, stdout: 'tok-from-gh\n', stderr: '' };
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit')) return { code: 0, stdout: JSON.stringify({ mergeCommit: { oid: MERGE_SHA } }), stderr: '' };
        if (args[0] === 'pr' && args[1] === 'view') return viewStderr ? { code: 1, stdout: '', stderr: viewStderr } : { code: 0, stdout: JSON.stringify(pr), stderr: '' };
        if (args[0] === 'pr' && args[1] === 'merge') return { code: mergeCode, stdout: '', stderr: mergeCode ? mergeStderr : '' };
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
    });
  });
  const ok = () => mergeCall({ repo: 'izagood/harkroom', number: 7, headSha: SHA });
  const results = () => forwards.filter((f) => f.type === 'http.forward' && f.path === '/agent/merge-results').map((f) => JSON.parse((f as { body?: string }).body ?? '{}'));
  const ghCalls = () => execs.filter((e) => e.args[0] === 'pr').map((e) => e.args.slice(0, 2).join(' '));

  it('repo.merge 가 아닌 요청은 건드리지 않는다', async () => {
    expect(await tm.maybeHandle('r1', 'a1', { type: 'mcp.request', id: 'x', payload: { method: 'tools/call', params: { name: 'secret.mount' } } })).toBeNull();
    expect(await tm.maybeHandle('r1', 'a1', { type: 'http.forward', id: 'x', method: 'GET', path: '/agent/config' })).toBeNull();
  });

  it('인자 모양이 틀리면 bad_request — 서버에도 gh 에도 가지 않는다(F3, 오퍼레이터가 마지막 관문)', async () => {
    const r = resultOf(await tm.maybeHandle('r1', 'a1', mergeCall({ repo: 'izagood/harkroom', number: 7, headSha: 'short' })));
    expect(r).toMatchObject({ id: 9, isError: true, body: { error: { code: 'bad_request' } } });
    expect(resultOf(await tm.maybeHandle('r1', 'a1', mergeCall({ repo: 'izagood/harkroom', number: '7; rm -rf', headSha: SHA }))).body.error.code).toBe('bad_request');
    expect(forwards).toHaveLength(0);
    expect(execs).toHaveLength(0);
  });

  it('임대가 없거나 남의 것이면 no_lease — 서버에 묻지도 않는다', async () => {
    expect(resultOf(await tm.maybeHandle('r2', 'a1', ok())).body.error.code).toBe('no_lease');
    const noCause = { ...ok() }; delete (noCause as { cause?: string }).cause;
    expect(resultOf(await tm.maybeHandle('r1', 'a1', noCause)).body.error.code).toBe('no_lease');
    lease = { leaseId: 'lease-1', token: 'tok-1', agentId: 'someone-else' };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('no_lease');
    expect(forwards).toHaveLength(0);
  });

  it('서버가 거절하면 그 코드로 끝난다 — gh 는 한 번도 부르지 않는다', async () => {
    checkStatus = 403;
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('not_granted');
    expect(execs).toHaveLength(0);
    expect(results()).toHaveLength(0);
  });

  it('P4: 서버가 denialId 를 실은 거절이면 그대로 넘긴다 — 에이전트가 message.ask 의 mergeDenialId 로 카드를 세운다', async () => {
    checkStatus = 403;
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    denialBody = { error: { code: 'not_granted', denialId: id } };
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r).toMatchObject({ isError: true, body: { error: { code: 'not_granted', denialId: id, message: expect.stringContaining('mergeDenialId') } } });
    expect(execs).toHaveLength(0);
    // uuid 가 아닌 값은 싣지 않는다 — 서버 본문을 그대로 비추지 않는다
    denialBody = { error: { code: 'not_granted', denialId: 'x; rm -rf' } };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.denialId).toBeUndefined();
  });

  it('P4: gh 계정이 저장소에 닿지 못하면 no_repo_access — 원문은 보고에만, 에이전트 답에는 「사람이 머지」 문구만', async () => {
    mergeCode = 1; mergeStderr = 'GraphQL: Resource not accessible by integration (mergePullRequest)';
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r.body.error.code).toBe('no_repo_access');
    expect(JSON.stringify(r.body)).not.toContain('Resource not accessible');
    expect(results()).toEqual([expect.objectContaining({ result: 'failed', error: expect.stringContaining('Resource not accessible') })]);

    forwards = []; execs = []; mergeCode = 0; viewStderr = 'GraphQL: Could not resolve to a Repository with the name \'example/service\'.';
    const v = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(v.body.error.code).toBe('no_repo_access');
    expect(ghCalls()).not.toContain('pr merge');
    // 저장소와 무관한 view 실패는 그대로 pr_not_found
    forwards = []; viewStderr = 'no pull requests found for branch';
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('pr_not_found');
  });

  it('서버에 닿지 않으면 unavailable — 머지하지 않는다(fail-closed)', async () => {
    checkStatus = null;
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('unavailable');
    expect(execs).toHaveLength(0);
  });

  it('임대 토큰은 서버로만 간다 — gh 인자·env 어디에도 없다', async () => {
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r.isError).toBe(false);
    const check = forwards[0] as { body?: string };
    expect(JSON.parse(check.body ?? '{}')).toMatchObject({ leaseId: 'lease-1', token: 'tok-1', repo: 'izagood/harkroom', number: 7, headSha: SHA });
    for (const e of execs) {
      expect(JSON.stringify(e.args)).not.toContain('tok-1');
      expect(JSON.stringify(e.env)).not.toContain('tok-1');
    }
  });

  it('머지 전 확인: head 가 바뀌었으면 head_moved — merge 는 안 부르고 실패를 보고한다', async () => {
    pr = { ...pr, headRefOid: 'c'.repeat(40) };
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r.body.error.code).toBe('head_moved');
    expect(ghCalls()).toEqual(['pr view']);
    expect(results()).toEqual([expect.objectContaining({ result: 'failed', headSha: SHA })]);
  });

  it.each([
    ['닫힌 PR', { state: 'MERGED' }, 'not_open'],
    ['draft', { isDraft: true }, 'draft'],
    ['mergeState 가 CLEAN 이 아님', { mergeStateStatus: 'BLOCKED' }, 'not_mergeable'],
    ['체크 하나가 빨강', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }, 'ci_not_green'],
    ['체크가 아직 도는 중', { statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }] }, 'ci_not_green'],
    ['체크가 하나도 없음', { statusCheckRollup: [] }, 'ci_not_green'],
  ])('머지 전 확인: %s → %s', async (_label, patch, code) => {
    pr = { ...pr, ...patch };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe(code);
    expect(ghCalls()).toEqual(['pr view']);
  });

  it('통과하면 gh 를 절대 경로·고정 env 로 squash + --match-head-commit 으로 부르고, 결과를 보고한다', async () => {
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r).toMatchObject({ isError: false, body: { merged: true, repo: 'izagood/harkroom', number: 7, mergeSha: MERGE_SHA, grantedBy: 'owner-1' } });
    const merge = execs.find((e) => e.args[1] === 'merge')!;
    expect(merge.file).toBe(GH);
    expect(merge.args).toEqual(['pr', 'merge', '7', '-R', 'izagood/harkroom', '--squash', '--match-head-commit', SHA]);
    expect(merge.args).not.toContain('--admin');
    expect(merge.env.PATH).toBe('/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin');
    expect(merge.env.GH_REPO).toBeUndefined();
    expect(merge.env.GH_TOKEN).toBe('tok-from-gh');  // merge.ghUser 의 토큰으로만
    expect(results()).toEqual([expect.objectContaining({ result: 'merged', mergeSha: MERGE_SHA, leaseId: 'lease-1' })]);
  });

  it('P1: merge.ghUser 가 없으면 no_gh_user — 활성 계정으로 넘어가지 않는다. 서버 판정은 통과했으므로 실패를 보고한다', async () => {
    ghUser = undefined;
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('no_gh_user');
    expect(execs).toHaveLength(0);
    expect(results()).toEqual([expect.objectContaining({ result: 'failed', error: expect.stringContaining('no_gh_user') })]);
  });

  it('P1: gh auth token -u 가 실패해도 거절한다 — gh pr 명령 0건', async () => {
    ghUser = 'broken';
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('gh_token_failed');
    expect(ghCalls()).toEqual([]);
  });

  it('arguments 에 받지 않는 키(approval 등)가 있으면 bad_request', async () => {
    expect(resultOf(await tm.maybeHandle('r1', 'a1', mergeCall({ repo: 'izagood/harkroom', number: 7, headSha: SHA, approval: 'x' }))).body.error.code).toBe('bad_request');
    expect(forwards).toHaveLength(0);
  });

  it('같은 이름의 취소된 중복 실행이 남아 있어도 그 이름에 초록 실행이 있으면 초록이다', async () => {
    pr = { ...pr, statusCheckRollup: [
      { name: 'check', status: 'COMPLETED', conclusion: 'CANCELLED' }, { name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'secrets', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).isError).toBe(false);
    pr = { ...pr, statusCheckRollup: [{ name: 'check', status: 'COMPLETED', conclusion: 'CANCELLED' }, { name: 'secrets', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('ci_not_green');
  });

  it('C1: 같은 이름에 초록과 빨강(FAILURE·TIMED_OUT·ACTION_REQUIRED)이 함께 있으면 빨강이다 — 옛 초록이 새 빨강을 덮지 않는다', async () => {
    for (const bad of ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED']) {
      pr = { ...pr, statusCheckRollup: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'check', status: 'COMPLETED', conclusion: bad }] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code, bad).toBe('ci_not_green');
    }
    expect(ghCalls().filter((c) => c === 'pr merge')).toEqual([]);
  });

  it('operator.json merge.ghUser 의 계정 토큰을 GH_TOKEN 으로 준다 — auth token 호출 자체는 토큰 없이', async () => {
    resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    const auth = execs.find((e) => e.args[0] === 'auth')!;
    expect(auth.args).toEqual(['auth', 'token', '-u', 'izagood']);
    expect(auth.env.GH_TOKEN).toBeUndefined();
    for (const e of execs.filter((e) => e.args[0] === 'pr')) expect(e.env.GH_TOKEN).toBe('tok-from-gh');
  });

  it('gh pr merge 가 실패하면 merge_failed 이고 실패를 보고한다 — stderr 는 잘라서', async () => {
    mergeCode = 1;
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r.body.error.code).toBe('merge_failed');
    expect(results()).toEqual([expect.objectContaining({ result: 'failed', error: expect.stringContaining('Base branch was modified') })]);
  });
});
