import { describe, it, expect, beforeEach } from 'vitest';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createTurnMerge, ghEnv, isAlreadyQueuedError, notGreenChecks, parseMergeArgs, parseQueueInfo, parseRequiredChecks, unstableVerdict, prCiVerdict, pushedAtOf, ENQUEUE_MUTATION, NO_PR_CI_PR_QUERY, NO_PR_CI_REPO_QUERY, QUEUE_QUERY, REQUIRED_QUERY, type ExecResult, type TurnMerge } from '../src/turnMerge.js';
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
  let checkMandateLine: Record<string, unknown> | null;
  let peekStatus: number;
  // merge queue — GraphQL 읽기의 답(null 이면 gh 가 실패한다)·뮤테이션의 답.
  let queue: { enabled: boolean; inQueue: boolean; entry: { position: number; state: string } | null } | null;
  let enqueueResult: ExecResult;
  // 읽을 때마다 차례로 내줄 큐 상태(비면 `queue`) — 경합 재현용.
  let queueSeq: (typeof queue)[];
  // 필수 체크 GraphQL 의 답(null 이면 gh 가 실패한다).
  let required: { oid: string; hasNextPage?: boolean; nodes: Record<string, unknown>[] } | null;
  // merge-results 의 201 본문 — CI 거절이면 서버가 카드용 denialId 를 싣는다.
  let resultsBody: string;
  // PR CI 없음 판정(C안)의 GraphQL·activity 답. null 이면 gh 가 실패한다.
  let prCiPr: Record<string, unknown> | null;
  let prCiRepo: Record<string, unknown> | null;
  let activity: Record<string, unknown>[] | null;
  let clock: number;
  let tm: TurnMerge;

  beforeEach(() => {
    forwards = []; execs = []; checkStatus = 200; mergeCode = 0; mergeStderr = 'GraphQL: Base branch was modified'; viewStderr = null; denialBody = { error: { code: 'not_granted' } }; ghUser = 'izagood'; pickByScope = null;
    lease = { leaseId: 'lease-1', token: 'tok-1', agentId: 'a1' };
    approvals = []; checkApproval = null; checkMandateLine = null; peekStatus = 200;
    queue = { enabled: false, inQueue: false, entry: null }; queueSeq = [];
    required = null;
    resultsBody = '{"messageId":"m1"}';
    prCiPr = null; prCiRepo = null; activity = null; clock = Date.parse('2026-10-23T12:00:00Z');
    enqueueResult = { code: 0, stdout: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { position: 3, state: 'QUEUED' } } } }), stderr: '' };
    pr = { state: 'OPEN', isDraft: false, headRefOid: SHA, baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] };
    tm = createTurnMerge({
      ghPath: GH, home: '/Users/x', log: () => {}, now: () => clock,
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
            ? { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ allowed: true, grantedBy: 'owner-1', causeByHuman: true, ...(checkApproval ? { approval: checkApproval } : {}), ...(checkMandateLine ? { mandateLine: checkMandateLine } : {}) }) }
            : { type: 'http.response', id: req.id, status: checkStatus, body: JSON.stringify(denialBody) };
        }
        return { type: 'http.response', id: req.id, status: 201, body: req.path === '/agent/merge-results' ? resultsBody : '{"messageId":"m1"}' };
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
        if (args[0] === 'api' && args[1] === 'graphql' && args[3] === `query=${REQUIRED_QUERY}`) {
          if (!required) return { code: 1, stdout: '', stderr: 'HTTP 502' };
          return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: required.oid, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: required.hasNextPage ?? false }, nodes: required.nodes } } } }] } } } } }), stderr: '' };
        }
        if (args[0] === 'api' && args[1] === 'graphql' && args[3] === `query=${NO_PR_CI_PR_QUERY}`) {
          return prCiPr ? { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: prCiPr } } }), stderr: '' } : { code: 1, stdout: '', stderr: 'HTTP 502' };
        }
        if (args[0] === 'api' && args[1] === 'graphql' && args[3] === `query=${NO_PR_CI_REPO_QUERY}`) {
          return prCiRepo ? { code: 0, stdout: JSON.stringify({ data: { repository: prCiRepo } }), stderr: '' } : { code: 1, stdout: '', stderr: 'HTTP 502' };
        }
        if (args[0] === 'api' && args[2] === 'GET' && args[3] === 'repos/izagood/harkroom/activity') {
          return activity ? { code: 0, stdout: JSON.stringify(activity), stderr: '' } : { code: 1, stdout: '', stderr: 'HTTP 404' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
    });
  });

  describe('PR CI 가 없는 저장소(C안, 스레드 50324ba9)', () => {
    const BASE = 'c'.repeat(40);
    const wf = (name: string, text: string, extra: Record<string, unknown> = {}) => ({ name, type: 'blob', object: { __typename: 'Blob', text, isTruncated: false, isBinary: false, ...extra } });
    const noCiRepo = (over: Record<string, unknown> = {}) => ({
      base: null, head: null,
      commit: { checkSuites: { totalCount: 1, nodes: [{ app: { slug: 'github-actions' }, checkRuns: { totalCount: 0 } }] }, status: null },
      ...over,
    });
    beforeEach(() => {
      pr = { ...pr, statusCheckRollup: [] };
      prCiPr = { baseRefOid: BASE, headRefOid: SHA, headRefName: 'feat/x', isCrossRepository: false };
      prCiRepo = noCiRepo();
      activity = [{ after: 'd'.repeat(40), timestamp: '2026-10-23T11:00:00Z' }, { after: SHA, timestamp: '2026-10-23T11:57:00Z' }];
    });

    it('workflow 가 PR 에 돌지 않고 외부 CI 도 없으며 push 뒤 2분이 지났으면 체크 0개로 머지하고 noPrChecks 를 남긴다', async () => {
      prCiRepo = noCiRepo({ base: { __typename: 'Tree', entries: [wf('release.yml', 'on:\n  push:\n    branches: [main]\n'), { name: 'notes.md', type: 'blob', object: null }] } });
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.isError).toBe(false);
      expect(r.body).toMatchObject({ merged: true, noPrChecks: true });
      expect(results()).toEqual([expect.objectContaining({ result: 'merged', noPrChecks: true })]);
      const repoQ = execs.find((e) => e.args[3] === `query=${NO_PR_CI_REPO_QUERY}`)!;
      expect(repoQ.args).toEqual(expect.arrayContaining([`baseExpr=${BASE}:.github/workflows`, `headExpr=${SHA}:.github/workflows`, `base=${BASE}`]));
    });

    it('base 나 head 의 workflow 에 pull_request·pull_request_target·merge_group 낱말이 있으면 거절한다(주석이어도)', async () => {
      for (const [side, text] of [['base', 'on: [pull_request]'], ['head', 'on:\n  pull_request_target:\n'], ['base', '# merge_group later\non: push']] as const) {
        prCiRepo = noCiRepo({ [side]: { __typename: 'Tree', entries: [wf('ci.yaml', text)] } });
        const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
        expect(r.body.error.code, text).toBe('ci_not_green');
      }
      expect(ghCalls()).not.toContain('pr merge');
    });

    it('잘린·바이너리 workflow, 100개 이상, 외부 CI suite·commit status, 조회 실패는 모두 거절한다(fail-closed)', () => {
      const out = (repo: unknown) => JSON.stringify({ data: { repository: repo } });
      expect(prCiVerdict(out(noCiRepo()))).toBeNull();
      expect(prCiVerdict(out(noCiRepo({ base: { __typename: 'Tree', entries: [wf('a.yml', 'on: push', { isTruncated: true })] } })))).not.toBeNull();
      expect(prCiVerdict(out(noCiRepo({ head: { __typename: 'Tree', entries: [wf('a.yml', '', { isBinary: true, text: null })] } })))).not.toBeNull();
      expect(prCiVerdict(out(noCiRepo({ base: { __typename: 'Tree', entries: Array.from({ length: 100 }, (_, i) => wf(`w${i}.yml`, 'on: push')) } })))).not.toBeNull();
      expect(prCiVerdict(out(noCiRepo({ base: { __typename: 'Blob' } })))).not.toBeNull();
      expect(prCiVerdict(out(noCiRepo({ commit: { checkSuites: { totalCount: 1, nodes: [{ app: { slug: 'circleci-checks' }, checkRuns: { totalCount: 2 } }] }, status: null } })))?.message).toContain('circleci-checks');
      expect(prCiVerdict(out(noCiRepo({ commit: { checkSuites: { totalCount: 0, nodes: [] }, status: { contexts: [{ context: 'ci/jenkins' }] } } })))).not.toBeNull();
      expect(prCiVerdict(out(noCiRepo({ commit: { checkSuites: { totalCount: 101, nodes: [] }, status: null } })))).not.toBeNull();
      expect(prCiVerdict(out(null))).not.toBeNull();
      expect(prCiVerdict('not json')).not.toBeNull();
      expect(pushedAtOf(JSON.stringify([{ after: SHA, timestamp: '2026-10-23T11:57:00Z' }]), SHA)).toBe(Date.parse('2026-10-23T11:57:00Z'));
      expect(pushedAtOf('[]', SHA)).toBeNull();
    });

    it('push 뒤 2분이 안 됐으면 ci_pending — 카드(denialId)도 머지도 없다', async () => {
      activity = [{ after: SHA, timestamp: '2026-10-23T11:59:30Z' }];
      resultsBody = JSON.stringify({ messageId: 'm1', denialId: '11111111-2222-4333-8444-555555555555' });
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('ci_pending');
      expect(r.body.error.denialId).toBeUndefined();
      expect(results()[0]).not.toHaveProperty('ciRefusal');
      expect(ghCalls()).not.toContain('pr merge');
    });

    it('포크 PR·activity 에 없는 head 는 이 오퍼레이터가 처음 본 시각부터 2분을 잰다', async () => {
      prCiPr = { ...prCiPr, isCrossRepository: true };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('ci_pending');
      expect(execs.some((e) => e.args[3] === 'repos/izagood/harkroom/activity')).toBe(false);
      clock += 60_000;
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('ci_pending');
      clock += 61_000;
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ merged: true, noPrChecks: true });
    });

    it('판정 조회의 head 가 --head 와 다르면 head_moved', async () => {
      prCiPr = { ...prCiPr, headRefOid: 'e'.repeat(40) };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('head_moved');
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

    it('relaxChecks 는 승인 기록의 칸으로만 — 켜져 있으면 CI 는 건너뛰고(UNSTABLE·빨강) 건너뛴 체크를 남긴다', async () => {
      approvals = [{ ...approvals[0]!, relaxChecks: true }];
      checkApproval = { ...checkApproval!, relaxChecks: true };
      pr = { ...pr, mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ merged: true, ignoredChecks: ['test'] });
      expect(results()).toEqual([expect.objectContaining({ result: 'merged', ignoredChecks: ['test'] })]);
      // 꺼진 승인이면 같은 PR 이 막힌다
      approvals = [{ ...approvals[0]!, relaxChecks: false }];
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('not_mergeable');
    });

    it.each(['DIRTY', 'BEHIND', 'UNKNOWN', 'BLOCKED', undefined])('F1(스레드 1fccc9a5): CI 를 건너뛰는 승인이어도 %s 는 사전 확인에서 거절 — 승인을 쓰지 않고 보고도 없다', async (state) => {
      approvals = [{ ...approvals[0]!, relaxChecks: true }];
      checkApproval = { ...checkApproval!, relaxChecks: true };
      pr = { ...pr, mergeStateStatus: state, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('not_mergeable');
      expect(r.body.error.message).toContain('approval was not used');
      expect(checksCalled()).toBe(0);
      expect(results()).toEqual([]);
      expect(ghCalls()).not.toContain('pr merge');
    });

    it('F1: draft 도 CI 를 건너뛰는 승인으로 풀리지 않는다', async () => {
      approvals = [{ ...approvals[0]!, relaxChecks: true }];
      pr = { ...pr, isDraft: true };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('draft');
      expect(checksCalled()).toBe(0);
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

    describe('계정을 비운 승인(G1) — 오퍼레이터가 그 저장소용 계정을 고른다', () => {
      beforeEach(() => {
        approvals = [{ id: 'ap-1', ghUser: null, relaxChecks: false }];
        checkApproval = { id: 'ap-1', ghUser: null, relaxChecks: false };
      });

      it('ghUser 가 null 이면 ghUserFor(repo) 의 계정으로 사전 확인·머지한다', async () => {
        pickByScope = { 'izagood/harkroom': 'repo-account' };
        const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
        expect(r).toMatchObject({ isError: false, body: { merged: true, viaApproval: true, ghUser: 'repo-account' } });
        expect(execs.filter((e) => e.args[0] === 'auth').map((e) => e.args[3])).toEqual(['repo-account']);
        const merge = execs.find((e) => e.args[0] === 'pr' && e.args[1] === 'merge')!;
        expect(merge.args).toContain('--match-head-commit');
        expect(merge.env.GH_TOKEN).toBe('tok-repo-account');
        // n6: 고른 계정 이름을 결과 보고에 싣는다(이름뿐 — 토큰은 아니다).
        expect(results()).toEqual([expect.objectContaining({ result: 'merged', ghUserUsed: 'repo-account' })]);
        expect(JSON.stringify(results())).not.toContain('tok-repo-account');
      });

      it('n11: ghUser 가 null 이면 오퍼레이터가 고른 계정을 merge-checks 에 싣는다', async () => {
        pickByScope = { 'izagood/harkroom': 'repo-account' };
        expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ merged: true, ghUser: 'repo-account' });
        const check = forwards.find((f) => f.type === 'http.forward' && f.path === '/agent/merge-checks') as { body?: string };
        expect(JSON.parse(check.body ?? '{}')).toMatchObject({ ghUser: 'repo-account' });
        expect(check.body).not.toContain('tok-repo-account');
      });

      it('null 인데 이 저장소 계정이 없으면 no_gh_user — 판정(소모)을 부르지 않는다', async () => {
        ghUser = undefined;
        const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
        expect(r.body.error.code).toBe('no_gh_user');
        expect(r.body.error.message).toContain('approval was not used');
        expect(checksCalled()).toBe(0);
        expect(ghCalls()).not.toContain('pr merge');
      });

      it('사전 확인은 비어 있었는데 서버가 계정이 적힌 승인을 썼으면 머지하지 않는다', async () => {
        checkApproval = { id: 'ap-1', ghUser: 'izagood', relaxChecks: false };
        expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('approval_mismatch');
        expect(ghCalls()).not.toContain('pr merge');
      });
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

  describe('n11: 머지에 쓸 gh 계정을 merge-checks 에 싣는다', () => {
    const checkBody = () => JSON.parse(((forwards.find((f) => f.type === 'http.forward' && f.path === '/agent/merge-checks') as { body?: string }).body) ?? '{}');

    it('grant 길: ghUserFor(repo) 의 계정을 싣고, 바로 그 계정의 토큰으로만 머지한다', async () => {
      pickByScope = { 'izagood/harkroom': 'repo-account' };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ merged: true, ghUser: 'repo-account' });
      expect(checkBody()).toMatchObject({ ghUser: 'repo-account', repo: 'izagood/harkroom', number: 7, headSha: SHA });
      expect(execs.filter((e) => e.args[0] === 'auth').map((e) => e.args[3])).toEqual(['repo-account']);
      expect(execs.find((e) => e.args[0] === 'pr' && e.args[1] === 'merge')!.env.GH_TOKEN).toBe('tok-repo-account');
    });

    it('1회 승인 길: 승인의 계정을 싣는다', async () => {
      approvals = [{ id: 'ap-1', ghUser: 'corp-account', relaxChecks: false }];
      checkApproval = { id: 'ap-1', ghUser: 'corp-account', relaxChecks: false };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ merged: true, ghUser: 'corp-account' });
      expect(checkBody()).toMatchObject({ ghUser: 'corp-account' });
    });

    it('이 저장소 계정이 없으면 ghUser 없이 묻고(옛 모양), 통과해도 no_gh_user 로 머지하지 않는다', async () => {
      ghUser = undefined;
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('no_gh_user');
      expect(checkBody()).not.toHaveProperty('ghUser');
      expect(ghCalls()).not.toContain('pr merge');
    });

    it('줄의 ghUser 가 쓸 계정과 다르면 mandate_gh_user_mismatch — gh 를 부르지 않고 실패를 보고한다', async () => {
      checkMandateLine = { id: 'l1', via: 'mandate', ghUser: 'other-account', ciOverride: false };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('mandate_gh_user_mismatch');
      expect(execs).toHaveLength(0);
      expect(results()).toEqual([expect.objectContaining({ result: 'failed' })]);
    });

    it('줄의 ghUser 가 같으면(대소문자 무관) 그 계정으로 머지한다', async () => {
      checkMandateLine = { id: 'l1', via: 'mandate', ghUser: 'IzaGood', ciOverride: false };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body).toMatchObject({ merged: true, ghUser: 'izagood' });
    });

    it('줄의 ciOverride 는 오퍼레이터에서 CI 를 풀지 않는다', async () => {
      checkMandateLine = { id: 'l1', via: 'mandate', ghUser: null, ciOverride: true };
      pr = { ...pr, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'test' }] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('ci_not_green');
      expect(ghCalls()).not.toContain('pr merge');
    });
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

  describe('이름별 최신 실행만 센다 (homelab #219)', () => {
    const at = (name: string, conclusion: string | null, startedAt: string, extra: Record<string, unknown> = {}) =>
      ({ __typename: 'CheckRun', name, workflowName: 'PR guard', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion, startedAt, ...extra });

    it('옛 실행이 빨강이고 최신이 초록이면 초록 — 실측 #219 모양(실행 셋, 옛 둘 FAILURE)', async () => {
      pr = { ...pr, statusCheckRollup: [
        at('commit-emails', 'FAILURE', '2026-10-19T09:06:40Z'), at('commit-emails', 'FAILURE', '2026-10-19T09:22:58Z'), at('commit-emails', 'SUCCESS', '2026-10-19T09:23:58Z'),
        at('secrets', 'FAILURE', '2026-10-19T09:06:40Z'), at('secrets', 'FAILURE', '2026-10-19T09:22:59Z'), at('secrets', 'SUCCESS', '2026-10-19T09:23:58Z'),
        at('pr-body', 'SUCCESS', '2026-10-19T09:06:40Z'), at('pr-body', 'SUCCESS', '2026-10-19T09:23:58Z'),
      ] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok()))).toMatchObject({ isError: false, body: { merged: true } });
      expect(notGreenChecks(pr)).toEqual([]);
    });

    it('옛 실행이 초록이고 최신이 빨강이면 빨강 — 배열 순서와 무관하게 시각으로 고른다', async () => {
      pr = { ...pr, statusCheckRollup: [at('check', 'FAILURE', '2026-10-19T09:30:00Z'), at('check', 'SUCCESS', '2026-10-19T09:00:00Z')] };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error).toMatchObject({ code: 'ci_not_green', message: 'not green: check' });
      expect(ghCalls().filter((c) => c === 'pr merge')).toEqual([]);
    });

    it('최신이 아직 도는 중이면 초록이 아니다 — 옛 초록으로 통과하지 않는다', async () => {
      pr = { ...pr, statusCheckRollup: [at('check', 'SUCCESS', '2026-10-19T09:00:00Z'), at('check', null, '2026-10-19T09:30:00Z')] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('ci_not_green');
      expect(ghCalls().filter((c) => c === 'pr merge')).toEqual([]);
    });

    it('취소된 실행은 최신으로 고르지 않는다 — 늦게 찍힌 취소가 앞 초록을 막지 않고, 앞 빨강을 풀지도 않는다', async () => {
      pr = { ...pr, statusCheckRollup: [at('check', 'SUCCESS', '2026-10-19T09:00:00Z'), at('check', 'CANCELLED', '2026-10-19T09:30:00Z')] };
      expect(notGreenChecks(pr)).toEqual([]);
      pr = { ...pr, statusCheckRollup: [at('check', 'FAILURE', '2026-10-19T09:00:00Z'), at('check', 'CANCELLED', '2026-10-19T09:30:00Z')] };
      expect(notGreenChecks(pr)).toEqual(['check']);
    });

    it('시각을 모르는 실행이 끼었거나 최신이 동률이면 모두 초록이어야 초록 — 대기 중(startedAt 없음)인 새 실행은 옛 초록으로 넘지 않는다', () => {
      pr = { ...pr, statusCheckRollup: [at('check', 'SUCCESS', '2026-10-19T09:00:00Z'), { name: 'check', workflowName: 'PR guard', status: 'QUEUED', conclusion: '' }] };
      expect(notGreenChecks(pr)).toEqual(['check']);
      pr = { ...pr, statusCheckRollup: [at('check', 'FAILURE', '2026-10-19T09:00:00Z'), at('check', 'SUCCESS', '0001-01-01T00:00:00Z')] };
      expect(notGreenChecks(pr)).toEqual(['check']);
      pr = { ...pr, statusCheckRollup: [at('check', 'FAILURE', '2026-10-19T09:30:00Z'), at('check', 'SUCCESS', '2026-10-19T09:30:00Z')] };
      expect(notGreenChecks(pr)).toEqual(['check']);
    });

    it('다른 workflow 의 같은 이름은 서로를 가리지 않는다', () => {
      pr = { ...pr, statusCheckRollup: [at('test', 'FAILURE', '2026-10-19T09:00:00Z', { workflowName: 'A' }), at('test', 'SUCCESS', '2026-10-19T09:30:00Z', { workflowName: 'B' })] };
      expect(notGreenChecks(pr)).toEqual(['test']);
    });

    it('UNSTABLE 길도 같다 — 필수 체크의 옛 빨강은 무시, 비필수의 최신 빨강만 ignoredChecks', async () => {
      pr = { ...pr, mergeStateStatus: 'UNSTABLE', statusCheckRollup: [at('test', 'SUCCESS', '2026-10-19T09:30:00Z'), at('lint', 'FAILURE', '2026-10-19T09:30:00Z')] };
      const node = (name: string, conclusion: string, startedAt: string, isRequired: boolean) =>
        ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, startedAt, checkSuite: { workflowRun: { workflow: { name: 'PR guard' } } }, isRequired });
      required = { oid: SHA, nodes: [
        node('test', 'FAILURE', '2026-10-19T09:00:00Z', true), node('test', 'SUCCESS', '2026-10-19T09:30:00Z', true),
        node('lint', 'SUCCESS', '2026-10-19T09:00:00Z', false), node('lint', 'FAILURE', '2026-10-19T09:30:00Z', false),
      ] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok()))).toMatchObject({ isError: false, body: { merged: true, ignoredChecks: ['lint'] } });
      // 필수의 최신이 빨강이면 거절.
      required = { oid: SHA, nodes: [node('test', 'SUCCESS', '2026-10-19T09:00:00Z', true), node('test', 'FAILURE', '2026-10-19T09:30:00Z', true)] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error).toMatchObject({ code: 'ci_not_green', message: 'required checks not green: test' });
    });

    it('parseRequiredChecks 는 workflow 이름과 시각(status-context 는 createdAt)을 gh pr view 모양으로 옮긴다', () => {
      const rc = parseRequiredChecks(JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: { contexts: { nodes: [
        { __typename: 'CheckRun', name: 't', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-19T09:00:00Z', checkSuite: { workflowRun: { workflow: { name: 'CI' } } }, isRequired: true },
        { __typename: 'CheckRun', name: 'ext', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-19T09:00:00Z', checkSuite: { workflowRun: null }, isRequired: false },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', createdAt: '2026-10-19T08:00:00Z', isRequired: false },
      ] } } } }] } } } } }));
      expect(rc!.checks).toEqual([
        { name: 't', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI', startedAt: '2026-10-19T09:00:00Z', isRequired: true },
        { name: 'ext', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-19T09:00:00Z', isRequired: false },
        { context: 'ci/legacy', state: 'SUCCESS', startedAt: '2026-10-19T08:00:00Z', isRequired: false },
      ]);
    });
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

  describe('UNSTABLE — 필수 체크만 초록이면 통과 (스레드 1fccc9a5)', () => {
    const run = (name: string, conclusion: string, isRequired: boolean) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, isRequired });
    const requiredCalls = () => execs.filter((e) => e.args[0] === 'api' && e.args[3] === `query=${REQUIRED_QUERY}`);
    beforeEach(() => {
      pr = { ...pr, mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'review / review', status: 'COMPLETED', conclusion: 'FAILURE' }] };
    });

    it('필수 체크가 전부 초록이면 squash 하고, 초록 아닌 비필수 체크 이름을 ignoredChecks 로 싣는다', async () => {
      required = { oid: SHA, nodes: [run('test', 'SUCCESS', true), run('review / review', 'FAILURE', false)] };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r).toMatchObject({ isError: false, body: { merged: true, ignoredChecks: ['review / review'] } });
      expect(ghCalls()).toEqual(['pr view', 'pr merge', 'pr view']);
      // 조회는 저장소·번호를 변수로만 넘긴다.
      expect(requiredCalls()[0]!.args.slice(4)).toEqual(['-f', 'owner=izagood', '-f', 'name=harkroom', '-F', 'number=7']);
    });

    it('merge queue 저장소면 큐에 넣고 ignoredChecks 를 같이 싣는다', async () => {
      queue = { enabled: true, inQueue: false, entry: null };
      required = { oid: SHA, nodes: [run('test', 'SUCCESS', true), run('review / review', 'FAILURE', false)] };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r).toMatchObject({ isError: false, body: { queued: true, ignoredChecks: ['review / review'] } });
      expect(enqueues()).toHaveLength(1);
    });

    it('필수 체크가 하나도 없는 저장소는 거절한다 — 실패한 이름과 「필수 체크를 정하라」를 문구에 싣는다', async () => {
      required = { oid: SHA, nodes: [run('test', 'SUCCESS', false), run('review / review', 'FAILURE', false)] };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('ci_not_green');
      expect(r.body.error.message).toContain('not green: review / review');
      expect(r.body.error.message).toContain('no required status checks');
      expect(ghCalls()).toEqual(['pr view']);
      expect(results()).toEqual([expect.objectContaining({ result: 'failed' })]);
    });

    it.each([
      ['필수 체크가 빨강', [run('test', 'FAILURE', true), run('review / review', 'FAILURE', false)], 'ci_not_green'],
      ['필수 체크가 아직 도는 중', [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null, isRequired: true }], 'ci_not_green'],
      ['같은 이름에 필수 초록과 빨강이 함께(C1)', [run('test', 'SUCCESS', true), run('test', 'FAILURE', true)], 'ci_not_green'],
      ['옛 status-context 필수가 실패', [run('build', 'SUCCESS', true), { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE', isRequired: true }], 'ci_not_green'],
    ])('%s → %s (merge 0건)', async (_l, nodes, code) => {
      required = { oid: SHA, nodes: nodes as Record<string, unknown>[] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe(code);
      expect(ghCalls()).toEqual(['pr view']);
    });

    it('필수 체크 조회가 실패하면 원래대로 not_mergeable — 실패한 체크 이름을 싣는다(fail-closed)', async () => {
      required = null;
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('not_mergeable');
      expect(r.body.error.message).toMatch(/UNSTABLE \(need CLEAN\) — not green: review \/ review — could not read which checks are required/);
      expect(ghCalls()).toEqual(['pr view']);
    });

    it('조회한 커밋이 --head 와 다르면 head_moved, 체크가 100개를 넘으면 판정하지 않는다', async () => {
      required = { oid: 'c'.repeat(40), nodes: [run('test', 'SUCCESS', true)] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('head_moved');
      required = { oid: SHA, hasNextPage: true, nodes: [run('test', 'SUCCESS', true)] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('not_mergeable');
      expect(ghCalls()).toEqual(['pr view', 'pr view']);
    });

    it('UNSTABLE 이 아닌 거절(BLOCKED 등)은 필수 체크를 묻지 않는다 — 문구에 초록 아닌 이름만 더한다', async () => {
      pr = { ...pr, mergeStateStatus: 'BLOCKED' };
      required = { oid: SHA, nodes: [run('test', 'SUCCESS', true)] };
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error).toMatchObject({ code: 'not_mergeable', message: 'mergeStateStatus is BLOCKED (need CLEAN) — not green: review / review' });
      expect(requiredCalls()).toHaveLength(0);
    });

    it('CLEAN 인데 체크가 빨강이면(있을 수 없지만) 지금처럼 ci_not_green — 필수 조회로 풀리지 않는다', async () => {
      pr = { ...pr, mergeStateStatus: 'CLEAN' };
      required = { oid: SHA, nodes: [run('test', 'SUCCESS', true), run('review / review', 'FAILURE', false)] };
      expect(resultOf(await tm.maybeHandle('r1', 'a1', ok())).body.error.code).toBe('ci_not_green');
      expect(requiredCalls()).toHaveLength(0);
    });
  });

  describe('CI 거절 → 카드 (스레드 1fccc9a5)', () => {
    const DENIAL = '11111111-2222-4333-8444-555555555555';
    it('ci_not_green 이면 ciRefusal(초록 아닌 이름)을 보고하고, 서버가 준 denialId 를 넘긴다', async () => {
      pr = { ...pr, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
      resultsBody = JSON.stringify({ messageId: 'm1', denialId: DENIAL });
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error).toMatchObject({ code: 'ci_not_green', denialId: DENIAL });
      expect(r.body.error.message).toContain('mergeDenialId');
      expect(results()).toEqual([expect.objectContaining({ result: 'failed', ciRefusal: { code: 'ci_not_green', mergeState: 'CLEAN', checks: ['test'] } })]);
    });

    it('UNSTABLE 인데 필수 체크가 없으면 not green 이름으로 ciRefusal — denialId 가 uuid 가 아니면 넘기지 않는다', async () => {
      pr = { ...pr, mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'review', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
      required = { oid: SHA, nodes: [{ __typename: 'CheckRun', name: 'review', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: false }, { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false }] };
      resultsBody = JSON.stringify({ messageId: 'm1', denialId: 'not-a-uuid' });
      const r = resultOf(await tm.maybeHandle('r1', 'a1', ok()));
      expect(r.body.error.code).toBe('ci_not_green');
      expect(r.body.error.denialId).toBeUndefined();
      expect(results()[0]).toMatchObject({ ciRefusal: { code: 'ci_not_green', mergeState: 'UNSTABLE', checks: ['review'] } });
    });

    it('BLOCKED·DIRTY·head_moved 는 CI 거절이 아니다 — ciRefusal 을 싣지 않는다', async () => {
      for (const patch of [{ mergeStateStatus: 'BLOCKED' }, { mergeStateStatus: 'DIRTY' }, { headRefOid: 'c'.repeat(40) }]) {
        forwards = [];
        pr = { ...pr, mergeStateStatus: 'CLEAN', headRefOid: SHA, ...patch, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] };
        resultOf(await tm.maybeHandle('r1', 'a1', ok()));
        expect(results()[0]!.ciRefusal, JSON.stringify(patch)).toBeUndefined();
      }
    });
  });

  it('parseRequiredChecks·unstableVerdict — 모양이 틀리면 null, isRequired 는 true 만 필수', () => {
    expect(parseRequiredChecks('nope')).toBeNull();
    expect(parseRequiredChecks(JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [] } } } } }))).toBeNull();
    const rc = parseRequiredChecks(JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: null } }] } } } } }));
    expect(rc).toEqual({ headOid: SHA, truncated: false, checks: [] });
    expect(unstableVerdict(rc!, SHA)).toMatchObject({ code: 'ci_not_green' });
    expect(unstableVerdict({ headOid: SHA, truncated: false, checks: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true }, { name: 'b', status: 'QUEUED' }] }, SHA)).toEqual({ ignored: ['b'] });
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
