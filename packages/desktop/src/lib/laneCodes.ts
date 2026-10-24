/**
 * API 키 연결 실패 코드 → 사람 말(designer v3 ④ 표). 실패 카드·격자·실행 탭 「마지막 시도」 세 곳이 **이 표 하나**를 쓴다.
 * 코드는 허용 목록(`PROVIDER_LANE_FAILURE_CODES`)으로 접혀 오고, 여기 없는 코드는 `unknown` 문장으로 접는다(security ③).
 */
import { CODEX_LANE_VERSIONS, KILO_LANE_VERSIONS, OMP_LANE_VERSIONS, OPENCODE_LANE_VERSIONS, PI_LANE_VERSIONS, providerLaneFailureCode } from '@harkroom/shared/providerLane';
import type { Translate } from '../i18n';

export type LaneCodeKey =
  | 'lane.code.lane_unset' | 'lane.code.not_granted' | 'lane.code.not_found' | 'lane.code.grant_suspended'
  | 'lane.code.secret_expired' | 'lane.code.no_lease' | 'lane.code.bg_unsupported' | 'lane.code.harness_unsupported'
  | 'lane.code.bad_model' | 'lane.code.workspace_protected' | 'lane.code.harness_version' | 'lane.code.harness_login_present' | 'lane.code.lane_setup' | 'lane.code.interactive_unsupported' | 'lane.code.unknown';

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
    case 'harness_login_present': return 'lane.code.harness_login_present';
    case 'lane_setup': return 'lane.code.lane_setup';
    default: return 'lane.code.unknown';
  }
}

/** 하네스별로 API 키 연결 격리를 잰 판(러너 판 관문과 같은 상수). 판 관문이 없는 하네스는 여기 없다. */
const LANE_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  opencode: OPENCODE_LANE_VERSIONS,
  codex: CODEX_LANE_VERSIONS,
  omp: OMP_LANE_VERSIONS,
  kilo: KILO_LANE_VERSIONS,
  pi: PI_LANE_VERSIONS,
};

/**
 * 하네스별로 API 키 전용 홈의 로그인 파일 자리(러너 `harness_login_present`, 에이전트 상태 폴더 기준). codex 는 lane 홈 하나,
 * pi 는 스레드마다 폴더가 따로 있다(`piHome.ts` threads/<해시>). `{thread}` 는 그 말로 바꿔 끼운다.
 */
const LANE_LOGIN_HOMES: Readonly<Record<string, string>> = {
  codex: 'codex-provider-lane/auth.json',
  pi: 'pi-provider-lane/threads/{thread}/auth.json',
};

/**
 * 까닭 코드를 사람 말로. `harness` 를 알면(설정 화면) 판 문장에 **그 하네스의 판만** 싣는다(designer n1). 모르면(실패 카드 — meta 에
 * 하네스가 없다) 판 관문이 있는 하네스를 모두 「opencode 1.18.32 · codex 0.154.0」 꼴로 늘어놓는다.
 */
export function laneCodeText(t: Translate, raw: unknown, harness?: string | null): string {
  const key = laneCodeKey(raw);
  // 받는 줄은 러너 판 관문과 같은 상수에서 끼워 넣는다 — 관문을 넓히면 문장도 같이 바뀐다.
  if (key === 'lane.code.harness_version') {
    const join = t('lane.code.harness_version.join');
    const known = harness ? LANE_VERSIONS[harness] : undefined;
    const pairs = known ? [[harness!, known] as const] : Object.entries(LANE_VERSIONS);
    const versions = pairs.flatMap(([h, vs]) => vs.map((v) => `${h} ${v}`)).join(join);
    return t(key, { versions });
  }
  // 할 일은 있는 버튼 이름을 끼워 넣는다 — 버튼 이름이 바뀌어도 문장이 따라간다(designer).
  // 지울 파일 자리 — 하네스를 알면 그 자리, 모르면 아는 자리를 모두 「또는」으로 잇는다(designer C D2, 판 문장과 같은 꼴).
  if (key === 'lane.code.harness_login_present') {
    const known = harness ? LANE_LOGIN_HOMES[harness] : undefined;
    const homes = (known ? [known] : Object.values(LANE_LOGIN_HOMES))
      .map((p) => p.replace('{thread}', t('lane.code.harness_login_present.thread')))
      .join(t('lane.code.harness_login_present.join'));
    return t(key, { home: homes });
  }
  if (key === 'lane.code.lane_setup') return t(key, { action: t('agents.restart.action') });
  return t(key);
}

/** 터미널 열기 오류 문장이 러너의 API 키 거절인가(`interactive_unsupported: …`). 서버가 문장을 그대로 실어 온다. */
export function isInteractiveUnsupported(message: string): boolean {
  return message.includes(`${INTERACTIVE_UNSUPPORTED_PREFIX}:`);
}

/** 화면 끝에 작게 다는 코드 이름 — 허용 목록 밖(주소·경로가 섞인 값 등)은 그대로 비추지 않고 `unknown` 으로 접는다. */
export function laneCodeName(raw: unknown): string {
  return providerLaneFailureCode(raw);
}
