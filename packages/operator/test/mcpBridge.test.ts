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
import { createRunnerLinkServer } from '../src/runnerLink.js';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';

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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('기다리던 조건이 끝내 오지 않았다');
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

  it('tools/list 의 답을 stdout 에 쓴 **뒤** onToolsListed 를 한 번만 부른다 — 러너가 이 신호를 기다려 프롬프트를 넣는다', async () => {
    await fakeOperator((socket, value) => {
      if (value.type !== 'mcp.request') return;
      const rpcId = (value.payload as { id: unknown }).id;
      socket.write(encodeLine({ type: 'mcp.response', id: value.id, messages: [{ jsonrpc: '2.0', id: rpcId, result: {} }] }));
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const written: unknown[] = [];
    const calls: number[] = [];
    stdout.on('data', (c: Buffer) => { for (const l of c.toString('utf8').split('\n')) if (l) written.push(JSON.parse(l)); });
    const done = runMcpBridge({ ...link, onToolsListed: () => calls.push(written.length) }, { stdin, stdout, stderr: new PassThrough() });
    // initialize 의 답으로는 부르지 않는다 — 하네스는 그 뒤에야 도구 목록을 묻는다.
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    await waitFor(() => written.length === 1);
    expect(calls).toEqual([]);
    stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await waitFor(() => calls.length === 1);
    // 부른 순간 tools/list 답(둘째 줄)은 이미 나가 있었다.
    expect(calls).toEqual([2]);
    // 다시 물어도 한 번뿐이다.
    stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n');
    await waitFor(() => written.length === 3);
    expect(calls).toEqual([2]);
    stdin.end();
    await done;
  });

  it('tools/list 가 거절(mcp.error)되면 onToolsListed 를 부르지 않는다 — 러너는 시한까지 기다린 뒤 넣는다', async () => {
    await fakeOperator((socket, value) => {
      if (value.type !== 'mcp.request') return;
      socket.write(encodeLine({ type: 'mcp.error', id: value.id, status: 503, message: 'down' }));
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    let called = 0;
    const done = runMcpBridge({ ...link, onToolsListed: () => { called += 1; } }, { stdin, stdout, stderr: new PassThrough() });
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    const out = await collect(stdout, 1);
    expect(out[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(called).toBe(0);
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

  // ── 2026-09-22 사고의 회귀선 ────────────────────────────────────────────────
  // 앱 갱신으로 오퍼레이터가 갈리면 옛 오퍼레이터는 종료하며 브릿지 소켓을 **일부러 끊는다**
  // (`runnerLink.ts` 의 `accepted`). 그때 브릿지가 그냥 끝나 버려서 진행 중이던 턴의 MCP
  // 호출이 답 없이 증발했고, 턴이 안 끝나니 러너가 못 물러나고, 러너가 안 물러나니 교체
  // 러너가 못 떠서 그 에이전트는 30분간 멘션을 아무도 안 집었다.
  it('오퍼레이터가 갈려도 다시 붙는다 — 열린 요청은 실패로 답하고 재전송하지 않는다', async () => {
    const seen: Record<string, unknown>[] = [];
    const live: Socket[] = [];
    let respond = false; // 1세대는 받기만 하고 답하지 않는다(교체가 그 사이에 온다).
    const handler = (socket: Socket, value: Record<string, unknown>): void => {
      if (!live.includes(socket)) live.push(socket);
      seen.push(value);
      if (!respond || value.type !== 'mcp.request') return;
      const rpcId = (value.payload as { id: unknown }).id;
      socket.write(encodeLine({ type: 'mcp.response', id: value.id, messages: [{ jsonrpc: '2.0', id: rpcId, result: { ok: true } }] }));
    };
    await fakeOperator(handler);

    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge(link, { stdin, stdout, stderr: new PassThrough() }, {
      reconnectInitialMs: 5, reconnectMaxMs: 10, requestTimeoutMs: 10_000, linkDownGraceMs: 10_000,
    });
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"message.post"}\n');
    await waitFor(() => seen.some((v) => v.type === 'mcp.request'));

    // 옛 오퍼레이터가 물러난다 — 연결을 끊고 소켓 파일을 치운다.
    for (const s of live) s.destroy();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;

    // 열린 요청은 **답을 받아야 한다.** 예전에는 여기서 아무것도 안 나왔다.
    const failed = await collect(stdout, 1);
    expect(failed[0]).toMatchObject({
      jsonrpc: '2.0', id: 1, error: { message: expect.stringContaining('오퍼레이터 링크가 끊겼다') },
    });

    // 새 오퍼레이터가 같은 자리에 뜬다.
    respond = true;
    await fakeOperator(handler);
    await waitFor(() => seen.filter((v) => v.type === 'hello').length === 2);
    stdin.write('{"jsonrpc":"2.0","id":2,"method":"message.read"}\n');
    const out = await collect(stdout, 1);
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } });

    // 재접속에도 hello 가 첫 줄이고, **실패한 요청을 다시 보내지는 않았다** — 다시 보내면
    // `message.post` 가 두 번 발화된다.
    expect(seen.filter((v) => v.type === 'hello')).toHaveLength(2);
    expect(seen.filter((v) => v.type === 'mcp.request' && (v.payload as { id: unknown }).id === 1)).toHaveLength(1);

    stdin.end();
    await done;
  });

  it('시한을 넘긴 요청은 오류로 답한다 — 소켓은 살아 있는데 답이 안 오는 경우', async () => {
    await fakeOperator(() => {}); // 받기만 하고 영영 답하지 않는다.
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge(link, { stdin, stdout, stderr: new PassThrough() }, { requestTimeoutMs: 40 });
    stdin.write('{"jsonrpc":"2.0","id":9,"method":"inbox.poll"}\n');
    const out = await collect(stdout, 1);
    expect(out[0]).toMatchObject({
      jsonrpc: '2.0', id: 9, error: { message: expect.stringContaining('40ms 안에 답하지 않았다') },
    });
    stdin.end();
    await done;
  });

  it('링크가 유예를 넘겨 없으면 요청을 바로 거절한다 — 오퍼레이터가 아예 없는 경우', async () => {
    // 서버를 안 띄운다. 예전에는 이때 프로세스가 죽어 하네스가 빨리 실패를 알았다 —
    // 재접속을 얻으면서 그 빠른 실패를 잃지 않았는지를 잰다.
    const nobody = { ...link, socketPath: join(dir, 'nobody.sock') };
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge(nobody, { stdin, stdout, stderr: new PassThrough() }, {
      reconnectInitialMs: 5, reconnectMaxMs: 5, linkDownGraceMs: 20, requestTimeoutMs: 60_000,
    });
    stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n');
    const out = await collect(stdout, 1);
    expect(out[0]).toMatchObject({
      jsonrpc: '2.0', id: 3, error: { message: expect.stringContaining('오퍼레이터 링크가 없다') },
    });
    stdin.end();
    await done;
  });
});

// 2026-10-02: 원본 ~786KB 를 넘는 그림의 `attachment.fetch` 가 90초 시한으로 실패했다 — 답 한 줄
// (base64)이 링크의 1MiB 상한을 넘어 오퍼레이터가 조용히 버렸다. 여기서는 **실제 runnerLink 서버**
// 를 unix 소켓 뒤에 두고 브릿지를 붙여, 그 길 전체를 잰다.
describe('mcp-bridge ↔ runnerLink 줄 상한', () => {
  async function realOperator(opts: { maxLineBytes?: number; respond: (req: RunnerLinkRequest) => RunnerLinkResponse }) {
    const link = createRunnerLinkServer({
      onFrame: () => {}, log: () => {}, ...(opts.maxLineBytes ? { maxLineBytes: opts.maxLineBytes } : {}),
      onRequest: async (_r, _a, req) => opts.respond(req),
    });
    link.expect('r-1', 'agent-a', 'sec');
    await new Promise<void>((resolve) => {
      server = createServer((socket) => {
        // `DaemonServer` 의 인계와 같은 모양: 첫 줄(hello)을 읽고 나머지·덜 끝난 머리를 넘긴다.
        const decoder = new NdjsonDecoder();
        const onData = (chunk: Buffer) => {
          const lines = decoder.push(chunk);
          if (lines.length === 0) return;
          socket.removeListener('data', onData);
          const rest = lines.slice(1).filter((l) => l.ok).map((l) => (l as { value: unknown }).value);
          link.accept(socket, (lines[0] as { value: unknown }).value, rest, decoder.takeBuffered());
        };
        socket.on('data', onData);
      });
      server.listen(socketPath, () => resolve());
    });
    return link;
  }

  async function readOne(stdout: PassThrough): Promise<Record<string, unknown>> {
    const decoder = new NdjsonDecoder(64 * 1024 * 1024);
    return new Promise((resolve) => {
      stdout.on('data', (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) if (line.ok) resolve(line.value as Record<string, unknown>);
      });
    });
  }

  it('그림 800KB 의 답(base64 ~1.07MB 한 줄)이 runnerLink → 브릿지를 지나 stdout 에 도착한다', async () => {
    const data = 'A'.repeat(Math.ceil(800_000 / 3) * 4);
    const link = await realOperator({
      respond: (req) => ({ type: 'mcp.response', id: req.id, messages: [{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'image', data, mimeType: 'image/png' }] } }] }),
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const done = runMcpBridge({ socketPath, runnerId: 'r-1', secret: 'sec' }, { stdin, stdout, stderr: new PassThrough() }, { requestTimeoutMs: 5_000 });
    const got = readOne(stdout);
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"attachment.fetch"}}\n');
    const out = await got;
    expect(out.error).toBeUndefined();
    expect(((out.result as { content: { data: string }[] }).content[0]!.data)).toHaveLength(data.length);
    stdin.end();
    await done;
    link.close();
  });

  it('답이 링크 상한을 넘으면 시한을 기다리지 않고 바로 JSON-RPC 오류가 온다', async () => {
    const link = await realOperator({
      maxLineBytes: 4096,
      respond: (req) => ({ type: 'mcp.response', id: req.id, messages: [{ jsonrpc: '2.0', id: 2, result: { pad: 'x'.repeat(10_000) } }] }),
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    // 시한을 길게 둔다 — 시한으로 끝나면 이 시험은 vitest 기본 시한에 걸려 실패한다.
    const done = runMcpBridge({ socketPath, runnerId: 'r-1', secret: 'sec' }, { stdin, stdout, stderr: new PassThrough() }, { requestTimeoutMs: 60_000 });
    const got = readOne(stdout);
    stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n');
    const out = await got;
    expect(out).toMatchObject({ id: 2, error: { code: -32000 } });
    expect((out.error as { message: string }).message).toMatch(/상한\(4096 바이트\)을 넘어/);
    stdin.end();
    await done;
    link.close();
  });

  it('요청이 링크 상한을 넘으면 보내지 않고 그 자리에서 거절한다 — 링크는 살아 있다', async () => {
    const seen: string[] = [];
    const link = await realOperator({
      respond: (req) => { seen.push(req.id); return { type: 'mcp.response', id: req.id, messages: [{ jsonrpc: '2.0', id: 4, result: {} }] }; },
    });
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const outs: Record<string, unknown>[] = [];
    const decoder = new NdjsonDecoder();
    stdout.on('data', (c: Buffer) => { for (const l of decoder.push(c)) if (l.ok) outs.push(l.value as Record<string, unknown>); });
    const done = runMcpBridge({ socketPath, runnerId: 'r-1', secret: 'sec' }, { stdin, stdout, stderr: new PassThrough() }, { requestTimeoutMs: 60_000, maxLineBytes: 2048 });
    stdin.write(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"pad":"${'y'.repeat(1940)}"}}\n`);
    await waitFor(() => outs.length === 1);
    expect(outs[0]).toMatchObject({ id: 3, error: { code: -32000 } });
    expect((outs[0]!.error as { message: string }).message).toMatch(/보내지 않았다/);
    // 뒤따르는 작은 요청은 정상으로 간다.
    stdin.write('{"jsonrpc":"2.0","id":4,"method":"tools/list"}\n');
    await waitFor(() => outs.length === 2);
    expect(outs[1]).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    expect(seen).toHaveLength(1);
    stdin.end();
    await done;
    link.close();
  });
});
