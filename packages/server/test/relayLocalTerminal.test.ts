// R1 PR-5(스레드 8d233406): 서버가 같은 머신 터미널 직결의 **열람 키·writer 키**를 내리고 거둔다.
// #1298 security F1·F2 — 오퍼레이터 소켓 토큰은 같은 uid 의 에이전트도 읽으므로, 서버가 만든 맞힐 수 없는
// 키만 허가가 된다. 이 시험은 키가 **그 뷰어와 오퍼레이터에만** 가는지, 회수가 강등 통지보다 먼저인지,
// 오퍼레이터가 모르면 지금 경로가 그대로인지를 허브 단위로 고정한다(소켓·DB 없이).
import { describe, it, expect } from 'vitest';
import type { AttachServerFrame, RelayServerFrame } from '@harkroom/shared';
import { createRelayHub, type RelaySocket } from '../src/ws/relay.js';

const S = 's1';

function setup(caps: string[] = ['input', 'interactive', 'local-terminal']) {
  const hub = createRelayHub();
  const toRunner: RelayServerFrame[] = [];
  const order: string[] = [];
  let runnerUp = true;
  const runnerSocket: RelaySocket = {
    send: (d) => {
      if (!runnerUp) throw new Error('closed');
      const f = JSON.parse(d) as RelayServerFrame; toRunner.push(f);
      order.push(f.type === 'local.writer' ? `runner:local.writer:${f.writerKey === null ? 'revoke' : 'grant'}` : `runner:${f.type}`);
    },
    close: () => {},
  };
  hub.addRunner('agent-1', runnerSocket);
  const announce = () => hub.onRunnerMessage('agent-1', JSON.stringify({
    type: 'announce', caps,
    sessions: [{ sessionId: S, agentAccountId: 'agent-1', channelId: 'c1', threadRootId: null, harness: 'claude-code', startedAt: '2026-10-10T00:00:00.000Z', acceptsInput: true }],
  }));
  announce();
  const viewer = (control: boolean, name = 'v') => {
    const got: AttachServerFrame[] = [];
    const handle = hub.addViewer(S, {
      send: (d) => {
        const f = JSON.parse(d) as AttachServerFrame; got.push(f);
        order.push(f.type === 'writer' ? `${name}:writer:${String(f.writer)}` : `${name}:${f.type}`);
      },
      close: () => {},
    }, { control });
    const lastWriter = () => got.filter((f) => f.type === 'writer').at(-1) as Extract<AttachServerFrame, { type: 'writer' }> | undefined;
    const viewKey = () => (got.find((f) => f.type === 'local') as { viewKey: string } | undefined)?.viewKey;
    return { got, handle, lastWriter, viewKey };
  };
  const frames = <T extends RelayServerFrame['type']>(t: T) => toRunner.filter((f) => f.type === t) as Extract<RelayServerFrame, { type: T }>[];
  return { hub, toRunner, order, viewer, frames, announce, downRunner: () => { runnerUp = false; } };
}

