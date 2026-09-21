// 서버 링크 — 스펙 2026-09-20 §4. 러너의 relay.ts 가 하던 dial·backoff 를 오퍼레이터가
// 맡되, 한 가지가 더 있다: **서버 ping 부재로 서버 죽음을 판정한다.** 이 채널은 신규라
// heartbeat 없는 구 서버가 존재하지 않는다 — 그래서 러너 쪽에서 막혔던 호환 문제가 없다.
//
// dialer·시계·타이머를 주입해 실제 소켓 없이 잰다. 실제 소켓은 서버 쪽 operatorChannel.test 가 탄다.
import { describe, it, expect } from 'vitest';
import { createServerLink, operatorUrl, type LinkDialer, type LinkTransport } from '../src/serverLink.js';

const HELLO = () => ({
  type: 'hello' as const, protocol: 1 as const,
  capabilities: { agentIds: ['a'], harnesses: {} }, runners: [], sessions: [],
});

describe('operatorUrl', () => {
  it('http(s) → ws(s) + /operator, 끝 슬래시는 없앤다', () => {
    expect(operatorUrl('https://example.com/')).toBe('wss://example.com/operator');
    expect(operatorUrl('http://localhost:3400')).toBe('ws://localhost:3400/operator');
  });
});

describe('serverLink', () => {
  it('열리면 hello 를 먼저 보낸다', () => {
    const sent: string[] = [];
    const dial: LinkDialer = (_url, _token, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const link = createServerLink({ baseUrl: 'http://s', token: 't', dial, hello: HELLO, onFrame: () => {} });
    link.start();
    expect(JSON.parse(sent[0]!).type).toBe('hello');
    expect(link.connected()).toBe(true);
  });

  it('서버 프레임을 파싱해 넘기고, 모르는 것은 버린다', () => {
    const got: string[] = [];
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: () => {}, close: () => {} }); };
    const link = createServerLink({ baseUrl: 'http://s', token: 't', dial, hello: HELLO, onFrame: (f) => got.push(f.type) });
    link.start();
    handlers!.onMessage(JSON.stringify({ type: 'assign', agentId: 'a', definition: {} }));
    handlers!.onMessage(JSON.stringify({ type: 'nope' }));
    handlers!.onMessage('{broken');
    expect(got).toEqual(['assign']);
  });

  it('끊기면 백오프로 다시 건다 — 곡선은 하나다', () => {
    const scheduled: number[] = [];
    let dials = 0;
    const dial: LinkDialer = (_u, _t, h) => { dials += 1; h.onClose('refused'); };
    const link = createServerLink({
      baseUrl: 'http://s', token: 't', dial, hello: HELLO, onFrame: () => {}, initialBackoffMs: 100,
      schedule: (fn, ms) => { scheduled.push(ms); if (scheduled.length < 4) fn(); },
    });
    link.start();
    expect(dials).toBe(4);
    expect(scheduled).toEqual([100, 200, 400, 800]);
  });

  it('ping 이 silenceMs 동안 없으면 스스로 끊고 재접속을 예약한다', () => {
    let now = 0; let closed = 0; const scheduled: number[] = [];
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const transport: LinkTransport = { send: () => {}, close: () => { closed += 1; handlers!.onClose('silence'); } };
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen(transport); };
    const link = createServerLink({
      baseUrl: 'http://s', token: 't', dial, hello: HELLO, onFrame: () => {},
      now: () => now, silenceMs: 1000, initialBackoffMs: 5000,
      // 감시 tick 은 직접 부른다(tick). 재접속 예약만 기록한다.
      schedule: (_fn, ms) => { scheduled.push(ms); },
    });
    link.start();
    now = 500; handlers!.onPing?.();
    now = 1400; link.tick(); expect(closed).toBe(0);   // 마지막 ping 으로부터 900ms — 아직 산다
    now = 1600; link.tick(); expect(closed).toBe(1);   // 1100ms — 죽은 것으로 본다
    expect(link.connected()).toBe(false);
    expect(scheduled).toContain(5000);                  // 재접속 backoff 가 예약됐다
  });

  it('stop 뒤에는 다시 걸지 않는다', () => {
    let dials = 0;
    const dial: LinkDialer = (_u, _t, h) => { dials += 1; h.onOpen({ send: () => {}, close: () => h.onClose('bye') }); };
    const link = createServerLink({
      baseUrl: 'http://s', token: 't', dial, hello: HELLO, onFrame: () => {},
      // 재접속 예약(100ms)만 즉시 실행한다. 침묵 감시 tick(1000ms)까지 동기로 돌리면 재귀다.
      initialBackoffMs: 100, silenceMs: 3000,
      schedule: (fn, ms) => { if (ms < 1000) fn(); },
    });
    link.start();
    link.stop();
    expect(dials).toBe(1);
    expect(link.send(HELLO())).toBe(false);
  });
});
