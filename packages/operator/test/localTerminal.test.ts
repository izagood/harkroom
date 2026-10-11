// 같은 머신의 터미널 직결 허브(R1 PR-3, 스레드 8d233406). 소켓 토큰은 같은 uid 의 에이전트도 읽으므로
// **허가가 아니다**(security F1·F2, #1298). 이 시험은 허브가 서버가 내린 키로만 문을 여는지를 고정한다 —
// 키 없는 구독·입력, 짧은(추측 가능한) 키, 갈아 끼운 뒤의 옛 키, 회수된 열람 키는 전부 거절이다.
import { describe, expect, it } from 'vitest';
import type { AgentSessionView, RelayServerFrame } from '@harkroom/shared';
import { createLocalTerminalHub, MAX_AWAITING_CHUNKS, type LocalTerminalSubscriber } from '../src/localTerminal.js';

const view = (sessionId: string): AgentSessionView => ({ sessionId } as unknown as AgentSessionView);
/** 서버가 만드는 것과 같은 꼴(≥128bit base64url). */
const VIEW = 'v'.repeat(32);
const VIEW2 = 'w'.repeat(32);
const W1 = 'a'.repeat(32);
const W2 = 'b'.repeat(32);

function setup() {
  const toRunner: { runnerId: string; frame: RelayServerFrame }[] = [];
  const logs: string[] = [];
  let linked = true;
  const hub = createLocalTerminalHub({
    sendToRunner: (runnerId, frame) => { if (!linked) return false; toRunner.push({ runnerId, frame }); return true; },
    log: (l) => logs.push(l),
  });
  const events: { event: string; payload: unknown }[] = [];
  const sub: LocalTerminalSubscriber = { send: (event, payload) => events.push({ event, payload }) };
  hub.onRunnerFrame('r1', { type: 'announce', sessions: [view('s1')] });
  return { hub, toRunner, events, sub, logs, unlink: () => { linked = false; } };
}

describe('localTerminal hub — 열람(F2)', () => {
  it('이 머신의 러너가 가진 세션인지만 답한다', () => {
    const { hub } = setup();
    expect(hub.isLocal('s1')).toBe(true);
    expect(hub.isLocal('other')).toBe(false);
  });

  it('서버가 열람 키를 주기 전에는 구독을 거절한다 — 토큰만으로는 남의 화면을 못 본다', () => {
    const { hub, sub, toRunner } = setup();
    expect(hub.subscribe(sub, 's1', VIEW)).toBe('not-viewer');
    expect(toRunner).toEqual([]);
  });

  it('준 열람 키로만 연다 — 다른 키·짧은 키는 거절이다', () => {
    const { hub, sub } = setup();
    hub.grantView('s1', VIEW);
    expect(hub.subscribe(sub, 's1', VIEW2)).toBe('not-viewer');
    hub.grantView('s1', 'short');
    expect(hub.subscribe(sub, 's1', 'short')).toBe('not-viewer');
    expect(hub.subscribe(sub, 'other', VIEW)).toBe('no-such-session');
    expect(hub.subscribe(sub, 's1', VIEW)).toBeNull();
  });

  it('열람 키를 거두면 그 키로 붙은 구독이 끝난다', () => {
    const { hub, sub, events } = setup();
    hub.grantView('s1', VIEW);
    hub.subscribe(sub, 's1', VIEW);
    hub.onRunnerFrame('r1', { type: 'replay', sessionId: 's1', data: '' });
    hub.revokeView('s1', VIEW);
    expect(events).toContainEqual({ event: 'terminalEnded', payload: { sessionId: 's1', reason: 'revoked' } });
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'YQ==' });
    expect(events.filter((e) => e.event === 'terminalOutput')).toHaveLength(1);
    expect(hub.subscribe(sub, 's1', VIEW)).toBe('not-viewer');
  });

  it('구독하면 재생을 청하고, 재생 → 그동안 쌓인 라이브 순서로 준다', () => {
    const { hub, toRunner, events, sub } = setup();
    hub.grantView('s1', VIEW);
    expect(hub.subscribe(sub, 's1', VIEW)).toBeNull();
    expect(toRunner).toEqual([{ runnerId: 'r1', frame: { type: 'replay.request', sessionId: 's1' } }]);
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'TElWRQ==' });
    expect(events).toEqual([]);
    hub.onRunnerFrame('r1', { type: 'replay', sessionId: 's1', data: 'UkVQTEFZ' });
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'TkVYVA==' });
    expect(events.map((e) => (e.payload as { data: string }).data)).toEqual(['UkVQTEFZ', 'TElWRQ==', 'TkVYVA==']);
  });

  it(`재생이 오지 않으면 ${MAX_AWAITING_CHUNKS}청크에서 기다리기를 그만두고 쌓인 것을 흘린다(n2)`, () => {
    const { hub, events, sub } = setup();
    hub.grantView('s1', VIEW);
    hub.subscribe(sub, 's1', VIEW);
    for (let i = 0; i <= MAX_AWAITING_CHUNKS; i += 1) hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'YQ==' });
    expect(events).toHaveLength(MAX_AWAITING_CHUNKS + 1);
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'Yg==' });
    expect(events).toHaveLength(MAX_AWAITING_CHUNKS + 2);
  });

  it('끊긴 구독자에게는 더 흘리지 않는다', () => {
    const { hub, events, sub } = setup();
    hub.grantView('s1', VIEW);
    hub.subscribe(sub, 's1', VIEW);
    hub.onRunnerFrame('r1', { type: 'replay', sessionId: 's1', data: '' });
    hub.drop(sub);
    hub.onRunnerFrame('r1', { type: 'output', sessionId: 's1', data: 'YQ==' });
    expect(events).toHaveLength(1);
  });
});

