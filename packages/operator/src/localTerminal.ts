/**
 * 같은 머신의 터미널 직결(R1 PR-3, 스레드 8d233406). 앱(또는 같은 사용자의 CLI)이 오퍼레이터 소켓으로
 * 러너의 PTY 바이트를 **서버를 거치지 않고** 받고 보낸다.
 *
 * ## 왜
 * 지금 키 하나는 앱 → 서버 → 오퍼레이터 → 러너 → PTY → 러너 → 오퍼레이터 → 서버 → 앱으로 간다. 러너가
 * 같은 맥이면 서버 구간 두 번(실측 요청 왕복 346~410ms × 2)이 통째로 낭비다. 이 모듈은 그 바이트만
 * 오퍼레이터 안에서 돌려준다.
 *
 * ## 제어는 서버, 바이트는 로컬 — 그리고 소켓 토큰은 허가가 아니다
 * 오퍼레이터 소켓 토큰은 **같은 uid 의 에이전트 셸도 읽을 수 있다**(10-01 실측). 그래서 "토큰을 가졌다"를
 * 볼 권한이나 칠 권한으로 읽으면, 에이전트가 사람이 앞에 있는 TUI(권한 확인 창 포함)를 훔쳐보거나 거기에
 * 키를 넣는 길이 된다 — 권한 분류기·hook 을 옆으로 도는 길이다(security F1·F2, #1298).
 *
 * 그래서 이 허브는 **서버가 내린 키 두 가지**로만 문을 연다. 판정(#346 writer·#369 acceptsInput·소유자
 * attach 티켓)은 전부 서버의 것이고, 허브는 그 결과를 키로 받아 대조할 뿐이다:
 * - **열람 키(viewKey)** — 서버가 소유자의 attach 를 인가할 때 그 뷰어와 오퍼레이터에 함께 준다. 이 키가
 *   있어야 출력을 구독한다. 세션 하나에 뷰어가 여럿일 수 있어 여러 개를 들고, 회수되면 그 키로 붙은 구독을
 *   끊는다.
 * - **writer 키(writerKey)** — 서버가 writer 차례를 줄 때마다 새로 만든다. 세션당 하나만 서 있고, 다른 창이
 *   차례를 가져가면 서버가 새 키로 갈아 끼운다 — 옛 창이 들고 있던 키로 보낸 바이트는 거절된다.
 * - 두 키 모두 **추측할 수 없는 값**이어야 한다(서버가 ≥128bit 난수로 만든다). 짧은 값은 허가로 받지 않고
 *   (`MIN_KEY_LENGTH`), 대조는 상수 시간으로 한다.
 * - 키를 내려 주는 서버 프레임은 다음 PR(PR-5)이 붙인다. 그 전에는 **구독도 입력도 언제나 거절된다**
 *   (완전 fail-closed) — 앱은 지금처럼 서버 경유로 보고 친다.
 *
 * ## 감사
 * 서버 감사는 **내용이 아니라 바이트 수**만 남긴다(detach 의 `inputBytes`). 이 경로로 들어간 입력도
 * 세션별 바이트 수만 센다. **신뢰 수준은 "오퍼레이터 자기 보고"다**(security #1302 n4) — 서버는 이 바이트를 보지
 * 못하므로, 같은 uid 의 오퍼레이터가 수를 부풀리거나 빼먹어도 서버는 가릴 수 없다. 러너가 직접 올린 보고는
 * 오퍼레이터가 버린다(`community.ts`). **떠나기 직전 최대 200ms(`INPUT_REPORT_MS`) 바이트가 detach 감사에서 빠질 수
 * 있다** — 서버는 창이 떠나는 순간의 합을 적고, 그 뒤 늦게 온 보고(이미 떠난 뷰어의 gen)는 다른 뷰어 감사를 부풀리지
 * 않게 조용히 버린다. 감사가 답하는 "사람이 개입했는가"는 앞선 보고들이 이미 답하므로 받아들인다(security #1302 판단).
 * 보고는 `reportInput` 으로 writer 키 번호별로 짧게 모아 나가고, 키를 갈거나 세션이 끝나기 전에 턴다.
 *
 * ## 재생
 * 구독할 때 러너에 `replay.request` 를 보낸다. 러너의 `replay` 답은 서버로도 그대로 올라가는데,
 * 서버 허브는 `awaitingReplay` 인 뷰어에게만 그것을 준다(`server/src/ws/relay.ts`) — 요청하지 않은
 * 재생은 서버에서 버려진다. 재생을 기다리는 동안 온 라이브 바이트는 쌓아 두되 상한(`MAX_AWAITING_CHUNKS`)이
 * 있다 — 재생에 답하지 않는 러너 앞에서 끝없이 쌓이지 않게.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AgentSessionView, RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';

/** 구독자 하나(앱 소켓 접속 하나). 이벤트를 흘릴 손잡이만 안다. */
export interface LocalTerminalSubscriber {
  send(event: 'terminalOutput' | 'terminalEnded', payload: unknown): void;
}

