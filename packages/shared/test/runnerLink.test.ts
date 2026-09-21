// 러너 ↔ 오퍼레이터 링크(스펙 2026-09-20 §5 PTY 행)의 **말**. 러너는 옛 릴레이 프레임
// (`RelayRunnerFrame`/`RelayServerFrame`)을 그대로 쓰고, 오퍼레이터가 `runnerId` 를 붙여
// 서버 채널에 싣는다 — 러너는 서버를 모르고(§5), 다중화는 오퍼레이터의 일이다. 여기서 재는
// 것은 그 감싸기·풀기가 **정보를 잃지 않고 왕복하는가**와, 첫 줄 hello 의 모양이다.
import { describe, it, expect } from 'vitest';
import type { RelayRunnerFrame, RelayServerFrame } from '../src/index.js';
import {
  checkRunnerHello, unwrapOperatorFrame, unwrapServerFrame, wrapRunnerFrame, wrapServerFrame,
  RUNNER_LINK_PROTOCOL_VERSION,
} from '../src/runnerLink.js';

const session = {
  sessionId: 's1', agentAccountId: 'a1', channelId: 'c1', threadRootId: null, harness: 'claude-code' as const,
  startedAt: '2026-09-21T00:00:00Z', acceptsInput: true,
};

describe('runnerLink — hello', () => {
  it('runner 역할·runnerId·secret 이 있어야 hello 다', () => {
    expect(checkRunnerHello({ type: 'hello', version: RUNNER_LINK_PROTOCOL_VERSION, role: 'runner', runnerId: 'r', secret: 's' }))
      .toEqual({ runnerId: 'r', secret: 's' });
    expect(checkRunnerHello({ type: 'hello', version: 1, role: 'app', token: 't' })).toBeNull();
    expect(checkRunnerHello({ type: 'hello', version: 99, role: 'runner', runnerId: 'r', secret: 's' })).toBeNull();
    expect(checkRunnerHello({ type: 'hello', version: 1, role: 'runner', runnerId: 'r' })).toBeNull();
  });
});

describe('runnerLink — 러너 프레임을 서버 채널 프레임으로', () => {
  const cases: RelayRunnerFrame[] = [
    { type: 'announce', sessions: [session], caps: ['input', 'cancel'] },
    { type: 'session.started', session },
    { type: 'session.ended', sessionId: 's1' },
    { type: 'output', sessionId: 's1', data: 'AAEC' },
    { type: 'replay', sessionId: 's1', data: '' },
    { type: 'interactive.opened', requestId: 'q', sessionId: 's1', created: true },
    { type: 'interactive.error', requestId: 'q', message: '거절' },
    { type: 'attention.required', sessionId: 's1', accountLabel: 'work', screen: 'AA==' },
  ];
  it.each(cases)('$type 이 runnerId 를 달고 갔다가 그대로 돌아온다', (frame) => {
    const wrapped = wrapRunnerFrame('r-1', frame);
    expect(wrapped).not.toBeNull();
    expect((wrapped as { runnerId: string }).runnerId).toBe('r-1');
    expect(unwrapOperatorFrame(wrapped!)).toEqual({ runnerId: 'r-1', frame });
  });
  it('bytes 는 base64 문자열 그대로다 — 서버는 열지 않는다', () => {
    const wrapped = wrapRunnerFrame('r', { type: 'output', sessionId: 's', data: '7ZU=' });
    expect(wrapped).toMatchObject({ type: 'pty.output', bytes: '7ZU=' });
  });
  it('hello·runner.started 같은 오퍼레이터 자신의 말은 러너 프레임이 아니다', () => {
    expect(unwrapOperatorFrame({ type: 'runner.started', agentId: 'a', runnerId: 'r' })).toBeNull();
  });
});

describe('runnerLink — 서버 채널 프레임을 러너 프레임으로', () => {
  const cases: RelayServerFrame[] = [
    { type: 'replay.request', sessionId: 's1' },
    { type: 'input', sessionId: 's1', data: 'AA==' },
    { type: 'session.cancel', sessionId: 's1', byHandle: 'jaebin' },
    { type: 'resize', sessionId: 's1', cols: 80, rows: 24 },
    { type: 'viewer.count', sessionId: 's1', count: 2 },
    { type: 'interactive.open', requestId: 'q', channelId: 'c1', threadRootId: 'm1', openedByHandle: 'jaebin', cols: 80, rows: 24 },
  ];
  it.each(cases)('$type 이 왕복한다', (frame) => {
    const wrapped = wrapServerFrame('r-1', frame);
    expect((wrapped as { runnerId: string }).runnerId).toBe('r-1');
    expect(unwrapServerFrame(wrapped)).toEqual(frame);
  });
  it('assign·unassign·runner.kill 은 러너에게 가는 말이 아니다', () => {
    expect(unwrapServerFrame({ type: 'unassign', agentId: 'a', drain: true })).toBeNull();
    expect(unwrapServerFrame({ type: 'runner.kill', runnerId: 'r' })).toBeNull();
  });
});
