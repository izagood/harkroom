// 같은 머신의 터미널 직결 허브(R1 PR-3, 스레드 8d233406). 서버가 writer 를 정한다는 설계(#346)를
// 이 경로가 넓히지 않는지를 고정한다 — 허가 없는 입력·옛 세대 입력·남의 머신 세션은 거절이다.
import { describe, expect, it } from 'vitest';
import type { AgentSessionView, RelayServerFrame } from '@harkroom/shared';
import { createLocalTerminalHub, type LocalTerminalSubscriber } from '../src/localTerminal.js';

const view = (sessionId: string): AgentSessionView => ({ sessionId } as unknown as AgentSessionView);

function setup() {
  const toRunner: { runnerId: string; frame: RelayServerFrame }[] = [];
  let linked = true;
  const hub = createLocalTerminalHub({
    sendToRunner: (runnerId, frame) => { if (!linked) return false; toRunner.push({ runnerId, frame }); return true; },
    log: () => {},
  });
  const events: { event: string; payload: unknown }[] = [];
  const sub: LocalTerminalSubscriber = { send: (event, payload) => events.push({ event, payload }) };
  hub.onRunnerFrame('r1', { type: 'announce', sessions: [view('s1')] });
  return { hub, toRunner, events, sub, unlink: () => { linked = false; } };
}

describe('localTerminal hub', () => {
  it('이 머신의 러너가 가진 세션만 로컬이다', () => {
    const { hub, sub } = setup();
    expect(hub.sessions().map((s) => s.sessionId)).toEqual(['s1']);
    expect(hub.subscribe(sub, 'other')).toBe('no-such-session');
  });

  it('구독하면 재생을 청하고, 재생 → 그동안 쌓인 라이브 순서로 준다', () => {
    const { hub, toRunner, events, sub } = setup();
    expect(hub.subscribe(sub, 's1')).toBeNull();
    expect(toRunner).toEqual([{ runnerId: 'r1', frame: { type: 'replay.request', sessionId: 's1' } }]);
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'TElWRQ==' });
    expect(events).toEqual([]);
    hub.onRunnerFrame('r1', { type: 'replay', sessionId: 's1', data: 'UkVQTEFZ' });
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'TkVYVA==' });
    expect(events.map((e) => (e.payload as { data: string }).data)).toEqual(['UkVQTEFZ', 'TElWRQ==', 'TkVYVA==']);
  });

  it('서버 허가 전에는 입력·크기를 거절한다(fail-closed)', () => {
    const { hub, toRunner } = setup();
    expect(hub.input('s1', 1, 'YQ==')).toBe('not-writer');
    expect(hub.resize('s1', 1, 80, 24)).toBe('not-writer');
    expect(toRunner).toEqual([]);
  });

  it('허가한 세대로만 받는다 — 다른 창이 writer 를 가져간 뒤의 옛 세대는 거절한다', () => {
    const { hub, toRunner } = setup();
    hub.grantWriter('s1', 7);
    expect(hub.input('s1', 7, 'YQ==')).toBeNull();
    hub.grantWriter('s1', 8);
    expect(hub.input('s1', 7, 'Yg==')).toBe('not-writer');
    hub.grantWriter('s1', null);
    expect(hub.input('s1', 8, 'Yw==')).toBe('not-writer');
    expect(toRunner).toEqual([{ runnerId: 'r1', frame: { type: 'input', sessionId: 's1', data: 'YQ==' } }]);
  });

  it('감사는 내용이 아니라 바이트 수만 센다', () => {
    const { hub } = setup();
    hub.grantWriter('s1', 1);
    hub.input('s1', 1, 'YWJj'); // 3바이트
    hub.input('s1', 1, 'YQ=='); // 1바이트
    expect(hub.takeInputBytes('s1')).toBe(4);
    expect(hub.takeInputBytes('s1')).toBe(0);
  });

  it('크기는 서버 허브와 같은 범위만 받는다', () => {
    const { hub } = setup();
    hub.grantWriter('s1', 1);
    expect(hub.resize('s1', 1, 0, 24)).toBe('bad-size');
    expect(hub.resize('s1', 1, 80, 1001)).toBe('bad-size');
    expect(hub.resize('s1', 1, 80.5, 24)).toBe('bad-size');
    expect(hub.resize('s1', 1, 120, 40)).toBeNull();
  });

  it('세션이 끝나거나 러너가 죽으면 구독자에게 끝을 알리고 허가도 잊는다', () => {
    const { hub, events, sub } = setup();
    hub.subscribe(sub, 's1');
    hub.grantWriter('s1', 1);
    hub.forgetRunner('r1');
    expect(events).toContainEqual({ event: 'terminalEnded', payload: { sessionId: 's1' } });
    hub.onRunnerFrame('r1', { type: 'session.started', session: view('s1') });
    expect(hub.input('s1', 1, 'YQ==')).toBe('not-writer');
  });

  it('러너 링크가 없으면 구독도 입력도 runner-gone 이다', () => {
    const { hub, sub, unlink } = setup();
    hub.grantWriter('s1', 1);
    unlink();
    expect(hub.subscribe(sub, 's1')).toBe('runner-gone');
    expect(hub.input('s1', 1, 'YQ==')).toBe('runner-gone');
    expect(hub.takeInputBytes('s1')).toBe(0);
  });

  it('끊긴 구독자에게는 더 흘리지 않는다', () => {
    const { hub, events, sub } = setup();
    hub.subscribe(sub, 's1');
    hub.onRunnerFrame('r1', { type: 'replay', sessionId: 's1', data: '' });
    hub.drop(sub);
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'YQ==' });
    expect(events).toHaveLength(1);
  });
});
