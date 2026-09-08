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
 * 하네스(claude/codex)는 필요 없다: 기동의 첫 호출(`murmur.me()`)에서 401 이 나므로 러너는
 * 상태 디렉터리도 만들기 전에 물러난다.
 */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_REJECTED_LINE, EX_CONFIG } from '@murmur/shared';

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 이 세션이 띄운 것들. 단언이 실패해도 반드시 거둔다 — 남기면 다음 테스트가 포트를 못 잡는다. */
let server: Server | null = null;

/**
 * `POST /mcp` 에 그날 서버가 실제로 낸 본문을 그대로 낸다(narwhal-server 로그 실측).
 *
 * `agent_only` 는 "PAT 는 유효한데 사람 계정이다"와 "PAT 를 못 찾았다"를 한 코드로 쓴다 —
 * 그날 러너가 받은 것은 후자(401)였다. 상태 코드가 판정의 근거이므로 그것을 고정한다.
 */
async function startRejectingServer(): Promise<string> {
  const s = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"agent_only","message":"MCP surface requires an agent PAT"}}');
  });
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  server = s;
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('포트를 얻지 못했다');
  return `http://127.0.0.1:${addr.port}`;
}

interface RunnerOutcome {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** 러너를 띄우고 스스로 물러나기를 기다린다. */
async function runRunner(murmurUrl: string): Promise<RunnerOutcome> {
  const child = spawn('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: agentRoot,
    env: {
      ...process.env,
      MURMUR_URL: murmurUrl,
      MURMUR_PAT: 'murp_revoked_by_reissue',
      // 풀을 비워 둔다 — 계정 축은 이 계약과 무관하고, 여기서 뜨면 실패 사유가 섞인다.
      MURMUR_CLAUDE_ACCOUNTS: '',
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

describe('폐기된 PAT 로 뜬 러너는 78 로 물러난다 (수용)', () => {
  beforeEach(() => { server = null; });

  afterEach(async () => {
    if (server) {
      server.close();
      await once(server, 'close');
      server = null;
    }
  });

  /**
   * 이 단언 둘이 앱↔러너 계약의 **전부**다: 종료 코드로 "재시도로 낫지 않는다"를,
   * 마지막 줄로 "그중 자격증명 쪽"을 말한다(`runnerLauncher.ts::handleExit` 이 그 둘을 읽는다).
   *
   * 2026-09-08 실측에서 이 자리에 온 것은 `code=1` 과 생 `StreamableHTTPError` 스택이었다.
   */
  it('MCP 트랜스포트의 401 을 받고 종료 코드 78 과 마커를 남긴다', async () => {
    const url = await startRejectingServer();

    const { code, stderr } = await runRunner(url);

    expect(stderr).toContain(CREDENTIAL_REJECTED_LINE);
    expect(code).toBe(EX_CONFIG);
  }, 60_000);

  /**
   * 생 스택으로 죽으면 안 된다 — 그것이 그날의 증상이었다. 스택은 사람에게 아무 길도
   * 알려 주지 않고, 앱은 78 이 아니므로 "재발급하면 된다"를 말할 수 없다.
   */
  it('처리되지 않은 예외로 죽지 않는다 — 안내문을 남긴다', async () => {
    const url = await startRejectingServer();

    const { stderr } = await runRunner(url);

    expect(stderr).not.toContain('StreamableHTTPError:');
    expect(stderr).toContain('MURMUR_PAT');
  }, 60_000);
});
