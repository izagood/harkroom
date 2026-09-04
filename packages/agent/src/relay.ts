// 러너 → 서버 상시 outbound WS 릴레이(스펙 §5 "릴레이"). 진행 중인 턴의 PTY 바이트를
// 서버로 밀어 넣어, 소유자가 데스크탑 xterm 에서 실시간으로 본다.
//
// **#315 로 방향이 하나 더 생겼다**: 소유자가 그 xterm 에 친 바이트가 `input` 프레임으로
// 되돌아와 PTY stdin 에 들어간다. 쓰기 권한(소유자만)은 서버가 attach 인가 때 판정하고,
// 러너는 그 판정을 다시 하지 않는다 — 인가를 두 곳에 두면 한쪽만 고치는 사고가 난다.
//
// **러너는 포트를 열지 않는다.** 러너는 사람의 로그인 세션 안에서 돌고, 관찰 하나 때문에
// 두 번째 보안 표면(청취 포트 + 인증 + TLS)을 만들지 않는다 — 그것이 스펙 §2 가 안 C
// (데스크탑 ↔ 러너 직결)를 기각한 이유다. 그래서 방향이 러너 → 서버이고, 인증은 PAT
// **헤더**다: 러너는 브라우저가 아니라 헤더를 실을 수 있으므로 티켓이 필요 없다.
//
// **재접속 정책은 새로 만들지 않았다.** `policy.ts` 의 `nextBackoffMs` 를 그대로 쓴다 —
// inbox.poll 루프(`main.ts`)가 쓰는 것과 같은 곡선이다. 릴레이만의 곡선을 두면 러너 한
// 프로세스가 서버 재시작에 두 가지 속도로 반응하고, 그 둘이 갈라진 뒤에는 한쪽만 고쳐진다.
//
// **스크롤백은 여기 메모리에만 산다.** 세션당 최근 256KB 를 `RingBuffer` 로 들고, attach
// 시 서버의 `replay.request` 에 그 스냅샷으로 답한다. DB 에 저장하지 않는다 — PTY 출력에는
// 하네스가 화면에 그린 모든 것(토큰, 환경변수, 사람이 붙여 넣은 비밀)이 들어간다. 프로세스가
// 죽으면 스크롤백도 같이 사라지는 것이 이 설계의 결과이고, 그것이 의도다.
import { randomUUID } from 'node:crypto';
import type { AgentHarness, AgentSessionView, RelayRunnerFrame, RelayServerFrame, RunnerCap } from '@murmur/shared';
import { RingBuffer, type PtyWriter } from './pty.js';
import { nextBackoffMs } from './policy.js';

/** 세션당 스크롤백 용량(스펙 §5). 러너 메모리에만 산다. */
export const RING_CAP_BYTES = 256 * 1024;

/**
 * 이 러너가 다룰 줄 아는 개입 능력(#346). announce 에 실려, 서버가 구 러너(caps 부재)로
 * input 을 흘리거나 인터랙티브 open 을 기다리다 타임아웃 나는 일을 막는다 — 능력을
 * 선언하지 않으면 서버는 없는 것으로 읽는다(없는 것을 있다고 표시하지 않는다).
 */
export const RUNNER_CAPS: readonly RunnerCap[] = ['input', 'interactive', 'handoff'];

/** 소켓의 최소 표면. 프로덕션은 `ws`, 테스트는 가짜다. */
export interface RelayTransport {
  send(data: string): void;
  close(): void;
}

export interface RelayHandlers {
  onOpen(transport: RelayTransport): void;
  onMessage(raw: string): void;
  /** 열렸다 끊긴 것과 애초에 못 붙은 것을 구분하지 않는다 — 둘 다 재접속 대상이다. */
  onClose(): void;
}

/**
 * 실제 소켓을 여는 함수. 주입 가능하게 뽑아 둔 이유: 재접속·백오프·announce 순서는
 * 소켓 없이 검증돼야 한다. 네트워크를 태우는 테스트는 그 순서가 깨졌을 때 "느리다"로만
 * 보이고, 무엇이 깨졌는지는 알려 주지 않는다.
 */
