// R1 PR-3b(스레드 8d233406): 오퍼레이터가 서버의 로컬 직결 키를 허브에 넣고, 입력 바이트를 번호별로 보고한다.
// 오퍼레이터는 여러 서버(커뮤니티)에 붙을 수 있으므로 **이 커뮤니티의 이 러너 세션**일 때만 키를 받는지,
// 그리고 감사 바이트가 키를 갈아 끼우거나 세션이 끝나기 전에 옛 번호로 털리는지(n4)를 고정한다.
import { describe, it, expect } from 'vitest';
import type { ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import type { AgentSessionView } from '@harkroom/shared';
import { createCommunity } from '../src/community.js';
import { createLocalTerminalHub, INPUT_REPORT_MS, type LocalTerminalSubscriber } from '../src/localTerminal.js';
import type { AssignmentReconciler } from '../src/assignments.js';
import type { LinkDialer } from '../src/serverLink.js';

const VIEW = 'v'.repeat(32);
const W1 = 'a'.repeat(32);
const W2 = 'b'.repeat(32);
const view = (sessionId: string): AgentSessionView => ({ sessionId } as unknown as AgentSessionView);

const reconciler: AssignmentReconciler = {
  onAssign: async () => 'spawned', onUnassign: async () => {}, restart: () => true, onRunnerExit: () => {}, announce: () => [],
};

function hubWithClock() {
  const timers: (() => void)[] = [];
  const reports: { runnerId: string; sessionId: string; gen: number; bytes: number }[] = [];
  const hub = createLocalTerminalHub({
    sendToRunner: () => true,
    reportInput: (runnerId, sessionId, gen, bytes) => reports.push({ runnerId, sessionId, gen, bytes }),
    schedule: (fn) => { timers.push(fn); },
    log: () => {},
  });
  hub.onRunnerFrame('r1', { type: 'announce', sessions: [view('s1')] });
  return { hub, reports, tick: () => { for (const fn of timers.splice(0)) fn(); } };
}

describe('입력 바이트 보고(감사, n4)', () => {
  it(`${INPUT_REPORT_MS}ms 창에 모아 번호와 함께 한 번에 올린다 — 내용은 없다`, () => {
    const { hub, reports, tick } = hubWithClock();
    hub.grantWriter('s1', W1, 7);
    hub.input('s1', W1, 'YWJj');
    hub.input('s1', W1, 'YQ==');
    expect(reports).toEqual([]);
    tick();
    expect(reports).toEqual([{ runnerId: 'r1', sessionId: 's1', gen: 7, bytes: 4 }]);
  });

  it('키를 갈아 끼우기 전에 옛 번호로 턴다 — 새 writer 의 감사에 섞이지 않는다', () => {
    const { hub, reports, tick } = hubWithClock();
    hub.grantWriter('s1', W1, 7);
    hub.input('s1', W1, 'YWJj');
    hub.grantWriter('s1', W2, 8);
    expect(reports).toEqual([{ runnerId: 'r1', sessionId: 's1', gen: 7, bytes: 3 }]);
    hub.input('s1', W2, 'YQ==');
    tick();
    expect(reports.at(-1)).toEqual({ runnerId: 'r1', sessionId: 's1', gen: 8, bytes: 1 });
  });

  it('키를 거두거나 세션이 끝나면 창을 기다리지 않고 턴다', () => {
    const a = hubWithClock();
    a.hub.grantWriter('s1', W1, 7);
    a.hub.input('s1', W1, 'YQ==');
    a.hub.grantWriter('s1', null);
    expect(a.reports).toEqual([{ runnerId: 'r1', sessionId: 's1', gen: 7, bytes: 1 }]);

    const b = hubWithClock();
    b.hub.grantWriter('s1', W1, 9);
    b.hub.input('s1', W1, 'YQ==');
    b.hub.onRunnerFrame('r1', { type: 'session.ended', sessionId: 's1' });
    expect(b.reports).toEqual([{ runnerId: 'r1', sessionId: 's1', gen: 9, bytes: 1 }]);
  });

  it('거절된 입력은 보고하지 않는다', () => {
    const { hub, reports, tick } = hubWithClock();
    hub.input('s1', W1, 'YQ==');
    tick();
    expect(reports).toEqual([]);
  });
});

describe('커뮤니티가 서버의 로컬 직결 키를 받는다', () => {
  function setup(agents: Record<string, object>) {
    const sent: string[] = [];
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const hub = createLocalTerminalHub({ sendToRunner: () => true, log: () => {} });
    const logs: string[] = [];
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents, reconciler, dial, schedule: () => {}, log: (l) => logs.push(l),
      runnerLink: { send: () => true, isLinked: () => true },
      localTerminal: { hub, agentOf: (runnerId) => (runnerId === 'r1' ? 'a-1' : runnerId === 'r2' ? 'a-2' : null) },
    });
    c.start();
    const fromServer = (f: ServerToOperatorFrame) => handlers!.onMessage(JSON.stringify(f));
    const events: string[] = [];
    const sub: LocalTerminalSubscriber = { send: (e) => events.push(e) };
    return { c, hub, sent, fromServer, sub, logs };
  }

  it('러너 announce 에 local-terminal 을 덧붙여 올린다', () => {
    const { c, sent } = setup({ 'a-1': {} });
    c.onRunnerFrame('r1', { type: 'announce', sessions: [], caps: ['input'] });
    const ann = sent.map((d) => JSON.parse(d)).find((f) => f.type === 'runner.announce');
    expect(ann.caps).toEqual(['input', 'local-terminal']);
  });

  it('이 커뮤니티의 이 러너 세션이면 열람·writer 키를 허브에 넣는다', () => {
    const { hub, fromServer, sub } = setup({ 'a-1': {} });
    hub.onRunnerFrame('r1', { type: 'announce', sessions: [view('s1')] });
    fromServer({ type: 'local.view', runnerId: 'r1', sessionId: 's1', viewKey: VIEW, granted: true });
    fromServer({ type: 'local.writer', runnerId: 'r1', sessionId: 's1', writerKey: W1, gen: 1 });
    expect(hub.subscribe(sub, 's1', VIEW)).toBeNull();
    expect(hub.input('s1', W1, 'YQ==')).toBeNull();
    fromServer({ type: 'local.writer', runnerId: 'r1', sessionId: 's1', writerKey: null, gen: 1 });
    expect(hub.input('s1', W1, 'YQ==')).toBe('not-writer');
  });

  it('다른 커뮤니티의 에이전트 세션·다른 러너를 사칭한 키는 버린다 — 한 서버가 남의 세션을 못 연다', () => {
    const { hub, fromServer, sub, logs } = setup({ 'a-1': {} });
    hub.onRunnerFrame('r2', { type: 'announce', sessions: [view('s2')] });
    hub.onRunnerFrame('r1', { type: 'announce', sessions: [view('s1')] });
    // s2 는 a-2(다른 커뮤니티)의 러너 것이다.
    fromServer({ type: 'local.view', runnerId: 'r2', sessionId: 's2', viewKey: VIEW, granted: true });
    // s1 은 r1 의 것인데 r2 라고 우긴다.
    fromServer({ type: 'local.writer', runnerId: 'r2', sessionId: 's1', writerKey: W1, gen: 1 });
    expect(hub.subscribe(sub, 's2', VIEW)).toBe('not-viewer');
    expect(hub.input('s1', W1, 'YQ==')).toBe('not-writer');
    expect(logs.filter((l) => l.includes('로컬 직결 키를 버린다'))).toHaveLength(2);
  });

  it('허브가 없는 오퍼레이터는 announce 를 그대로 올리고 키 프레임을 러너로 흘리지 않는다', () => {
    const sent: string[] = [];
    const toRunner: unknown[] = [];
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents: { 'a-1': {} }, reconciler, dial, schedule: () => {}, log: () => {},
      runnerLink: { send: (_r, f) => { toRunner.push(f); return true; }, isLinked: () => true },
    });
    c.start();
    c.onRunnerFrame('r1', { type: 'announce', sessions: [], caps: ['input'] });
    expect(sent.map((d) => JSON.parse(d)).find((f) => f.type === 'runner.announce').caps).toEqual(['input']);
    handlers!.onMessage(JSON.stringify({ type: 'local.writer', runnerId: 'r1', sessionId: 's1', writerKey: W1, gen: 1 }));
    expect(toRunner).toEqual([]);
  });
});
