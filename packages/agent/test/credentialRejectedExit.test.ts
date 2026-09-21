/**
 * **러너를 실제로 띄워** 자격증명 거부 계약을 확인하는 수용 층(#250, 2026-09-08 실측).
 *
 * 왜 단위 테스트로 충분하지 않았나 — 이 계약은 **두 번** 깨졌고, 두 번 다 판정 함수의
 * 단위 테스트는 초록이었다:
 *
 * 1. `#250`: 판정은 있는데 폴 루프의 catch 에 걸려 있지 않았다. `mainCredentialSites.test.ts`
 *    가 소스를 읽어 그 자리를 재는 것으로 막았다 — 실행 경로를 안 타므로 약한 검사다.
 * 2. 2026-09-08 14:04(@murmur 러너): 판정도 있고 자리도 맞았는데, **MCP 트랜스포트가 던지는
 *    401 이 판정을 통과하지 못했다**. `StreamableHTTPError` 가 가진 것은 숫자 `code` 뿐이고
 *    `status` 도 `source` 도 없었다. 러너는 78 로 물러나지 않고 `poll 루프 오류, 재접속` 만
 *    찍다가 처리되지 않은 예외로 죽었고(종료 코드 1 + 생 스택), 앱은 그 죽음을
 *    `needs_reissue` 로 표시할 근거를 못 받았다.
 *
 * 두 결함의 공통점은 **경계**다: 판정 함수는 옳았고, 그 함수에 값이 도달하는 경로가 틀렸다.
 * 경계를 재려면 프로세스를 띄워야 한다. 그래서 이 층은 러너를 실제로 spawn 하고, 401 만
 * 내는 최소 서버를 붙여 **종료 코드와 마커 한 줄**을 본다 — 앱이 읽는 것이 정확히 그 둘이다.
 *
 * 하네스(claude/codex)는 필요 없다: 기동의 첫 호출(`harkroom.me()`)에서 401 이 나므로 러너는
 * 상태 디렉터리도 만들기 전에 물러난다.
 */
import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_REJECTED_LINE, EX_CONFIG } from '@harkroom/shared';
import { NdjsonDecoder, encodeLine } from '@harkroom/shared/daemonProtocol';

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let server: Server | null = null;

/**
 * 서버가 이 오퍼레이터를 거절하는 상황의 오퍼레이터 흉내(스펙 2026-09-20 §5). 러너의 모든 요청
 * (MCP 든 REST 든)에 401 을 되돌린다 — 오퍼레이터 토큰이 폐기됐거나 배정이 풀린 모양이다.
 */
async function startRejectingOperator(): Promise<string> {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'hk-reject-')), 'op.sock');
  const s = createServer((socket) => {
    const decoder = new NdjsonDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        if (!line.ok) continue;
        const v = line.value as { type?: string; id?: string };
        if (v.type === 'mcp.request') {
          socket.write(encodeLine({ type: 'mcp.error', id: v.id, status: 401, message: '{"error":{"code":"unauthorized","message":"오퍼레이터 토큰이 폐기됐다"}}' }));
        } else if (v.type === 'http.forward') {
          socket.write(encodeLine({ type: 'http.response', id: v.id, status: 401, body: 'unauthorized' }));
        }
      }
    });
  });
  s.listen(socketPath);
  await once(s, 'listening');
  server = s;
  return socketPath;
}

interface RunnerOutcome {
  code: number | null;
  stderr: string;
  stdout: string;
}

async function runRunner(socketPath: string): Promise<RunnerOutcome> {
  // 오퍼레이터가 spawn 전에 써 두는 파일 — 여기서는 소켓 옆에 최소 모양으로 둔다.
  const mcpConfigPath = join(dirname(socketPath), 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { harkroom: { type: 'stdio', command: '/opt/harkroom/harkroom-operator', args: ['mcp-bridge'] } } }));
  const child = spawn('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: agentRoot,
    env: {
      ...process.env,
      HARKROOM_OPERATOR_SOCKET: socketPath,
      HARKROOM_RUNNER_ID: 'r-test',
      HARKROOM_RUNNER_SECRET: 'sec_revoked_by_reissue',
      HARKROOM_OPERATOR_BIN: '/opt/harkroom/harkroom-operator',
      HARKROOM_MCP_CONFIG: mcpConfigPath,
      HARKROOM_CLAUDE_ACCOUNTS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { stdout += c; });
  child.stderr.on('data', (c: string) => { stderr += c; });

  const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return { code, stderr, stdout };
}

describe('오퍼레이터가 서버에서 거절당한 러너는 78 로 물러난다 (수용)', () => {
  beforeEach(() => { server = null; });

  afterEach(async () => {
    if (server) {
      server.close();
      await once(server, 'close');
      server = null;
    }
  });

  it('링크 위의 MCP 401 을 받고 종료 코드 78 과 마커를 남긴다', async () => {
    const socketPath = await startRejectingOperator();

    const { code, stderr } = await runRunner(socketPath);

    expect(stderr).toContain(CREDENTIAL_REJECTED_LINE);
    expect(code).toBe(EX_CONFIG);
  }, 60_000);

  it('처리되지 않은 예외로 죽지 않는다 — 안내문을 남긴다', async () => {
    const socketPath = await startRejectingOperator();

    const { stderr } = await runRunner(socketPath);

    expect(stderr).not.toContain('StreamableHTTPError:');
    // 사람이 할 일이 PAT 교체가 아니라 오퍼레이터·배정 확인이라고 말한다.
    expect(stderr).toContain('오퍼레이터');
    expect(stderr).not.toContain('HARKROOM_PAT');
  }, 60_000);
});