export type RelayDialer = (url: string, pat: string, handlers: RelayHandlers) => void;

/** 한 턴에 대응하는 살아 있는 PTY 세션. */
interface LiveSession {
  info: AgentSessionView;
  ring: RingBuffer;
  /**
   * 이 세션의 PTY stdin(#315). 세션이 열린 시점에는 아직 spawn 전이라 `null` 이고,
   * `runPtyTurn` 의 `onSpawn` 이 이어 붙인다. `null` 인 동안 도착한 입력은 **버린다** —
   * 큐에 담아 두면 사람이 아직 프롬프트가 뜨지 않은 화면에 친 것이 나중에 엉뚱한
   * 프롬프트의 답으로 들어간다. 안 보이는 화면에 친 것은 답이 아니다.
   */
  writer: PtyWriter | null;
  /** 서버가 알려 준 뷰어 수 변동(#337). 인터랙티브 고아 회수 타이머가 읽는다. */
  onViewerCount?: (count: number) => void;
}

export interface OpenSessionInput {
  agentAccountId: string;
  channelId: string;
  threadRootId: string | null;
  harness: AgentHarness;
  /** 이 PTY 가 어떤 턴인가(#337). 생략하면 멘션 턴이다 — 기존 호출부(mentionTurn)가 그대로다. */
  mode?: 'mention' | 'interactive';
  /**
   * 이 세션의 PTY 에 사람이 입력할 수 있는가(#369). **필수다** — 생략을 허용하면 기본값이
   * 곧 판정이 되고, 그 기본값이 무엇이든 한쪽 호출부가 거짓말을 하게 된다. 호출부는
   * `acceptsPtyInput(plan)` 으로 자기 계획에서 그대로 읽어 넘긴다.
   */
  acceptsInput: boolean;
  /** 이 세션의 뷰어 수 변동 통지(#337). 인터랙티브 턴만 넘긴다 — 멘션 턴의 끝은 exit 뿐이다. */
  onViewerCount?: (count: number) => void;
}

/**
 * 서버의 `interactive.open` 요청을 실제 턴으로 만드는 훅(#337). `interactiveTurn.ts` 가
 * 꽂는다. 성공은 `{sessionId, created}` — created 가 false 면 이미 돌던 턴에 합류시킨
 * 것이다. 실패는 **던진다** — 릴레이가 그 메시지를 `interactive.error` 로 서버에 그대로
 * 돌려주고, 서버는 사람 화면에 그대로 올린다(codex 거절 문구가 이 경로로 사람에게 간다).
 */
export type InteractiveOpenHandler = (req: {
  channelId: string;
  threadRootId: string;
  openedByHandle: string;
  /**
   * 이어받기 요청인가(#384). **필수다** — 프레임의 옵셔널 필드(구 서버는 모른다)를 여기서
   * 한 번 정규화하고, 그 뒤로는 아무도 다시 판정하지 않는다.
   */
  handoff: boolean;
  cols?: number;
  rows?: number;
}) => Promise<{ sessionId: string; created: boolean; waiting: boolean }>;

/**
 * 열린 세션의 호출자 쪽 손잡이. 턴을 도는 코드(`mentionTurn.ts`)는 이것만 안다 —
 * 소켓도, 프레임도, 재접속도 모른다.
 */
export interface OpenSession {
  sessionId: string;
  /** PTY 가 뱉은 바이트. ring 에 담고 서버로도 흘린다. */
  push(chunk: Buffer): void;
  /**
   * PTY stdin 을 이 세션에 이어 붙인다(#315). spawn 되는 순간 `runPtyTurn` 의 `onSpawn`
   * 이 부른다 — 그 전에 서버가 보낸 입력은 쓸 곳이 없어 버려진다(`LiveSession.writer`).
   */
  bindInput(writer: PtyWriter): void;
  /** 턴이 끝났다. 세션을 닫고 서버에 알린다. */
  close(): void;
}

