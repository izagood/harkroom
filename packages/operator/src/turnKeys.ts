/**
 * 턴 열쇠 장부 — 하네스 아래에 주는 좁은 턴 자격(설계: harkroom 스레드 b22c0d4f, architect C안).
 *
 * 러너는 하네스를 띄울 때마다 열쇠 둘(`bridge`·`shell`, shared `TurnKeyScope`)을 만들어 **relay 요청**
 * (`http.forward POST TURN_KEYS_PATH`)으로 여기 맡기고, 답(200)을 받은 뒤에 띄운다. 하네스가 끝나면
 * `TURN_KEYS_END_PATH` 로 그 턴의 열쇠를 지운다. 서버로 나가지 않는다(`turnSlots` 와 같은 가로채기).
 *
 * - 맡기기·끝내기는 **relay 소켓에서만** 받는다 — 하네스가 여는 소켓(bridge·hook·wrapper)에서 오면 403.
 * - 열쇠는 그것을 맡긴 러너(`runnerId`)에 묶인다. hello 의 runnerId 가 다르면 못 붙는다.
 * - 열쇠로 붙은 소켓의 요청은 cause·턴 id 를 **장부 값으로** 쓴다(`runnerLink.ts`) — 셸 env 의 값을 믿지 않는다.
 * - 장부에는 원값이 아니라 sha256 을 둔다. 러너가 잊히면(`forgetRunner`) 그 러너의 열쇠를 전부 지우고,
 *   끝내기가 오지 않은 열쇠는 `TURN_KEY_MAX_AGE_MS` 뒤에 쓴다. 오퍼레이터가 다시 뜨면 장부가 비어 모두 죽는다.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  TURN_KEY_PATTERN, TURN_KEYS_END_PATH, TURN_KEYS_PATH,
  type RunnerLinkKind, type RunnerLinkRequest, type RunnerLinkResponse, type TurnKeyScope,
} from '@harkroom/shared/runnerLink';
import { API_TOOL } from './turnApi.js';
import { MERGE_TOOL } from './turnMerge.js';

/** 끝내기가 오지 않은 열쇠의 수명 상한. 대화형 턴이 길어서 넉넉히 둔다. */
export const TURN_KEY_MAX_AGE_MS = 12 * 60 * 60_000;
/** 러너 하나가 쥘 수 있는 턴 수 — 넘치면 맡기기를 거절한다(장부를 키우지 못하게). */
export const TURN_KEYS_PER_RUNNER = 64;
const ID_MAX = 200;

export interface TurnKeyEntry {
  runnerId: string;
  scope: TurnKeyScope;
  turnId: string;
  /** 그 턴을 띄운 메시지 id. 대화형·백그라운드 턴은 없다. */
  cause: string | null;
}

export interface TurnKeyLedger {
  /** 맡기기·끝내기 요청이면 답한다. 아니면 null(다음 처리기로). */
  maybeHandle(runnerId: string, req: RunnerLinkRequest, from: RunnerLinkKind): RunnerLinkResponse | null;
  /** 열쇠 원값으로 찾는다. 모르면 null. */
  lookup(key: string): TurnKeyEntry | null;
  /** 러너가 잊혔다 — 그 러너의 열쇠를 전부 지운다. */
  forgetRunner(runnerId: string): void;
  /** 수명을 넘긴 열쇠를 지운다. */
  sweep(): void;
  /** 지금 장부에 있는 열쇠 수(시험·상태용). */
  size(): number;
}

const digest = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest();

