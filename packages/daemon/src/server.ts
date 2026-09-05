/**
 * daemon 의 소켓 서버 — `hello` 로 문을 지키고, 네 요청을 러너 표에 잇는다(`#431` 2-b).
 *
 * 프레이밍·인증·메시지 판별은 **전부 `@murmur/shared/daemonProtocol` 것을 쓴다.** 여기서
 * 다시 짜지 않는 이유는 앱 클라이언트(2-b 3/3)도 같은 모듈을 쓸 것이기 때문이다 — 두
 * 곳에 같은 규칙이 있으면 한쪽만 고쳐지는 날이 온다.
 *
 * ## 이 서버가 하지 않는 것
 *
 * - **판단하지 않는다.** `listRunners` 는 관측을 그대로 준다. "정리해야 한다"고 말하지
 *   않는다(`#431`: daemon 은 판단하지 않는다, 관측을 노출한다)
 * - **세션을 모른다.** `sessions.json` 도 `SessionStore` 도 이 파일에 없다(D5)
 * - **고아를 재발견하지 않는다**(`adoptRunner` 는 2-c) · **스스로 물러나지 않는다**
 *   (`shutdownIfIdle` 은 2-d). 둘 다 `parseRequest` 가 `unknown-request` 로 거절한다
 */
import { createServer, type Server, type Socket } from 'node:net';

import {
  checkHello,
  daemonError,
  encodeLine,
  makeErrorResponse,
  makeEvent,
  makeResponse,
  NdjsonDecoder,
  parseRequest,
  type DaemonError,
  type DaemonIdentity,
  type DaemonRequest,
  type KillRunnerParams,
  type ListRunnersResult,
  type PingResult,
  type RunnerExitEvent,
  type SpawnRunnerParams,
  type SpawnRunnerResult,
} from '@murmur/shared/daemonProtocol';

import type { RunnerRegistry } from './runners.js';

export interface DaemonServerDeps {
  /**
   * 붙는 쪽이 대야 하는 토큰. **`claimDaemonEndpoint` 가 이긴 뒤에 만든 값**이라 서버
   * 객체를 만드는 시점에는 아직 없다 — 그래서 빈 값으로 시작하고 `setToken` 으로 채운다.
   * 빈 토큰은 `tokensMatch` 가 **어떤 경우에도 거절**하므로, 채우기 전의 창에 누가
   * 붙어도 통과하지 못한다(`daemonProtocol.tokensMatch` 의 `a.length === 0` 줄).
   */
  token: string;
  identity: DaemonIdentity;
  registry: RunnerRegistry;
  /** 로그 한 줄. 기본은 stdout — 앱이 사이드카 파이프로 그대로 본다. */
  log?: (line: string) => void;
}

/** 접속 하나의 상태. **`hello` 전에는 아무 요청도 받지 않는다.** */
interface Connection {
  socket: Socket;
  decoder: NdjsonDecoder;
  authenticated: boolean;
}

export class DaemonServer {
  private readonly connections = new Set<Connection>();
  private readonly log: (line: string) => void;
  private token: string;

  constructor(private readonly deps: DaemonServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.token = deps.token;
  }

