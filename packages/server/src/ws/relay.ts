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

import { randomUUID } from 'node:crypto';
import type {
  AgentSessionState,
  AgentSessionView,
  AttachClientFrame,
  AttachServerFrame,
  RelayRunnerFrame,
  RelayServerFrame,
  WriterDeniedReason,
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
  /**
   * 이 뷰어가 러너로 흘린 입력 바이트 누계(#315, 스펙 §5-2 결정 3). detach 감사가 이
   * 합산 하나만 남긴다. **base64 길이 산술로만 센다** — 바이트 수를 세려고 디코드하면
   * "서버는 `data` 를 열지 않는다"(파일 머리)가 그 자리에서 깨진다.
   */
  inputBytes: number;
}

interface Runner {
  socket: RelaySocket;
  /** 이 러너가 announce 한 세션들. 소켓이 끊기면 통째로 버린다. */
  sessions: Map<string, AgentSessionView>;
  /**
   * announce 가 선언한 개입 능력(#346). 선언이 없으면(구 러너) 빈 집합이다 — 그 러너로
   * `input` 을 흘리면 프레임이 조용히 버려져 사람은 쳤다고 믿는데 아무 데도 닿지 않는다.
   * 그래서 능력이 없으면 뷰어에 writer 차례 자체를 주지 않는다(`addViewer`).
   */
  caps: Set<string>;
}

/**
 * attach 한 뷰어 하나의 손잡이(#315). 라우트가 유일한 호출자다 — 소켓의 message/close
 * 이벤트를 이리로 넘기고, detach 감사에 `inputBytes()` 를 싣는다.
 */
export interface ViewerHandle {
  /** 구독을 끊는다(패널 닫힘·소켓 절단). writer 였다면 가장 최근 뷰어가 승계한다. */
  close(): void;
  /**
   * 뷰어 소켓에서 온 원문 프레임 하나를 처리한다. 반환은 "러너로 포워딩됐는가" —
   * writer 가 아니거나, 러너가 없거나, 프레임이 비정형이면 **조용히 버리고** false 다.
   * 버리는 것이 의도다: 읽기 전용 뷰어의 타이핑은 오류가 아니라 차례가 아닌 것뿐이다.
   */
  handleMessage(raw: string): boolean;
  /** 이 뷰어가 러너로 흘린 입력 바이트 누계. 내용은 여기 없다 — 수만 있다. */
  inputBytes(): number;
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
   * 뷰어를 세션에 붙인다. 붙는 즉시 상태를 보내고, 러너가 살아 있으면 ring buffer 재생을
   * 요청하며, **writer 차례를 이 뷰어로 넘긴다**(스펙 §5-2 결정 2 — 마지막 attach 가
   * writer). 입력 포워딩·바이트 누계도 반환 핸들이 갖는다 — writer 판정과 포워딩을 한
   * 곳(허브)에 두지 않으면 "누가 지금 쓰는가"의 진실이 라우트와 허브로 갈라진다.
   */
  addViewer(sessionId: string, socket: RelaySocket): ViewerHandle;

  /**
   * 러너에게 "이 스레드를 인터랙티브로 열어라"를 요청하고 응답을 기다린다(#337,
   * 스펙 §5-2 결정 4). requestId 로 `interactive.opened`/`interactive.error` 와 상관되고,
   * `timeoutMs`(기본 10초) 안에 응답이 없으면 `runner_timeout` 이다. 러너가 없으면
   * `no_runner`, caps 에 'interactive' 가 없으면 **기다리지 않고 즉시** `runner_outdated` —
   * 구 러너는 이 프레임을 버리므로 기다리는 것은 곧 원인 없는 타임아웃이다.
   */
  openInteractive(
    agentAccountId: string,
    req: { channelId: string; threadRootId: string; openedByHandle: string; cols?: number; rows?: number },
    opts?: { timeoutMs?: number },
  ): Promise<InteractiveOpenOutcome>;
}

