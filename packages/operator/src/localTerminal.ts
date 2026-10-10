/**
 * 같은 머신의 터미널 직결(R1 PR-3, 스레드 8d233406). 앱(또는 같은 사용자의 CLI)이 오퍼레이터 소켓으로
 * 러너의 PTY 바이트를 **서버를 거치지 않고** 받고 보낸다.
 *
 * ## 왜
 * 지금 키 하나는 앱 → 서버 → 오퍼레이터 → 러너 → PTY → 러너 → 오퍼레이터 → 서버 → 앱으로 간다. 러너가
 * 같은 맥이면 서버 구간 두 번(실측 요청 왕복 346~410ms × 2)이 통째로 낭비다. 이 모듈은 그 바이트만
 * 오퍼레이터 안에서 돌려준다.
 *
 * ## 제어는 서버, 바이트는 로컬
 * **누가 칠 수 있는가는 여전히 서버가 정한다**(#346 writer, #369 acceptsInput). 이 허브는 그 판정을
 * 다시 하지 않고 **서버가 내려 준 허가**만 따른다:
 * - 출력 구독은 이 머신의 러너가 가진 세션이면 열린다. 소켓 토큰을 가진 쪽 = 이 오퍼레이터의 주인과
 *   같은 OS 사용자이고, 그 사용자는 같은 바이트를 서버 경유로도 이미 볼 수 있다.
 * - **입력·크기는 서버가 허가(`grantWriter`)를 준 세대(`gen`)로만 받는다.** 허가가 없거나 세대가
 *   다르면 거절한다(fail-closed). 허가를 내려 주는 서버 프레임은 다음 PR(PR-5)이 붙인다 — 그 전에는
 *   이 경로의 입력은 언제나 거절되고, 앱은 지금처럼 서버 경유로 친다.
 * - 세대 번호가 있는 이유: 다른 창이 writer 를 가져가는 순간 서버는 새 세대를 내린다. 옛 창이 들고
 *   있던 허가로 보낸 바이트가 새 writer 의 입력에 섞이지 않게 한다.
 *
 * ## 감사
 * 서버 감사는 **내용이 아니라 바이트 수**만 남긴다(detach 의 `inputBytes`). 이 경로로 들어간 입력도
 * 세션별 바이트 수만 센다 — `takeInputBytes` 를 PR-5 가 서버에 보고한다.
 *
 * ## 재생
 * 구독할 때 러너에 `replay.request` 를 보낸다. 러너의 `replay` 답은 서버로도 그대로 올라가는데,
 * 서버 허브는 `awaitingReplay` 인 뷰어에게만 그것을 준다(`server/src/ws/relay.ts`) — 요청하지 않은
 * 재생은 서버에서 버려진다.
 */
