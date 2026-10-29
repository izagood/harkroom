// 턴 도중 새 글(스레드 f1460447) — 오퍼레이터의 `thread.peek` 와 hook 판단. 앵커는 임대의 cause 에서만 정하고, 사람 글만 한 번씩 싣는다.
import { describe, expect, it } from 'vitest';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createTurnPeek, peekContext, THREAD_PEEK_TOOL } from '../src/turnPeek.js';
import { decidePostToolHook } from '../src/hookCli.js';
import { parseCliArgs } from '../src/cli.js';

const AGENT = 'a-1';
const HUMAN = 'h-1';
const OTHER_AGENT = 'a-2';

function fakeServer(thread: { seq: number; authorId: string; kind?: string; body: string; deletedAt?: string | null }[]) {
  const paths: string[] = [];
  const forward = async (_agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse> => {
    const path = req.type === 'http.forward' ? req.path : '';
    paths.push(path);
    const ok = (v: unknown): RunnerLinkResponse => ({ type: 'http.response', id: req.id, status: 200, body: JSON.stringify(v) });
    if (path.startsWith('/messages/')) return ok({ id: 'cause-1', seq: 10, channelId: 'c-1', threadRootId: 'root-1' });
    if (path === '/accounts') return ok({ accounts: [{ id: HUMAN, kind: 'human', handle: 'pat' }, { id: AGENT, kind: 'agent', handle: 'me' }, { id: OTHER_AGENT, kind: 'agent', handle: 'tm' }] });
    if (path.startsWith('/channels/c-1/messages?thread=root-1&since=')) {
      const since = Number(/since=(\d+)/.exec(path)![1]);
      return ok({ messages: thread.filter((m) => m.seq > since).map((m) => ({ kind: 'user', deletedAt: null, ...m })), hasMore: false });
    }
    return { type: 'http.response', id: req.id, status: 404, body: '' };
  };
  return { forward, paths };
}

const call = (cause: string | undefined, args: Record<string, unknown> = { sinceSeq: 10 }): RunnerLinkRequest =>
  ({ type: 'mcp.request', id: 'r', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: THREAD_PEEK_TOOL, arguments: args } }, ...(cause ? { cause } : {}) } as RunnerLinkRequest);

const postsOf = (res: RunnerLinkResponse | null): { posts: { seq: number; handle: string; body: string }[]; error?: { code: string } } => {
  const m = (res as { messages: { result: { content: { text: string }[] } }[] }).messages[0]!;
  return JSON.parse(m.result.content[0]!.text);
};

