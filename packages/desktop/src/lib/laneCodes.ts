/**
 * API 키 연결 실패 코드 → 사람 말(designer v3 ④ 표). 실패 카드·격자·실행 탭 「마지막 시도」 세 곳이 **이 표 하나**를 쓴다.
 * 코드는 허용 목록(`PROVIDER_LANE_FAILURE_CODES`)으로 접혀 오고, 여기 없는 코드는 `unknown` 문장으로 접는다(security ③).
 */
import { providerLaneFailureCode } from '@harkroom/shared/providerLane';
import type { Translate } from '../i18n';

export type LaneCodeKey =
  | 'lane.code.lane_unset' | 'lane.code.not_granted' | 'lane.code.not_found' | 'lane.code.grant_suspended'
  | 'lane.code.secret_expired' | 'lane.code.no_lease' | 'lane.code.bg_unsupported' | 'lane.code.harness_unsupported'
  | 'lane.code.bad_model' | 'lane.code.workspace_protected' | 'lane.code.harness_version' | 'lane.code.interactive_unsupported' | 'lane.code.unknown';

/** 터미널 거절(러너 `interactive_unsupported`)은 실패 카드 코드가 아니라 거절 문장의 머리다 — 같은 표에서 문장을 고른다. */
export const INTERACTIVE_UNSUPPORTED_PREFIX = 'interactive_unsupported';

export function laneCodeKey(raw: unknown): LaneCodeKey {
  if (raw === INTERACTIVE_UNSUPPORTED_PREFIX) return 'lane.code.interactive_unsupported';
  const code = providerLaneFailureCode(raw);
  switch (code) {
    case 'lane_unset': case 'bad_base_url': return 'lane.code.lane_unset';
    case 'not_granted': case 'forbidden': return 'lane.code.not_granted';
    case 'not_found': return 'lane.code.not_found';
    case 'grant_suspended': return 'lane.code.grant_suspended';
    case 'secret_expired': return 'lane.code.secret_expired';
    case 'no_lease': case 'lease_invalid': return 'lane.code.no_lease';
    case 'bg_unsupported': return 'lane.code.bg_unsupported';
    case 'harness_unsupported': return 'lane.code.harness_unsupported';
    case 'bad_model': return 'lane.code.bad_model';
    case 'workspace_protected': return 'lane.code.workspace_protected';
    case 'harness_version': return 'lane.code.harness_version';
    default: return 'lane.code.unknown';
  }
}

export function laneCodeText(t: Translate, raw: unknown): string {
  return t(laneCodeKey(raw));
}

/** 터미널 열기 오류 문장이 러너의 API 키 거절인가(`interactive_unsupported: …`). 서버가 문장을 그대로 실어 온다. */
export function isInteractiveUnsupported(message: string): boolean {
  return message.includes(`${INTERACTIVE_UNSUPPORTED_PREFIX}:`);
}

/** 화면 끝에 작게 다는 코드 이름 — 허용 목록 밖(주소·경로가 섞인 값 등)은 그대로 비추지 않고 `unknown` 으로 접는다. */
export function laneCodeName(raw: unknown): string {
  return providerLaneFailureCode(raw);
}