import type { AgentSessionView, RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';

/** 구독자 하나(앱 소켓 접속 하나). 이벤트를 흘릴 손잡이만 안다. */
export interface LocalTerminalSubscriber {
  send(event: 'terminalOutput' | 'terminalEnded', payload: unknown): void;
}

export type LocalTerminalRefusal = 'no-such-session' | 'not-writer' | 'runner-gone' | 'bad-size';

export interface LocalTerminalHubDeps {
  /** 러너에 프레임을 내린다. 링크가 없으면 false. */
  sendToRunner(runnerId: string, frame: RelayServerFrame): boolean;
  log(line: string): void;
}

export interface LocalTerminalHub {
  /** 러너가 올린 프레임을 본다(서버로 가는 것과 별개로). */
  onRunnerFrame(runnerId: string, frame: RelayRunnerFrame): void;
  /** 러너가 죽었다 — 그 세션의 구독자에게 끝을 알리고 잊는다. */
  forgetRunner(runnerId: string): void;
  /** 이 머신의 러너가 지금 가진 세션. 앱이 "이 세션은 로컬인가"를 여기서 판정한다. */
  sessions(): AgentSessionView[];
  subscribe(sub: LocalTerminalSubscriber, sessionId: string): LocalTerminalRefusal | null;
  unsubscribe(sub: LocalTerminalSubscriber, sessionId: string): void;
  /** 접속이 끊겼다 — 그 구독을 전부 뗀다. */
  drop(sub: LocalTerminalSubscriber): void;
  /** 서버가 이 세션의 로컬 writer 허가를 준다(세대) 또는 거둔다(null). */
  grantWriter(sessionId: string, gen: number | null): void;
  input(sessionId: string, gen: number, data: string): LocalTerminalRefusal | null;
  resize(sessionId: string, gen: number, cols: number, rows: number): LocalTerminalRefusal | null;
  /** 지난 호출 뒤로 이 경로에 들어간 입력 바이트 수(감사 보고용). 읽으면 0 으로 돌아간다. */
  takeInputBytes(sessionId: string): number;
}

/** base64 문자열이 담은 바이트 수. 디코드하지 않는다 — 내용은 우리가 볼 것이 아니다. */
function base64ByteLength(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

/** 서버 허브(#335)와 같은 범위. PTY ioctl 로 그대로 내려가므로 여기서도 거른다. */
const MAX_DIM = 1000;

export function createLocalTerminalHub(deps: LocalTerminalHubDeps): LocalTerminalHub {
  /** sessionId → 그 세션을 가진 러너와 뷰. */
  const owner = new Map<string, { runnerId: string; view: AgentSessionView }>();
  const subs = new Map<string, Set<LocalTerminalSubscriber>>();
  /** 재생을 기다리는 구독자. 재생이 오기 전의 라이브 바이트는 **버리지 않고** 뒤에 붙인다. */
  const awaiting = new Map<string, Map<LocalTerminalSubscriber, string[]>>();
  const writerGen = new Map<string, number>();
  const inputBytes = new Map<string, number>();

  const endSession = (sessionId: string): void => {
    for (const sub of subs.get(sessionId) ?? []) sub.send('terminalEnded', { sessionId });
    subs.delete(sessionId);
    awaiting.delete(sessionId);
    owner.delete(sessionId);
    writerGen.delete(sessionId);
  };

  const gate = (sessionId: string, gen: number): { runnerId: string } | LocalTerminalRefusal => {
    const o = owner.get(sessionId);
    if (!o) return 'no-such-session';
    const granted = writerGen.get(sessionId);
    if (granted === undefined || granted !== gen) return 'not-writer';
    return { runnerId: o.runnerId };
  };

  return {
    onRunnerFrame(runnerId, frame) {
      switch (frame.type) {
        case 'announce':
          for (const [id, o] of owner) if (o.runnerId === runnerId && !frame.sessions.some((s) => s.sessionId === id)) endSession(id);
          for (const view of frame.sessions) owner.set(view.sessionId, { runnerId, view });
          return;
        case 'session.started':
          owner.set(frame.session.sessionId, { runnerId, view: frame.session });
          return;
        case 'session.ended':
          endSession(frame.sessionId);
          return;
        case 'output': {
          const waiting = awaiting.get(frame.sessionId);
          for (const sub of subs.get(frame.sessionId) ?? []) {
            const queue = waiting?.get(sub);
            if (queue) queue.push(frame.data);
            else sub.send('terminalOutput', { sessionId: frame.sessionId, data: frame.data });
          }
          return;
        }
        case 'replay': {
          const waiting = awaiting.get(frame.sessionId);
          if (!waiting) return;
          for (const [sub, queue] of waiting) {
            // 재생이 먼저, 그동안 쌓인 라이브가 그다음 — 서버 허브와 같은 순서 규율이다.
            sub.send('terminalOutput', { sessionId: frame.sessionId, data: frame.data, replay: true });
            for (const data of queue) sub.send('terminalOutput', { sessionId: frame.sessionId, data });
          }
          awaiting.delete(frame.sessionId);
          return;
        }
        default:
          return;
      }
    },
    forgetRunner(runnerId) {
      for (const [id, o] of [...owner]) if (o.runnerId === runnerId) endSession(id);
    },
    sessions() {
      return [...owner.values()].map((o) => o.view);
    },
    subscribe(sub, sessionId) {
      const o = owner.get(sessionId);
      if (!o) return 'no-such-session';
      let set = subs.get(sessionId);
      if (!set) { set = new Set(); subs.set(sessionId, set); }
      if (set.has(sub)) return null;
      if (!deps.sendToRunner(o.runnerId, { type: 'replay.request', sessionId })) return 'runner-gone';
      set.add(sub);
      let waiting = awaiting.get(sessionId);
      if (!waiting) { waiting = new Map(); awaiting.set(sessionId, waiting); }
      waiting.set(sub, []);
      return null;
    },
    unsubscribe(sub, sessionId) {
      subs.get(sessionId)?.delete(sub);
      awaiting.get(sessionId)?.delete(sub);
    },
    drop(sub) {
      for (const set of subs.values()) set.delete(sub);
      for (const waiting of awaiting.values()) waiting.delete(sub);
    },
    grantWriter(sessionId, gen) {
      if (gen === null) writerGen.delete(sessionId);
      else writerGen.set(sessionId, gen);
    },
    input(sessionId, gen, data) {
      const g = gate(sessionId, gen);
      if (typeof g === 'string') return g;
      if (!deps.sendToRunner(g.runnerId, { type: 'input', sessionId, data })) return 'runner-gone';
      inputBytes.set(sessionId, (inputBytes.get(sessionId) ?? 0) + base64ByteLength(data));
      return null;
    },
    resize(sessionId, gen, cols, rows) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_DIM || rows > MAX_DIM) return 'bad-size';
      const g = gate(sessionId, gen);
      if (typeof g === 'string') return g;
      return deps.sendToRunner(g.runnerId, { type: 'resize', sessionId, cols, rows }) ? null : 'runner-gone';
    },
    takeInputBytes(sessionId) {
      const n = inputBytes.get(sessionId) ?? 0;
      inputBytes.delete(sessionId);
      return n;
    },
  };
}
