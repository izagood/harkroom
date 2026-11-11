// 같은 머신 터미널 직결의 **웹뷰 쪽 얇은 표면**(R1 PR-4, 스레드 8d233406).
//
// 왜 있나: 러너가 같은 맥이면 키 하나가 앱 → 서버 → 오퍼레이터 → 러너 → … → 서버 → 앱으로 두 번 왕복하던 것을
// (추정 0.7~0.8초) 오퍼레이터 소켓 안에서 돌려준다. 이 파일은 Rust 명령(`terminal_*`)과 이벤트를 감쌀 뿐이다 —
// **판정은 오퍼레이터가 한다**: 열람 키가 맞아야 출력을 구독하고, writer 키가 맞아야 입력을 받는다. 키는 서버가
// 이 창의 attach 소켓에만 내린 것이다(`agentTerminal.ts` 의 `local`·`writer.writerKey`).
//
// 표면이 없는 세상(웹·테스트)에서는 `null` 을 돌려 화면이 서버 경유로 남게 한다 — 던지지 않는다.

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriInternals {
  invoke?: Invoke;
  transformCallback?: (cb: (payload: unknown) => void) => number;
}

function internals(): TauriInternals | null {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return g.__TAURI_INTERNALS__ ?? null;
}

/** Rust 가 쓰는 이벤트 이름. `main.rs::TERMINAL_OUTPUT_EVENT`·`TERMINAL_ENDED_EVENT` 와 **같은 값**이어야 한다. */
export const TERMINAL_OUTPUT_EVENT = 'harkroom://terminal-output';
export const TERMINAL_ENDED_EVENT = 'harkroom://terminal-ended';

/** 오퍼레이터의 거절 사유(`operator/src/localTerminal.ts` 의 `LocalTerminalRefusal`). */
export type LocalRefusal = 'no-such-session' | 'not-viewer' | 'not-writer' | 'runner-gone' | 'bad-size' | 'unavailable';

/** 오퍼레이터 답 `{ok:true}` / `{ok:false, reason}` 을 거절 사유(없으면 null)로 읽는다. 표면이 없거나 던지면 `unavailable`. */
function readAnswer(value: unknown): LocalRefusal | null {
  const v = value as { ok?: unknown; reason?: unknown } | null;
  if (v?.ok === true) return null;
  return typeof v?.reason === 'string' ? (v.reason as LocalRefusal) : 'unavailable';
}

export interface LocalTerminalPort {
  /** 이 세션을 이 맥의 러너가 가졌는가. 표면이 없거나 묻지 못하면 false(서버 경유로 남는다). */
  isLocal(sessionId: string): Promise<boolean>;
  subscribe(sessionId: string, viewKey: string): Promise<LocalRefusal | null>;
  unsubscribe(sessionId: string): Promise<void>;
  /** `data` 는 base64 다(서버 경로와 같은 규율 — 바이트를 문자열로 디코드하지 않는다). */
  input(sessionId: string, writerKey: string, data: string): Promise<LocalRefusal | null>;
  resize(sessionId: string, writerKey: string, cols: number, rows: number): Promise<LocalRefusal | null>;
  /** 이 세션의 출력·끝을 듣는다. 끊는 함수를 돌려준다. */
  listen(sessionId: string, cb: { onOutput(base64: string): void; onEnded(reason: string | null): void }): Promise<() => void>;
}

function createTauriPort(api: TauriInternals & { invoke: Invoke }): LocalTerminalPort {
  const call = async (cmd: string, args: Record<string, unknown>): Promise<LocalRefusal | null> => {
    try { return readAnswer(await api.invoke(cmd, args)); } catch { return 'unavailable'; }
  };
  const listenOne = async (event: string, handler: (body: Record<string, unknown>) => void): Promise<() => void> => {
    if (typeof api.transformCallback !== 'function') return () => undefined;
    const handlerId = api.transformCallback((payload) => {
      const body = (payload as { payload?: unknown })?.payload;
      if (body && typeof body === 'object') handler(body as Record<string, unknown>);
    });
    const eventId = await api.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler: handlerId });
    return () => { void api.invoke('plugin:event|unlisten', { event, eventId }); };
  };
  return {
    async isLocal(sessionId) {
      try {
        const v = (await api.invoke('terminal_is_local', { sessionId })) as { local?: unknown } | null;
        return v?.local === true;
      } catch {
        return false;
      }
    },
    subscribe: (sessionId, viewKey) => call('terminal_subscribe', { sessionId, viewKey }),
    async unsubscribe(sessionId) { await call('terminal_unsubscribe', { sessionId }); },
    input: (sessionId, writerKey, data) => call('terminal_input', { sessionId, writerKey, data }),
    resize: (sessionId, writerKey, cols, rows) => call('terminal_resize', { sessionId, writerKey, cols, rows }),
    async listen(sessionId, cb) {
      // 이벤트는 앱 전체로 온다 — 이 세션 것만 고른다.
      const offOut = await listenOne(TERMINAL_OUTPUT_EVENT, (b) => {
        if (b.sessionId === sessionId && typeof b.data === 'string') cb.onOutput(b.data);
      });
      const offEnd = await listenOne(TERMINAL_ENDED_EVENT, (b) => {
        if (b.sessionId === sessionId) cb.onEnded(typeof b.reason === 'string' ? b.reason : null);
      });
      return () => { offOut(); offEnd(); };
    },
  };
}

let override: LocalTerminalPort | null | undefined;

/** 시험이 바꿔 끼운다. `null` 이면 "표면 없음". `undefined` 로 되돌린다. */
export function setLocalTerminalPort(port: LocalTerminalPort | null | undefined): void {
  override = port;
}

/** 이 빌드의 직결 표면. 웹·테스트처럼 Tauri 가 없으면 `null` — 화면은 서버 경유로 남는다. */
export function getLocalTerminalPort(): LocalTerminalPort | null {
  if (override !== undefined) return override;
  const api = internals();
  if (typeof api?.invoke !== 'function') return null;
  return createTauriPort(api as TauriInternals & { invoke: Invoke });
}