export type InteractiveOpenOutcome =
  | { ok: true; sessionId: string; created: boolean }
  /** `message` 는 `runner_rejected` 일 때 러너가 보낸 사람용 문구다(codex 거절 등). */
  | { ok: false; reason: 'no_runner' | 'runner_outdated' | 'runner_timeout' | 'runner_rejected'; message?: string };

/**
 * base64 문자열이 담은 바이트 수 — **디코드 없이** 길이 산술로만 구한다. 감사에 남길
 * 입력 바이트 수가 이것뿐인데, 그 수를 세자고 디코드하면 "서버는 `data` 를 열지 않는다"
 * 가 감사 경로에서 깨진다.
 */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * PTY 창 크기로 받아들일 수 있는 값인가(#335). 여기서 막지 않으면 이 숫자가 러너의
 * `resize` 를 지나 ioctl 로 그대로 내려간다 — 0·음수·NaN·정수 아닌 값은 node-pty 가
 * 던지고, 터무니없이 큰 값은 러너가 그 크기의 화면 버퍼를 잡는다.
 *
 * 상한을 1000 으로 둔 이유: 실제 모니터에서 나올 수 있는 폭·높이보다 넉넉히 크면서,
 * 잘못된 값이 러너 메모리를 물어뜯지는 못하는 자리다.
 */
function isPtySize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000;
}

/** interactive.open 응답 대기의 기본 한도. 러너는 로컬 spawn 뿐이라 10초면 충분히 길다. */
const INTERACTIVE_OPEN_TIMEOUT_MS = 10_000;

