/**
 * `harkroom-operator mcp-bridge` — 하네스와 오퍼레이터 사이의 stdio 파이프(스펙 2026-09-20 §5).
 *
 * 러너가 만드는 `mcp.json` 의 `harkroom` 항목이 HTTP URL 에서 이 **stdio 명령**으로 바뀐다.
 * 하네스(claude-code·codex)는 이것을 여느 stdio MCP 서버처럼 띄우고, 이 프로세스는:
 *
 *   stdin 의 JSON-RPC 한 줄  →  오퍼레이터 소켓에 `mcp.request{id, payload}`
 *   소켓의 `mcp.response`     →  그 안의 메시지들을 stdout 에 한 줄씩
 *   소켓의 `mcp.error`        →  그 요청의 JSON-RPC 오류 응답 한 줄(하네스가 영원히 기다리지 않게)
 *
 * **해석하지 않는다.** JSON 인지만 본다. 인증은 러너 env 를 상속한 `HARKROOM_RUNNER_ID`·
 * `HARKROOM_RUNNER_SECRET` 이고, hello 의 `kind: 'bridge'` 로 러너 코어의 relay 소켓과 갈린다
 * (같은 러너에 브릿지가 여럿일 수 있다 — 하네스는 MCP 서버를 턴마다 다시 띄운다).
 *
 * 요청마다 링크 id 하나를 붙여 상관한다. JSON-RPC 의 id 를 그대로 쓰지 않는 이유: 알림에는
 * id 가 없고, 하네스가 id 를 재사용해도 이쪽이 흔들리면 안 된다.
 */
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { NdjsonDecoder } from '@harkroom/shared/daemonProtocol';
import {
  RUNNER_LINK_PROTOCOL_VERSION, isRunnerLinkResponse, type RunnerHello, type RunnerLinkRequest,
} from '@harkroom/shared/runnerLink';

export interface BridgeLink { socketPath: string; runnerId: string; secret: string }

export interface BridgeStdio { stdin: Readable; stdout: Writable; stderr: Writable }

/** 링크 위의 요청 id → 그 요청의 JSON-RPC id(오류 응답을 만들 때 쓴다). 알림은 null. */
type Pending = Map<string, unknown>;

export function runMcpBridge(link: BridgeLink, io: BridgeStdio): Promise<void> {
  return new Promise<void>((resolve) => {
    const pending: Pending = new Map();
    const socket = connect(link.socketPath);
    const decoder = new NdjsonDecoder();
    const stdinDecoder = new NdjsonDecoder();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve();
    };
    const writeOut = (message: unknown): void => { io.stdout.write(`${JSON.stringify(message)}\n`); };
    // hello 가 **첫 줄**이어야 한다. 소켓이 열리기 전에 stdin 이 먼저 올 수 있으므로 그동안의
    // 요청은 여기 모아 두고, hello 뒤에 순서대로 보낸다.
    let connected = false;
    const queued: string[] = [];
    const sendLine = (line: string): void => { if (connected) socket.write(line); else queued.push(line); };

    socket.on('connect', () => {
      const hello: RunnerHello = {
        type: 'hello', version: RUNNER_LINK_PROTOCOL_VERSION, role: 'runner',
        runnerId: link.runnerId, secret: link.secret, kind: 'bridge',
      };
      socket.write(`${JSON.stringify(hello)}\n`);
      connected = true;
      for (const line of queued.splice(0)) socket.write(line);
    });
    socket.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        if (!line.ok || !isRunnerLinkResponse(line.value)) continue;
        const res = line.value;
        if (!pending.has(res.id)) continue;
        const rpcId = pending.get(res.id);
        pending.delete(res.id);
        if (res.type === 'mcp.response') {
          for (const m of res.messages) writeOut(m);
        } else if (res.type === 'mcp.error' && rpcId !== null && rpcId !== undefined) {
          // 알림(id 없음)의 실패는 답할 상대가 없다 — 요청이었을 때만 오류 응답을 만든다.
          writeOut({ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `harkroom 서버가 거절했다 (${res.status}): ${res.message}` } });
        }
      }
    });
    socket.on('error', (err: Error) => {
      io.stderr.write(`오퍼레이터 소켓 오류: ${err.message}\n`);
      // 열린 요청은 전부 실패다 — 하네스가 기다리지 않게 답한다.
      for (const [, rpcId] of pending) {
        if (rpcId !== null && rpcId !== undefined) writeOut({ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `오퍼레이터에 닿지 못했다: ${err.message}` } });
      }
      pending.clear();
      finish();
    });
    socket.on('close', () => finish());

    io.stdin.on('data', (chunk: Buffer | string) => {
      for (const line of stdinDecoder.push(chunk)) {
        if (!line.ok) continue;
        const payload = line.value;
        const id = randomUUID();
        const rpcId = typeof payload === 'object' && payload !== null ? (payload as { id?: unknown }).id ?? null : null;
        pending.set(id, rpcId);
        const req: RunnerLinkRequest = { type: 'mcp.request', id, payload };
        sendLine(`${JSON.stringify(req)}\n`);
      }
    });
    io.stdin.on('end', () => finish());
    io.stdin.on('error', () => finish());
  });
}
