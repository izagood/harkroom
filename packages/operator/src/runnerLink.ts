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
import { encodeLine, NdjsonDecoder } from '@harkroom/shared/daemonProtocol';
import { checkRunnerHello } from '@harkroom/shared/runnerLink';

/** `net.Socket` 의 최소 표면. 테스트가 가짜를 준다. */
export interface LinkSocket {
  write(line: string): boolean;
  destroy(): void;
  on(event: 'data', fn: (chunk: Buffer) => void): this;
  on(event: 'close' | 'error', fn: () => void): this;
  removeAllListeners(event: string): this;
}

export interface RunnerLinkDeps {
  /** 인증된 러너의 프레임. `agentId` 는 `expect` 가 적어 둔 값이다 — 러너의 주장이 아니다. */
  onFrame(runnerId: string, agentId: string, frame: RelayRunnerFrame): void;
  onClose?(runnerId: string): void;
  log(line: string): void;
}

export interface RunnerLinkServer {
  /** spawn 직전에 적는다. 같은 runnerId 를 다시 적으면 덮어쓴다(재spawn). */
  expect(runnerId: string, agentId: string, secret: string): void;
  /** 러너가 죽었다 — 그 secret 으로는 더 못 붙는다. */
  forget(runnerId: string): void;
  /**
   * `DaemonServer` 가 첫 줄을 읽고 넘긴다. `pending` 은 같은 청크에 hello 뒤로 이미 풀린
   * 줄들이다 — 여기서 받지 않으면 그 줄들이 사라진다(첫 announce 가 정확히 그 자리에 온다).
   * 거절이면 소켓을 끊고 false.
   */
  accept(socket: LinkSocket, hello: unknown, pending: unknown[]): boolean;
  send(runnerId: string, frame: RelayServerFrame): boolean;
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
  const expected = new Map<string, { agentId: string; secret: string }>();
  const linked = new Map<string, LinkSocket>();

  const drop = (runnerId: string, socket: LinkSocket): void => {
    if (linked.get(runnerId) !== socket) return;
    linked.delete(runnerId);
    deps.onClose?.(runnerId);
  };

  const handleLine = (runnerId: string, agentId: string, value: unknown): void => {
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

    accept(socket, hello, pending) {
      const claim = checkRunnerHello(hello);
      const entry = claim ? expected.get(claim.runnerId) : undefined;
      if (!claim || !entry || !secretsMatch(entry.secret, claim.secret)) {
        deps.log(`러너 링크 거절: ${claim ? `runnerId=${claim.runnerId}` : 'hello 형식 아님'} — 모르는 러너이거나 secret 이 다르다`);
        socket.destroy();
        return false;
      }
      const { runnerId } = claim;
      // 같은 러너가 다시 붙으면 앞 소켓을 놓는다 — 러너 재접속이 앞 소켓의 close 보다 먼저 올 수 있다.
      const previous = linked.get(runnerId);
      if (previous && previous !== socket) { linked.delete(runnerId); previous.destroy(); }
      linked.set(runnerId, socket);

      const decoder = new NdjsonDecoder();
      socket.removeAllListeners('data');
      socket.on('data', (chunk) => {
        for (const line of decoder.push(chunk)) {
          if (!line.ok) { if (line.error.code === 'line-too-long') drop(runnerId, socket), socket.destroy(); continue; }
          handleLine(runnerId, entry.agentId, line.value);
        }
      });
      socket.on('close', () => drop(runnerId, socket));
      socket.on('error', () => drop(runnerId, socket));
      for (const value of pending) handleLine(runnerId, entry.agentId, value);
      deps.log(`러너 링크 연결: runnerId=${runnerId} agent=${entry.agentId}`);
      return true;
    },

    send(runnerId, frame) {
      const socket = linked.get(runnerId);
      if (!socket) return false;
      try { socket.write(encodeLine(frame)); return true; } catch { return false; }
    },

    isLinked: (runnerId) => linked.has(runnerId),
    agentOf: (runnerId) => expected.get(runnerId)?.agentId ?? null,

    close() {
      for (const [runnerId, socket] of linked) { linked.delete(runnerId); socket.destroy(); }
    },
  };
}