export type LocalTerminalRefusal = 'no-such-session' | 'not-viewer' | 'not-writer' | 'runner-gone' | 'bad-size';

export interface LocalTerminalHubDeps {
  /** 러너에 프레임을 내린다. 링크가 없으면 false. */
  sendToRunner(runnerId: string, frame: RelayServerFrame): boolean;
  /**
   * 이 경로로 들어간 입력의 **바이트 수**를 서버 감사에 올린다(PR-3b). `gen` 은 그 바이트를 받아 준 writer 키의
   * 번호다 — 서버는 그 번호의 키를 받은 뷰어에게만 더한다. 없으면 보고하지 않는다(`takeInputBytes` 로 꺼낸다).
   */
  reportInput?(runnerId: string, sessionId: string, gen: number, bytes: number): void;
  /** 보고를 잠깐 모았다가 보낸다(키 한 번에 프레임 하나를 피한다). 기본 `setTimeout`. */
  schedule?(fn: () => void, ms: number): void;
  log(line: string): void;
}

/**
 * 입력 바이트 보고를 모으는 창(ms). 서버의 detach 감사는 창이 떠나는 순간의 합을 쓰므로 길게 잡으면 마지막
 * 몇 키가 감사에서 빠질 수 있다 — 짧게 잡고, 키를 거두거나 세션이 끝날 때는 창을 기다리지 않고 바로 턴다.
 */
export const INPUT_REPORT_MS = 200;

export interface LocalTerminalHub {
  /** 러너가 올린 프레임을 본다(서버로 가는 것과 별개로). */
  onRunnerFrame(runnerId: string, frame: RelayRunnerFrame): void;
  /** 러너가 죽었다 — 그 세션의 구독자에게 끝을 알리고 잊는다. */
  forgetRunner(runnerId: string): void;
  /** 이 sessionId 를 이 머신의 러너가 가졌는가. 다른 세션 목록은 내주지 않는다. */
  isLocal(sessionId: string): boolean;
  subscribe(sub: LocalTerminalSubscriber, sessionId: string, viewKey: string): LocalTerminalRefusal | null;
  unsubscribe(sub: LocalTerminalSubscriber, sessionId: string): void;
  /** 접속이 끊겼다 — 그 구독을 전부 뗀다. */
  drop(sub: LocalTerminalSubscriber): void;
  /** 서버가 열람 키를 준다(PR-5). */
  grantView(sessionId: string, viewKey: string): void;
  /** 서버가 열람 키를 거둔다 — 그 키로 붙은 구독은 끝난다. */
  revokeView(sessionId: string, viewKey: string): void;
  /**
   * 서버가 writer 키를 갈아 끼운다(null 이면 거둔다). `gen` 은 그 키의 번호(비밀 아님, 감사 짝맞춤용).
   * 갈아 끼우기 **전에** 옛 번호로 센 바이트를 털어 보고한다 — 새 writer 의 감사에 섞이지 않게.
   */
  grantWriter(sessionId: string, writerKey: string | null, gen?: number): void;
  /** 이 세션을 가진 러너(서버 프레임이 맞는 러너에서 왔는지 대조하는 데 쓴다). */
  ownerOf(sessionId: string): string | null;
  input(sessionId: string, writerKey: string, data: string): LocalTerminalRefusal | null;
  resize(sessionId: string, writerKey: string, cols: number, rows: number): LocalTerminalRefusal | null;
  /** 지난 호출 뒤로 이 경로에 들어간 입력 바이트 수(감사 보고용). 읽으면 0 으로 돌아간다. */
  takeInputBytes(sessionId: string): number;
}

/** 허가로 받는 키의 최소 길이. base64url 22자 ≈ 128bit — 그보다 짧은 값은 추측할 수 있는 번호로 본다. */
export const MIN_KEY_LENGTH = 22;
/** 재생을 기다리는 동안 쌓아 둘 라이브 청크 수. 넘으면 재생을 포기하고 쌓인 것부터 흘린다. */
export const MAX_AWAITING_CHUNKS = 1024;
/** 서버 허브(#335 `isPtySize`)와 같은 범위. PTY ioctl 로 그대로 내려가므로 여기서도 거른다. */
const MAX_DIM = 1000;

