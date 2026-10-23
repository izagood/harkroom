/**
 * 전용 제공사 경로의 턴 마운트(`@harkroom/shared/providerLane`) — 러너가 PTY 를 띄우기 직전에 부른다.
 *
 * 러너는 relay 로 `POST PROVIDER_LANE_MOUNT_PATH {cause}` 를 보낸다. 여기서 그 에이전트의 로컬 설정(`operator.json`)을
 * **매번** 읽어 비밀 이름을 고르고, 그 턴의 임대로 `turnSecrets.mountFor` 를 부른다. 답은 base URL 과 값 파일의
 * 경로다 — 값은 이 응답에 싣지 않는다(파일만, `turnSecrets.ts` 의 원칙).
 *
 * - **relay 에서만**(브릿지·hook 이 부르면 403). 브릿지는 하네스가 띄운 것이라 모델이 고를 수 있다.
 * - base URL·비밀 이름은 로컬 설정에서만 온다(security ⓓ). 요청 본문은 cause 하나만 읽는다.
 * - 설정이 없으면 `{lane: null}`(200). 러너는 lane 으로 떴는데 이 답이면 턴을 멈춘다 — 계정 로그인으로 떨어지지 않는다.
 */
import type { RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { TURN_SLOTS_PATH } from './turnSlots.js';
import { PROVIDER_LANE_MOUNT_PATH, providerLaneFailureCode, readProviderLaneConfig, type ProviderLaneConfig, type ProviderLaneFailureCode, type ProviderLaneMountResult, type ProviderLaneStatus } from '@harkroom/shared/providerLane';
import type { TurnSecrets } from './turnSecrets.js';

const CAUSE_MAX = 128;

/**
 * 에이전트별 마지막 키 받기 결과(2a, `ProviderLaneStatus`). **메모리에만** 둔다 — 화면의 「마지막 시도」 줄을 위한 것이라
 * 오퍼레이터가 다시 뜨면 비어도 된다(다음 턴이 채운다). 러너의 결과 통지가 정본이고, 마운트 실패는 러너가 통지를
 * 못 보내고 죽는 경우를 위해 여기서도 적는다.
 */
export interface ProviderLaneStatusBook {
  note(agentId: string, ok: boolean, code?: ProviderLaneFailureCode): void;
  /** 그 턴의 끝(n16). 키 받기가 성공한 기록에만 붙는다 — 없으면 버린다. */
  noteTurn(agentId: string, ok: boolean): void;
  snapshot(): Record<string, ProviderLaneStatus>;
}

export function createProviderLaneStatusBook(now: () => number = Date.now): ProviderLaneStatusBook {
  const book = new Map<string, ProviderLaneStatus>();
  return {
    note(agentId, ok, code) {
      book.set(agentId, { at: new Date(now()).toISOString(), ok, ...(ok ? {} : { code: providerLaneFailureCode(code) }) });
    },
    noteTurn(agentId, ok) {
      const cur = book.get(agentId);
      if (!cur?.ok) return;
      if (ok) { const { apiFailed: _, ...rest } = cur; book.set(agentId, rest); }
      else book.set(agentId, { ...cur, apiFailed: true });
    },
    snapshot() {
      return Object.fromEntries(book);
    },
  };
}

export interface ProviderLaneMountDeps {
  /** 그 에이전트의 로컬 lane 설정. 매번 파일에서 읽는다 — 앱이 바꾼 값이 다음 턴에 바로 든다. */
  laneOf(agentId: string): Promise<ProviderLaneConfig | null>;
  turnSecrets: Pick<TurnSecrets, 'mountFor'>;
  /** 마운트 실패를 적을 곳. 없으면 안 적는다. */
  status?: ProviderLaneStatusBook;
  log(line: string): void;
}

export interface ProviderLaneMount {
  maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest, from: RunnerLinkKind): Promise<RunnerLinkResponse | null>;
}

export function createProviderLaneMount(deps: ProviderLaneMountDeps): ProviderLaneMount {
  const answer = (req: RunnerLinkRequest, status: number, body: unknown): RunnerLinkResponse =>
    ({ type: 'http.response', id: req.id, status, body: JSON.stringify(body) });
  const refuse = (req: RunnerLinkRequest, status: number, code: string) => answer(req, status, { error: { code } });

  return {
    async maybeHandle(runnerId, agentId, req, from) {
      if (req.type !== 'http.forward' || req.method !== 'POST') return null;
      if (req.path.split('?')[0] !== PROVIDER_LANE_MOUNT_PATH) return null;
      if (from !== 'relay') return refuse(req, 403, 'forbidden');
      let cause: unknown;
      try { cause = (JSON.parse(req.body ?? '') as { cause?: unknown }).cause; } catch { cause = undefined; }
      if (typeof cause !== 'string' || !cause || cause.length > CAUSE_MAX) return refuse(req, 400, 'bad_request');

      const lane = readProviderLaneConfig(await deps.laneOf(agentId).catch(() => null));
      if (!lane) return answer(req, 200, { lane: null } satisfies ProviderLaneMountResult);
      const out = await deps.turnSecrets.mountFor(runnerId, cause, lane.secretName);
      if (!out.ok) {
        // 거절 코드는 비밀이 아니다 — 러너가 실패 통지에 싣는다. 이름·주소는 찍지 않는다.
        deps.log(`provider-lane: agent=${agentId} 비밀을 못 꺼냈다 — ${out.code}`);
        deps.status?.note(agentId, false, providerLaneFailureCode(out.code));
        return refuse(req, out.code === 'no_lease' ? 409 : 502, out.code);
      }
      return answer(req, 200, { lane: { baseUrl: lane.baseUrl, path: out.path } } satisfies ProviderLaneMountResult);
    },
  };
}

/**
 * 러너의 API 키 연결 모드가 지금 설정과 다르면 **새 턴 자리**를 막는다(C1, security ⓒ). 켰는데 아직 옛 러너(풀 모드)면 그 러너가
 * 풀 계정으로 새 턴을 세우는 틈이 생긴다 — 설정을 바꾸면 러너를 다시 띄우지만, 다시 뜨기 전까지(도는 턴이 끝날 때까지)가 그 틈이다.
 * 409 는 러너가 「가득 참」으로 읽어 읽음 처리 없이 다음 폴로 미룬다. 자리 **놓기**(`/release`)는 막지 않는다. 같은 러너는 한 번만 적는다.
 */
export function createLaneTurnGate(deps: { mismatch(runnerId: string, agentId: string): boolean; log(line: string): void }) {
  const logged = new Set<string>();
  return {
    maybeBlock(runnerId: string, agentId: string, req: RunnerLinkRequest, from: RunnerLinkKind): RunnerLinkResponse | null {
      if (from !== 'relay' || req.type !== 'http.forward' || req.method !== 'POST' || req.path.split('?')[0] !== TURN_SLOTS_PATH) return null;
      if (!deps.mismatch(runnerId, agentId)) { logged.delete(runnerId); return null; }
      if (!logged.has(runnerId)) {
        logged.add(runnerId);
        deps.log(`API 키 연결: agent=${agentId} 러너 모드가 설정과 달라 새 턴을 막는다 — 러너가 다시 뜨면 풀린다`);
      }
      return { type: 'http.response', id: req.id, status: 409, body: JSON.stringify({ error: { code: 'lane_pending' } }) };
    },
  };
}
