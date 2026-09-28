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
 *
 * ## 소켓이 끊겨도 이 프로세스는 끝나지 않는다 (2026-09-22)
 *
 * 처음에는 **소켓 하나 = 프로세스 하나**였다. `close` 면 그대로 끝냈다. 그 전제가 실제로
 * 깨진 날의 기록:
 *
 * > 앱이 0.2.20 → 0.3.3 으로 갱신되며 오퍼레이터가 교체됐다. 옛 오퍼레이터는 종료하며
 * > 브릿지 소켓을 **일부러 전부 끊는다**(`runnerLink.ts` 의 `accepted` — 안 끊으면
 * > `net.Server.close()` 가 마지막 연결을 영영 기다려 새 오퍼레이터가 엔드포인트를 못 얻는다).
 * > 그 순간 진행 중이던 턴의 `message.post`·`message.read` 는 **답 없이 증발했고**, 하네스는
 * > 영원히 기다렸다. 턴이 안 끝나니 러너가 물러나지 못하고, 러너가 안 물러나니 교체 러너가
 * > 못 떠서, 그 에이전트는 30분간 멘션을 아무도 안 집었다.
 *
 * 즉 **끊김은 사고가 아니라 교체할 때마다 반드시 일어나는 일**이다. 그래서 이 모듈은 두
 * 가지를 지킨다:
 *
 * 1. **다시 붙는다.** 같은 소켓 경로에 백오프로 재접속한다. id·secret 은 env 에 그대로
 *    있고, 새 오퍼레이터는 회수 대상 러너의 secret 까지 `expect()` 에 다시 적어 둔다
 *    (`run.ts` 의 `adoptOrphans`, #838) — 붙기만 하면 인증은 통과한다. 러너 코어의 relay 는
 *    이미 그렇게 하고 있었고(`agent/src/relay.ts`), 브릿지만 안 하고 있었다.
 * 2. **stdin 이 닫히는 것만이 끝이다.** 소켓이 끊겼다고 여기서 물러나면 하네스는 MCP 서버를
 *    통째로 잃고, 그 턴은 도구 없이 남는다.
 *
 * ## 열린 요청은 실패로 **답한다**. 다시 보내지는 않는다
 *
 * 끊긴 순간 열려 있던 요청은 전부 JSON-RPC 오류로 답한다 — 원래 `error` 경로만 하던 일을
 * `close` 도 하게 한 것이다. 그 둘이 갈려 있던 것이 위 사고에서 답이 증발한 자리다(상대
 * 프로세스가 **정상 종료**하면 `error` 가 아니라 `close` 다).
 *
 * **재전송은 하지 않는다.** `message.post` 를 다시 보내면 같은 말이 두 번 나간다. 요청이
 * 처리됐는지 안 됐는지는 이쪽에서 알 방법이 없으므로, 오류 본문에 그 불확실성을 적고 판단을
 * 에이전트에게 넘긴다 — 그쪽은 스레드를 읽어 확인할 수 있다.
 *
 * 아직 **보내지 못한**(끊긴 동안 stdin 으로 들어와 큐에 쌓인) 줄은 다르다. 그것은 소켓에
 * 나간 적이 없으니 재접속 뒤 그대로 보내도 중복이 아니다.
 *
 * ## 다만 큐는 짧게만 참는다
 *
 * 교체는 보통 몇 초다. 그 몇 초를 큐로 덮으면 에이전트는 끊김을 **아예 안 겪는다** — 그것이
 * 이 큐의 값이다. 그런데 오퍼레이터가 영영 안 돌아오는 경우까지 큐로 참으면, 모든 호출이
 * 시한(90초)을 꽉 채우고서야 실패한다. 예전 코드가 그 경우 **즉시** 죽어 하네스에게 빠르게
 * 실패를 알려 주던 것보다 나쁘다.
 *
 * 그래서 링크가 `DEFAULT_LINK_DOWN_GRACE_MS` 넘게 없으면 그때부터는 **바로 거절한다.**
 * 러너 코어의 relay 가 같은 판단을 이미 하고 있다(`agent/src/relay.ts`: *"링크가 없으면 즉시
 * 거절한다 — 큐에 담아 두면 25초 롱폴이 링크 뒤에서 쌓여 …"*). 다른 점은 유예 하나뿐이고,
 * 그 유예가 바로 이 모듈이 고치려는 사고의 폭이다.
 *
 * ## 시한 — 매달리지 않는 것이 감지보다 싸다
 *
 * 요청 하나가 `DEFAULT_REQUEST_TIMEOUT_MS` 를 넘기면 오류로 답한다. 재접속(1)이 못 덮는
 * 경우 — 소켓은 살아 있는데 답이 안 오는 경우 — 가 여기 걸린다. 위 사고에서 에이전트는
 * 답이 안 오자 `sleep` 루프를 돌았고, 그 루프가 러너의 하네스 정지 감지(`기록이 자라는가`)까지
 * 속였다. 감지를 정교하게 만드는 것보다 **호출이 매달리지 않게 하는 것**이 싸고 확실하다.
 */
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { NdjsonDecoder } from '@harkroom/shared/daemonProtocol';
import {
  RUNNER_LINK_PROTOCOL_VERSION, isRunnerLinkResponse, type RunnerHello, type RunnerLinkRequest,
} from '@harkroom/shared/runnerLink';

export interface BridgeLink { socketPath: string; runnerId: string; secret: string }

export interface BridgeStdio { stdin: Readable; stdout: Writable; stderr: Writable }

/** 취소할 수 있는 예약 하나. 회귀선이 시간을 직접 돌리려고 표면으로 뽑아 뒀다. */
export interface BridgeTimer { cancel(): void }

/** 시한과 재접속 간격. 기본값을 쓰는 것이 정상이고, 주입은 회귀선의 몫이다. */
export interface BridgeTuning {
  requestTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  linkDownGraceMs?: number;
  schedule?: (fn: () => void, ms: number) => BridgeTimer;
}

/**
 * 요청 하나의 시한.
 *
 * 위아래가 다 막혀 있는 값이다: **25초 롱폴(`inbox.poll`)보다는 넉넉히 길고**, 하네스가
 * 스스로 도구 호출을 백그라운드로 넘기는 시각(claude-code 실측 120초)보다는 **짧아야 한다.**
 * 짧아야 하는 이유는 그 순간의 차이다 — 우리가 먼저 답하면 에이전트는 "실패했다"를 알고
 * 다음 수를 두지만, 하네스가 먼저 넘기면 에이전트는 "아직 기다리는 중"으로 남는다.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
/** 첫 재접속 지연. 오퍼레이터 교체는 보통 몇 초 안에 끝나므로 촘촘히 시작한다. */
export const DEFAULT_RECONNECT_INITIAL_MS = 200;
/** 재접속 지연의 상한. 오퍼레이터가 영영 안 돌아와도 이 주기로만 두드린다. */
export const DEFAULT_RECONNECT_MAX_MS = 5_000;
/**
 * 링크가 없는 동안 요청을 큐에 참아 주는 시간. 이 뒤로는 바로 거절한다 — 모듈 주석의
 * "큐는 짧게만 참는다". 오퍼레이터 교체 실측이 몇 초였으므로 그 몇 배로 잡았다.
 */
export const DEFAULT_LINK_DOWN_GRACE_MS = 15_000;
/** 링크가 유예를 넘겨 없을 때 요청에 돌려주는 말. relay 의 `LINK_DOWN_MESSAGE` 와 같은 뜻이다. */
export const LINK_DOWN_MESSAGE = '오퍼레이터 링크가 없다 — 재접속 중이다. 잠시 뒤 다시 불러라';

const defaultSchedule = (fn: () => void, ms: number): BridgeTimer => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

/** 링크 위의 요청 하나. `rpcId` 는 오류 응답을 만들 때 쓴다(알림은 `null`). */
interface PendingRequest { rpcId: unknown; timer: BridgeTimer }

export function runMcpBridge(link: BridgeLink, io: BridgeStdio, tuning: BridgeTuning = {}): Promise<void> {
  const requestTimeoutMs = tuning.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconnectInitialMs = tuning.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
  const reconnectMaxMs = tuning.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const linkDownGraceMs = tuning.linkDownGraceMs ?? DEFAULT_LINK_DOWN_GRACE_MS;
  const schedule = tuning.schedule ?? defaultSchedule;

  return new Promise<void>((resolve) => {
    const pending = new Map<string, PendingRequest>();
    const stdinDecoder = new NdjsonDecoder();
    /** 아직 소켓에 못 나간 줄들. **보낸 적이 없으므로** 재접속 뒤 그대로 보낸다. */
    const queued: { id: string; line: string }[] = [];
    let socket: Socket | null = null;
    let connected = false;
    let finished = false;
    let reconnectDelayMs = reconnectInitialMs;
    let reconnectTimer: BridgeTimer | null = null;
    /** 유예를 넘겨 링크가 없다 — 이 동안 들어오는 요청은 큐에 안 담고 바로 거절한다. */
    let linkDownHard = false;
    let graceTimer: BridgeTimer | null = null;

    // stdout 이 이미 닫혔을 수 있다(하네스가 먼저 갔다). 그때의 `EPIPE` 로 타이머 안에서
    // 프로세스가 죽지 않게 한다 — 여기서 할 수 있는 일은 안 쓰는 것뿐이다.
    const writeOut = (message: unknown): void => {
      try { io.stdout.write(`${JSON.stringify(message)}\n`); } catch { /* 하네스가 이미 갔다 */ }
    };
    const note = (line: string): void => {
      try { io.stderr.write(`${line}\n`); } catch { /* 로그는 없어도 된다 */ }
    };
    /** 알림(id 없음)의 실패는 답할 상대가 없다 — 요청이었을 때만 오류 응답을 만든다. */
    const answerError = (rpcId: unknown, message: string): void => {
      if (rpcId === null || rpcId === undefined) return;
      writeOut({ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message } });
    };

    const forget = (id: string): PendingRequest | undefined => {
      const entry = pending.get(id);
      if (entry === undefined) return undefined;
      entry.timer.cancel();
      pending.delete(id);
      // 아직 못 나간 줄이면 큐에서도 뺀다. 남겨 두면 재접속 뒤에 **답할 사람이 없는 요청**이
      // 나가고, 그것이 `message.post` 면 이미 시한으로 실패를 알린 말이 뒤늦게 발화된다.
      const q = queued.findIndex((e) => e.id === id);
      if (q >= 0) queued.splice(q, 1);
      return entry;
    };

    /**
     * **소켓에 이미 나간** 요청 전부를 실패로 답한다. 재전송하지 않는다 — 모듈 주석 참조.
     *
     * 큐에만 있는 줄은 건드리지 않는다. 그것은 나간 적이 없으니 실패가 아니라 **아직 안 보낸
     * 것**이고, 재접속이 곧 그대로 보낸다(그 줄들을 포기시키는 것은 유예 시계의 몫이다).
     */
    const failSentPending = (message: string): void => {
      const notSent = new Set(queued.map((e) => e.id));
      for (const [id, entry] of [...pending]) {
        if (notSent.has(id)) continue;
        pending.delete(id);
        entry.timer.cancel();
        answerError(entry.rpcId, message);
      }
    };

    const finish = (): void => {
      if (finished) return;
      finished = true;
      reconnectTimer?.cancel();
      reconnectTimer = null;
      graceTimer?.cancel();
      graceTimer = null;
      for (const [, entry] of pending) entry.timer.cancel();
      pending.clear();
      socket?.destroy();
      socket = null;
      resolve();
    };

    const openSocket = (): void => {
      if (finished) return;
      const s = connect(link.socketPath);
      const decoder = new NdjsonDecoder(); // 연결마다 새 프레임 경계다.
      socket = s;
      s.on('connect', () => {
        connected = true;
        linkDownHard = false;
        graceTimer?.cancel();
        graceTimer = null;
        reconnectDelayMs = reconnectInitialMs;
        // hello 가 **첫 줄**이어야 한다. 그 뒤에 큐에 쌓인 줄을 순서대로 흘린다.
        const hello: RunnerHello = {
          type: 'hello', version: RUNNER_LINK_PROTOCOL_VERSION, role: 'runner',
          runnerId: link.runnerId, secret: link.secret, kind: 'bridge',
        };
        s.write(`${JSON.stringify(hello)}\n`);
        for (const entry of queued.splice(0)) s.write(entry.line);
      });
      s.on('data', (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          if (!line.ok || !isRunnerLinkResponse(line.value)) continue;
          const res = line.value;
          const entry = forget(res.id);
          if (entry === undefined) continue;
          if (res.type === 'mcp.response') {
            for (const m of res.messages) writeOut(m);
          } else if (res.type === 'mcp.error') {
            answerError(entry.rpcId, `harkroom 서버가 거절했다 (${res.status}): ${res.message}`);
          }
        }
      });
      // `error` 뒤에는 반드시 `close` 가 온다. 그래서 **처리는 `close` 한 곳**이다 —
      // 둘을 갈라 놓은 것이 2026-09-22 사고에서 답이 증발한 자리다(모듈 주석).
      s.on('error', (err: Error) => { note(`오퍼레이터 소켓 오류: ${err.message}`); });
      s.on('close', () => { if (socket === s) onDisconnected(); });
    };

    const onDisconnected = (): void => {
      if (finished) return;
      const wasConnected = connected;
      connected = false;
      socket = null;
      failSentPending(
        '오퍼레이터 링크가 끊겼다(오퍼레이터 교체·재시작) — 이 요청이 처리됐는지는 알 수 없다. '
        + '결과를 확인한 뒤에 다시 불러라. 링크는 곧 스스로 다시 붙는다',
      );
      if (wasConnected) note('오퍼레이터 링크가 끊겼다 — 다시 붙는다');
      // 유예 시계는 **끊긴 동안 한 번만** 돈다. 재접속 실패로 close 가 반복될 때마다 다시
      // 걸면 시계가 영원히 처음으로 돌아가 유예가 끝나지 않는다.
      if (graceTimer === null && !linkDownHard) {
        graceTimer = schedule(() => {
          graceTimer = null;
          if (connected || finished) return;
          linkDownHard = true;
          // 아직 못 나간 줄은 여기서 거절한다 — 시한(90초)까지 들고 있을 이유가 없다.
          for (const entry of queued.splice(0)) {
            const p = pending.get(entry.id);
            if (p === undefined) continue;
            pending.delete(entry.id);
            p.timer.cancel();
            answerError(p.rpcId, LINK_DOWN_MESSAGE);
          }
          note(`오퍼레이터 링크가 ${linkDownGraceMs}ms 째 없다 — 이제부터 요청을 바로 거절한다`);
        }, linkDownGraceMs);
      }
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        openSocket();
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxMs);
    };

    io.stdin.on('data', (chunk: Buffer | string) => {
      for (const line of stdinDecoder.push(chunk)) {
        if (!line.ok) continue;
        const payload = line.value;
        const id = randomUUID();
        const rpcId = typeof payload === 'object' && payload !== null ? (payload as { id?: unknown }).id ?? null : null;
        if (linkDownHard) { answerError(rpcId, LINK_DOWN_MESSAGE); continue; }
        // 시한은 **stdin 에 들어온 순간부터** 잰다. 소켓에 나간 순간이 아니다 — 끊겨 있는
        // 동안 큐에 쌓인 요청도 똑같이 매달릴 수 있고, 그쪽이 더 오래 매달린다.
        const timer = schedule(() => {
          if (!pending.has(id)) return;
          forget(id);
          answerError(
            rpcId,
            `harkroom 오퍼레이터가 ${requestTimeoutMs}ms 안에 답하지 않았다 — `
            + '이 요청이 처리됐는지는 알 수 없다. 결과를 확인한 뒤에 다시 불러라',
          );
        }, requestTimeoutMs);
        pending.set(id, { rpcId, timer });
        const req: RunnerLinkRequest = { type: 'mcp.request', id, payload };
        const text = `${JSON.stringify(req)}\n`;
        if (connected && socket !== null) socket.write(text);
        else queued.push({ id, line: text });
      }
    });
    // **여기가 이 프로세스의 유일한 끝이다.** 하네스가 stdin 을 닫았다는 것은 이 MCP 서버를
    // 더 쓰지 않겠다는 뜻이고, 소켓이 끊긴 것은 그런 뜻이 아니다.
    io.stdin.on('end', () => finish());
    io.stdin.on('error', () => finish());

    openSocket();
  });
}