export interface RelayClientOptions {
  /** murmur 서버의 http(s) 베이스 URL. ws(s) 로 바꿔 `/agent-relay` 에 붙는다. */
  murmurUrl: string;
  pat: string;
  dial?: RelayDialer;
  /** 재접속 예약. 테스트가 시간을 직접 돌리려고 뽑아 뒀다. */
  schedule?: (fn: () => void, ms: number) => void;
  /** 첫 재접속 지연. 이후 `nextBackoffMs` 로 늘어난다. */
  initialBackoffMs?: number;
  /**
   * `interactive.open` 프레임의 처리자(#337). 없으면 — main.ts 가 배선을 빠뜨렸거나 아주
   * 구식 조립이면 — 요청을 **에러로 응답한다**: caps 에 interactive 를 선언해 놓고 조용히
   * 버리면 서버가 10초 타임아웃까지 기다린 뒤 원인 없는 504 를 사람에게 준다.
   */
  onInteractiveOpen?: InteractiveOpenHandler;
}

export interface RelayClient {
  /** 접속을 시작한다. 이 뒤로는 끊겨도 스스로 다시 붙는다. */
  start(): void;
  /** 더 붙지 않는다. 열린 소켓도 닫는다. */
  stop(): void;
  /** 턴 하나를 세션으로 연다. 릴레이가 끊겨 있어도 성공한다(ring 은 계속 쌓인다). */
  openSession(input: OpenSessionInput): OpenSession;
  /** 지금 붙어 있는가. 로그·테스트가 본다. */
  connected(): boolean;
}

/** http(s) → ws(s). 경로는 `/agent-relay` 하나뿐이다. */
export function relayUrl(murmurUrl: string): string {
  return `${murmurUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/agent-relay`;
}

