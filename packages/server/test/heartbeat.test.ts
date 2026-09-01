import { describe, it, expect, vi } from 'vitest';
import { createHeartbeat, type HeartbeatSocket } from '../src/ws/heartbeat.js';

function fakeSocket(): HeartbeatSocket & { pings: number; terminated: boolean } {
  return {
    pings: 0,
    terminated: false,
    ping() { this.pings += 1; },
    terminate() { this.terminated = true; },
  };
}

describe('heartbeat', () => {
  it('pings every tracked socket on a tick', () => {
    const hb = createHeartbeat();
    const a = fakeSocket();
    const b = fakeSocket();
    hb.track(a);
    hb.track(b);

    hb.tick();

    expect(a.pings).toBe(1);
    expect(b.pings).toBe(1);
    expect(a.terminated).toBe(false);
  });

  // 살아 있는 피어는 ping 에 pong 으로 답한다. 그 답이 다음 tick 까지 오면 계속 산다.
  it('keeps a socket that answered the previous ping', () => {
    const hb = createHeartbeat();
    const s = fakeSocket();
    hb.track(s);

    for (let i = 0; i < 5; i += 1) {
      hb.tick();
      hb.pong(s);
    }

    expect(s.terminated).toBe(false);
    expect(s.pings).toBe(5);
  });

  // 죽은 TCP 연결은 close 이벤트를 주지 않는다 — 그래서 pong 부재가 유일한 신호다.
  it('terminates a socket that never answered', () => {
    const hb = createHeartbeat();
    const s = fakeSocket();
    hb.track(s);

    hb.tick();          // ping 을 보내고 답을 기다린다
    expect(s.terminated).toBe(false);
    hb.tick();          // 여전히 답이 없다 → 끊는다

    expect(s.terminated).toBe(true);
  });

  // 한 번 놓친 뒤 다시 답하면 살려야 한다. 순간적인 지연으로 끊으면 정상 연결이 흔들린다.
  it('forgives a single missed pong when the next one arrives', () => {
    const hb = createHeartbeat();
    const s = fakeSocket();
    hb.track(s);

    hb.tick();          // ping
    hb.pong(s);         // 늦게라도 답이 왔다
    hb.tick();          // 살아 있다

    expect(s.terminated).toBe(false);
  });

  it('stops tracking a socket once it is untracked', () => {
    const hb = createHeartbeat();
    const s = fakeSocket();
    hb.track(s);
    hb.untrack(s);

    hb.tick();
    hb.tick();

    expect(s.pings).toBe(0);
    expect(s.terminated).toBe(false);
  });

  // terminate 가 던져도(이미 닫힌 소켓 등) 나머지 소켓의 판정이 멈추면 안 된다.
  it('keeps sweeping when one socket throws on terminate', () => {
    const hb = createHeartbeat();
    const bad = { ping: vi.fn(), terminate: () => { throw new Error('already destroyed'); } };
    const good = fakeSocket();
    hb.track(bad);
    hb.track(good);

    hb.tick();
    expect(() => hb.tick()).not.toThrow();

    expect(good.terminated).toBe(true);
  });
});
