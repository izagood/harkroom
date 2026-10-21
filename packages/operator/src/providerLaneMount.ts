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
import { PROVIDER_LANE_MOUNT_PATH, readProviderLaneConfig, type ProviderLaneConfig, type ProviderLaneMountResult } from '@harkroom/shared/providerLane';
import type { TurnSecrets } from './turnSecrets.js';

const CAUSE_MAX = 128;

export interface ProviderLaneMountDeps {
  /** 그 에이전트의 로컬 lane 설정. 매번 파일에서 읽는다 — 앱이 바꾼 값이 다음 턴에 바로 든다. */
  laneOf(agentId: string): Promise<ProviderLaneConfig | null>;
  turnSecrets: Pick<TurnSecrets, 'mountFor'>;
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
        return refuse(req, out.code === 'no_lease' ? 409 : 502, out.code);
      }
      return answer(req, 200, { lane: { baseUrl: lane.baseUrl, path: out.path } } satisfies ProviderLaneMountResult);
    },
  };
}
