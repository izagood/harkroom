// 커뮤니티 인스턴스 — 스펙 2026-09-20 §3 격리. 오퍼레이터는 머신당 하나이고 커뮤니티(=서버)
// 여럿에 붙는다. 격리는 스코핑 조건이 아니라 **인스턴스**로 강제한다(데스크탑 communities.ts
// 와 같은 패턴): 커뮤니티마다 링크·배정·로컬 설정을 따로 든 객체 하나.
import { describe, it, expect } from 'vitest';
import type { ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import { createCommunity } from '../src/community.js';
import type { AssignmentReconciler } from '../src/assignments.js';
import type { LinkDialer } from '../src/serverLink.js';

function fakeReconciler() {
  const calls: string[] = [];
  const reconciler: AssignmentReconciler = {
    onAssign: async (baseUrl, def, local) => { calls.push(`assign ${baseUrl} ${def.agentId} ${local?.workingDir ?? '-'}`); return 'spawned'; },
    onUnassign: async (baseUrl, agentId, drain) => { calls.push(`unassign ${baseUrl} ${agentId} ${drain}`); },
    onRunnerExit: (agentId, code) => { calls.push(`exit ${agentId} ${code}`); },
    announce: () => [{ agentId: 'a-1', runnerId: 'r-1', pid: 7 }],
  };
  return { reconciler, calls };
}

describe('community', () => {
  it('hello 에 로컬 설정의 에이전트와 살아 있는 러너를 싣는다', () => {
    const sent: string[] = [];
    const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const { reconciler } = fakeReconciler();
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x',
      agents: { 'a-1': { workingDir: '~/x' }, 'a-2': {} },
      reconciler, dial, schedule: () => {}, log: () => {},
    });
    c.start();
    const hello = JSON.parse(sent[0]!);
    expect(hello.type).toBe('hello');
    expect(hello.capabilities.agentIds.sort()).toEqual(['a-1', 'a-2']);
    expect(hello.runners).toEqual([{ agentId: 'a-1', runnerId: 'r-1', pid: 7 }]);
  });

  it('assign 은 로컬 설정과 함께 조정기로, unassign 도 조정기로 간다', async () => {
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: () => {}, close: () => {} }); };
    const { reconciler, calls } = fakeReconciler();
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents: { 'a-1': { workingDir: '~/x' } },
      reconciler, dial, schedule: () => {}, log: () => {},
    });
    c.start();
    const assign: ServerToOperatorFrame = { type: 'assign', agentId: 'a-1', definition: {
      agentId: 'a-1', handle: 'murmur', harness: 'claude-code', instructions: '', model: null, effort: null,
      mentionPermission: 'auto', workingDirDefault: null, credentialScope: 'none', ownerAccountId: null, mcpServers: [],
    } };
    handlers!.onMessage(JSON.stringify(assign));
    handlers!.onMessage(JSON.stringify({ type: 'unassign', agentId: 'a-1', drain: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['assign https://example.com a-1 ~/x', 'unassign https://example.com a-1 true']);
    expect(c.assignments.has('a-1')).toBe(false);
  });

  it('러너 프레임은 runnerId 를 달고 서버로, 서버의 러너 프레임은 runnerId 의 러너로 간다(스펙 §5)', () => {
    const sent: string[] = [];
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const { reconciler } = fakeReconciler();
    const toRunner: { runnerId: string; frame: unknown }[] = [];
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents: { 'a-1': {} },
      reconciler, dial, schedule: () => {}, log: () => {},
      runnerLink: { send: (r, f) => { toRunner.push({ runnerId: r, frame: f }); return true; }, isLinked: () => true },
    });
    c.start();
    c.onRunnerFrame('r-1', { type: 'output', sessionId: 's1', data: 'AA==' });
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: 'pty.output', runnerId: 'r-1', sessionId: 's1', bytes: 'AA==' });
    handlers!.onMessage(JSON.stringify({ type: 'pty.resize', runnerId: 'r-1', sessionId: 's1', cols: 80, rows: 24 }));
    expect(toRunner).toEqual([{ runnerId: 'r-1', frame: { type: 'resize', sessionId: 's1', cols: 80, rows: 24 } }]);
  });

  it('러너의 생사를 서버에 알리고, 재접속 hello 에는 붙어 있는 러너의 세션이 실린다', () => {
    const sent: string[] = [];
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const { reconciler } = fakeReconciler();
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents: { 'a-1': {} },
      reconciler, dial, schedule: () => {}, log: () => {},
      runnerLink: { send: () => true, isLinked: () => true },
    });
    c.start();
    c.notifyRunnerStarted('a-1', 'r-1');
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: 'runner.started', agentId: 'a-1', runnerId: 'r-1' });
    const session = { sessionId: 's1', agentAccountId: 'a-1', channelId: 'c', threadRootId: null, harness: 'claude-code' as const, startedAt: 't', acceptsInput: true };
    c.onRunnerFrame('r-1', { type: 'announce', sessions: [session], caps: ['input'] });
    // 서버가 끊겼다 다시 붙는다 — hello 에 세션이 실리고, 그 뒤 runner.announce 로 목록을 다시 낸다.
    sent.length = 0;
    handlers!.onClose('끊김');
    handlers!.onOpen({ send: (d) => sent.push(d), close: () => {} });
    const frames = sent.map((d) => JSON.parse(d) as { type: string; sessions?: unknown[] });
    expect(frames[0]!.type).toBe('hello');
    expect(frames[0]!.sessions).toEqual([session]);
    expect(frames.some((f) => f.type === 'runner.announce')).toBe(true);
    c.notifyRunnerExited('r-1', 0);
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: 'runner.exited', runnerId: 'r-1', code: 0 });
  });

  it('로컬 설정에 없는 에이전트의 assign 은 거절한다 — 양쪽 동의', async () => {
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: () => {}, close: () => {} }); };
    const { reconciler, calls } = fakeReconciler();
    const lines: string[] = [];
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents: {},
      reconciler, dial, schedule: () => {}, log: (l) => lines.push(l),
    });
    c.start();
    handlers!.onMessage(JSON.stringify({ type: 'assign', agentId: 'stranger', definition: { agentId: 'stranger', handle: 's' } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
    expect(lines.some((l) => l.includes('stranger'))).toBe(true);
  });
});