export function createRelayClient(opts: RelayClientOptions): RelayClient {
  const dial = opts.dial ?? nodeWsDialer;
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const initialBackoffMs = opts.initialBackoffMs ?? 1_000;

  const sessions = new Map<string, LiveSession>();
  let transport: RelayTransport | null = null;
  let stopped = false;
  let backoffMs = initialBackoffMs;

  const send = (frame: RelayRunnerFrame): void => {
    if (!transport) return;
    // 소켓이 방금 죽었을 수 있다 — 한 프레임을 못 보낸 것으로 턴을 죽이지 않는다.
    // 바이트를 잃는 것은 관찰의 손실이고, 턴은 사람이 기다리는 답이다.
    try { transport.send(JSON.stringify(frame)); } catch { /* 재접속이 announce 로 복구한다 */ }
  };

  /**
   * `interactive.open` 왕복(#337). 성공·실패 어느 쪽이든 **반드시 응답한다** — 응답이
   * 없으면 서버는 10초 타임아웃까지 기다린 뒤 원인 없는 504 를 사람에게 준다. 훅이
   * 던진 메시지는 그대로 서버로 간다: codex 거절(§5-2 결정 8)의 문구가 이 경로로
   * 사람 화면에 도달한다.
   */
  const handleInteractiveOpen = async (frame: {
    requestId: string;
    channelId: string;
    threadRootId: string;
    openedByHandle: string;
    handoff?: boolean;
    cols?: number;
    rows?: number;
  }): Promise<void> => {
    const handler = opts.onInteractiveOpen;
    if (!handler) {
      send({
        type: 'interactive.error',
        requestId: frame.requestId,
        message: '이 러너에는 인터랙티브 열기가 배선되지 않았다 — 러너를 최신으로 올려 다시 시도해라',
      });
      return;
    }
    try {
      const opened = await handler({
        channelId: frame.channelId,
        threadRootId: frame.threadRootId,
        openedByHandle: frame.openedByHandle,
        // 구 서버는 이 필드를 모른다 — 없으면 이어받기가 아니다(shared 의 프레임 주석).
        handoff: frame.handoff === true,
        cols: frame.cols,
        rows: frame.rows,
      });
      if (opened.waiting) {
        // 이어받기 예약(#384). "열렸다"로 답하지 않는다 — 사람은 아직 못 친다. 이 프레임이
        // 서버를 지나 화면의 "턴이 끝나면 엽니다"가 된다: 기다림이 화면에 없으면
        // "눌렀는데 아무 일이 없다"이고, 그것이 이 저장소가 오늘 반복해서 고친 결함이다.
        send({ type: 'interactive.reserved', requestId: frame.requestId, sessionId: opened.sessionId });
        return;
      }
      send({ type: 'interactive.opened', requestId: frame.requestId, sessionId: opened.sessionId, created: opened.created });
    } catch (err) {
      send({
        type: 'interactive.error',
        requestId: frame.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onServerFrame = (raw: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as RelayServerFrame;

    switch (frame.type) {
      case 'replay.request': {
        if (typeof frame.sessionId !== 'string') return;
        // 모르는 세션에는 답하지 않는다. 빈 재생으로 답하면 "끝난 세션"과 "아직 출력이
        // 없는 세션"이 뷰어에게 같아진다.
        const live = sessions.get(frame.sessionId);
        if (!live) return;
        send({ type: 'replay', sessionId: frame.sessionId, data: live.ring.snapshot().toString('base64') });
        return;
      }

      case 'input': {
        if (typeof frame.sessionId !== 'string' || typeof frame.data !== 'string') return;
        const live = sessions.get(frame.sessionId);
        if (!live) return;
        // **쓰기 차례는 서버가 이미 판정했다**(#315·#346 — writer 규칙, 허브의 setWriter).
        // 러너는 그 판정을 다시 하지 않는다: 여기서 한 번 더 판정하려면 러너가 뷰어들을
        // 알아야 하고, 그러면 인가가 두 곳으로 갈라진다. 러너가 지키는 것은 "이 세션이
        // 내 것인가" 뿐이고, 그것은 위 `sessions.get` 이 이미 답했다.
        //
        // **이 경로는 턴의 모드를 건드리지 않는다.** PTY stdin 에 바이트를 넣을 뿐이고,
        // `plan`(모드·권한 프리셋)은 턴이 시작될 때 이미 조립돼 봉인됐다.
        live.writer?.write(Buffer.from(frame.data, 'base64'));
        return;
      }

      case 'resize': {
        if (typeof frame.sessionId !== 'string') return;
        const live = sessions.get(frame.sessionId);
        if (!live) return;
        // **여기서도 판정을 다시 하지 않는다**(위 `input` 주석과 같은 이유, #335). 크기를
        // 정하는 것이 지금의 writer 라는 판정도, 값 검증(1..1000 정수)도 서버 허브가 이미
        // 했다. 그래도 `writer`(PTY 통로)가 없을 수 있다 — spawn 전이면 크기를 적용할
        // PTY 가 아직 없고, 그때는 버린다: 큐에 담아 두면 다음 턴의 PTY 가 지난 턴의 창
        // 크기로 열린다.
        live.writer?.resize(frame.cols, frame.rows);
        return;
      }

      case 'viewer.count': {
        if (typeof frame.sessionId !== 'string' || typeof frame.count !== 'number') return;
        const live = sessions.get(frame.sessionId);
        // 콜백 예외는 삼킨다 — 관찰(고아 회수 타이머)이 다른 턴을 죽이면 안 된다.
        try { live?.onViewerCount?.(frame.count); } catch { /* 관찰은 답을 죽이지 않는다 */ }
        return;
      }

      case 'interactive.open': {
        if (typeof frame.requestId !== 'string') return;
        void handleInteractiveOpen(frame);
        return;
      }

      default:
        return;
    }
  };

  const connect = (): void => {
    if (stopped) return;
    dial(relayUrl(opts.murmurUrl), opts.pat, {
      onOpen: (t) => {
        transport = t;
        backoffMs = initialBackoffMs;
        // 재접속마다 다시 보낸다. 서버는 소켓이 끊기면 이 러너의 세션 레지스트리를
        // 버리므로(살아 있는지 알 방법이 없다), announce 가 없으면 진행 중인 턴이
        // 서버 쪽에서 영구히 사라진다 — attach 가 재접속을 못 넘긴다.
        send({ type: 'announce', sessions: [...sessions.values()].map((s) => s.info), caps: RUNNER_CAPS });
      },
      onMessage: onServerFrame,
      onClose: () => {
        transport = null;
        if (stopped) return;
        schedule(connect, backoffMs);
        backoffMs = nextBackoffMs(backoffMs);
      },
    });
  };

  return {
    start: connect,

    stop() {
      stopped = true;
      transport?.close();
      transport = null;
    },

    openSession(input) {
      const info: AgentSessionView = {
        sessionId: randomUUID(),
        agentAccountId: input.agentAccountId,
        channelId: input.channelId,
        threadRootId: input.threadRootId,
        harness: input.harness,
        // 러너 시계다. 서버가 찍지 않는 이유: 세션이 언제 열렸는지는 러너만 아는 사실이고,
        // 서버가 프레임 도착 시각으로 대신하면 재접속 뒤 announce 에서 값이 바뀐다.
        startedAt: new Date().toISOString(),
        // 데스크탑이 "사람이 조종 중인 세션"을 구분해 그릴 근거(#337). 생략은 멘션 턴이다.
        mode: input.mode ?? 'mention',
        // 서버의 writer 판정이 읽는 사실(#369). 여기서 다시 계산하지 않는다 — 근거는
        // 그 턴의 계획(stdinFile)이고, 그것을 아는 것은 턴을 조립한 호출부다.
        acceptsInput: input.acceptsInput,
      };
      const live: LiveSession = {
        info, ring: new RingBuffer(RING_CAP_BYTES), writer: null, onViewerCount: input.onViewerCount,
      };
      sessions.set(info.sessionId, live);
      send({ type: 'session.started', session: info });

      return {
        sessionId: info.sessionId,
        push(chunk) {
          // ring 은 릴레이가 끊겨 있어도 계속 채운다 — 재접속 뒤 attach 하면 그동안의
          // 화면이 재생돼야 한다. 여기서 멈추면 끊긴 구간이 영구히 사라진다.
          live.ring.push(chunk);
          send({ type: 'output', sessionId: info.sessionId, data: chunk.toString('base64') });
        },
        bindInput(writer) {
          live.writer = writer;
        },
        close() {
          sessions.delete(info.sessionId);
          // 세션을 맵에서 뺐으므로 뒤늦게 온 입력은 위 `sessions.get` 에서 걸린다.
          // 통로도 함께 끊는다 — 이미 끝난 PTY 를 붙잡고 있을 이유가 없다.
          live.writer = null;
          send({ type: 'session.ended', sessionId: info.sessionId });
        },
      };
    },

    connected: () => transport !== null,
  };
}

/**
 * 프로덕션 dialer. `ws` 를 쓰는 이유: Node 의 전역 `WebSocket`(undici)은 **커스텀 헤더를
 * 실을 수 없다.** 이 소켓의 인증은 PAT 헤더이므로(URL 에 실으면 앞단 프록시 로그에 남는다)
 * 헤더를 실을 수 있는 클라이언트가 필요하다.
 *
 * `import` 를 함수 안에 둔 이유: 이 모듈을 import 하는 테스트가 가짜 dialer 만 쓸 때
 * `ws` 를 실제로 로드하지 않게 한다.
 */
const nodeWsDialer: RelayDialer = (url, pat, handlers) => {
  void (async () => {
    const { default: WebSocket } = await import('ws');
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${pat}` } });
    // `ws` 는 실패 시 'error' 와 'close' 를 **둘 다** 낸다. 그대로 넘기면 재접속이 두 번
    // 예약되고, 그 두 배가 매 실패마다 곱해져 몇 분 뒤에는 접속 폭풍이 된다. 이 dial 의
    // 끝을 한 번만 알린다 — 백오프가 곡선 하나로 남는다.
    let settled = false;
    const settle = () => { if (!settled) { settled = true; handlers.onClose(); } };
    socket.on('open', () => {
      handlers.onOpen({ send: (data) => socket.send(data), close: () => socket.close() });
    });
    socket.on('message', (raw: unknown) => handlers.onMessage(String(raw)));
    socket.on('close', settle);
    // 핸드셰이크 자체가 실패(401, 연결 거부)하면 여기로 온다. 삼키면 러너가 조용히
    // 릴레이 없이 도는 상태로 남는다.
    socket.on('error', settle);
  })().catch(() => handlers.onClose());
};