describe('localTerminal hub — 쓰기(F1)', () => {
  it('서버가 writer 키를 주기 전에는 입력·크기를 거절한다(fail-closed)', () => {
    const { hub, toRunner } = setup();
    expect(hub.input('s1', W1, 'YQ==')).toBe('not-writer');
    expect(hub.resize('s1', W1, 80, 24)).toBe('not-writer');
    expect(toRunner).toEqual([]);
  });

  it('짧은 키는 허가로 받지 않는다 — 맞힐 수 있는 번호는 허가가 아니다', () => {
    const { hub } = setup();
    hub.grantWriter('s1', '7');
    expect(hub.input('s1', '7', 'YQ==')).toBe('not-writer');
  });

  it('지금 서 있는 키로만 받는다 — 갈아 끼운 뒤의 옛 키·거둔 뒤는 거절이다', () => {
    const { hub, toRunner } = setup();
    hub.grantWriter('s1', W1);
    expect(hub.input('s1', W1, 'YQ==')).toBeNull();
    hub.grantWriter('s1', W2);
    expect(hub.input('s1', W1, 'Yg==')).toBe('not-writer');
    hub.grantWriter('s1', null);
    expect(hub.input('s1', W2, 'Yw==')).toBe('not-writer');
    expect(toRunner).toEqual([{ runnerId: 'r1', frame: { type: 'input', sessionId: 's1', data: 'YQ==' } }]);
  });

  it('열람 키는 쓰기 허가가 아니다', () => {
    const { hub } = setup();
    hub.grantView('s1', VIEW);
    expect(hub.input('s1', VIEW, 'YQ==')).toBe('not-writer');
  });

  it('감사는 내용이 아니라 바이트 수만 세고, 세션이 끝나도 보고 전까지 남긴다', () => {
    const { hub } = setup();
    hub.grantWriter('s1', W1);
    hub.input('s1', W1, 'YWJj'); // 3바이트
    hub.input('s1', W1, 'YQ=='); // 1바이트
    hub.onRunnerFrame('r1', { type: 'session.ended', sessionId: 's1' });
    expect(hub.takeInputBytes('s1')).toBe(4);
    expect(hub.takeInputBytes('s1')).toBe(0);
  });

  it('크기는 서버 허브와 같은 범위만 받는다', () => {
    const { hub } = setup();
    hub.grantWriter('s1', W1);
    expect(hub.resize('s1', W1, 0, 24)).toBe('bad-size');
    expect(hub.resize('s1', W1, 80, 1001)).toBe('bad-size');
    expect(hub.resize('s1', W1, 80.5, 24)).toBe('bad-size');
    expect(hub.resize('s1', W1, 120, 40)).toBeNull();
  });

  it('세션이 끝나거나 러너가 죽으면 구독자에게 끝을 알리고 키도 잊는다', () => {
    const { hub, events, sub } = setup();
    hub.grantView('s1', VIEW);
    hub.subscribe(sub, 's1', VIEW);
    hub.grantWriter('s1', W1);
    hub.forgetRunner('r1');
    expect(events).toContainEqual({ event: 'terminalEnded', payload: { sessionId: 's1' } });
    hub.onRunnerFrame('r1', { type: 'session.started', session: view('s1') });
    expect(hub.input('s1', W1, 'YQ==')).toBe('not-writer');
    expect(hub.subscribe(sub, 's1', VIEW)).toBe('not-viewer');
  });

  it('러너 링크가 없으면 구독도 입력도 runner-gone 이다', () => {
    const { hub, sub, unlink } = setup();
    hub.grantView('s1', VIEW);
    hub.grantWriter('s1', W1);
    unlink();
    expect(hub.subscribe(sub, 's1', VIEW)).toBe('runner-gone');
    expect(hub.input('s1', W1, 'YQ==')).toBe('runner-gone');
    expect(hub.takeInputBytes('s1')).toBe(0);
  });
});

describe('localTerminal hub — 러너끼리(n3)', () => {
  it('다른 러너가 가진 세션을 자기 것이라 해도 덮어쓰지 않고, 그 러너의 출력·종료도 받지 않는다', () => {
    const { hub, sub, events, toRunner, logs } = setup();
    hub.onRunnerFrame('r2', { type: 'session.started', session: view('s1') });
    expect(logs.some((l) => l.includes('무시'))).toBe(true);
    hub.grantView('s1', VIEW);
    hub.grantWriter('s1', W1);
    hub.subscribe(sub, 's1', VIEW);
    hub.input('s1', W1, 'YQ==');
    expect(toRunner.every((t) => t.runnerId === 'r1')).toBe(true);
    hub.onRunnerFrame('r1', { type: 'replay', sessionId: 's1', data: '' });
    hub.onRunnerFrame('r2', { type: 'output', sessionId: 's1', data: 'ZXZpbA==' });
    hub.onRunnerFrame('r2', { type: 'session.ended', sessionId: 's1' });
    expect(events.map((e) => (e.payload as { data?: string }).data)).toEqual(['']);
    expect(hub.isLocal('s1')).toBe(true);
  });
});
