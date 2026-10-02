/**
 * 러너 ↔ 오퍼레이터 unix 링크의 오퍼레이터 쪽 — 스펙 2026-09-20 §5 PTY 행.
 *
 * 러너는 spawn 때 받은 `HARKROOM_RUNNER_ID`·`HARKROOM_RUNNER_SECRET` 으로 오퍼레이터 소켓에
 * 붙어 첫 줄에 `hello{role:'runner'}` 를 보낸다(`@harkroom/shared/runnerLink`). 소켓 파일은 앱
 * 프로토콜과 **같은 것**이고 `DaemonServer` 가 첫 줄의 `role` 로 갈라 이리로 넘긴다 — 두 번째
 * 소켓을 열지 않는다(러너도 오퍼레이터도 포트를 열지 않는다는 결정의 연장).
 *
 * ## 인증은 장부 하나다
 *
 * `expect(runnerId, agentId, secret)` 이 spawn 직전에 적고, 러너가 죽으면 `forget` 이 지운다.
 * secret 은 spawn 마다 새로 만든다 — 한 러너의 secret 이 새어도 다른 러너·다음 세대에는
 * 쓸모가 없다. 비교는 상수 시간(`timingSafeEqual`)이다: 로컬 소켓이라 원격 타이밍 공격은
 * 없지만, 같은 머신의 다른 사용자 프로세스가 소켓에 닿을 수 있는 환경을 배제하지 않는다.
 *
 * ## 이 모듈은 프레임을 **해석하지 않는다**
 *
 * 줄을 JSON 으로 풀어 `onFrame` 에 넘길 뿐이다. 무엇이 세션이고 무엇이 바이트인지는
 * `relayMux.ts` 도 모른다(붙이고 뗄 뿐) — 아는 것은 서버 릴레이 허브 하나다(스펙 §8 근거 ②).
 */