export function createRelayHub(): RelayHub {
  const runners = new Map<string, Runner>();
  /**
   * interactive.open 의 미결 요청(#337). agentAccountId 를 함께 든다 — 응답 프레임이
   * **그 러너의 소켓에서** 왔는지 확인해, 다른 에이전트의 러너가 requestId 를 위조해
   * 남의 열기 요청을 가로채는 길을 막는다(output 의 ownerOf 검사와 같은 결).
   */
  const pendingOpens = new Map<string, {
    agentAccountId: string;
    resolve: (outcome: InteractiveOpenOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** sessionId → 그 세션을 가진 에이전트 계정. 세션 조회를 러너 순회 없이 하려고 둔다. */
  const ownerOf = new Map<string, string>();
  /** 배열이다 — 삽입 순서가 곧 attach 순서이고, writer 승계가 그 순서의 끝을 읽는다. */
  const viewers = new Map<string, Viewer[]>();
  /**
   * 세션별 현재 writer(스펙 §5-2 결정 2). 소유자·admin 이 동시에 붙어도 이 맵이 한 명만
   * 가리키므로 바이트가 섞이는 상태 자체가 없다 — 잠금 장치를 따로 만들지 않는 이유다.
   */
  const writerOf = new Map<string, Viewer>();

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

  /**
   * 이 세션이 **입력**을 받을 수 있는가(#369). 못 받으면 그 이유다.
   *
   * `sessionAcceptsInput` 이 아니라 이유를 돌려주는 이유: 뷰어에 그대로 실어 보내야 하고,
   * 화면이 원인을 지어내지 않는 것이 이 결함 수정의 절반이다.
   */
  const inputDenial = (sessionId: string): WriterDeniedReason | null => {
    const agentAccountId = ownerOf.get(sessionId);
    const runner = agentAccountId ? runners.get(agentAccountId) : undefined;
    // 러너가 없거나 `input` 능력을 선언하지 않았으면(구 러너, #346) 그 러너로 흘린 input 은
    // 조용히 버려진다 — 차례를 주는 것이 곧 "쳤는데 아무 데도 안 닿는 입력창"을 만드는 일이다.
    if (!runner?.caps.has('input')) return 'runner-outdated';
    // #369: 이 턴의 stdin 이 프롬프트 파일이면(진행 중인 멘션 턴) PTY master 로 쓴 바이트가
    // 자식의 fd 0 에 닿지 않는다. **하네스 종류로 재지 않는다** — 러너가 자기 계획에서 읽어
    // 실어 보낸 사실 하나를 그대로 쓴다(`AgentSessionView.acceptsInput`).
    const accepts = runner.sessions.get(sessionId)?.acceptsInput;
    // **모르는 것과 아닌 것을 가른다.** `#346` 시절의 러너는 `input` 능력은 선언하면서 이
    // 필드는 안 싣는다 — 그때 `'observe-only'` 라고 답하면 화면이 "프롬프트를 파일로 받는다"
    // 는, 확인한 적 없는 이유를 사람에게 읽어 준다. 입력을 닫는 것은 같지만(모르는 것을 열
    // 수는 없다) 이유는 러너가 낡았다는 사실 그대로여야 한다.
    if (accepts === undefined) return 'runner-outdated';
    if (!accepts) return 'observe-only';
    return null;
  };

  /**
   * 차례를 넘긴다. 이전 차례에 `false`, 새 차례에 그 세션이 허용하는 능력을 **이 순서로**
   * 알린다 — 두 창이 동시에 "내 차례"라고 믿는 순간을 만들지 않는다.
   *
   * **차례 하나에 능력 둘이다**(#369): 폭은 차례를 가진 창이면 언제나 정하고(#335 — stdin 과
   * 무관하게 ioctl 로 닿는다), 입력은 그 세션이 실제로 받을 수 있을 때만 연다.
   */
  const setWriter = (sessionId: string, next: Viewer | null): void => {
    const prev = writerOf.get(sessionId) ?? null;
    if (prev === next) return;
    // 강등의 이유는 언제나 하나다 — 더 최근에 붙은 창이 차례를 가져갔다(#369: 이유를
    // 함께 실어야 화면이 그것을 지어내지 않는다). 능력이 없어 차례 자체를 못 주는 경우는
    // 애초에 여기 오지 않는다(`addViewer` 가 걸러 낸다).
    if (prev) sendTo(prev, { type: 'writer', writer: false, resize: false, reason: 'other-writer' });
    if (next) {
      writerOf.set(sessionId, next);
      const denial = inputDenial(sessionId);
      sendTo(next, { type: 'writer', writer: denial === null, resize: true, reason: denial });
    } else {
      writerOf.delete(sessionId);
    }
  };

  const registerSession = (agentAccountId: string, session: AgentSessionView): void => {
    const runner = runners.get(agentAccountId);
    if (!runner) return;
    runner.sessions.set(session.sessionId, session);
    ownerOf.set(session.sessionId, agentAccountId);
  };

  /** 이 에이전트의 미결 open 요청을 전부 실패로 끝낸다 — 러너가 죽었는데 타임아웃까지 기다릴 이유가 없다. */
  const failPendingOpens = (agentAccountId: string, outcome: InteractiveOpenOutcome): void => {
    for (const [requestId, pending] of pendingOpens) {
      if (pending.agentAccountId !== agentAccountId) continue;
      pendingOpens.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(outcome);
    }
  };

  /** 뷰어 수 변동을 러너에게 알린다(#337). 구 러너는 이 프레임을 조용히 버린다 — 무해하다. */
  const notifyViewerCount = (sessionId: string): void => {
    const agentAccountId = ownerOf.get(sessionId);
    const runner = agentAccountId ? runners.get(agentAccountId) : undefined;
    if (!runner) return;
    sendToRunner(runner, { type: 'viewer.count', sessionId, count: viewers.get(sessionId)?.length ?? 0 });
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
      const runner: Runner = { socket, sessions: new Map(), caps: new Set() };
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
        // 미결 open 은 타임아웃까지 끌지 않는다 — 답할 러너가 이미 없다.
        failPendingOpens(agentAccountId, { ok: false, reason: 'no_runner' });
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
          // 능력도 announce 가 진실의 원천이다 — 선언이 없으면(구 러너) 빈 집합으로
          // **교체**한다. 남겨 두면 다운그레이드된 러너가 옛 능력을 계속 주장한다.
          runner.caps = new Set(Array.isArray(frame.caps) ? frame.caps : []);
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
        case 'interactive.opened':
        case 'interactive.error': {
          if (typeof frame.requestId !== 'string') return;
          const pending = pendingOpens.get(frame.requestId);
          // 응답은 **요청을 보냈던 그 러너**의 소켓에서만 받는다 — output 의 ownerOf
          // 검사와 같은 결: 다른 에이전트의 러너가 requestId 를 위조해 남의 열기 요청을
          // 가로채지 못한다.
          if (!pending || pending.agentAccountId !== agentAccountId) return;
          pendingOpens.delete(frame.requestId);
          clearTimeout(pending.timer);
          if (frame.type === 'interactive.opened') {
            if (typeof frame.sessionId !== 'string') return;
            pending.resolve({ ok: true, sessionId: frame.sessionId, created: frame.created === true });
          } else {
            pending.resolve({
              ok: false,
              reason: 'runner_rejected',
              message: typeof frame.message === 'string' ? frame.message : undefined,
            });
          }
          return;
        }
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

    addViewer(sessionId, socket) {
      const agentAccountId = ownerOf.get(sessionId);
      const runner = agentAccountId ? runners.get(agentAccountId) : undefined;
      const viewer: Viewer = { socket, awaitingReplay: Boolean(runner), queued: [], inputBytes: 0 };
      let list = viewers.get(sessionId);
      if (!list) { list = []; viewers.set(sessionId, list); }
      list.push(viewer);

      if (!runner) {
        // 러너가 없는 세션에 붙었다 — attach 인가와 핸드셰이크 사이에 러너가 끊긴 창이다.
        // 재생을 영원히 기다리지 않게 상태만 알린다.
        sendTo(viewer, { type: 'status', state: 'runner-offline' });
      } else {
        sendTo(viewer, { type: 'status', state: 'running' });
        sendToRunner(runner, { type: 'replay.request', sessionId });
      }

      // 마지막 attach 가 차례를 갖는다(스펙 §5-2 결정 2). 러너가 아예 능력이 없으면
      // (구 러너, #346) 차례 자체를 주지 않는다 — 폭도 입력도 그 러너에는 안 닿는다.
      // 그 밖의 경우 차례는 주고, 무엇을 할 수 있는지는 `setWriter` 가 이유와 함께 알린다.
      if (runner?.caps.has('input')) {
        setWriter(sessionId, viewer);
      } else {
        sendTo(viewer, { type: 'writer', writer: false, resize: false, reason: 'runner-outdated' });
      }

      // 러너의 인터랙티브 고아 회수(#337)가 이 수를 본다 — 늘어난 쪽도 알린다(0→1 이
      // 유예 타이머 취소다).
      notifyViewerCount(sessionId);

      return {
        close() {
          const current = viewers.get(sessionId);
          if (!current) return;
          const idx = current.indexOf(viewer);
          if (idx === -1) return;
          current.splice(idx, 1);
          if (!current.length) viewers.delete(sessionId);
          if (writerOf.get(sessionId) === viewer) {
            // 가장 최근에 붙은 남은 뷰어가 승계한다 — 배열 끝이 곧 그 사람이다.
            setWriter(sessionId, current.at(-1) ?? null);
          }
          notifyViewerCount(sessionId);
        },

        handleMessage(raw) {
          // 뷰어는 무엇이든 보낼 수 있다 — 파싱 실패로 소켓을 죽이지 않는다.
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { return false; }
          const frame = parsed as AttachClientFrame;
          if (frame?.type !== 'input' && frame?.type !== 'resize') return false;
          // **차례가 아니면 여기서 멈춘다.** 화면이 입력을 안 그리는 것만으로는 게이트가
          // 아니다 — 소켓은 누구나 직접 열 수 있으므로, 진짜 게이트는 이 줄이다.
          // **#335 의 resize 도 이 한 줄이 막는다** — 스펙 §5 "resize 는 writer 를 따른다":
          // 읽기 전용 창이 크기를 바꾸면 그 창은 더 이상 읽기 전용이 아니다.
          //
          // **#369 에서 이 줄의 뜻이 좁아졌다**: 전에는 이 한 줄이 두 프레임의 판정 전부였고
          // "차례를 가진 사람 = 칠 수 있는 사람"이었다. 이제 차례는 **순서**만 정하고(누가
          // 폭의 주인인가), 입력이 실제로 열리는지는 아래 한 겹이 더 본다 — 관찰 전용
          // 세션에는 writer 가 없지만 폭의 주인은 여전히 있어야 하기 때문이다.
          if (writerOf.get(sessionId) !== viewer) return false;
          const owner = ownerOf.get(sessionId);
          const target = owner ? runners.get(owner) : undefined;
          // caps 를 여기서도 본다(#346) — writer 배정이 이미 caps 를 봤지만, 배정 뒤
          // 러너가 능력 없는 버전으로 재접속·재announce 하는 창이 있다. 그때의 input 은
          // 러너가 조용히 버릴 프레임이므로 애초에 보내지 않는다.
          if (!target?.caps.has('input')) return false;

          // **입력은 한 겹 더 탄다**(#369). 차례는 폭까지만 보장하고, 바이트를 넣는 것은
          // 그 세션의 stdin 이 PTY 일 때만 성립한다 — 아니면 자식에게 닿지 않으므로
          // 애초에 보내지 않는다(러너까지 갔다가 버려지면 감사에는 "개입했다"로 남는다).
          if (frame.type === 'input' && inputDenial(sessionId) !== null) return false;

          if (frame.type === 'resize') {
            // 이 숫자는 러너의 resize 를 지나 ioctl 로 그대로 내려간다 — 0·음수·NaN·
            // 정수 아닌 값은 node-pty 가 던지고, 터무니없이 큰 값은 러너가 그 크기의
            // 화면 버퍼를 잡는다(#335). 감사 합산(inputBytes)에는 넣지 않는다 — 창 크기
            // 조절은 개입이 아니라 보기다(shared 의 AttachClientFrame 주석).
            if (!isPtySize(frame.cols) || !isPtySize(frame.rows)) return false;
            sendToRunner(target, { type: 'resize', sessionId, cols: frame.cols, rows: frame.rows });
            return true;
          }

          if (typeof frame.data !== 'string') return false;
          // ★ `data` 를 **그대로** 옮긴다. 되돌렸다 싣거나 문자열로 디코드하면 사람이 친
          //   제어 바이트(Ctrl-C, 화살표, 붙여 넣은 멀티바이트)가 깨진다.
          sendToRunner(target, { type: 'input', sessionId, data: frame.data });
          viewer.inputBytes += base64ByteLength(frame.data);
          return true;
        },

        inputBytes: () => viewer.inputBytes,
      };
    },

    openInteractive(agentAccountId, req, opts) {
      const runner = runners.get(agentAccountId);
      if (!runner) return Promise.resolve({ ok: false, reason: 'no_runner' });
      if (!runner.caps.has('interactive')) {
        // 구 러너는 이 프레임을 조용히 버린다 — 기다리는 것은 곧 원인 없는 타임아웃이므로
        // **즉시** 거절한다(#346 caps 의 존재 이유).
        return Promise.resolve({ ok: false, reason: 'runner_outdated' });
      }
      return new Promise((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pendingOpens.delete(requestId);
          resolve({ ok: false, reason: 'runner_timeout' });
        }, opts?.timeoutMs ?? INTERACTIVE_OPEN_TIMEOUT_MS);
        timer.unref?.();
        pendingOpens.set(requestId, { agentAccountId, resolve, timer });
        sendToRunner(runner, {
          type: 'interactive.open',
          requestId,
          channelId: req.channelId,
          threadRootId: req.threadRootId,
          openedByHandle: req.openedByHandle,
          cols: req.cols,
          rows: req.rows,
        });
      });
    },
  };
}