  /** 엔드포인트를 이긴 뒤 그때 만들어진 토큰을 채운다(`DaemonServerDeps.token` 주석). */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * `net.Server` 를 만들어 임시 경로에 bind 한다 — **`claimDaemonEndpoint` 의
   * `bindTemporary` 로 그대로 넘길 함수다.**
   *
   * 2-a 가 그 주입 지점을 두면서 "실제 `net.Server` 수명과 맞물리는지는 2-b 에서만 알 수
   * 있다"고 남겼다. 맞물린다 — 그리고 **맞물리는 방식이 중요하다**: 여기서 만든 서버를
   * `claimDaemonEndpoint` 가 돌려받아, 졌거나 pid·토큰 기록이 실패하면 **자기가 닫는다**
   * (`closeServer`·`rollbackSocketName`). 즉 진 daemon 의 소켓이 파일로도 fd 로도 남지
   * 않는다. 넘기지 않으면(`void` 를 돌려주면) 파일은 지워지는데 **fd 는 열린 채 남아**
   * 이 프로세스가 살아 있는 한 accept 를 계속 기다린다 — 아무 이름도 없는 소켓에 대해서.
   *
   * 하드링크는 inode 를 공유하므로, 임시 이름이 정규 이름으로 올라간 뒤 임시 이름이
   * 지워져도 **이 서버 객체는 그대로 정규 이름의 소켓을 서비스한다.** 다시 bind 하지
   * 않는다 — 그것이 이 구조가 성립하는 이유다.
   *
   * ## `listen EINVAL` 을 만나면 — 경로 길이다 (실측 2026-09-06)
   *
   * unix 소켓 경로에는 커널 상한이 있다(`sockaddr_un.sun_path`, macOS 104바이트 ·
   * Linux 108바이트). 넘으면 `bind` 가 **`EINVAL`** 로 실패하는데, 그 이름만 보고는
   * 경로 길이가 원인이라는 것을 알 수 없다.
   *
   * 실물 검증 중 실제로 밟았다 — 깊은 워크트리 아래에서 daemon 을 띄우자
   * `listen EINVAL: invalid argument …/daemon/.p512a6b83bb` 가 났고, 그 경로는 115바이트였다.
   * 운영에서 쓰는 앱 데이터 디렉터리는 훨씬 짧아 닿지 않지만, **앱이 daemon 에게 넘기는
   * `--socket` 경로를 정할 때 이 상한을 넘기면 daemon 이 뜨지 않는다.** 그 사유는
   * 여기서 지어내지 않고 `EINVAL` 원문 그대로 올라간다(`#368`) — 이 주석이 그 원문을
   * 읽는 사람에게 무엇을 봐야 하는지 알려 주는 자리다.
   */
  bindTemporary = async (tempPath: string): Promise<Server> => {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(tempPath);
    });
    return server;
  };

  private server: Server | null = null;

  /** 러너 exit 을 붙어 있는 모두에게 알린다. **`incarnationId` 가 실린다.** */
  broadcastRunnerExit(event: RunnerExitEvent): void {
    const line = encodeLine(makeEvent('runnerExit', event));
    for (const conn of this.connections) {
      // 인증 못 한 접속에는 아무것도 흘리지 않는다 — 이벤트도 정보다.
      if (!conn.authenticated) continue;
      conn.socket.write(line);
    }
  }

  /**
   * 붙은 소켓들을 닫고 서버를 내린다. **러너는 건드리지 않는다** — `main.ts` 의 종료
   * 경로 주석 참조.
   */
  async close(): Promise<void> {
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  private accept(socket: Socket): void {
    const conn: Connection = { socket, decoder: new NdjsonDecoder(), authenticated: false };
    this.connections.add(conn);
    socket.on('data', (chunk: Buffer) => this.onData(conn, chunk));
    socket.on('error', () => this.drop(conn));
    socket.on('close', () => {
      this.connections.delete(conn);
    });
  }

  private onData(conn: Connection, chunk: Buffer): void {
    for (const line of conn.decoder.push(chunk)) {
      if (!line.ok) {
        // 상한 초과는 **연결을 끊을 사건**이다(프로토콜 주석: 정상 트래픽이 아니라 사고).
        this.sendError(conn, null, line.error);
        if (line.error.code === 'line-too-long') this.drop(conn);
        continue;
      }
      if (!conn.authenticated) {
        this.handleHello(conn, line.value);
        continue;
      }
      this.handleRequest(conn, line.value);
    }
  }

  /**
   * 첫 메시지를 검사한다. **거절이면 사유를 한 줄 보내고 끊는다.**
   *
   * 사유를 보내고 끊는 이유(`#368`): 그냥 끊으면 앱 쪽에는 "이유 없이 끊겼다"만 남고,
   * 토큰이 낡았는지 프로토콜 버전이 갈렸는지를 사람이 알 길이 없다.
   */
  private handleHello(conn: Connection, value: unknown): void {
    const check = checkHello(value, this.token);
    if (!check.ok) {
      conn.socket.write(encodeLine({ type: 'hello', ok: false, error: check.error }));
      this.log(`hello 거절: ${check.error.code} — ${check.error.message}`);
      this.drop(conn);
      return;
    }
    conn.authenticated = true;
    conn.socket.write(encodeLine({ type: 'hello', ok: true, daemon: this.deps.identity }));
  }

  private handleRequest(conn: Connection, value: unknown): void {
    const parsed = parseRequest(value);
    if (!isRequest(parsed)) {
      // id 를 못 읽었을 수도 있으므로 응답의 id 는 값에서 최선으로 건진다.
      this.sendError(conn, readId(value), parsed);
      return;
    }
    try {
      const payload = this.dispatch(parsed);
      if (isDaemonError(payload)) {
        conn.socket.write(encodeLine(makeErrorResponse(parsed.id, payload)));
        return;
      }
      conn.socket.write(encodeLine(makeResponse(parsed.id, payload)));
    } catch (err) {
      // 실패 사유를 지어내지 않는다 — 원문 그대로 올린다(`#368`).
      const message = err instanceof Error ? err.message : String(err);
      conn.socket.write(
        encodeLine(makeErrorResponse(parsed.id, daemonError('internal', message))),
      );
    }
  }

  private dispatch(req: DaemonRequest): unknown | DaemonError {
    switch (req.type) {
      case 'ping': {
        const result: PingResult = { nowMs: Date.now() };
        return result;
      }
      case 'spawnRunner': {
        const params = readSpawnParams(req.payload);
        if (isDaemonError(params)) return params;
        const record = this.deps.registry.spawnRunner(params.agentId, params.env);
        const result: SpawnRunnerResult = {
          agentId: record.agentId,
          pid: record.pid,
          incarnationId: record.incarnationId,
        };
        // **env 를 로그에 적지 않는다** — PAT 가 거기 실린다(`SpawnRunnerParams` 주석).
        this.log(`러너 spawn: agent=${record.agentId} pid=${record.pid}`);
        return result;
      }
      case 'killRunner': {
        const params = readKillParams(req.payload);
        if (isDaemonError(params)) return params;
        const record = this.deps.registry.killRunner(params.agentId, params.incarnationId);
        if (!record) return daemonError('no-such-runner', `이 daemon 이 아는 러너가 아니다: ${params.agentId}`);
        // 보낸 사실만 적는다. "곧 죽을 것이다"라고 쓰지 않는다 — daemon 은 모른다.
        this.log(`SIGTERM 보냄: agent=${record.agentId} pid=${record.pid}`);
        return { agentId: record.agentId, pid: record.pid, termSentAtMs: record.termSentAtMs };
      }
      case 'listRunners': {
        const result: ListRunnersResult = { runners: this.deps.registry.listRunners() };
        return result;
      }
    }
  }

  private sendError(conn: Connection, id: string | null, error: DaemonError): void {
    conn.socket.write(encodeLine(makeErrorResponse(id ?? '', error)));
  }

  private drop(conn: Connection): void {
    this.connections.delete(conn);
    conn.socket.destroy();
  }
}

