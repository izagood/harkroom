// 릴레이 다중화기(스펙 2026-09-20 §5 PTY 행). 러너 프레임에 runnerId 를 붙여 서버로, 서버
// 프레임의 runnerId 로 러너를 골라 내려보낸다. **해석하지 않는다** — 스펙 §8 근거 ②(어휘):
// 오퍼레이터가 세션 프레임을 읽기 시작하면 "누가 불렸나"의 진실이 두 곳에 산다.
import { describe, it, expect } from 'vitest';
import type { RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';
import type { OperatorToServerFrame, ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import { createRelayMux } from '../src/relayMux.js';

function fakeLink() {
  const sent: { runnerId: string; frame: RelayServerFrame }[] = [];
  const linked = new Set<string>();
  return {
    sent, linked,
    send: (runnerId: string, frame: RelayServerFrame) => { if (!linked.has(runnerId)) return false; sent.push({ runnerId, frame }); return true; },
    isLinked: (runnerId: string) => linked.has(runnerId),
  };
}

describe('relayMux', () => {
  it('러너 프레임에 runnerId 를 붙여 서버로 보낸다', () => {
    const out: OperatorToServerFrame[] = [];
    const link = fakeLink();
    const mux = createRelayMux({ link, send: (f) => { out.push(f); return true; }, log: () => {} });
    const frame: RelayRunnerFrame = { type: 'output', sessionId: 's1', data: '7ZU=' };
    mux.onRunnerFrame('r-1', frame);
    expect(out).toEqual([{ type: 'pty.output', runnerId: 'r-1', sessionId: 's1', bytes: '7ZU=' }]);
  });

  it('서버 프레임은 runnerId 의 러너에게 풀어서 내려보낸다 — 배정 프레임은 러너에게 가지 않는다', () => {
    const link = fakeLink(); link.linked.add('r-1');
    const mux = createRelayMux({ link, send: () => true, log: () => {} });
    const input: ServerToOperatorFrame = { type: 'pty.input', runnerId: 'r-1', sessionId: 's1', bytes: 'AA==' };
    expect(mux.onServerFrame(input)).toBe(true);
    expect(link.sent).toEqual([{ runnerId: 'r-1', frame: { type: 'input', sessionId: 's1', data: 'AA==' } }]);
    expect(mux.onServerFrame({ type: 'unassign', agentId: 'a', drain: true })).toBe(false);
  });

  it('붙어 있지 않은 러너에게 온 프레임은 버리고 false 다 — 큐에 담지 않는다', () => {
    const link = fakeLink();
    const mux = createRelayMux({ link, send: () => true, log: () => {} });
    expect(mux.onServerFrame({ type: 'pty.input', runnerId: 'r-9', sessionId: 's1', bytes: 'AA==' })).toBe(false);
    expect(link.sent).toEqual([]);
  });

  it('마지막 announce 를 러너마다 기억해 서버 재접속 때 다시 낸다 — 세션이 서버에서 영구히 사라지지 않게', () => {
    const out: OperatorToServerFrame[] = [];
    const link = fakeLink();
    const mux = createRelayMux({ link, send: (f) => { out.push(f); return true; }, log: () => {} });
    const session = { sessionId: 's1', agentAccountId: 'a', channelId: 'c', threadRootId: null, harness: 'claude-code' as const, startedAt: 't', acceptsInput: true };
    mux.onRunnerFrame('r-1', { type: 'announce', sessions: [session], caps: ['input'] });
    mux.onRunnerFrame('r-1', { type: 'session.started', session: { ...session, sessionId: 's2' } });
    mux.onRunnerFrame('r-1', { type: 'session.ended', sessionId: 's1' });
    out.length = 0;
    link.linked.add('r-1');
    mux.resync();
    // 세션 목록은 러너가 진실의 원천이다 — 여기서는 announce 이후의 started/ended 를 따라간
    // 목록을 낸다(러너에게 다시 물을 왕복이 없다).
    expect(out).toEqual([{ type: 'runner.announce', runnerId: 'r-1', sessions: [{ ...session, sessionId: 's2' }], caps: ['input'] }]);
  });

  it('러너 링크가 끊긴 러너는 resync 에 싣지 않는다', () => {
    const out: OperatorToServerFrame[] = [];
    const link = fakeLink();
    const mux = createRelayMux({ link, send: (f) => { out.push(f); return true; }, log: () => {} });
    mux.onRunnerFrame('r-1', { type: 'announce', sessions: [], caps: [] });
    out.length = 0;
    mux.resync();
    expect(out).toEqual([]);
  });
});
