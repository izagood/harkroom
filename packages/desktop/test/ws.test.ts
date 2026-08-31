import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectWs } from '../src/lib/ws';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  close() { this.closed = true; this.onclose?.(); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('connectWs', () => {
  it('converts http→ws, dispatches events, reconnects with backoff', () => {
    const events: unknown[] = [];
    let opens = 0; let downs = 0;
    const handle = connectWs('http://x:3400', 't&k', {
      onEvent: (e) => events.push(e),
      onOpen: () => { opens += 1; },
      onDown: () => { downs += 1; },
    });
    const ws1 = FakeWebSocket.instances[0]!;
    expect(ws1.url).toBe('ws://x:3400/ws?token=t%26k');
    ws1.onopen?.();
    ws1.onmessage?.({ data: JSON.stringify({ type: 'lease.changed', repo: 'r1' }) });
    expect(events).toEqual([{ type: 'lease.changed', repo: 'r1' }]);
    expect(opens).toBe(1);

    ws1.onclose?.(); // 서버측 끊김 → 재연결 예약
    expect(downs).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    handle.close(); // 명시 종료 후에는 재연결 없음
    FakeWebSocket.instances[1]!.onclose?.();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