describe('R1 PR-5 — 로컬 직결 키', () => {
  it('보통 attach 는 지금과 같다 — 키가 없고, 재생을 받는다', () => {
    const { viewer, frames } = setup();
    const v = viewer(false);
    expect(v.viewKey()).toBeUndefined();
    expect(v.lastWriter()?.writerKey).toBeUndefined();
    expect(frames('local.view')).toHaveLength(0);
    expect(frames('local.writer')).toHaveLength(0);
    expect(frames('replay.request')).toHaveLength(1);
  });

  it('오퍼레이터가 local-terminal 을 모르면 제어 요청도 보통 attach 로 되돌린다', () => {
    const { viewer, frames } = setup(['input', 'interactive']);
    const v = viewer(true);
    expect(v.viewKey()).toBeUndefined();
    expect(v.lastWriter()?.writerKey).toBeUndefined();
    expect(frames('replay.request')).toHaveLength(1);
  });

  it('제어 attach 는 같은 열람·writer 키를 그 뷰어와 오퍼레이터에 준다 — 키는 맞힐 수 없는 길이다', () => {
    const { viewer, frames } = setup();
    const v = viewer(true);
    const view = frames('local.view');
    const writer = frames('local.writer');
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ sessionId: S, granted: true });
    expect(v.viewKey()).toBe(view[0]!.viewKey);
    expect(v.lastWriter()?.writerKey).toBe(writer[0]!.writerKey);
    expect(view[0]!.viewKey.length).toBeGreaterThanOrEqual(22);
    expect(writer[0]!.writerKey!.length).toBeGreaterThanOrEqual(22);
    expect(view[0]!.viewKey).not.toBe(writer[0]!.writerKey);
    // 제어 뷰어는 재생을 오퍼레이터 소켓에서 받는다.
    expect(frames('replay.request')).toHaveLength(0);
  });

  it('제어 뷰어에는 출력을 보내지 않는다(두 번 그리지 않게)', () => {
    const { hub, viewer } = setup();
    const v = viewer(true);
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'output', sessionId: S, data: 'YQ==' }));
    expect(v.got.filter((f) => f.type === 'output')).toHaveLength(0);
  });

  it('차례가 넘어가면 옛 writer 키 회수가 강등 통지보다 먼저 가고, 새 writer 는 새 키를 받는다 — 키는 다른 창에 안 간다', () => {
    const { viewer, frames, order } = setup();
    const a = viewer(true, 'A');
    const keyA = a.lastWriter()!.writerKey!;
    const b = viewer(true, 'B');
    const writers = frames('local.writer');
    expect(writers.map((w) => w.writerKey === null)).toEqual([false, true, false]);
    // 회수가 강등 통지보다 늦으면 그 사이 옛 창의 바이트가 오퍼레이터에서 받아들여진다.
    const revokeAt = order.indexOf('runner:local.writer:revoke');
    const demoteAt = order.indexOf('A:writer:false');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(demoteAt).toBeGreaterThan(revokeAt);
    const keyB = b.lastWriter()!.writerKey!;
    expect(keyB).not.toBe(keyA);
    expect(a.lastWriter()?.writer).toBe(false);
    expect(a.lastWriter()?.writerKey).toBeUndefined();
    // A 는 B 의 키를 한 번도 받지 않았다.
    expect(JSON.stringify(a.got)).not.toContain(keyB);
    expect(JSON.stringify(b.got)).not.toContain(a.viewKey()!);
  });

  it('창이 떠나면 writer 키와 열람 키를 둘 다 거둔다', () => {
    const { viewer, frames } = setup();
    const v = viewer(true);
    const viewKey = v.viewKey()!;
    v.handle.close();
    expect(frames('local.writer').at(-1)).toMatchObject({ writerKey: null });
    expect(frames('local.view').at(-1)).toEqual({ type: 'local.view', sessionId: S, viewKey, granted: false });
  });

  it('오퍼레이터에 못 보냈으면 키를 창에 주지 않고 보통 attach 로 되돌린다', () => {
    const { viewer, downRunner } = setup();
    downRunner();
    const v = viewer(true);
    expect(v.viewKey()).toBeUndefined();
    expect(v.lastWriter()?.writerKey).toBeUndefined();
  });

  it('러너가 다시 announce 하면 서 있는 열람·writer 키를 다시 알린다', () => {
    const { viewer, frames, announce } = setup();
    const v = viewer(true);
    announce();
    expect(frames('local.view').filter((f) => f.granted && f.viewKey === v.viewKey())).toHaveLength(2);
    expect(frames('local.writer').filter((f) => f.writerKey === v.lastWriter()!.writerKey)).toHaveLength(2);
  });

  it('local.input 은 그 번호의 키를 받은 뷰어에게만 더하고, 남의 러너가 보낸 것은 버린다', () => {
    const { hub, viewer, frames } = setup();
    const a = viewer(true);
    const genA = frames('local.writer')[0]!.gen;
    viewer(true);
    // 강등 뒤에 도착한 A 의 바이트도 A 가 친 것이다.
    hub.onRunnerFrame('agent-1', { type: 'local.input', sessionId: S, gen: genA, bytes: 5 });
    hub.onRunnerFrame('agent-1', { type: 'local.input', sessionId: S, gen: 9999, bytes: 7 });
    hub.onRunnerFrame('agent-2', { type: 'local.input', sessionId: S, gen: genA, bytes: 100 });
    hub.onRunnerFrame('agent-1', { type: 'local.input', sessionId: S, gen: genA, bytes: -1 });
    expect(a.handle.inputBytes()).toBe(5);
  });
});
