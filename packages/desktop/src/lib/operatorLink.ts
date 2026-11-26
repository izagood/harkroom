/**
 * 이 맥 오퍼레이터 ↔ 서버 링크 경고(안 A, designer 시안 v1 「operator-link-warning」 4절, 소유자 승인 2026-11-26).
 *
 * 오퍼레이터가 서버와 끊기면 에이전트 칩에는 「멈춤」만 보이고 까닭은 오퍼레이터 로그에만 있었다. 오퍼레이터가
 * `serverLinkState` 이벤트(→ Rust `harkroom://operator-link`)와 `serverLinkGet` 으로 상태를 주고, 여기서 카드 단계를 가린다.
 *
 * | 단계 | 조건 | 카드 |
 * |---|---|---|
 * | 정상 | up, 또는 down 60초 미만(깜빡임 방지) | 없음 |
 * | 재시도 중 | down 60초~5분 | 노랑, 닫기 없음 |
 * | 오래 끊김 | down 5분 이상 | 빨강, [지금 다시 시도][자세히][나중에], OS 알림 1회 |
 * | 다시 붙음 | 카드가 섰던 끊김 뒤 up — 이 맥 러너가 다 뜰 때까지 + 10초 | 초록, 저절로 걷힘 |
 *
 * **원문 오류는 오지 않는다** — 오퍼레이터가 까닭을 낱말(`ServerLinkReason`)로 접어 보낸다. 어느 커뮤니티의 오퍼레이터인지는
 * 몸의 `host` 로 가린다(커뮤니티를 섞지 않는다).
 */
import { SERVER_LINK_REASONS, type ServerLinkReason, type ServerLinkState } from '@harkroom/shared/daemonProtocol';
import { withCommunity } from './operatorCommunity';

export const OPERATOR_LINK_EVENT = 'harkroom://operator-link';
/** 이보다 짧은 끊김은 정상으로 둔다. */
export const LINK_GRACE_MS = 60_000;
/** 이만큼 끊기면 빨강(소유자 결정 2026-11-26). */
export const LINK_LONG_MS = 5 * 60_000;
/** 러너가 다 뜬 뒤 초록 카드를 더 두는 시간. */
export const LINK_BACK_HOLD_MS = 10_000;

export type LinkPhase = 'ok' | 'retry' | 'long';

/** 몸을 재서 받는다 — 모양이 틀리면 null(카드를 지어내지 않는다). */
export function parseServerLinkState(v: unknown): ServerLinkState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.state !== 'up' && o.state !== 'down') return null;
  if (typeof o.host !== 'string') return null;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const reason = typeof o.reason === 'string' && (SERVER_LINK_REASONS as readonly string[]).includes(o.reason)
    ? (o.reason as ServerLinkReason)
    : o.state === 'down' ? 'other' : null;
  return {
    state: o.state,
    reason,
    closeCode: num(o.closeCode),
    host: o.host,
    downSinceMs: num(o.downSinceMs),
    lastUpMs: num(o.lastUpMs),
    attempts: num(o.attempts) ?? 0,
    nextRetryAtMs: num(o.nextRetryAtMs),
  };
}

/** 끊긴 단계. up 이거나 시작 시각을 모르면 정상. */
export function linkPhase(link: ServerLinkState | null, nowMs: number): LinkPhase {
  if (!link || link.state === 'up' || link.downSinceMs === null) return 'ok';
  const down = nowMs - link.downSinceMs;
  if (down >= LINK_LONG_MS) return 'long';
  if (down >= LINK_GRACE_MS) return 'retry';
  return 'ok';
}

/** 그 커뮤니티 주소의 호스트(포트·경로 없이). 못 읽으면 null. */
export function hostOfBaseUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try { return new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}

/** [나중에] 열쇠 — 까닭과 끊긴 시작 시각. 까닭이 바뀌면(offline→dns) 다시 선다. */
export function linkDismissKey(link: ServerLinkState): string {
  return `${link.host}|${link.reason ?? ''}|${link.downSinceMs ?? ''}`;
}

/** 까닭마다의 할 일 키(시안 4절). */
export function linkActionKey(reason: ServerLinkReason | null): 'opLink.do.network' | 'opLink.do.wait' | 'opLink.do.auth' | 'opLink.do.other' {
  switch (reason) {
    case 'dns': case 'offline': return 'opLink.do.network';
    case 'closed': case 'refused': case 'tls': return 'opLink.do.wait';
    case 'auth': return 'opLink.do.auth';
    default: return 'opLink.do.other';
  }
}

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback?: (cb: (payload: unknown) => void) => number;
}
function internals(): TauriInternals | null {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return g.__TAURI_INTERNALS__ ?? null;
}

export function hasOperatorLinkSurface(): boolean {
  return typeof internals()?.invoke === 'function';
}

/** 지금 상태 한 장(끊긴 도중에 앱이 켜졌을 때). 링크가 없거나 옛 오퍼레이터면 null. */
export async function getOperatorLink(community?: string | null): Promise<ServerLinkState | null> {
  const invoke = internals()?.invoke;
  if (!invoke) return null;
  try {
    return parseServerLinkState(await invoke('operator_server_link_get', withCommunity(community ? { community } : undefined)));
  } catch {
    return null;
  }
}

/** [지금 다시 시도] — 재접속 대기를 건너뛴다. */
export async function retryOperatorLinkNow(community?: string | null): Promise<boolean> {
  const invoke = internals()?.invoke;
  if (!invoke) return false;
  try {
    const out = await invoke('operator_server_link_retry_now', withCommunity(community ? { community } : undefined)) as { retried?: unknown } | null;
    return out?.retried === true;
  } catch {
    return false;
  }
}

/** 상태 바뀜을 듣는다. 표면이 없으면 아무것도 안 하는 해제 함수. */
export async function listenOperatorLink(cb: (link: ServerLinkState) => void): Promise<() => void> {
  const api = internals();
  if (typeof api?.invoke !== 'function' || typeof api.transformCallback !== 'function') return () => undefined;
  const invoke = api.invoke;
  const handlerId = api.transformCallback((payload) => {
    const link = parseServerLinkState((payload as { payload?: unknown })?.payload);
    if (link) cb(link);
  });
  const eventId = await invoke('plugin:event|listen', { event: OPERATOR_LINK_EVENT, target: { kind: 'Any' }, handler: handlerId });
  return () => { void invoke('plugin:event|unlisten', { event: OPERATOR_LINK_EVENT, eventId }); };
}
