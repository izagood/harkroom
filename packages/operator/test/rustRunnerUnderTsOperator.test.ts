// B4-5c: **진짜** Rust 러너(`harkroom-runner-rs`)가 TS 오퍼레이터의 러너 링크에 붙는가.
// TS 오퍼레이터와 같은 부품(RunnerRegistry → spawn, createRunnerLinkServer → hello 검사)을 진짜 unix 소켓에 놓고,
// 고른 러너가 rust 일 때 그 바이너리가 hello(secret) 로 붙는지 본다.
//
// 바이너리는 cargo 가 만든다 — `HARKROOM_RUNNER_RS_BIN` 이 있을 때만 돈다(없으면 건너뛴다).
//   cd crates/harkroom-runner && cargo build --locked --bin harkroom-runner-rs
//   HARKROOM_RUNNER_RS_BIN=$PWD/target/debug/harkroom-runner-rs npx vitest run test/rustRunnerUnderTsOperator.test.ts
import { describe, it, expect } from 'vitest';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
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
    const logs2: string[] = [];
    // 붙은 사실은 **사건으로** 받는다. 이 시험의 링크는 요청에 답하지 않으므로 러너는 붙은 뒤 「내 계정을 읽지 못했다」로
    // 곧 물러난다 — 그 뒤 `isLinked` 를 물으면 이미 false 일 수 있다(CI 에서 그렇게 졌다).
    const attached: string[] = [];
    const link = createRunnerLinkServer({ onFrame: () => {}, onRelayAttach: (id) => attached.push(id), log: (l) => logs2.push(l) });
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

    // 러너 자신의 출력을 파일로 받는다 — 붙지 못하면 그 꼬리를 실패 문구에 싣는다(CI 에서 원인을 보려고).
    const logPath = join(dir, 'runner.log');
    const logs = {
      open: () => { const fd = openSync(logPath, 'a'); return { fd, path: logPath, close: () => closeSync(fd) }; },
      pathFor: () => logPath,
      tail: async () => [],
    };
    const registry = new RunnerRegistry({ command: '/nonexistent/harkroom-runner', args: [], rustCommand: BIN! }, nodeRunnerHost, () => {}, null, logs);
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
      while (!attached.includes(runnerId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const tail = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(로그 없음)');
      // hello 가 secret 검사를 지나 relay 로 붙었다. 거절이면 attach 가 없고 링크 로그에 거절 줄이 남는다.
      expect(attached, `러너 출력:\n${tail()}\n링크 로그:\n${logs2.join('\n')}`).toEqual([runnerId]);
      expect(logs2.filter((l) => /거절/.test(l))).toEqual([]);
    } finally {
      registry.killRunner('agent-rs');
      link.close();
      server.close();
    }
  }, 20_000);
});
