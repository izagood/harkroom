// B4-5c: **진짜** Rust 러너(`harkroom-runner-rs`)가 TS 오퍼레이터의 러너 링크에 붙는가.
// TS 오퍼레이터와 같은 부품(RunnerRegistry → spawn, createRunnerLinkServer → hello 검사)을 진짜 unix 소켓에 놓고,
// 고른 러너가 rust 일 때 그 바이너리가 hello(secret) 로 붙는지 본다.
//
// 바이너리는 cargo 가 만든다 — `HARKROOM_RUNNER_RS_BIN` 이 있을 때만 돈다(없으면 건너뛴다).
//   cd crates/harkroom-runner && cargo build --locked --bin harkroom-runner-rs
//   HARKROOM_RUNNER_RS_BIN=$PWD/target/debug/harkroom-runner-rs npx vitest run test/rustRunnerUnderTsOperator.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { NdjsonDecoder } from '@harkroom/shared/daemonProtocol';
import { RUNNER_LINK_ENV } from '@harkroom/shared/runnerLink';
import { createRunnerLinkServer } from '../src/runnerLink.js';
import { RunnerRegistry, nodeRunnerHost } from '../src/runners.js';

const BIN = process.env.HARKROOM_RUNNER_RS_BIN;

describe.skipIf(!BIN)('진짜 Rust 러너가 TS 오퍼레이터 링크에 붙는다(B4-5c)', () => {
  it('rust 로 고르면 rustCommand 가 뜨고 hello 가 secret 검사를 지나 링크된다', async () => {
    // 소켓 경로는 짧아야 한다(macOS 104자) — tmpdir 바로 아래.
    const dir = await mkdtemp(join(tmpdir(), 'b45c-'));
    const sock = join(dir, 'op.sock');
    const logs: string[] = [];
    const link = createRunnerLinkServer({ onFrame: () => {}, log: (l) => logs.push(l) });
    // DaemonServer 가 하는 것처럼 첫 줄(hello)을 link.accept 로 넘긴다.
    const server = createServer((socket: Socket) => {
      const dec = new NdjsonDecoder();
      const onData = (b: Buffer) => {
        const lines = dec.push(b.toString('utf8')).filter((l) => l.ok).map((l) => (l as { value: unknown }).value);
        if (lines.length === 0) return;
        socket.removeListener('data', onData);
        link.accept(socket as never, lines[0], lines.slice(1));
      };
      socket.on('data', onData);
    });
    await new Promise<void>((r) => server.listen(sock, r));

    const registry = new RunnerRegistry({ command: '/nonexistent/harkroom-runner', args: [], rustCommand: BIN! }, nodeRunnerHost);
    expect(await registry.rustRunnerPresent()).toBe(true);
    const runnerId = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    link.expect(runnerId, 'agent-rs', secret);
    try {
      const rec = await registry.spawnRunner('agent-rs', {
        [RUNNER_LINK_ENV.socketPath]: sock,
        [RUNNER_LINK_ENV.runnerId]: runnerId,
        [RUNNER_LINK_ENV.secret]: secret,
        // 배정(`assignments.ts`)이 늘 싣는 둘 — Rust 러너는 없으면 기동을 거절한다.
        HARKROOM_OPERATOR_BIN: '/usr/bin/true',
        HARKROOM_MCP_CONFIG: join(dir, 'mcp.json'),
        HOME: dir,
      }, runnerId, { kind: 'rust' });
      expect(rec.runnerImpl).toBe('rust');
      const deadline = Date.now() + 10_000;
      while (!link.isLinked(runnerId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(link.isLinked(runnerId)).toBe(true);
      expect(link.agentOf(runnerId)).toBe('agent-rs');
      expect(registry.listRunners()[0]).toMatchObject({ agentId: 'agent-rs', alive: true, runnerImpl: 'rust' });
    } finally {
      registry.killRunner('agent-rs');
      link.close();
      server.close();
    }
  }, 20_000);
});
