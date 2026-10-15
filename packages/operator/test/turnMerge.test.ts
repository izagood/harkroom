import { describe, it, expect, beforeEach } from 'vitest';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createTurnMerge, ghEnv, isAlreadyQueuedError, parseMergeArgs, parseQueueInfo, ENQUEUE_MUTATION, QUEUE_QUERY, type ExecResult, type TurnMerge } from '../src/turnMerge.js';
import { pickMergeGhUser } from '../src/localMerge.js';

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
      // 조직 grant(owner/*)는 grant 쪽 문법이다 — 래퍼가 머지할 저장소 자리에는 못 온다(서버 판정에서 grant 문자열과 정확 일치하지 않게).
      ['acme-org/*', '1', '--head', SHA],
      ['*/*', '1', '--head', SHA],
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
  let pickByScope: Record<string, string> | null;
  let lease: { leaseId: string; token: string; agentId: string } | null;
  let approvals: Record<string, unknown>[];
  let checkApproval: Record<string, unknown> | null;
  let peekStatus: number;
  // merge queue — GraphQL 읽기의 답(null 이면 gh 가 실패한다)·뮤테이션의 답.
  let queue: { enabled: boolean; inQueue: boolean; entry: { position: number; state: string } | null } | null;
  let enqueueResult: ExecResult;
  // 읽을 때마다 차례로 내줄 큐 상태(비면 `queue`) — 경합 재현용.
  let queueSeq: (typeof queue)[];
  let tm: TurnMerge;

  beforeEach(() => {
    forwards = []; execs = []; checkStatus = 200; mergeCode = 0; mergeStderr = 'GraphQL: Base branch was modified'; viewStderr = null; denialBody = { error: { code: 'not_granted' } }; ghUser = 'izagood'; pickByScope = null;
    lease = { leaseId: 'lease-1', token: 'tok-1', agentId: 'a1' };
    approvals = []; checkApproval = null; peekStatus = 200;
    queue = { enabled: false, inQueue: false, entry: null }; queueSeq = [];
    enqueueResult = { code: 0, stdout: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { position: 3, state: 'QUEUED' } } } }), stderr: '' };
    pr = { state: 'OPEN', isDraft: false, headRefOid: SHA, baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] };
    tm = createTurnMerge({
      ghPath: GH, home: '/Users/x', log: () => {},
      ghUserFor: async (repo) => (pickByScope
        ? pickMergeGhUser({ byScope: pickByScope }, repo)
        : ghUser ? { login: ghUser, scope: '(device default)' } : null),
      lookupLease: (runnerId, cause) => (runnerId === 'r1' && cause === 'cause-1' ? lease : null),
      forward: async (_agentId, req) => {
        forwards.push(req);
        if (req.type !== 'http.forward') throw new Error('unexpected');
        if (checkStatus === null) return { type: 'http.response', id: req.id, status: 0, body: 'down' };
        if (req.path === '/agent/merge-approvals/peek') {
          if (peekStatus !== 200) return { type: 'http.response', id: req.id, status: peekStatus, body: '{}' };
          return { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ approval: approvals[0] ?? null }) };
        }
        if (req.path === '/agent/merge-checks') {
          return checkStatus === 200
            ? { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ allowed: true, grantedBy: 'owner-1', causeByHuman: true, ...(checkApproval ? { approval: checkApproval } : {}) }) }
            : { type: 'http.response', id: req.id, status: checkStatus, body: JSON.stringify(denialBody) };
        }
        return { type: 'http.response', id: req.id, status: 201, body: '{"messageId":"m1"}' };
      },
      exec: async (file, args, env): Promise<ExecResult> => {
        execs.push({ file, args, env });
        if (args[0] === 'auth' && args[3] === 'corp-account') return { code: 0, stdout: 'tok-approved\n', stderr: '' };
        if (args[0] === 'auth' && args[3] === 'gone') return { code: 1, stdout: '', stderr: 'no oauth token found for github.com account gone' };
        if (args[0] === 'auth' && pickByScope) return { code: 0, stdout: `tok-${args[3]}\n`, stderr: '' };
        if (args[0] === 'auth') return ghUser === 'broken' ? { code: 1, stdout: '', stderr: 'no oauth token' } : { code: 0, stdout: 'tok-from-gh\n', stderr: '' };
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit')) return { code: 0, stdout: JSON.stringify({ mergeCommit: { oid: MERGE_SHA } }), stderr: '' };
        if (args[0] === 'pr' && args[1] === 'view') return viewStderr ? { code: 1, stdout: '', stderr: viewStderr } : { code: 0, stdout: JSON.stringify(pr), stderr: '' };
        if (args[0] === 'pr' && args[1] === 'merge') return { code: mergeCode, stdout: '', stderr: mergeCode ? mergeStderr : '' };
        if (args[0] === 'api' && args[1] === 'graphql' && args[3] === `query=${QUEUE_QUERY}`) {
          const qv = queueSeq.length ? queueSeq.shift()! : queue;
          if (!qv) return { code: 1, stdout: '', stderr: 'HTTP 502' };
          return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_kw1', isMergeQueueEnabled: qv.enabled, isInMergeQueue: qv.inQueue, mergeQueueEntry: qv.entry } } } }), stderr: '' };
        }
        if (args[0] === 'api' && args[1] === 'graphql' && args[3] === `query=${ENQUEUE_MUTATION}`) return enqueueResult;
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
    });
  });
  const ok = () => mergeCall({ repo: 'izagood/harkroom', number: 7, headSha: SHA });
  const results = () => forwards.filter((f) => f.type === 'http.forward' && f.path === '/agent/merge-results').map((f) => JSON.parse((f as { body?: string }).body ?? '{}'));
  const closedReports = () => forwards.filter((f) => f.type === 'http.forward' && f.path === '/agent/merge-closed').map((f) => JSON.parse((f as { body?: string }).body ?? '{}'));
  const ghCalls = () => execs.filter((e) => e.args[0] === 'pr').map((e) => e.args.slice(0, 2).join(' '));
  const enqueues = () => execs.filter((e) => e.args[0] === 'api' && e.args[3] === `query=${ENQUEUE_MUTATION}`);

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

  it('서버가 거절하면 그 코드로 끝난다 — gh 는 읽기(pr view)만 한 번, 머지는 부르지 않는다', async () => {
    checkStatus = 403;
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('not_granted');
    expect(ghCalls()).toEqual(['pr view']);
    expect(results()).toHaveLength(0);
    expect(closedReports()).toHaveLength(0);
  });

  it('서버가 거절하면 gh 를 부르지 않는 코드도 있다 — lease_invalid 등은 그대로 끝난다', async () => {
    checkStatus = 403;
    denialBody = { error: { code: 'lease_invalid' } };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('lease_invalid');
    expect(execs).toHaveLength(0);
  });

  describe('Q3: PR 이 이미 MERGED·CLOSED 면 기다리던 머지 카드를 닫는다 (스레드 0e30c565)', () => {
    it('cause_not_human 거절인데 PR 이 MERGED — merge-closed 를 보고하고 denialId 없이 not_open 으로 끝난다(새 카드 없음)', async () => {
      checkStatus = 403;
      denialBody = { error: { code: 'cause_not_human', denialId: '0f0e0d0c-0b0a-4908-8706-050403020100' } };
      pr = { ...pr, state: 'MERGED' };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('not_open');
      expect(r.body.error.denialId).toBeUndefined();
      expect(closedReports()).toEqual([{ leaseId: 'lease-1', token: 'tok-1', repo: 'izagood/harkroom', number: 7, state: 'MERGED' }]);
      expect(ghCalls()).toEqual(['pr view']);
    });

    it('거절인데 PR 이 OPEN 이면 보고하지 않고 지금처럼 denialId 를 넘긴다', async () => {
      checkStatus = 403;
      const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
      denialBody = { error: { code: 'cause_not_human', denialId: id } };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.denialId).toBe(id);
      expect(closedReports()).toHaveLength(0);
    });

    it('거절인데 gh 를 못 읽으면(계정 없음) 지금처럼 카드 길 — 보고 없음', async () => {
      checkStatus = 403;
      ghUser = undefined;
      const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
      denialBody = { error: { code: 'not_granted', denialId: id } };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.denialId).toBe(id);
      expect(closedReports()).toHaveLength(0);
    });

    it('판정은 통과했는데 머지 전 확인에서 CLOSED — 실패 보고와 함께 merge-closed 도 보고한다', async () => {
      pr = { ...pr, state: 'CLOSED' };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('not_open');
      expect(closedReports().map((b) => b.state)).toEqual(['CLOSED']);
      expect(ghCalls()).not.toContain('pr merge');
    });
  });

  it('P4: 서버가 denialId 를 실은 거절이면 그대로 넘긴다 — 에이전트가 message.ask 의 mergeDenialId 로 카드를 세운다', async () => {
    checkStatus = 403;
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    denialBody = { error: { code: 'not_granted', denialId: id } };
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r).toMatchObject({ isError: true, body: { error: { code: 'not_granted', denialId: id, message: expect.stringContaining('mergeDenialId') } } });
    expect(ghCalls()).toEqual(['pr view']);
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

  describe('1회 승인 (스레드 1b75d7a0, security 순서: 사전 확인 → 소모 → 즉시 머지)', () => {
    const checksCalled = () => forwards.filter((f) => f.type === 'http.forward' && f.path === '/agent/merge-checks').length;
    beforeEach(() => {
      approvals = [{ id: 'ap-1', ghUser: 'corp-account', relaxChecks: false }];
      checkApproval = { id: 'ap-1', ghUser: 'corp-account', relaxChecks: false };
    });

    it('사전 확인에서 막히면 서버 판정(소모)을 부르지 않는다 — 승인이 남는다', async () => {
      pr = { ...pr, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'check' }] };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('ci_not_green');
      expect(r.body.error.message).toContain('approval was not used');
      expect(checksCalled()).toBe(0);
      expect(ghCalls()).not.toContain('pr merge');
      pr = { ...pr, headRefOid: 'c'.repeat(40) };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('head_moved');
      expect(checksCalled()).toBe(0);
    });

    it('승인 계정으로만 머지한다 — 기기 줄의 계정(ghUserFor)으로 내려가지 않고 --match-head-commit 을 지킨다', async () => {
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r).toMatchObject({ isError: false, body: { merged: true, viaApproval: true, ghUser: 'corp-account' } });
      const auths = execs.filter((e) => e.args[0] === 'auth').map((e) => e.args[3]);
      expect(auths).toEqual(['corp-account']);
      const merge = execs.find((e) => e.args[0] === 'pr' && e.args[1] === 'merge')!;
      expect(merge.args).toEqual(['pr', 'merge', '7', '-R', 'izagood/harkroom', '--squash', '--match-head-commit', SHA]);
      expect(merge.env.GH_TOKEN).toBe('tok-approved');
      // 사전 확인 → 판정 → 머지 순서
      expect(forwards.filter((f) => f.type === 'http.forward').map((f) => (f as { path: string }).path).slice(0, 2)).toEqual(['/agent/merge-approvals/peek', '/agent/merge-checks']);
      // 사전 확인은 임대로 묻는다 — 서버가 그 임대의 채널·스레드로 거른다(security F2).
      expect(JSON.parse((forwards[0] as { body?: string }).body ?? '{}')).toMatchObject({ leaseId: 'lease-1', token: 'tok-1', repo: 'izagood/harkroom', number: 7, headSha: SHA });
    });

    it('relaxChecks 는 승인 기록의 칸으로만 — 켜져 있으면 CI·CLEAN 은 GitHub 에 맡긴다(OPEN·head 는 그대로 본다)', async () => {
      approvals = [{ ...approvals[0]!, relaxChecks: true }];
      checkApproval = { ...checkApproval!, relaxChecks: true };
      pr = { ...pr, mergeStateStatus: 'BLOCKED', statusCheckRollup: [] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ merged: true });
      // 꺼진 승인이면 같은 PR 이 막힌다
      approvals = [{ ...approvals[0]!, relaxChecks: false }];
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('not_mergeable');
    });

    it('서버가 쓴 승인이 사전 확인한 것(id)과 다르면 머지하지 않는다 — 계정이 같아도(security F2)', async () => {
      checkApproval = { id: 'ap-2', ghUser: 'corp-account', relaxChecks: false };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('approval_mismatch');
      expect(ghCalls()).not.toContain('pr merge');
      forwards = []; execs = [];
      checkApproval = { id: 'ap-1', ghUser: 'izagood', relaxChecks: false };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('approval_mismatch');
      expect(ghCalls()).not.toContain('pr merge');
      expect(results()).toEqual([expect.objectContaining({ result: 'failed' })]);
    });

    it('소모 뒤 머지가 실패하면 보고하고, 다시 승인(새 카드)이 필요하다고 답한다', async () => {
      mergeCode = 1; mergeStderr = 'GraphQL: Head branch was modified';
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('merge_failed');
      expect(r.body.error.message).toContain('approve again');
      expect(results()).toEqual([expect.objectContaining({ result: 'failed' })]);
    });

    it('승인 목록을 못 읽으면 unavailable — 머지하지 않는다(5xx 도 판정으로 넘어가지 않는다, security F2)', async () => {
      checkStatus = null;
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('unavailable');
      expect(execs).toHaveLength(0);
      checkStatus = 200; peekStatus = 503; forwards = [];
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('unavailable');
      expect(forwards.filter((f) => f.type === 'http.forward' && f.path === '/agent/merge-checks')).toHaveLength(0);
      expect(execs).toHaveLength(0);
    });
  });

  it('임대 토큰은 서버로만 간다 — gh 인자·env 어디에도 없다', async () => {
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r.isError).toBe(false);
    const check = forwards.find((f) => f.type === 'http.forward' && f.path === '/agent/merge-checks') as { body?: string };
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

  it('줄별 계정(e085b6a7): 정확한 owner/name 줄이 owner/* 줄보다 이기고, 그 계정의 토큰으로 머지한다', async () => {
    pickByScope = { 'izagood/*': 'org-acct', 'izagood/harkroom': 'repo-acct' };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).isError).toBeFalsy();
    expect(execs.find((e) => e.args[0] === 'auth')!.args).toEqual(['auth', 'token', '-u', 'repo-acct']);
    expect(execs.find((e) => e.args[1] === 'merge')!.env.GH_TOKEN).toBe('tok-repo-acct');
  });

  it('줄별 계정: 저장소 줄이 없으면 조직 줄의 계정', async () => {
    pickByScope = { 'izagood/*': 'org-acct', 'other/*': 'nope' };
    await tm.maybeHandle('r1', 'a1', ok());
    expect(execs.find((e) => e.args[1] === 'merge')!.env.GH_TOKEN).toBe('tok-org-acct');
  });

  it('줄별 계정: 맞는 줄이 없으면 no_gh_user — 다른 조직 줄이나 활성 계정으로 넘어가지 않는다', async () => {
    pickByScope = { 'acme-org/*': 'rebel-x' };
    expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('no_gh_user');
    expect(execs).toHaveLength(0);
  });

  it('줄별 계정: 고른 계정이 gh 에서 로그아웃됐으면 gh_user_not_logged_in — gh pr 명령 0건, 실패를 보고한다', async () => {
    pickByScope = { 'izagood/*': 'gone' };
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r.body.error.code).toBe('gh_user_not_logged_in');
    expect(r.body.error.message).toContain('izagood/*');
    expect(ghCalls()).toEqual([]);
    expect(results()).toEqual([expect.objectContaining({ result: 'failed', error: expect.stringContaining('gh_user_not_logged_in') })]);
  });

  it('no_repo_access 답에는 어떤 계정으로 시도했는지 싣는다(토큰은 없다)', async () => {
    pickByScope = { 'izagood/*': 'org-acct' };
    viewStderr = 'GraphQL: Could not resolve to a Repository with the name';
    const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
    expect(r.body.error.code).toBe('no_repo_access');
    expect(r.body.error.message).toContain('org-acct');
    expect(JSON.stringify(r.body)).not.toContain('tok-');
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

  describe('merge queue (10-16)', () => {
    it('큐를 쓰는 브랜치면 squash 대신 큐에 넣는다 — expectedHeadOid=--head, jump 없음, 결과·보고는 queued', async () => {
      queue = { enabled: true, inQueue: false, entry: null };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r).toMatchObject({ isError: false, body: { merged: false, queued: true, alreadyQueued: false, queue: { position: 3, state: 'QUEUED' }, ghUser: 'izagood' } });
      expect(ghCalls()).toEqual(['pr view']);
      const [e] = enqueues();
      expect(e!.args).toEqual(['api', 'graphql', '-f', `query=${ENQUEUE_MUTATION}`, '-f', 'id=PR_kw1', '-f', `head=${SHA}`]);
      expect(ENQUEUE_MUTATION).toContain('expectedHeadOid:$head');
      expect(ENQUEUE_MUTATION).not.toMatch(/jump/);
      expect(e!.env.GH_TOKEN).toBe('tok-from-gh');
      expect(results()).toEqual([expect.objectContaining({ result: 'queued', mergeSha: null, headSha: SHA })]);
    });

    it('큐를 안 쓰면 지금처럼 squash — 결과에 queued:false', async () => {
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body).toMatchObject({ merged: true, queued: false });
      expect(ghCalls()).toContain('pr merge');
      expect(enqueues()).toHaveLength(0);
    });

    it('큐 정보를 못 읽으면 squash 를 시도한다(큐 브랜치면 GitHub 이 거절 → merge_failed)', async () => {
      queue = null;
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.merged).toBe(true);
      expect(enqueues()).toHaveLength(0);
    });

    it('관문은 큐에 넣기 전에 똑같이 건다 — CI 빨강·CLEAN 아님·head 바뀜·서버 거절이면 큐에 넣지 않는다', async () => {
      queue = { enabled: true, inQueue: false, entry: null };
      const cases: [() => void, string][] = [
        [() => { pr = { ...pr, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'check' }] }; }, 'ci_not_green'],
        [() => { pr = { ...pr, mergeStateStatus: 'BLOCKED' }; }, 'not_mergeable'],
        [() => { pr = { ...pr, headRefOid: 'c'.repeat(40) }; }, 'head_moved'],
        [() => { checkStatus = 403; denialBody = { error: { code: 'cause_not_human' } }; }, 'cause_not_human'],
        [() => { checkStatus = null; }, 'unavailable'],
      ];
      for (const [arrange, code] of cases) {
        const saved = { ...pr }; checkStatus = 200; arrange();
        expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code, code).toBe(code);
        expect(enqueues(), code).toHaveLength(0);
        pr = saved;
      }
    });

    it('이미 큐에 있으면 오류가 아니라 already_queued — 다시 넣지 않고 보고도 하지 않는다', async () => {
      queue = { enabled: true, inQueue: true, entry: { position: 2, state: 'AWAITING_CHECKS' } };
      // 큐에 든 동안의 mergeStateStatus 로 막히지 않는다.
      pr = { ...pr, mergeStateStatus: 'BLOCKED' };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r).toMatchObject({ isError: false, body: { merged: false, queued: true, alreadyQueued: true, prHeadRefOid: SHA, queue: { position: 2, state: 'AWAITING_CHECKS' } } });
      expect(r.body.note).not.toContain('not the --head');
      // 큐에 든 head 가 인자와 다르면 그 사실을 싣는다(security n2).
      pr = { ...pr, headRefOid: 'd'.repeat(40) };
      const r2 = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r2.body).toMatchObject({ alreadyQueued: true, headSha: SHA, prHeadRefOid: 'd'.repeat(40) });
      expect(r2.body.note).toContain(`the PR head is ${'d'.repeat(40)}, not the --head you passed`);
      expect(enqueues()).toHaveLength(0);
      expect(ghCalls()).not.toContain('pr merge');
      expect(results()).toHaveLength(0);
    });

    it('권한이 없어도 이미 큐에 있으면 카드 없이 already_queued(확인하러 다시 부른 경우) — 큐에 없으면 지금처럼 denialId', async () => {
      checkStatus = 403; denialBody = { error: { code: 'not_granted', denialId: '11111111-2222-4333-8444-555555555555' } };
      queue = { enabled: true, inQueue: true, entry: { position: 1, state: 'MERGEABLE' } };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body).toMatchObject({ alreadyQueued: true });
      expect(r.body.error).toBeUndefined();
      expect(enqueues()).toHaveLength(0);
      queue = { enabled: true, inQueue: false, entry: null };
      const r2 = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r2.body.error).toMatchObject({ code: 'not_granted', denialId: '11111111-2222-4333-8444-555555555555' });
      expect(enqueues()).toHaveLength(0);
    });

    it('큐가 머지한 뒤 다시 부르면 not_open(MERGED) — 확인 길', async () => {
      queue = { enabled: true, inQueue: false, entry: null };
      pr = { ...pr, state: 'MERGED' };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('not_open');
      expect(enqueues()).toHaveLength(0);
      // 「⛔ 머지 실패」 줄을 남기지 않는다 — 카드만 닫는다(10-16 실측에서 찾음).
      expect(results()).toHaveLength(0);
      expect(closedReports()).toEqual([expect.objectContaining({ state: 'MERGED', number: 7 })]);
    });

    it('1회 승인: 이미 큐에 있으면 승인을 쓰지 않는다(merge-checks 를 부르지 않는다)', async () => {
      approvals = [{ id: 'ap-1', ghUser: 'corp-account', relaxChecks: false }];
      queue = { enabled: true, inQueue: true, entry: { position: 4, state: 'QUEUED' } };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body).toMatchObject({ alreadyQueued: true });
      expect(forwards.some((f) => f.type === 'http.forward' && f.path === '/agent/merge-checks')).toBe(false);
    });

    it('1회 승인으로도 큐에 넣는다 — 승인 계정 토큰으로', async () => {
      approvals = [{ id: 'ap-1', ghUser: 'corp-account', relaxChecks: false }];
      checkApproval = { id: 'ap-1', ghUser: 'corp-account', relaxChecks: false };
      queue = { enabled: true, inQueue: false, entry: null };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body).toMatchObject({ queued: true, alreadyQueued: false, viaApproval: true, ghUser: 'corp-account' });
      expect(enqueues()[0]!.env.GH_TOKEN).toBe('tok-approved');
      expect(results()).toEqual([expect.objectContaining({ result: 'queued' })]);
    });

    it('1회 승인: 사전 확인 뒤 누가 먼저 넣었으면 alreadyQueued 에 「승인이 쓰였다」를 적는다(security n3)', async () => {
      approvals = [{ id: 'ap-1', ghUser: 'corp-account', relaxChecks: false }];
      checkApproval = { id: 'ap-1', ghUser: 'corp-account', relaxChecks: false };
      queueSeq = [{ enabled: true, inQueue: false, entry: null }, { enabled: true, inQueue: true, entry: { position: 1, state: 'QUEUED' } }];
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body).toMatchObject({ alreadyQueued: true });
      expect(r.body.note).toContain('the one-time approval was used');
      expect(enqueues()).toHaveLength(0);
    });

    it('넣는 사이 누가 먼저 넣었으면 already_queued, 그 밖의 실패는 enqueue_failed + failed 보고', async () => {
      queue = { enabled: true, inQueue: false, entry: null };
      enqueueResult = { code: 1, stdout: '', stderr: 'gh: Pull request is already in the queue' };
      // 문구가 맞아도 다시 읽어 큐에 없으면 거짓 「큐에 있음」을 내지 않는다(security n1).
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('enqueue_failed');
      expect(results()).toEqual([expect.objectContaining({ result: 'failed' })]);
      forwards = [];
      // 다시 읽으니 정말 큐에 있다 — 경합이다.
      queueSeq = [{ enabled: true, inQueue: false, entry: null }, { enabled: true, inQueue: true, entry: { position: 5, state: 'QUEUED' } }];
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ alreadyQueued: true, queue: { position: 5 } });
      expect(results()).toHaveLength(0);
      enqueueResult = { code: 1, stdout: '', stderr: 'GraphQL: Pull request is not mergeable (enqueuePullRequest)' };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('enqueue_failed');
      expect(results()).toEqual([expect.objectContaining({ result: 'failed', error: expect.stringContaining('not mergeable') })]);
    });
  });

  it('isAlreadyQueuedError — 실측 문구(10-16 mq-sandbox)를 알아본다', () => {
    expect(isAlreadyQueuedError('gh: Pull request is already in the queue')).toBe(true);
    expect(isAlreadyQueuedError('GraphQL: Pull request is already in the merge queue')).toBe(true);
    expect(isAlreadyQueuedError('gh: Pull request is not mergeable')).toBe(false);
  });

  it('parseQueueInfo — 모양이 틀리면 null, 큐 항목이 있으면 inQueue', () => {
    expect(parseQueueInfo('nope')).toBeNull();
    expect(parseQueueInfo(JSON.stringify({ data: { repository: { pullRequest: null } } }))).toBeNull();
    expect(parseQueueInfo(JSON.stringify({ data: { repository: { pullRequest: { id: 'X', isMergeQueueEnabled: true, isInMergeQueue: false, mergeQueueEntry: { position: 1, state: 'QUEUED' } } } } })))
      .toEqual({ id: 'X', enabled: true, inQueue: true, entry: { position: 1, state: 'QUEUED' } });
  });
});