// 교차 불변식(스펙 §7)의 재료 — 오퍼레이터는 자기 소유자를 `/operators/self` 로 안다. 그리고
// 조정기가 거절한 배정은 서버에 `runner.exited{reason}` 으로 보인다 — 조용히 안 뜨는 것이 아니라.
describe('community — 소유자 확인과 거절 통지', () => {
  const dialOpen = (sent: string[]): LinkDialer => (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); return h; };
  it('붙을 때 /operators/self 를 오퍼레이터 토큰으로 읽어 소유자 id 를 안다', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(`${String(url)} ${(init?.headers as Record<string, string>)?.authorization ?? ''}`);
      return new Response(JSON.stringify({ id: 'op-1', ownerAccountId: 'u-9' }), { status: 200 });
    }) as unknown as typeof fetch;
    const { reconciler } = fakeReconciler();
    const c = createCommunity({ baseUrl: 'https://example.com', token: 'hkop_x', agents: {}, reconciler, dial: dialOpen([]), schedule: () => {}, log: () => {}, fetchImpl });
    c.start();
    expect(await c.ownerAccountId()).toBe('u-9');
    expect(urls).toEqual(['https://example.com/operators/self Bearer hkop_x']);
  });
  it('self 를 못 읽으면 null — 그때 personal 배정은 조정기가 거절한다', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const { reconciler } = fakeReconciler();
    const c = createCommunity({ baseUrl: 'https://example.com', token: 'hkop_x', agents: {}, reconciler, dial: dialOpen([]), schedule: () => {}, log: () => {}, fetchImpl });
    c.start();
    expect(await c.ownerAccountId()).toBeNull();
  });
  it('조정기가 거절하면 서버에 runner.exited{reason} 을 보내고 배정 목록에 남기지 않는다', async () => {
    const sent: string[] = [];
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const reconciler: AssignmentReconciler = {
      onAssign: async () => ({ refused: 'personal_on_foreign_operator' }),
      onUnassign: async () => {}, onRunnerExit: () => {}, announce: () => [],
    };
    const c = createCommunity({ baseUrl: 'https://example.com', token: 'hkop_x', agents: { 'a-1': {} }, reconciler, dial, schedule: () => {}, log: () => {} });
    c.start();
    handlers!.onMessage(JSON.stringify({ type: 'assign', agentId: 'a-1', definition: {
      agentId: 'a-1', handle: 'privy', harness: 'claude-code', instructions: '', model: null, effort: null,
      mentionPermission: 'auto', workingDirDefault: null, credentialScope: 'personal', ownerAccountId: 'u-1', mcpServers: [],
    } }));
    await new Promise((r) => setTimeout(r, 0));
    const exited = sent.map((d) => JSON.parse(d)).find((f) => f.type === 'runner.exited');
    expect(exited).toMatchObject({ type: 'runner.exited', code: null, reason: 'personal_on_foreign_operator' });
    expect(typeof exited.runnerId).toBe('string');
    expect(c.assignments.has('a-1')).toBe(false);
  });
});
