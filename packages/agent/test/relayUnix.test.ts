// 러너 → 오퍼레이터 unix 링크(스펙 2026-09-20 §5). 러너 쪽에서 바뀌는 것은 **소켓의 상대와
// 첫 줄**뿐이다 — 세션·ring·재접속(`relay.test.ts`)은 그대로다. 그래서 여기서 재는 것도 둘이다:
// 링크가 있으면 서버 대신 소켓으로 거는가, 그 소켓 위의 말(NDJSON, 첫 줄 hello)이 맞는가.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdjsonDecoder, encodeLine } from '@harkroom/shared/daemonProtocol';
import type { RelayRunnerFrame } from '@harkroom/shared';
import { createRelayClient, unixDialer, type RelayHandlers, type RelayTransport, type RelayUnixDialer } from '../src/relay.js';

const LINK = { socketPath: '/tmp/op.sock', runnerId: 'r-1', secret: 'sec' };

describe('링크가 있으면 서버가 아니라 오퍼레이터 소켓으로 건다', () => {
  it('unix dialer 에 링크 정보를 넘기고, WS dialer 는 부르지 않는다', () => {
    const wsDials: string[] = [];
    const unixDials: { socketPath: string; runnerId: string; secret: string }[] = [];
    const client = createRelayClient({
      harkroomUrl: 'http://x', pat: 'p', link: LINK,
      dial: (url) => { wsDials.push(url); },
      unixDial: (link) => { unixDials.push(link); },
    });
    client.start();
    expect(wsDials).toEqual([]);
    expect(unixDials).toEqual([LINK]);
  });

  it('소켓이 열리면 옛 릴레이와 똑같이 announce 부터 보낸다 — 러너 코어는 상대를 모른다', () => {
    const sent: RelayRunnerFrame[] = [];
    let handlers: RelayHandlers | null = null;
    const unixDial: RelayUnixDialer = (_link, h) => { handlers = h; };
    const client = createRelayClient({ harkroomUrl: 'http://x', pat: 'p', link: LINK, unixDial });
    client.start();
    const transport: RelayTransport = { send: (d) => sent.push(JSON.parse(d) as RelayRunnerFrame), close: () => {} };
    handlers!.onOpen(transport);
    expect(sent[0]).toMatchObject({ type: 'announce', sessions: [] });
  });
});

describe('unixDialer — 소켓 위의 말', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hk-link-'));
  const socketPath = join(dir, 'op.sock');
  let server: Server | null = null;
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; });

  /** 오퍼레이터 흉내 — 첫 줄을 검사하고, 그 뒤 줄은 모아 두고, 요청이 오면 답한다. */
  function fakeOperator(onLine: (socket: Socket, value: unknown) => void): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((socket) => {
        const decoder = new NdjsonDecoder();
        socket.on('data', (chunk: Buffer) => {
          for (const line of decoder.push(chunk)) if (line.ok) onLine(socket, line.value);
        });
      });
      server.listen(socketPath, () => resolve());
    });
  }

  it('첫 줄이 hello{role:runner, runnerId, secret} 이고, 그 뒤는 릴레이 프레임 한 줄씩이다', async () => {
    const lines: unknown[] = [];
    await fakeOperator((socket, value) => {
      lines.push(value);
      // 오퍼레이터가 내려보내는 프레임도 NDJSON 한 줄이다.
      if ((value as { type?: string }).type === 'hello') socket.write(encodeLine({ type: 'replay.request', sessionId: 's1' }));
    });
    const received: string[] = [];
    let opened: RelayTransport | null = null;
    await new Promise<void>((resolve) => {
      unixDialer({ socketPath, runnerId: 'r-1', secret: 'sec' }, {
        onOpen: (t) => { opened = t; t.send(JSON.stringify({ type: 'announce', sessions: [], caps: [] })); },
        onMessage: (raw) => { received.push(raw); resolve(); },
        onClose: () => {},
      });
    });
    expect(lines[0]).toEqual({ type: 'hello', version: 1, role: 'runner', runnerId: 'r-1', secret: 'sec' });
    expect(lines[1]).toEqual({ type: 'announce', sessions: [], caps: [] });
    expect(JSON.parse(received[0]!)).toEqual({ type: 'replay.request', sessionId: 's1' });
    opened!.close();
  });

  it('소켓이 없으면 onClose 에 사유가 실린다 — 조용히 재시도만 하지 않는다', async () => {
    const reason = await new Promise<string | undefined>((resolve) => {
      unixDialer({ socketPath: join(dir, 'nope.sock'), runnerId: 'r', secret: 's' }, {
        onOpen: () => {}, onMessage: () => {}, onClose: (r) => resolve(r),
      });
    });
    expect(reason).toMatch(/ENOENT|nope\.sock/);
  });

  it('오퍼레이터가 끊으면 onClose 가 한 번만 온다', async () => {
    await fakeOperator((socket) => { socket.destroy(); });
    let closes = 0;
    await new Promise<void>((resolve) => {
      unixDialer({ socketPath, runnerId: 'r-1', secret: 'sec' }, {
        onOpen: () => {}, onMessage: () => {}, onClose: () => { closes += 1; resolve(); },
      });
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(closes).toBe(1);
  });
});
