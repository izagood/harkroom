import { describe, it, expect } from 'vitest';
import { createAppHeartbeat, type AppHeartbeatSocket } from '../src/ws/appHeartbeat.js';

function fakeSocket(failing = false): AppHeartbeatSocket & { sent: string[] } {
  return {
    sent: [],
    send(data) { if (failing) throw new Error('closing'); this.sent.push(data); },
  };
}

describe('app heartbeat', () => {
  it('sends an hb frame carrying the interval to every tracked socket on a tick', () => {
    const hb = createAppHeartbeat(20_000);
    const a = fakeSocket();
    const b = fakeSocket();
    hb.track(a);
    hb.track(b);

    hb.tick();

    expect(a.sent.map((x) => JSON.parse(x))).toEqual([{ type: 'hb', intervalMs: 20_000 }]);
    expect(b.sent).toHaveLength(1);
  });

  it('stops sending to an untracked (closed) socket', () => {
    const hb = createAppHeartbeat(1_000);
    const s = fakeSocket();
    hb.track(s);
    hb.untrack(s);
    hb.tick();
    expect(s.sent).toEqual([]);
    expect(hb.size()).toBe(0);
  });

  // 닫히는 중인 소켓 하나가 send 에서 던져도 나머지는 받는다.
  it('keeps beating the other sockets when one send throws', () => {
    const hb = createAppHeartbeat(1_000);
    const bad = fakeSocket(true);
    const good = fakeSocket();
    hb.track(bad);
    hb.track(good);
    expect(() => hb.tick()).not.toThrow();
    expect(good.sent).toHaveLength(1);
  });
});
