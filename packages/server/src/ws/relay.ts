// 러너 PTY ↔ 서버 ↔ 데스크탑 xterm 바이트 릴레이의 인메모리 레지스트리(스펙 §5 "릴레이").
//
// **서버는 불투명 우체국이다**(스펙 §2). 이 파일은 프레임의 봉투(JSON)만 열어 `sessionId`
// 를 읽고, 바이트(`data`, base64)는 **문자열 그대로** 옮긴다 — 한 번도 디코드하지 않는다.
// 디코드하면 두 가지가 동시에 깨진다: 청크 경계에서 잘린 UTF-8 이 U+FFFD 로 치환되고
// (되돌릴 수 없다), ANSI 이스케이프 시퀀스가 조각나 xterm 이 화면을 재구성하지 못한다.
// `packages/agent/src/pty.ts` 의 `RingBuffer` 가 일부러 문자 경계 정렬을 하지 않는 것과
// 같은 규율의 서버 쪽 절반이다.
//
// **PTY 바이트를 DB·로그에 남기지 않는다.** PTY 출력에는 하네스가 화면에 그린 것이 전부
// 들어간다 — 토큰, 환경변수, 사람이 붙여 넣은 비밀. 스크롤백이 러너 메모리의 ring buffer
// 에만 사는 이유가 그것이고(스펙 §5), 그래서 이 파일에는 바이트를 찍는 `log` 호출도,
// 바이트를 담는 `recordAudit` detail 도 없다. 감사에는 attach/detach 와 **바이트 수**만
// 간다(라우트 쪽).
//
// **이벤트 버스(`events.ts`)를 타지 않는다.** 그쪽은 단일 브로드캐스트 + audience 필터라,
// 세션 바이트를 흘리면 워크스페이스의 모든 소켓이 PTY 출력을 받는다. 릴레이는 여기의
// 전용 맵으로 러너 소켓과 뷰어 소켓을 직결한다.

import type {
  AgentSessionState,
  AgentSessionView,
  AttachServerFrame,
  RelayRunnerFrame,
  RelayServerFrame,
} from '@murmur/shared';

/**
 * 소켓의 최소 표면. `@fastify/websocket` 의 소켓도 테스트의 가짜도 이 모양이면 된다 —
 * 허브가 ws 구현을 몰라야 프레임 순서·재생 순서를 소켓 없이 검증할 수 있다.
 */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Viewer {
  socket: RelaySocket;
  /**
   * ring buffer 재생을 아직 기다리는 중인가. true 인 동안 라이브 바이트는 `queued` 에
   * 담아 두고 재생 뒤에 흘린다 — 안 그러면 xterm 이 최신 바이트를 먼저 그린 뒤 과거
   * 화면으로 덮어써서, 사람이 보는 것이 "지금"이 아니라 "조금 전"이 된다.
   */
  awaitingReplay: boolean;
  /** 재생 전에 도착한 라이브 바이트(base64 문자열 그대로). */
  queued: string[];
}

interface Runner {
  socket: RelaySocket;
  /** 이 러너가 announce 한 세션들. 소켓이 끊기면 통째로 버린다. */
  sessions: Map<string, AgentSessionView>;
}

export interface RelayHub {
  /**
   * 러너 소켓을 등록한다. 같은 에이전트로 두 번째 러너가 붙으면 **앞의 것을 끊는다** —
   * 에이전트당 러너는 하나이고, 둘을 남겨 두면 같은 세션 id 를 두 러너가 주장할 때
   * 어느 쪽 바이트가 진짜인지 판정할 근거가 없다.
   */
  addRunner(agentAccountId: string, socket: RelaySocket): () => void;
  /** 러너가 보낸 원문 프레임 한 개를 처리한다. 파싱 실패·모르는 타입은 조용히 버린다. */
  onRunnerMessage(agentAccountId: string, raw: string): void;

  /** 이 계정이 볼 수 있는 세션들. `agentAccountIds` 가 'all' 이면 admin 이다. */
  listSessions(agentAccountIds: readonly string[] | 'all'): AgentSessionView[];
  /** 세션 하나. 없으면 null — 끝난 세션과 없던 세션을 여기서 구분하지 않는다. */
  getSession(sessionId: string): AgentSessionView | null;

  /**
   * 뷰어를 세션에 붙인다. 반환값을 부르면 구독이 끊긴다(패널을 닫는 경로).
   * 붙는 즉시 상태를 보내고, 러너가 살아 있으면 ring buffer 재생을 요청한다.
   */
  addViewer(sessionId: string, socket: RelaySocket): () => void;

  /**
   * 사람이 친 바이트를 그 세션의 러너에게 넘긴다(#315). `data` 는 base64 이고, 여기서도
   * **열지 않는다** — 출력과 같은 규율이다(파일 머리 주석). 러너가 없거나 세션을 모르면
   * false 다: 인가는 라우트가 이미 했으므로 여기서 거절하는 것은 "러너가 없다" 뿐이다.
   */
  sendInput(sessionId: string, data: string): boolean;