import { timingSafeEqual } from 'node:crypto';
import type { RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';
import { encodeLine, LineTooLongError, NdjsonDecoder } from '@harkroom/shared/daemonProtocol';
import {
  RUNNER_LINK_MAX_LINE_BYTES, checkRunnerHello, isRunnerLinkNotice, isRunnerLinkRequest,
  type OperatorToRunnerNotice, type RunnerLinkNotice, type RunnerLinkRequest, type RunnerLinkResponse,
} from '@harkroom/shared/runnerLink';

/** `net.Socket` 의 최소 표면. 테스트가 가짜를 준다. */
export interface LinkSocket {
  write(line: string): boolean;
  destroy(): void;
  on(event: 'data', fn: (chunk: Buffer) => void): this;
  on(event: 'close' | 'error', fn: () => void): this;
  removeAllListeners(event: string): this;
}

export interface RunnerLinkDeps {
  /** 인증된 러너의 릴레이 프레임. `agentId` 는 `expect` 가 적어 둔 값이다 — 러너의 주장이 아니다. */
  onFrame(runnerId: string, agentId: string, frame: RelayRunnerFrame): void;
  /**
   * 요청 프레임(`mcp.request`·`http.forward`, 스펙 §5 MCP 행). 답은 **온 소켓으로** 돌아간다 —
   * relay 소켓이든 브릿지 소켓이든. 없으면 요청은 status 0 으로 거절된다(삼키지 않는다).
   */
  onRequest?(runnerId: string, agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  /**
   * 단방향 통지(`runner.pollStopped`·`mcp.authRejected`). **서버로 안 나간다** — 오퍼레이터 안에서 끝나는 말이다
   * (`shared/runnerLink.ts` 의 `RunnerLinkNotice`). 없으면 그냥 버린다.
   */
  onNotice?(runnerId: string, agentId: string, notice: RunnerLinkNotice): void;
  onClose?(runnerId: string): void;
  log(line: string): void;
  /** 한 줄 상한. 기본은 `RUNNER_LINK_MAX_LINE_BYTES` 이고, 주입은 회귀선의 몫이다. */
  maxLineBytes?: number;
}

export interface RunnerLinkServer {
  /** spawn 직전에 적는다. 같은 runnerId 를 다시 적으면 덮어쓴다(재spawn). */
  expect(runnerId: string, agentId: string, secret: string): void;
  /** 러너가 죽었다 — 그 secret 으로는 더 못 붙는다. */
  forget(runnerId: string): void;
  /**
   * `DaemonServer` 가 첫 줄을 읽고 넘긴다. `pending` 은 같은 청크에 hello 뒤로 이미 풀린
   * 줄들이다 — 여기서 받지 않으면 그 줄들이 사라진다(첫 announce 가 정확히 그 자리에 온다).
   * `buffered` 는 그 뒤에 붙어 온 **아직 안 끝난 줄의 머리**다 — 큰 요청이 hello 와 한 청크로
   * 오면 생긴다. 거절이면 소켓을 끊고 false.
   */
  accept(socket: LinkSocket, hello: unknown, pending: unknown[], buffered?: Buffer): boolean;
  send(runnerId: string, frame: RelayServerFrame): boolean;
  /** 오퍼레이터 자신의 말(`handover.released`). 릴레이 소켓이 없으면 false. */
  sendNotice(runnerId: string, notice: OperatorToRunnerNotice): boolean;
  isLinked(runnerId: string): boolean;
  agentOf(runnerId: string): string | null;
  /** 붙어 있는 러너 전부를 끊는다(종료 경로). 러너 프로세스는 건드리지 않는다. */
  close(): void;
}

function secretsMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function createRunnerLinkServer(deps: RunnerLinkDeps): RunnerLinkServer {
  const maxLineBytes = deps.maxLineBytes ?? RUNNER_LINK_MAX_LINE_BYTES;
  const expected = new Map<string, { agentId: string; secret: string }>();
  const linked = new Map<string, LinkSocket>();
  /**
   * 받아들인 소켓 전부 — relay 와 bridge. `linked` 는 relay 만 담는다(러너당 하나, send 의 대상).
   * bridge 는 하네스 프로세스가 여는 것이라 러너보다 오래 살 수 있고, `close` 가 이것을
   * 안 끊으면 `net.Server.close()` 가 마지막 연결이 닫히길 영영 기다린다 — 앱 갱신 때
   * 옛 오퍼레이터가 종료 중에 멈춰 새 오퍼레이터가 엔드포인트를 얻지 못하던 원인(2026-09-21).
   */
  const accepted = new Set<LinkSocket>();

  const drop = (runnerId: string, socket: LinkSocket): void => {
    if (linked.get(runnerId) !== socket) return;
    linked.delete(runnerId);
    deps.onClose?.(runnerId);
  };

  const refuse = (req: RunnerLinkRequest, message: string): RunnerLinkResponse =>
    req.type === 'mcp.request'
      ? { type: 'mcp.error', id: req.id, status: 0, message }
      : { type: 'http.response', id: req.id, status: 0, body: message };

  /**
   * 답 한 줄을 쓴다. **상한 초과는 삼키지 않는다** — 같은 id 로 작은 거절을 대신 보낸다.
   * 삼키면 상대(브릿지)는 오지 않는 답을 시한(90초)까지 기다리고, 원인은 어디에도 안 남는다
   * (2026-10-02: 786KB 넘는 그림의 `attachment.fetch` 가 정확히 그렇게 사라졌다).
   */
  const writeAnswer = (socket: LinkSocket, req: RunnerLinkRequest, res: RunnerLinkResponse): void => {
    let line: string;
    try {
      line = encodeLine(res, maxLineBytes);
    } catch (err) {
      const why = err instanceof LineTooLongError
        ? `응답이 ${err.byteLength} 바이트로 러너 링크 한 줄 상한(${err.limit} 바이트)을 넘어 전달하지 못했다`
        : `응답을 러너 링크 한 줄로 만들지 못했다: ${err instanceof Error ? err.message : String(err)}`;
      deps.log(`러너 링크 답을 거절로 바꿔 보낸다: id=${req.id} — ${why}`);
      line = encodeLine(refuse(req, why), maxLineBytes);
    }
    try { socket.write(line); } catch { /* 끊긴 소켓 — 답할 곳이 없다 */ }
  };

  const handleLine = (runnerId: string, agentId: string, socket: LinkSocket, kind: 'relay' | 'bridge', value: unknown): void => {
    if (isRunnerLinkRequest(value)) {
      const answer = deps.onRequest
        ? deps.onRequest(runnerId, agentId, value).catch((err: unknown) => refuse(value, err instanceof Error ? err.message : String(err)))
        : Promise.resolve(refuse(value, '이 오퍼레이터에는 전달이 배선되지 않았다'));
      void answer.then((res) => { writeAnswer(socket, value, res); });
      return;
    }
    // 브릿지는 PTY 를 모른다 — 요청이 아닌 것은 버린다.
    if (kind === 'bridge') return;
    // 통지는 **릴레이 프레임보다 먼저** 가른다. 아래로 흘려보내면 `wrapRunnerFrame` 이
    // 모르는 타입으로 null 을 돌려 조용히 사라진다 — 그러면 회수 게이트가 영영 안 열린다.
    if (isRunnerLinkNotice(value)) { deps.onNotice?.(runnerId, agentId, value); return; }
    // 얕게만 본다 — 타입 문자열이 있으면 릴레이 프레임으로 넘긴다. 깊은 검증은 서버 허브의 일이다.
    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string') return;
    deps.onFrame(runnerId, agentId, value as RelayRunnerFrame);
  };

  return {
    expect(runnerId, agentId, secret) { expected.set(runnerId, { agentId, secret }); },
    forget(runnerId) {
      expected.delete(runnerId);
      const socket = linked.get(runnerId);
      if (socket) { linked.delete(runnerId); socket.destroy(); }
    },

    accept(socket, hello, pending, buffered) {
      const claim = checkRunnerHello(hello);
      const entry = claim ? expected.get(claim.runnerId) : undefined;
      if (!claim || !entry || !secretsMatch(entry.secret, claim.secret)) {
        deps.log(`러너 링크 거절: ${claim ? `runnerId=${claim.runnerId}` : 'hello 형식 아님'} — 모르는 러너이거나 secret 이 다르다`);
        socket.destroy();
        return false;
      }
      const { runnerId, kind } = claim;
      if (kind === 'relay') {
        // 같은 러너가 다시 붙으면 앞 소켓을 놓는다 — 러너 재접속이 앞 소켓의 close 보다 먼저 올 수 있다.
        const previous = linked.get(runnerId);
        if (previous && previous !== socket) { linked.delete(runnerId); previous.destroy(); }
        linked.set(runnerId, socket);
      }

      const decoder = new NdjsonDecoder(maxLineBytes);
      const onChunk = (chunk: Buffer): void => {
        for (const line of decoder.push(chunk)) {
          if (!line.ok) {
            if (line.error.code === 'line-too-long') {
              // 넘긴 줄은 이미 버려져 id 를 모른다 — 답 대신 끊고, 이유는 로그에 남긴다.
              // 브릿지는 끊김을 보고 나간 요청 전부를 즉시 실패로 답한다(시한을 안 기다린다).
              deps.log(`러너 링크(${kind}) 줄이 상한을 넘어 끊는다: runnerId=${runnerId} ${line.error.message}`);
              if (kind === 'relay') drop(runnerId, socket);
              socket.destroy();
            }
            continue;
          }
          handleLine(runnerId, entry.agentId, socket, kind, line.value);
        }
      };
      socket.removeAllListeners('data');
      socket.on('data', onChunk);
      accepted.add(socket);
      socket.on('close', () => accepted.delete(socket));
      if (kind === 'relay') {
        socket.on('close', () => drop(runnerId, socket));
        socket.on('error', () => drop(runnerId, socket));
      } else {
        socket.on('error', () => socket.destroy());
      }
      for (const value of pending) handleLine(runnerId, entry.agentId, socket, kind, value);
      if (buffered !== undefined && buffered.length > 0) onChunk(buffered);
      deps.log(`러너 링크 연결(${kind}): runnerId=${runnerId} agent=${entry.agentId}`);
      return true;
    },

    send(runnerId, frame) {
      const socket = linked.get(runnerId);
      if (!socket) return false;
      try { socket.write(encodeLine(frame, maxLineBytes)); return true; } catch { return false; }
    },

    sendNotice(runnerId, notice) {
      const socket = linked.get(runnerId);
      if (!socket) return false;
      try { socket.write(encodeLine(notice, maxLineBytes)); return true; } catch { return false; }
    },

    isLinked: (runnerId) => linked.has(runnerId),
    agentOf: (runnerId) => expected.get(runnerId)?.agentId ?? null,

    close() {
      for (const [runnerId, socket] of linked) { linked.delete(runnerId); socket.destroy(); }
      // bridge 도 끊는다 — 하네스의 MCP 호출은 끊긴 소켓에서 오류를 받고, 러너는 재접속한다.
      for (const socket of accepted) { accepted.delete(socket); socket.destroy(); }
    },
  };
}