function isRequest(value: DaemonRequest | DaemonError): value is DaemonRequest {
  return 'type' in value && 'id' in value;
}

function isDaemonError(value: unknown): value is DaemonError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    !('id' in value)
  );
}

function readId(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

function readSpawnParams(payload: unknown): SpawnRunnerParams | DaemonError {
  if (typeof payload !== 'object' || payload === null) {
    return daemonError('bad-payload', 'payload 가 객체가 아니다');
  }
  const { agentId, env } = payload as { agentId?: unknown; env?: unknown };
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return daemonError('bad-payload', 'agentId 가 없다');
  }
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return daemonError('bad-payload', 'env 가 객체가 아니다');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return daemonError('bad-payload', `env.${key} 가 문자열이 아니다`);
    }
    out[key] = value;
  }
  return { agentId, env: out };
}

function readKillParams(payload: unknown): KillRunnerParams | DaemonError {
  if (typeof payload !== 'object' || payload === null) {
    return daemonError('bad-payload', 'payload 가 객체가 아니다');
  }
  const { agentId, incarnationId } = payload as { agentId?: unknown; incarnationId?: unknown };
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return daemonError('bad-payload', 'agentId 가 없다');
  }
  if (incarnationId !== undefined && typeof incarnationId !== 'string') {
    return daemonError('bad-payload', 'incarnationId 가 문자열이 아니다');
  }
  return { agentId, incarnationId };
}
