// `harkroom-operator mcp-bridge` — 하네스와 오퍼레이터 사이의 stdio 파이프(스펙 2026-09-20 §5).
// 하네스는 이것을 stdio MCP 서버로 띄운다. 브릿지는 stdin 의 JSON-RPC 줄을 `mcp.request` 로
// 오퍼레이터 소켓에 싣고, `mcp.response` 의 메시지들을 stdout 에 한 줄씩 쓴다. 실제 unix
// 소켓으로 잰다 — 이 프로세스가 지키는 것은 정확히 "소켓 위의 말"이다.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { NdjsonDecoder, encodeLine } from '@harkroom/shared/daemonProtocol';
import { runMcpBridge } from '../src/mcpBridge.js';

const dir = mkdtempSync(join(tmpdir(), 'hk-bridge-'));
const socketPath = join(dir, 'op.sock');
let server: Server | null = null;
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; });

function fakeOperator(onLine: (socket: Socket, value: Record<string, unknown>) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      const decoder = new NdjsonDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) if (line.ok) onLine(socket, line.value as Record<string, unknown>);
      });
    });
    server.listen(socketPath, () => resolve());
  });
}

const link = { socketPath, runnerId: 'r-1', secret: 'sec' };

async function collect(stdout: PassThrough, n: number): Promise<unknown[]> {
  const out: unknown[] = [];
  const decoder = new NdjsonDecoder();
  await new Promise<void>((resolve) => {
    stdout.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) if (line.ok) out.push(line.value);
      if (out.length >= n) resolve();
    });
  });
  return out;
}

describe('mcp-bridge', () => {
  it('첫 줄은 kind:bridge 인 hello 이고, stdin 의 JSON-RPC 한 줄이 mcp.request 로 실린다', async () => {
    const lines: Record<string, unknown>[] = [];
    await fakeOperator((socket, value) => {
      lines.push(value);
      if (value.type === 'mcp.request') {
        socket.write(encodeLine({ type: 'mcp.response', id: value.id, messages: [{ jsonrpc: '2.0', id: 1, result: { tools: [] } }] }));
      }
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge(link, { stdin, stdout, stderr: new PassThrough() });
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    const out = await collect(stdout, 1);
    expect(lines[0]).toMatchObject({ type: 'hello', role: 'runner', kind: 'bridge', runnerId: 'r-1', secret: 'sec' });
    expect(lines[1]).toMatchObject({ type: 'mcp.request', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    stdin.end();
    await done;
  });

  it('요청 둘이 교차해도 답이 각자 제 자리로 간다 — 롱폴이 다른 요청을 막지 않는다', async () => {
    const pending: { socket: Socket; id: unknown; rpcId: unknown }[] = [];
    await fakeOperator((socket, value) => {
      if (value.type !== 'mcp.request') return;
      const rpcId = (value.payload as { id: unknown }).id;
      pending.push({ socket, id: value.id, rpcId });
      // 두 번째 요청이 오면 **역순으로** 답한다 — 첫 요청(롱폴)이 아직 열려 있는 모양이다.
      if (pending.length === 2) {
        for (const p of [...pending].reverse()) {
          p.socket.write(encodeLine({ type: 'mcp.response', id: p.id, messages: [{ jsonrpc: '2.0', id: p.rpcId, result: { rpc: p.rpcId } }] }));
        }
      }
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge(link, { stdin, stdout, stderr: new PassThrough() });
    stdin.write('{"jsonrpc":"2.0","id":10,"method":"inbox.poll"}\n{"jsonrpc":"2.0","id":11,"method":"tools/list"}\n');
    const out = await collect(stdout, 2);
    expect(out).toEqual([
      { jsonrpc: '2.0', id: 11, result: { rpc: 11 } },
      { jsonrpc: '2.0', id: 10, result: { rpc: 10 } },
    ]);
    stdin.end();
    await done;
  });

  it('오퍼레이터가 HTTP 로 거절하면 그 요청의 JSON-RPC 오류 응답을 stdout 에 쓴다 — 하네스가 영원히 기다리지 않게', async () => {
    await fakeOperator((socket, value) => {
      if (value.type === 'mcp.request') socket.write(encodeLine({ type: 'mcp.error', id: value.id, status: 403, message: 'not_assigned' }));
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge(link, { stdin, stdout, stderr: new PassThrough() });
    stdin.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
    const out = await collect(stdout, 1);
    expect(out[0]).toMatchObject({ jsonrpc: '2.0', id: 7, error: { message: expect.stringContaining('403') } });
    stdin.end();
    await done;
  });

  it('stdin 이 닫히면 소켓을 닫고 끝난다', async () => {
    let closed = false;
    let sawHello: () => void = () => {};
    const helloSeen = new Promise<void>((r) => { sawHello = r; });
    await fakeOperator((socket, value) => {
      socket.on('close', () => { closed = true; });
      if (value.type === 'hello') sawHello();
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge(link, { stdin, stdout, stderr: new PassThrough() });
    await helloSeen;
    stdin.end();
    await done;
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(true);
  });
});