describe('thread.peek', () => {
  const lease = { leaseId: 'l', token: 't', agentId: AGENT };

  it('사람 글만, 커서 뒤만, 한 번씩 — 자기·다른 에이전트·시스템·지운 글은 빠진다', async () => {
    const thread = [
      { seq: 9, authorId: HUMAN, body: '턴 시작 전 글' },
      { seq: 11, authorId: AGENT, body: '내 글' },
      { seq: 12, authorId: OTHER_AGENT, body: '다른 에이전트' },
      { seq: 13, authorId: HUMAN, kind: 'system', body: '시스템 줄' },
      { seq: 14, authorId: HUMAN, body: '지운 글', deletedAt: '2026-10-29T00:00:00Z' },
      { seq: 15, authorId: HUMAN, body: '멈춰' },
    ];
    const s = fakeServer(thread);
    const peek = createTurnPeek({ forward: s.forward, lookupLease: () => lease, log: () => {} });
    const first = postsOf(await peek.maybeHandle('run-1', AGENT, call('cause-1'), 'hook'));
    expect(first.posts).toEqual([{ seq: 15, handle: 'pat', body: '멈춰' }]);
    // 같은 글을 다시 싣지 않는다.
    expect(postsOf(await peek.maybeHandle('run-1', AGENT, call('cause-1'), 'hook')).posts).toEqual([]);
    thread.push({ seq: 16, authorId: HUMAN, body: '아니 계속해' });
    expect(postsOf(await peek.maybeHandle('run-1', AGENT, call('cause-1'), 'hook')).posts.map((p) => p.seq)).toEqual([16]);
    // 앵커는 cause 에서 정한다 — 인자에 채널을 실어도 그 경로로 가지 않는다.
    await peek.maybeHandle('run-1', AGENT, call('cause-1', { sinceSeq: 0, channelId: 'evil', threadRootId: 'evil' }), 'hook');
    expect(s.paths.some((p) => p.includes('evil'))).toBe(false);
  });

  it('임대가 없거나 다른 에이전트 것이면 서버에 묻지 않고 빈 목록', async () => {
    const s = fakeServer([{ seq: 15, authorId: HUMAN, body: '멈춰' }]);
    const none = createTurnPeek({ forward: s.forward, lookupLease: () => null, log: () => {} });
    expect(postsOf(await none.maybeHandle('run-1', AGENT, call('cause-1'), 'hook')).posts).toEqual([]);
    const other = createTurnPeek({ forward: s.forward, lookupLease: () => ({ ...lease, agentId: 'x' }), log: () => {} });
    expect(postsOf(await other.maybeHandle('run-1', AGENT, call('cause-1'), 'hook')).posts).toEqual([]);
    expect(postsOf(await other.maybeHandle('run-1', AGENT, call(undefined), 'hook')).posts).toEqual([]);
    expect(s.paths).toEqual([]);
  });

  it('hook 소켓에서만 답한다 — 에이전트 MCP 로 부르면 hook_only', async () => {
    const s = fakeServer([{ seq: 15, authorId: HUMAN, body: '멈춰' }]);
    const peek = createTurnPeek({ forward: s.forward, lookupLease: () => lease, log: () => {} });
    const r = postsOf(await peek.maybeHandle('run-1', AGENT, call('cause-1'), 'bridge'));
    expect(r.error?.code).toBe('hook_only');
    expect(s.paths).toEqual([]);
  });

  it('서버 오류는 빈 목록(턴을 막지 않는다)', async () => {
    const peek = createTurnPeek({ forward: async (_a, req) => ({ type: 'http.response', id: req.id, status: 500, body: '' }), lookupLease: () => lease, log: () => {} });
    expect(postsOf(await peek.maybeHandle('run-1', AGENT, call('cause-1'), 'hook')).posts).toEqual([]);
  });

  it('글당 길이 상한·인용 표시', () => {
    const text = peekContext([{ seq: 3, handle: 'pat', body: '멈춰\n둘째 줄' }])!;
    expect(text).toContain('턴 도중 새 글');
    expect(text).toContain('> 멈춰\n> 둘째 줄');
    expect(peekContext([])).toBeNull();
  });
});

describe('hook posttool', () => {
  it('글이 있으면 그 글, 턴 밖·실패·모양이 틀리면 null(무출력)', async () => {
    const ok = await decidePostToolHook(5, async () => ({ ok: true, text: JSON.stringify({ posts: [{ seq: 6, handle: 'pat', body: '멈춰' }] }) }));
    expect(ok).toContain('> 멈춰');
    expect(await decidePostToolHook(5, async () => ({ ok: false, notInTurn: true }))).toBeNull();
    expect(await decidePostToolHook(5, async () => { throw new Error('x'); })).toBeNull();
    expect(await decidePostToolHook(5, async () => ({ ok: true, text: 'not json' }))).toBeNull();
    expect(await decidePostToolHook(5, async () => ({ ok: true, text: JSON.stringify({ posts: [{ seq: 'x' }] }) }))).toBeNull();
  });

  it('cli: posttool --since 는 음이 아닌 정수만', () => {
    expect(parseCliArgs(['hook', 'posttool', '--since', '42'])).toEqual({ command: 'hook', event: 'posttool', since: 42 });
    expect(parseCliArgs(['hook', 'posttool', '--since', '-1'])).toEqual({ command: 'hook', event: 'posttool', since: 0 });
    expect(parseCliArgs(['hook', 'posttool'])).toEqual({ command: 'hook', event: 'posttool', since: 0 });
  });
});