/** 상수 시간 대조. 길이가 다르면 바로 false 지만 길이는 비밀이 아니다(서버가 같은 길이로 만든다). */
function keyEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function usableKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= MIN_KEY_LENGTH;
}

/** base64 문자열이 담은 바이트 수. 디코드하지 않는다 — 내용은 우리가 볼 것이 아니다. */
function base64ByteLength(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

export function createLocalTerminalHub(deps: LocalTerminalHubDeps): LocalTerminalHub {
  /** sessionId → 그 세션을 가진 러너와 뷰. */
  const owner = new Map<string, { runnerId: string; view: AgentSessionView }>();
  /** sessionId → 구독자 → 그 구독을 연 열람 키(회수 때 이 키로 붙은 것만 끊는다). */
  const subs = new Map<string, Map<LocalTerminalSubscriber, string>>();
  /** 재생을 기다리는 구독자. 재생이 오기 전의 라이브 바이트는 **버리지 않고** 뒤에 붙인다. */
  const awaiting = new Map<string, Map<LocalTerminalSubscriber, string[]>>();
  const viewKeys = new Map<string, Set<string>>();
  const writerKey = new Map<string, string>();
  /** 지금 writer 키의 번호. 보고가 이 번호로 나간다. */
  const writerGen = new Map<string, number>();
  const inputBytes = new Map<string, number>();
  /** 아직 보고하지 않은 바이트 — 세션별로 번호 하나에 묶인다(번호가 바뀌면 그 전에 턴다). */
  const unreported = new Map<string, { runnerId: string; gen: number; bytes: number }>();
  const pendingFlush = new Set<string>();
  const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); });

  /** 모아 둔 바이트를 지금 보고한다. */
  const flush = (sessionId: string): void => {
    pendingFlush.delete(sessionId);
    const u = unreported.get(sessionId);
    if (!u) return;
    unreported.delete(sessionId);
    if (u.bytes > 0) deps.reportInput?.(u.runnerId, sessionId, u.gen, u.bytes);
  };

  const endSession = (sessionId: string): void => {
    // 잊기 전에 턴다(n4) — 세션이 끝난 뒤의 보고는 이 허브가 번호를 잊어 갈 곳이 없다.
    flush(sessionId);
    writerGen.delete(sessionId);
    for (const sub of subs.get(sessionId)?.keys() ?? []) sub.send('terminalEnded', { sessionId });
    subs.delete(sessionId);
    awaiting.delete(sessionId);
    owner.delete(sessionId);
    viewKeys.delete(sessionId);
    writerKey.delete(sessionId);
    // inputBytes 는 남긴다 — 감사 보고(PR-5)가 털어 가기 전에 사라지면 그 바이트가 감사에서 빠진다.
  };

  /** 다른 러너가 이미 가진 sessionId 를 덮어쓰지 않는다 — 러너 링크 비밀도 같은 uid 가 읽는다(n3). */
  const claim = (runnerId: string, view: AgentSessionView): void => {
    const cur = owner.get(view.sessionId);
    if (cur && cur.runnerId !== runnerId) {
      deps.log(`localTerminal: ${runnerId} 가 ${cur.runnerId} 의 세션 ${view.sessionId} 를 자기 것이라 했다 — 무시`);
      return;
    }
    owner.set(view.sessionId, { runnerId, view });
  };

  const writerGate = (sessionId: string, key: string): { runnerId: string } | LocalTerminalRefusal => {
    const o = owner.get(sessionId);
    if (!o) return 'no-such-session';
    const granted = writerKey.get(sessionId);
    if (granted === undefined || !keyEquals(granted, key)) return 'not-writer';
    return { runnerId: o.runnerId };
  };

  const flushAwaiting = (sessionId: string, sub: LocalTerminalSubscriber, queue: string[]): void => {
    for (const data of queue) sub.send('terminalOutput', { sessionId, data });
  };

  return {
    onRunnerFrame(runnerId, frame) {
      switch (frame.type) {
        case 'announce':
          for (const [id, o] of [...owner]) if (o.runnerId === runnerId && !frame.sessions.some((s) => s.sessionId === id)) endSession(id);
          for (const view of frame.sessions) claim(runnerId, view);
          return;
        case 'session.started':
          claim(runnerId, frame.session);
          return;
        case 'session.ended':
          if (owner.get(frame.sessionId)?.runnerId === runnerId) endSession(frame.sessionId);
          return;
        case 'output': {
          if (owner.get(frame.sessionId)?.runnerId !== runnerId) return;
          const waiting = awaiting.get(frame.sessionId);
          for (const sub of subs.get(frame.sessionId)?.keys() ?? []) {
            const queue = waiting?.get(sub);
            if (!queue) { sub.send('terminalOutput', { sessionId: frame.sessionId, data: frame.data }); continue; }
            queue.push(frame.data);
            if (queue.length > MAX_AWAITING_CHUNKS) {
              // 재생에 답하지 않는 러너다 — 재생 없이 쌓인 라이브부터 흘리고 기다리기를 그만둔다(n2).
              deps.log(`localTerminal: ${frame.sessionId} 재생이 오지 않아 기다리기를 그만둔다`);
              waiting!.delete(sub);
              flushAwaiting(frame.sessionId, sub, queue);
            }
          }
          return;
        }
        case 'replay': {
          if (owner.get(frame.sessionId)?.runnerId !== runnerId) return;
          const waiting = awaiting.get(frame.sessionId);
          if (!waiting) return;
          for (const [sub, queue] of waiting) {
            // 재생이 먼저, 그동안 쌓인 라이브가 그다음 — 서버 허브와 같은 순서 규율이다.
            sub.send('terminalOutput', { sessionId: frame.sessionId, data: frame.data, replay: true });
            flushAwaiting(frame.sessionId, sub, queue);
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
    isLocal(sessionId) {
      return owner.has(sessionId);
    },
    subscribe(sub, sessionId, viewKey) {
      const o = owner.get(sessionId);
      if (!o) return 'no-such-session';
      const keys = viewKeys.get(sessionId);
      if (!usableKey(viewKey) || !keys || ![...keys].some((k) => keyEquals(k, viewKey))) return 'not-viewer';
      let map = subs.get(sessionId);
      if (!map) { map = new Map(); subs.set(sessionId, map); }
      if (map.has(sub)) { map.set(sub, viewKey); return null; }
      if (!deps.sendToRunner(o.runnerId, { type: 'replay.request', sessionId })) return 'runner-gone';
      map.set(sub, viewKey);
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
      for (const map of subs.values()) map.delete(sub);
      for (const waiting of awaiting.values()) waiting.delete(sub);
    },
    grantView(sessionId, viewKey) {
      if (!usableKey(viewKey)) { deps.log(`localTerminal: ${sessionId} 열람 키가 너무 짧아 받지 않는다`); return; }
      let keys = viewKeys.get(sessionId);
      if (!keys) { keys = new Set(); viewKeys.set(sessionId, keys); }
      keys.add(viewKey);
    },
    revokeView(sessionId, viewKey) {
      viewKeys.get(sessionId)?.delete(viewKey);
      const map = subs.get(sessionId);
      if (!map) return;
      for (const [sub, key] of [...map]) {
        if (!keyEquals(key, viewKey)) continue;
        map.delete(sub);
        awaiting.get(sessionId)?.delete(sub);
        sub.send('terminalEnded', { sessionId, reason: 'revoked' });
      }
    },
    ownerOf(sessionId) {
      return owner.get(sessionId)?.runnerId ?? null;
    },
    grantWriter(sessionId, key, gen) {
      // 키가 바뀌면 옛 번호로 센 바이트를 먼저 턴다 — 새 번호로 섞이면 감사가 다른 사람에게 간다.
      flush(sessionId);
      writerGen.delete(sessionId);
      if (key !== null && typeof gen === 'number' && Number.isSafeInteger(gen)) writerGen.set(sessionId, gen);
      if (key === null) { writerKey.delete(sessionId); return; }
      if (!usableKey(key)) {
        deps.log(`localTerminal: ${sessionId} writer 키가 너무 짧아 받지 않는다`);
        writerKey.delete(sessionId);
        return;
      }
      writerKey.set(sessionId, key);
    },
    input(sessionId, key, data) {
      const g = writerGate(sessionId, key);
      if (typeof g === 'string') return g;
      if (!deps.sendToRunner(g.runnerId, { type: 'input', sessionId, data })) return 'runner-gone';
      const bytes = base64ByteLength(data);
      inputBytes.set(sessionId, (inputBytes.get(sessionId) ?? 0) + bytes);
      const gen = writerGen.get(sessionId);
      if (deps.reportInput && gen !== undefined) {
        const u = unreported.get(sessionId);
        if (u && u.gen === gen) u.bytes += bytes;
        else { if (u) flush(sessionId); unreported.set(sessionId, { runnerId: g.runnerId, gen, bytes }); }
        if (!pendingFlush.has(sessionId)) { pendingFlush.add(sessionId); schedule(() => flush(sessionId), INPUT_REPORT_MS); }
      }
      return null;
    },
    resize(sessionId, key, cols, rows) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_DIM || rows > MAX_DIM) return 'bad-size';
      const g = writerGate(sessionId, key);
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
