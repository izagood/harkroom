import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectWs } from '../src/lib/ws';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  /** 실제 CloseEvent 는 code 를 싣는다 — 서버가 4401(자격증명)·4403(origin)로 사유를 알린다. */
  close(code?: number) { this.closed = true; this.onclose?.(code === undefined ? undefined : { code }); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

});
afterEach(() => { vi.unstubAllGlobals(); });

/** 실제 타이머로 도는 재연결을 기다린다 — 티켓 발급이 비동기라 가짜 타이머와 섞이지 않는다. */
const settle = async (ms = 0) => {
  await new Promise((r) => setTimeout(r, ms));
};

describe('connectWs', () => {
  it('connects with a freshly issued ticket and dispatches events', async () => {
    const events: unknown[] = [];
    let opens = 0;
    const handle = connectWs('http://x:3400', async () => 'murt_a&b', {
      onEvent: (e) => events.push(e),
      onOpen: () => { opens += 1; },
      onDown: () => {},
    });
    await settle();

    const ws1 = FakeWebSocket.instances[0]!;
    expect(ws1.url).toBe('ws://x:3400/ws?ticket=murt_a%26b');
    ws1.onopen?.();
    ws1.onmessage?.({ data: JSON.stringify({ type: 'lease.changed', repo: 'r1' }) });

    expect(events).toEqual([{ type: 'lease.changed', repo: 'r1' }]);
    expect(opens).toBe(1);
    handle.close();
  });

  // 티켓은 1회용이다 — 재연결 때 앞서 쓴 값을 다시 실으면 서버가 거절한다.
  it('takes a new ticket for each reconnect', async () => {
    let issued = 0;
    const handle = connectWs('http://x:3400', async () => `murt_${++issued}`, {
      onEvent: () => {}, onOpen: () => {}, onDown: () => {},
    });
    await settle();
    expect(FakeWebSocket.instances[0]!.url).toContain('ticket=murt_1');

    FakeWebSocket.instances[0]!.onclose?.();
    await settle(1100);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.url).toContain('ticket=murt_2');
    handle.close();
  });

  it('treats a failed ticket request as a dropped connection and retries', async () => {
    let attempts = 0;
    let downs = 0;
    const handle = connectWs('http://x:3400', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return 'murt_ok';
    }, { onEvent: () => {}, onOpen: () => {}, onDown: () => { downs += 1; } });
    await settle();

    expect(FakeWebSocket.instances).toHaveLength(0); // 첫 시도는 소켓조차 못 연다
    expect(downs).toBe(1);

    await settle(1100);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toContain('ticket=murt_ok');
    handle.close();
  });

  it('stops reconnecting after an explicit close', async () => {
    const handle = connectWs('http://x:3400', async () => 'murt_x', {
      onEvent: () => {}, onOpen: () => {}, onDown: () => {},
    });
    await settle();

    handle.close();
    FakeWebSocket.instances[0]!.onclose?.();
    await settle(1200);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // 명시 종료가 티켓 발급 도중에 들어오면, 돌아온 뒤 소켓을 열어선 안 된다.
  it('does not open a socket when closed while the ticket is in flight', async () => {
    let release: (() => void) | null = null;
    const handle = connectWs('http://x:3400', async () => {
      await new Promise<void>((r) => { release = r; });
      return 'murt_late';
    }, { onEvent: () => {}, onOpen: () => {}, onDown: () => {} });
    await settle();

    handle.close();
    release!();
    await settle(50);

    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

// 자격증명이 죽은 것과 네트워크가 끊긴 것은 같은 상태가 아니다 — 네트워크는 돌아오지만
// 폐기된 세션은 돌아오지 않는다. 구분하지 않으면 사용자는 빨간 점과 영구 재연결만 본다.
describe('connectWs — 자격증명 실패는 재시도로 낫지 않는다', () => {
  const settleReal = async (ms = 0) => { await new Promise((r) => setTimeout(r, ms)); };

  it('reports a credential failure and stops retrying when the ticket is rejected', async () => {
    let issued = 0;
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => {
      issued += 1;
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    }, { onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason) });

    await settleReal(1200);

    expect(downs).toEqual(['credential']);
    expect(issued).toBe(1); // 재시도하지 않는다
    expect(FakeWebSocket.instances).toHaveLength(0);
    handle.close();
  });

  it('treats a 4401 close as a credential failure and does not reconnect', async () => {
    let issued = 0;
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => `murt_${++issued}`, {
      onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason),
    });
    await settleReal();

    FakeWebSocket.instances[0]!.close(4401);
    await settleReal(1200);

    expect(downs).toEqual(['credential']);
    expect(FakeWebSocket.instances).toHaveLength(1);
    handle.close();
  });

  it('reports an origin rejection separately and does not reconnect', async () => {
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => 'murt_a', {
      onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason),
    });
    await settleReal();

    FakeWebSocket.instances[0]!.close(4403);
    await settleReal(1200);

    expect(downs).toEqual(['origin']);
    expect(FakeWebSocket.instances).toHaveLength(1);
    handle.close();
  });

  // 네트워크 끊김은 기다리면 낫는다 — 이 경로는 계속 재시도해야 한다.
  it('keeps reconnecting on an ordinary close', async () => {
    let issued = 0;
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => `murt_${++issued}`, {
      onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason),
    });
    await settleReal();

    FakeWebSocket.instances[0]!.close(1006);
    await settleReal(1200);

    expect(downs).toEqual(['network']);
    expect(FakeWebSocket.instances).toHaveLength(2);
    handle.close();
  });

  // 티켓 발급이 네트워크 문제로 실패한 것은(status 없음) 재시도 대상이다.
  it('retries when the ticket request fails without an auth status', async () => {
    let issued = 0;
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => {
      issued += 1;
      throw new Error('network down');
    }, { onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason) });

    await settleReal(1200);

    expect(downs[0]).toBe('network');
    expect(issued).toBeGreaterThan(1);
    handle.close();
  });
});
