// 터미널 폭 불일치 — 폭을 못 정하는 창도 PTY 크기를 안다. 서버 쪽 회귀선.
//
// 증상: 넓은 입력 창과 좁은 읽기 전용 창이 같은 claude TUI 를 보면, 읽기 전용 창이 자기
// 패널 폭으로 접어 줄이 중간에 꺾이고 상태 줄에 두 글이 섞였다. PTY 는 폭의 주인의 폭으로
// 그리므로, 그 크기를 붙은 모든 창이 받아야 한다(`AttachServerFrame` 의 `size`).
//
// 허브를 직접 세운다 — 이 사실은 소켓 너머가 아니라 허브의 상태(창 목록·지금 크기)에 산다.
import { describe, it, expect } from 'vitest';
import type { AttachServerFrame } from '@harkroom/shared';
import { createRelayHub, type RelaySocket } from '../src/ws/relay.js';

function setup() {
  const hub = createRelayHub();
  const runnerSocket: RelaySocket = { send: () => {}, close: () => {} };
  hub.addRunner('agent-1', runnerSocket);
  hub.onRunnerMessage('agent-1', JSON.stringify({
    type: 'announce',
    caps: ['input', 'interactive'],
    sessions: [{
      sessionId: 's1', agentAccountId: 'agent-1', channelId: 'c1', threadRootId: null,
      harness: 'claude-code', startedAt: '2026-10-12T00:00:00.000Z', acceptsInput: true,
    }],
  }));
  const open = () => {
    const frames: AttachServerFrame[] = [];
    const handle = hub.addViewer('s1', { send: (d) => frames.push(JSON.parse(d) as AttachServerFrame), close: () => {} });
    const sizes = () => frames.filter((f) => f.type === 'size').map((f) => f as { cols: number; rows: number }).map(({ cols, rows }) => ({ cols, rows }));
    return { handle, frames, sizes };
  };
  return { hub, open };
}

const resize = (cols: number, rows: number) => JSON.stringify({ type: 'resize', cols, rows });

describe('PTY 크기를 붙은 모든 창에 알린다', () => {
  it('폭의 주인이 크기를 바꾸면 읽기 전용 창도 같은 값을 받는다', () => {
    const { open } = setup();
    const reader = open();
    const owner = open(); // 마지막 attach 가 폭의 주인이다
    expect(reader.sizes()).toEqual([]); // 아직 아무도 크기를 안 보냈다 — 지어내지 않는다

    expect(owner.handle.handleMessage(resize(180, 50))).toBe(true);
    expect(reader.sizes()).toEqual([{ cols: 180, rows: 50 }]);
    expect(owner.sizes()).toEqual([{ cols: 180, rows: 50 }]);
  });

  it('읽기 전용 창의 resize 는 크기를 바꾸지 않고 알리지도 않는다', () => {
    const { open } = setup();
    const reader = open();
    const owner = open();
    owner.handle.handleMessage(resize(180, 50));
    expect(reader.handle.handleMessage(resize(80, 24))).toBe(false);
    expect(reader.sizes()).toEqual([{ cols: 180, rows: 50 }]);
    expect(owner.sizes()).toEqual([{ cols: 180, rows: 50 }]);
  });

  it('나중에 붙는 창은 attach 때 지금 크기를 받는다', () => {
    const { open } = setup();
    const owner = open();
    owner.handle.handleMessage(resize(150, 40));
    const late = open();
    expect(late.sizes()).toEqual([{ cols: 150, rows: 40 }]);
    // 크기 통지는 writer 통지 뒤에 온다 — 창은 차례를 먼저 알고 크기를 적용한다.
    const kinds = late.frames.map((f) => f.type);
    expect(kinds.indexOf('size')).toBeGreaterThan(kinds.indexOf('writer'));
  });

  it('같은 크기가 반복되면(드래그 중 같은 칸 수) 다시 알리지 않는다', () => {
    const { open } = setup();
    const reader = open();
    const owner = open();
    owner.handle.handleMessage(resize(120, 40));
    owner.handle.handleMessage(resize(120, 40));
    owner.handle.handleMessage(resize(121, 40));
    expect(reader.sizes()).toEqual([{ cols: 120, rows: 40 }, { cols: 121, rows: 40 }]);
  });

  it('틀린 크기는 PTY 에도 창에도 가지 않는다', () => {
    const { open } = setup();
    const reader = open();
    const owner = open();
    expect(owner.handle.handleMessage(resize(0, 40))).toBe(false);
    expect(reader.sizes()).toEqual([]);
  });

  it('모든 창이 떠난 뒤 세션이 끝나면 크기를 잊는다 — 새 세션이 남의 크기를 물려받지 않는다', () => {
    const { hub, open } = setup();
    const owner = open();
    owner.handle.handleMessage(resize(150, 40));
    owner.handle.close();
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.ended', sessionId: 's1' }));
    hub.onRunnerMessage('agent-1', JSON.stringify({
      type: 'session.started',
      session: {
        sessionId: 's1', agentAccountId: 'agent-1', channelId: 'c1', threadRootId: null,
        harness: 'claude-code', startedAt: '2026-10-12T00:01:00.000Z', acceptsInput: true,
      },
    }));
    expect(open().sizes()).toEqual([]);
  });
});