  /**
   * 소유자 패널의 크기를 그 세션의 PTY 에 반영한다(#335). `sendInput` 과 같은 자리에
   * 두는 이유는 같은 소켓·같은 게이트를 타기 때문이다(라우트가 판정한다).
   *
   * **`sendInput` 과 다른 점이 하나 있다: 붙은 뷰어가 없으면 false 다.** 입력은 뷰어
   * 소켓에서만 들어오므로 "아무도 안 붙어 있다"가 구조적으로 불가능하지만, 크기는
   * 마지막 뷰어가 떠난 뒤에 늦게 도착한 프레임으로도 올 수 있다 — 아무도 보고 있지
   * 않은 PTY 의 크기를 바꿀 이유는 없고, 바꾸면 그 뒤에 붙는 사람이 남의 창 크기를
   * 물려받는다.
   */
  sendResize(sessionId: string, cols: number, rows: number): boolean;
}

export function createRelayHub(): RelayHub {
  const runners = new Map<string, Runner>();
  /** sessionId → 그 세션을 가진 에이전트 계정. 세션 조회를 러너 순회 없이 하려고 둔다. */
  const ownerOf = new Map<string, string>();
  const viewers = new Map<string, Set<Viewer>>();

  const sendTo = (viewer: Viewer, frame: AttachServerFrame): void => {
    // 이미 닫힌 소켓에 쓰면 ws 가 던진다 — 한 뷰어의 죽은 소켓이 나머지 중계를 멈추면
    // 안 되므로 여기서 삼킨다. close 핸들러가 곧 이 뷰어를 목록에서 뺀다.
    try { viewer.socket.send(JSON.stringify(frame)); } catch { /* 죽은 소켓은 close 가 정리한다 */ }
  };

  const broadcastStatus = (sessionId: string, state: AgentSessionState): void => {
    for (const viewer of viewers.get(sessionId) ?? []) sendTo(viewer, { type: 'status', state });
  };

  const sendToRunner = (runner: Runner, frame: RelayServerFrame): void => {
    try { runner.socket.send(JSON.stringify(frame)); } catch { /* 끊긴 러너는 close 가 정리한다 */ }
  };

  const registerSession = (agentAccountId: string, session: AgentSessionView): void => {
    const runner = runners.get(agentAccountId);
    if (!runner) return;
    runner.sessions.set(session.sessionId, session);
    ownerOf.set(session.sessionId, agentAccountId);
  };

  const dropSession = (agentAccountId: string, sessionId: string): void => {
    runners.get(agentAccountId)?.sessions.delete(sessionId);
    // 세션이 끝나도 뷰어 소켓은 열려 있다 — 사람이 마지막 화면을 계속 보고 있을 수 있다.
    // '끝났다'만 알리고 소켓은 그대로 둔다(닫는 것은 사람의 몫이다).
    broadcastStatus(sessionId, 'ended');
    ownerOf.delete(sessionId);
  };

  return {
    addRunner(agentAccountId, socket) {
      const previous = runners.get(agentAccountId);
      if (previous && previous.socket !== socket) {
        for (const sessionId of previous.sessions.keys()) {
          broadcastStatus(sessionId, 'runner-offline');
          ownerOf.delete(sessionId);
        }
        previous.socket.close(4409, 'replaced by a newer runner connection');
      }
      const runner: Runner = { socket, sessions: new Map() };
      runners.set(agentAccountId, runner);

      return () => {
        // 이미 다른 러너로 교체됐다면 그쪽 등록을 지우지 않는다 — 재접속이 앞 소켓의
        // close 보다 먼저 도착하는 순서가 실제로 생긴다(백오프 재접속 경로).
        if (runners.get(agentAccountId) !== runner) return;
        runners.delete(agentAccountId);
        for (const sessionId of runner.sessions.keys()) {
          // 러너가 사라진 것은 '턴이 끝났다'와 다른 사실이다. 뷰어가 그것을 구분해야
          // "기다리면 돌아온다"와 "이 턴은 끝났다"를 화면에 다르게 말할 수 있다.
          broadcastStatus(sessionId, 'runner-offline');
          ownerOf.delete(sessionId);
        }
      };
    },

    onRunnerMessage(agentAccountId, raw) {
      let parsed: unknown;
      // 러너는 무엇이든 보낼 수 있다 — 파싱 실패로 서버가 죽지 않아야 한다.
      try { parsed = JSON.parse(raw); } catch { return; }
      if (typeof parsed !== 'object' || parsed === null) return;
      const frame = parsed as RelayRunnerFrame;

      switch (frame.type) {
        case 'announce': {
          if (!Array.isArray(frame.sessions)) return;
          // 재접속마다 다시 온다. 러너가 진실의 원천이므로 이전 목록을 **교체**한다 —
          // 합집합으로 두면 러너가 재시작해 사라진 세션이 서버에 영구히 남는다.
          const runner = runners.get(agentAccountId);
          if (!runner) return;
          for (const sessionId of runner.sessions.keys()) ownerOf.delete(sessionId);
          runner.sessions.clear();
          for (const session of frame.sessions) registerSession(agentAccountId, session);
          return;
        }
        case 'session.started':
          if (!frame.session?.sessionId) return;
          registerSession(agentAccountId, frame.session);
          broadcastStatus(frame.session.sessionId, 'running');
          return;
        case 'session.ended':
          if (typeof frame.sessionId !== 'string') return;
          dropSession(agentAccountId, frame.sessionId);
          return;
        case 'output': {
          if (typeof frame.sessionId !== 'string' || typeof frame.data !== 'string') return;
          // 이 세션이 정말 이 러너의 것인지 확인한다 — 안 하면 러너 하나가 남의 세션
          // id 로 프레임을 보내 그 세션의 뷰어에게 바이트를 밀어 넣을 수 있다.
          if (ownerOf.get(frame.sessionId) !== agentAccountId) return;
          for (const viewer of viewers.get(frame.sessionId) ?? []) {
            // ★ `frame.data` 를 **그대로** 옮긴다. Buffer 로 되돌렸다가 다시 싣거나
            //   문자열로 디코드하면 잘린 UTF-8·ANSI 가 깨진다(파일 머리 주석).
            if (viewer.awaitingReplay) viewer.queued.push(frame.data);
            else sendTo(viewer, { type: 'output', data: frame.data });
          }
          return;
        }
        case 'replay': {
          if (typeof frame.sessionId !== 'string' || typeof frame.data !== 'string') return;
          if (ownerOf.get(frame.sessionId) !== agentAccountId) return;
          for (const viewer of viewers.get(frame.sessionId) ?? []) {
            if (!viewer.awaitingReplay) continue;
            // 재생이 먼저, 그동안 쌓인 라이브가 그다음. 빈 재생도 그대로 보낸다 —
            // 빈 것을 걸러 내면 "아직 아무 출력도 없는 턴"과 "재생을 못 받았다"가 같아진다.
            sendTo(viewer, { type: 'output', data: frame.data });
            viewer.awaitingReplay = false;
            for (const queued of viewer.queued) sendTo(viewer, { type: 'output', data: queued });
            viewer.queued = [];
          }
          return;
        }
        default:
          return;
      }
    },

    listSessions(agentAccountIds) {
      const out: AgentSessionView[] = [];
      for (const [agentAccountId, runner] of runners) {
        if (agentAccountIds !== 'all' && !agentAccountIds.includes(agentAccountId)) continue;
        out.push(...runner.sessions.values());
      }
      return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },

    getSession(sessionId) {
      const agentAccountId = ownerOf.get(sessionId);
      if (!agentAccountId) return null;
      return runners.get(agentAccountId)?.sessions.get(sessionId) ?? null;
    },

    sendInput(sessionId, data) {
      const agentAccountId = ownerOf.get(sessionId);
      const runner = agentAccountId ? runners.get(agentAccountId) : undefined;
      if (!runner) return false;
      // ★ `data` 를 **그대로** 옮긴다. 되돌렸다 싣거나 문자열로 디코드하면 사람이 친
      //   제어 바이트(Ctrl-C, 화살표, 붙여 넣은 멀티바이트)가 깨진다.
      sendToRunner(runner, { type: 'input', sessionId, data });
      return true;
    },

    sendResize(sessionId, cols, rows) {
      // **아무도 안 붙어 있으면 아무 일도 안 일어난다**(위 인터페이스 주석).
      if (!viewers.get(sessionId)?.size) return false;
      const agentAccountId = ownerOf.get(sessionId);
      const runner = agentAccountId ? runners.get(agentAccountId) : undefined;
      if (!runner) return false;
      sendToRunner(runner, { type: 'resize', sessionId, cols, rows });
      return true;
    },

    addViewer(sessionId, socket) {
      const agentAccountId = ownerOf.get(sessionId);
      const runner = agentAccountId ? runners.get(agentAccountId) : undefined;
      const viewer: Viewer = { socket, awaitingReplay: Boolean(runner), queued: [] };
      let set = viewers.get(sessionId);
      if (!set) { set = new Set(); viewers.set(sessionId, set); }
      set.add(viewer);

      if (!runner) {
        // 러너가 없는 세션에 붙었다 — attach 인가와 핸드셰이크 사이에 러너가 끊긴 창이다.
        // 재생을 영원히 기다리지 않게 상태만 알린다.
        sendTo(viewer, { type: 'status', state: 'runner-offline' });
      } else {
        sendTo(viewer, { type: 'status', state: 'running' });
        sendToRunner(runner, { type: 'replay.request', sessionId });
      }

      return () => {
        const current = viewers.get(sessionId);
        if (!current) return;
        current.delete(viewer);
        if (!current.size) viewers.delete(sessionId);
      };
    },
  };
}
