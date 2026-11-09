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

  // 서버는 티켓 미스(만료·다른 프로세스가 발급)에도 4401 을 보낸다 — REST 가 세션이 살아 있다고 하면 다시 붙는다.
  it('reconnects after a 4401 when the credential check says the session is alive', async () => {
    let issued = 0;
    const downs: string[] = [];
    const checks: number[] = [];
    const handle = connectWs('http://x:3400', async () => `murt_${++issued}`, {
      onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason),
      credentialStillValid: async () => { checks.push(1); return true; },
    });
    await settleReal();

    FakeWebSocket.instances[0]!.close(4401);
    await settleReal(1200);

    expect(checks).toHaveLength(1);
    expect(downs).toEqual(['network']);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(issued).toBe(2); // 새 티켓으로
    handle.close();
  });

  it('gives up as a credential failure when the check confirms the session is dead', async () => {
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => 'murt_a', {
      onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason),
      credentialStillValid: async () => false,
    });
    await settleReal();

    FakeWebSocket.instances[0]!.close(4401);
    await settleReal(1200);

    expect(downs).toEqual(['credential']);
    expect(FakeWebSocket.instances).toHaveLength(1);
    handle.close();
  });

  it('treats a failing check as "not proven dead" and reconnects', async () => {
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => 'murt_a', {
      onEvent: () => {}, onOpen: () => {}, onDown: (reason) => downs.push(reason),
      credentialStillValid: async () => { throw new Error('offline'); },
    });
    await settleReal();

    FakeWebSocket.instances[0]!.close(4401);
    await settleReal(1200);

    expect(downs).toEqual(['network']);
    expect(FakeWebSocket.instances).toHaveLength(2);
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

// 좀비 연결: 서버가 끊었는데 앞단이 이쪽 다리를 열어 둔 채 두면 close 가 오지 않는다(실측 17분).
// 서버 hb 를 한 번 받은 뒤로 주기의 2.5배 동안 아무 프레임도 없으면 스스로 버리고 새 티켓으로 다시 붙어야 한다.
describe('connectWs — receive watchdog (app heartbeat)', () => {
  afterEach(() => { vi.useRealTimers(); });

  const hb = (intervalMs: number) => ({ data: JSON.stringify({ type: 'hb', intervalMs }) });

  it('abandons a silent socket and reconnects within a minute when hb stops (20s server interval)', async () => {
    let issued = 0;
    const downs: string[] = [];
    const events: unknown[] = [];
    const handle = connectWs('http://x:3400', async () => `murt_${++issued}`, {
      onEvent: (e) => events.push(e), onOpen: () => {}, onDown: (r) => downs.push(r),
    });
    await settle();
    vi.useFakeTimers();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.onopen?.();
    ws1.onmessage?.(hb(20_000));
    expect(events).toEqual([]); // hb 는 상태 층으로 올라가지 않는다

    // 2주기(40초)까지는 참는다 — 한 번 늦은 hb 로 끊지 않는다.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws1.closed).toBe(false);

    // 2.5주기(50초)를 넘기면 다음 점검(5초 간격)에서 버리고, 1초 백오프 뒤 새 티켓으로 다시 연다.
    // 최악 50+5+1 = 56초 — 마지막 프레임 뒤 1분 안에 새 소켓이 선다.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(ws1.closed).toBe(true);
    expect(downs).toEqual(['network']);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.url).toContain('ticket=murt_2');
    handle.close();
  });

  it('keeps a socket that keeps receiving frames (hb or events)', async () => {
    const handle = connectWs('http://x:3400', async () => 't', {
      onEvent: () => {}, onOpen: () => {}, onDown: () => {},
    });
    await settle();
    vi.useFakeTimers();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.onopen?.();
    ws1.onmessage?.(hb(20_000));
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      ws1.onmessage?.(i % 2 ? hb(20_000) : { data: JSON.stringify({ type: 'lease.changed', repo: 'r' }) });
    }
    expect(ws1.closed).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    handle.close();
  });

  // 옛 서버는 hb 를 보내지 않는다 — 그때 감시를 켜면 새 앱이 옛 서버와 계속 끊긴다.
  it('never arms the watchdog against an old server that sends no hb', async () => {
    const handle = connectWs('http://x:3400', async () => 't', {
      onEvent: () => {}, onOpen: () => {}, onDown: () => {},
    });
    await settle();
    vi.useFakeTimers();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.onopen?.();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(ws1.closed).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    handle.close();
  });

  it('stops watching after an explicit close', async () => {
    const downs: string[] = [];
    const handle = connectWs('http://x:3400', async () => 't', {
      onEvent: () => {}, onOpen: () => {}, onDown: (r) => downs.push(r),
    });
    await settle();
    vi.useFakeTimers();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.onopen?.();
    ws1.onmessage?.(hb(20_000));
    handle.close();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(downs).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('clamps an absurd interval instead of spinning', async () => {
    const handle = connectWs('http://x:3400', async () => 't', {
      onEvent: () => {}, onOpen: () => {}, onDown: () => {},
    });
    await settle();
    vi.useFakeTimers();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.onopen?.();
    ws1.onmessage?.(hb(0)); // → 1초로 묶인다: 2.5초 안에 프레임이 없으면 끊는 것이 정상
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ws1.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ws1.closed).toBe(true);
    handle.close();
  });
});
