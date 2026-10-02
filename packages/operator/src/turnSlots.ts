/**
 * 동시 턴 상한 — 오퍼레이터 **전체**에서 센다(`HARKROOM_MAX_TURNS`, 원격 operator 계획 R1, 스레드 3b0f0255).
 *
 * 왜: 턴은 러너 안에서 스레드마다 하나씩, 러너끼리는 아무 상한 없이 뜬다(스펙 2026-09-08 "동시 상한은 두지
 * 않는다"). 2026-10-02 22:05 KST 에 러너 15개 아래 턴이 겹쳐 맥이 메모리 부족으로 꺼졌다. 턴 하나의 프로세스
 * 트리(claude + mcp-bridge + 빌드 자식)가 맥 실측 0.47~0.62GB 이고, 빌드가 겹치면 그 몇 배다. 에이전트마다
 * 러너가 따로라 러너 안의 상한으로는 머신 전체를 못 막는다 — 러너를 모두 띄우는 오퍼레이터가 센다.
 *
 * 길: 러너가 턴을 띄우기 직전 `http.forward POST /agent/turn-slots` 로 자리를 묻는다. **서버로 나가지 않고
 * 여기서 답한다**(`turnMerge` 와 같은 가로채기). 그래서 옛 오퍼레이터는 이 경로를 서버로 넘기고, 서버는 그런
 * 라우트가 없어 404 를 주며, 러너는 그것을 "상한 없음"으로 읽는다 — 판 차이에서 턴이 멈추지 않는다.
 *
 * - 자리가 없으면 409. 러너는 그 멘션을 `blocked` 로 세고 **읽음 처리하지 않는다** — 인박스가 곧 대기열이다.
 * - 자리의 키는 `(runnerId, key)` 다. runnerId 는 링크 인증이 정한 값이라 러너가 남의 자리를 놓을 수 없다.
 * - 러너의 relay 링크가 끊기면(러너가 죽었다) 그 러너의 자리를 전부 돌려받는다(`releaseRunner`).
 * - 상한은 **새로 띄우는 것만** 막는다. 오퍼레이터가 재기동하면 장부가 비어 채택한 러너의 도는 턴을 세지
 *   못한다 — 그 사이는 상한을 잠깐 넘을 수 있다. 막기보다 덜 위험한 쪽(일이 멈추지 않는 쪽)을 골랐다.
 * - 값이 없거나 0 이면 상한이 없다(지금까지와 같다).
 */
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';

export const TURN_SLOTS_PATH = '/agent/turn-slots';
export const TURN_SLOTS_RELEASE_PATH = '/agent/turn-slots/release';
export const MAX_TURNS_ENV = 'HARKROOM_MAX_TURNS';

/** 러너가 보내는 키(스레드 키). 길이만 막는다 — 비교에만 쓰고 어디에도 찍지 않는다. */
const KEY_MAX = 512;

/**
 * env 값을 상한으로 읽는다. 없음·빈 값·0 은 상한 없음(null). 숫자가 아니면 상한 없음 + 경고 —
 * 잘못 적은 값 하나로 모든 턴이 멈추는 쪽보다 낫다.
 */
export function parseMaxTurns(raw: string | undefined, log: (line: string) => void = () => {}): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const v = raw.trim();
  if (!/^\d{1,4}$/.test(v)) {
    log(`${MAX_TURNS_ENV}=${JSON.stringify(v.slice(0, 20))} 는 0 이상의 정수가 아니다 — 동시 턴 상한 없이 돈다`);
    return null;
  }
  const n = Number(v);
  return n === 0 ? null : n;
}

export interface TurnSlots {
  /** 이 요청이 자리 요청이면 답을 만든다. 아니면 null(다음 처리자로 넘긴다). */
  maybeHandle(runnerId: string, req: RunnerLinkRequest): RunnerLinkResponse | null;
  /** 러너가 죽었다 — 그 러너의 자리를 돌려받는다. */
  releaseRunner(runnerId: string): void;
  /** 지금 쥔 자리 수(상태 표시·시험용). */
  inUse(): number;
  readonly max: number | null;
}

export function createTurnSlots(opts: { max: number | null; log?: (line: string) => void }): TurnSlots {
  const log = opts.log ?? (() => {});
  /** runnerId → 그 러너가 쥔 키들. */
  const held = new Map<string, Set<string>>();
  let count = 0;
  let lastFullLogAt = 0;

  const answer = (req: RunnerLinkRequest, status: number, body: unknown): RunnerLinkResponse =>
    ({ type: 'http.response', id: req.id, status, body: JSON.stringify(body) });

  const readKey = (req: Extract<RunnerLinkRequest, { type: 'http.forward' }>): string | null => {
    try {
      const v = (JSON.parse(req.body ?? '') as { key?: unknown }).key;
      return typeof v === 'string' && v.length > 0 && v.length <= KEY_MAX ? v : null;
    } catch {
      return null;
    }
  };

  return {
    max: opts.max,
    inUse: () => count,

    maybeHandle(runnerId, req) {
      if (req.type !== 'http.forward' || req.method !== 'POST') return null;
      const path = req.path.split('?')[0];
      if (path !== TURN_SLOTS_PATH && path !== TURN_SLOTS_RELEASE_PATH) return null;
      const key = readKey(req);
      if (!key) return answer(req, 400, { error: { code: 'bad_request', message: 'key 가 없다' } });
      const mine = held.get(runnerId);

      if (path === TURN_SLOTS_RELEASE_PATH) {
        if (mine?.delete(key)) {
          count -= 1;
          if (!mine.size) held.delete(runnerId);
        }
        // 멱등 — 없는 자리를 놓아도 204 다.
        return { type: 'http.response', id: req.id, status: 204, body: '' };
      }

      // 같은 키를 다시 잡으면 이미 쥔 것이다(재시도) — 두 번 세지 않는다.
      if (mine?.has(key)) return answer(req, 200, { max: opts.max, inUse: count });
      if (opts.max !== null && count >= opts.max) {
        const now = Date.now();
        // 붐빌 때 폴마다 찍히지 않게 1분에 한 번만 남긴다.
        if (now - lastFullLogAt > 60_000) {
          lastFullLogAt = now;
          log(`동시 턴 상한(${opts.max})이 찼다 — 새 턴은 자리가 날 때까지 인박스에서 기다린다`);
        }
        return answer(req, 409, { error: { code: 'turn_slots_full', message: `동시 턴 상한 ${opts.max} 이 찼다` }, max: opts.max, inUse: count });
      }
      const set = mine ?? new Set<string>();
      set.add(key);
      held.set(runnerId, set);
      count += 1;
      return answer(req, 200, { max: opts.max, inUse: count });
    },

    releaseRunner(runnerId) {
      const mine = held.get(runnerId);
      if (!mine) return;
      count -= mine.size;
      held.delete(runnerId);
    },
  };
}