export function createTurnKeyLedger(opts: { now?: () => number; log?: (line: string) => void } = {}): TurnKeyLedger {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  /** sha256(hex) → 항목. */
  const byDigest = new Map<string, TurnKeyEntry & { digest: Buffer; at: number }>();
  /** runnerId → turnId → 그 턴 열쇠들의 digest(hex). */
  const byRunner = new Map<string, Map<string, string[]>>();

  const answer = (req: RunnerLinkRequest, status: number, body: unknown): RunnerLinkResponse =>
    req.type === 'mcp.request'
      ? { type: 'mcp.error', id: req.id, status, message: JSON.stringify(body) }
      : { type: 'http.response', id: req.id, status, body: JSON.stringify(body) };

  const dropTurn = (runnerId: string, turnId: string): void => {
    const turns = byRunner.get(runnerId);
    const digests = turns?.get(turnId);
    if (!turns || !digests) return;
    for (const d of digests) byDigest.delete(d);
    turns.delete(turnId);
    if (turns.size === 0) byRunner.delete(runnerId);
  };

  const parse = (req: Extract<RunnerLinkRequest, { type: 'http.forward' }>): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(req.body ?? '');
      return typeof v === 'object' && v !== null ? v as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;

  return {
    maybeHandle(runnerId, req, from) {
      if (req.type !== 'http.forward' || (req.path !== TURN_KEYS_PATH && req.path !== TURN_KEYS_END_PATH)) return null;
      // 하네스가 여는 소켓은 열쇠를 맡기거나 지우지 못한다 — 맡기는 것은 러너 코어뿐이다.
      if (from !== 'relay') return answer(req, 403, { error: 'relay_only' });
      if (req.method !== 'POST') return answer(req, 405, { error: 'method' });
      const body = parse(req);
      if (!body || !id(body.turnId)) return answer(req, 400, { error: 'bad_request' });
      const turnId = body.turnId;
      if (req.path === TURN_KEYS_END_PATH) {
        dropTurn(runnerId, turnId);
        return answer(req, 200, { ok: true });
      }
      const cause = body.cause === undefined || body.cause === null ? null : body.cause;
      if (cause !== null && !id(cause)) return answer(req, 400, { error: 'bad_request' });
      const keys = body.keys as Record<string, unknown> | undefined;
      const bridge = keys?.bridge;
      const shell = keys?.shell;
      if (typeof bridge !== 'string' || typeof shell !== 'string' || !TURN_KEY_PATTERN.test(bridge) || !TURN_KEY_PATTERN.test(shell) || bridge === shell) {
        return answer(req, 400, { error: 'bad_keys' });
      }
      const turns = byRunner.get(runnerId) ?? new Map<string, string[]>();
      if (!turns.has(turnId) && turns.size >= TURN_KEYS_PER_RUNNER) {
        log(`턴 열쇠 맡기기 거절: runnerId=${runnerId} — 턴 ${TURN_KEYS_PER_RUNNER}개가 이미 열려 있다`);
        return answer(req, 429, { error: 'too_many_turns' });
      }
      // 같은 턴을 다시 맡기면 앞 열쇠를 버린다(재spawn).
      dropTurn(runnerId, turnId);
      const at = now();
      const digests: string[] = [];
      for (const [scope, key] of [['bridge', bridge], ['shell', shell]] as const) {
        const d = digest(key);
        const hex = d.toString('hex');
        if (byDigest.has(hex)) {
          for (const x of digests) byDigest.delete(x);
          return answer(req, 409, { error: 'key_reused' });
        }
        byDigest.set(hex, { runnerId, scope, turnId, cause, digest: d, at });
        digests.push(hex);
      }
      turns.set(turnId, digests);
      byRunner.set(runnerId, turns);
      return answer(req, 200, { ok: true });
    },

    lookup(key) {
      if (!TURN_KEY_PATTERN.test(key)) return null;
      const d = digest(key);
      const hit = byDigest.get(d.toString('hex'));
      // 맵 조회는 digest 로 하고, 찾은 뒤에도 상수 시간으로 한 번 더 맞춘다.
      if (!hit || !timingSafeEqual(hit.digest, d)) return null;
      if (now() - hit.at > TURN_KEY_MAX_AGE_MS) return null;
      return { runnerId: hit.runnerId, scope: hit.scope, turnId: hit.turnId, cause: hit.cause };
    },

    forgetRunner(runnerId) {
      const turns = byRunner.get(runnerId);
      if (!turns) return;
      for (const turnId of [...turns.keys()]) dropTurn(runnerId, turnId);
    },

    sweep() {
      const t = now();
      for (const [runnerId, turns] of [...byRunner]) {
        for (const [turnId, digests] of [...turns]) {
          const first = digests[0] === undefined ? undefined : byDigest.get(digests[0]);
          if (!first || t - first.at > TURN_KEY_MAX_AGE_MS) dropTurn(runnerId, turnId);
        }
      }
    },

    size: () => byDigest.size,
  };
}

/** 래퍼 소켓(`wrapper`)이 받는 요청인가 — `tools/call` 의 머지·api 도구 하나. 셸 열쇠의 힘을 셸이 하던 일까지로 묶는다. */
export function isWrapperCall(req: RunnerLinkRequest): boolean {
  if (req.type !== 'mcp.request') return false;
  const p = req.payload as { method?: unknown; params?: { name?: unknown } } | null;
  return typeof p === 'object' && p !== null && p.method === 'tools/call' && (p.params?.name === MERGE_TOOL || p.params?.name === API_TOOL);
}
