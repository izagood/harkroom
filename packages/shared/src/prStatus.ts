/**
 * 읽기 전용 PR 상태 도구 `pr.status`(2026-10-31). 셸이 없는 하네스도 PR 의 상태·CI 를 읽게 한다.
 *
 * 나눠 맡는 자리:
 * - **서버**는 도구 모양만 등록한다(`tools/list` 에 보이게, `server/src/mcp/mcpPlugin.ts`). 서버까지 온 호출은
 *   `operator_required` 로 답한다 — `secret.mount`·`attachment.upload` 와 같은 모양.
 * - **오퍼레이터**가 브릿지에서 이 호출을 가로채, 턴 임대를 붙여 `PR_STATUS_CHECKS_PATH` 로 허락을 묻고, 허락이면 gh 로 읽어
 *   `pickPrStatus` 로 고정 칸만 골라 돌려준다. 서버에 닿지 못하면 거절한다(허락 없이 읽지 않는다).
 *
 * 읽을 수 있는 저장소는 **그 에이전트가 `repo.merge` grant 를 받은 저장소뿐**이다(서버 `mergeGrantFor` 와 같은 맞춤).
 * 채널에 묶인 저장소(`channel.repo`)는 쓰지 않는다 — 그 칸은 채널 관리자 누구나 적을 수 있는 자유 글이라(2026-10-31),
 * 그것을 근거로 열면 채널 관리자가 오퍼레이터의 gh 자격으로 아무 저장소나 읽게 만들 수 있다.
 */

/** MCP 도구 이름. 오퍼레이터가 `tools/call` 의 `params.name` 을 이것과 견줘 가로챈다. */
export const PR_STATUS_TOOL = 'pr.status';

/** 오퍼레이터가 gh 를 부르기 전에 묻는 서버 자리(`http.forward`, POST). */
export const PR_STATUS_CHECKS_PATH = '/agent/pr-status-checks';

/** 서버가 허락하지 않을 때의 코드. 400 `bad_request`·`bad_repo`, 403 `forbidden`(오퍼레이터를 거치지 않음)·`lease_invalid`·`not_granted`. */
export type PrStatusDenial = 'bad_request' | 'bad_repo' | 'forbidden' | 'lease_invalid' | 'not_granted';

/** 체크 하나 — 이름과 결론만. 체크 출력·URL·시각은 싣지 않는다. */
export interface PrStatusCheck {
  name: string;
  /** CheckRun 의 `conclusion`(없으면 `status`, 예: IN_PROGRESS) 또는 StatusContext 의 `state`. 모르면 ''. */
  conclusion: string;
}

/**
 * `pr.status` 의 결과 — **고정 칸뿐**이다. 제목·본문·작성자·URL·체크 출력은 싣지 않는다: 모두 남이 적은 글이라
 * 모델 문맥에 실리면 지시로 읽힐 수 있다(프롬프트 주입).
 */
export interface PrStatusResult {
  /** OPEN · CLOSED · MERGED */
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  /** gh 의 `mergeStateStatus`(CLEAN · BLOCKED · BEHIND · DIRTY · UNSTABLE · UNKNOWN …). */
  mergeStateStatus: string;
  checks: PrStatusCheck[];
}

/** 이름·결론 한 칸의 상한 — 체크 이름은 남이 정한 글이라 길이를 자른다. */
export const PR_STATUS_FIELD_MAX = 200;
/** 체크 개수 상한. */
export const PR_STATUS_CHECKS_MAX = 100;

/**
 * 남이 정한 글(체크 이름·브랜치 이름)을 **한 줄**로 만든다(2026-10-31). 줄바꿈·탭은 공백 하나로, 제어 문자(C0·DEL·C1)·방향 제어
 * (U+200E·U+200F·U+061C·U+202A–202E·U+2066–2069)·폭 없는 문자(U+200B–200D·U+2060·U+FEFF)는 지운다 — 모델 문맥에서 줄을 꾸며
 * 다른 칸·지시처럼 보이게 하거나, 보이는 글과 다른 순서로 읽히게 하는 길을 막는다. 앞뒤 공백도 걷는다.
 */
export function oneLineText(s: string): string {
  return s
    .replace(/[\r\n\t\v\f\u2028\u2029\u0085]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u061c\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const str = (v: unknown): string => (typeof v === 'string' ? oneLineText(v).slice(0, PR_STATUS_FIELD_MAX) : '');
const ENUMISH = /^[A-Z_]{0,40}$/;
const enumish = (v: unknown): string => {
  const s = str(v);
  return ENUMISH.test(s) ? s : '';
};

/**
 * `gh pr view --json state,isDraft,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup` 의 결과에서 고정 칸만 고른다.
 * 그 밖의 칸(title·body·author·url, 체크의 detailsUrl·output 등)은 들어와도 버린다. 모양이 아니면 null.
 */
export function pickPrStatus(raw: unknown): PrStatusResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || typeof r.headRefOid !== 'string') return null;
  const rollup = Array.isArray(r.statusCheckRollup) ? r.statusCheckRollup : [];
  const checks: PrStatusCheck[] = [];
  for (const c of rollup.slice(0, PR_STATUS_CHECKS_MAX)) {
    if (typeof c !== 'object' || c === null) continue;
    const x = c as Record<string, unknown>;
    // CheckRun 은 name·conclusion·status, StatusContext 는 context·state 다.
    const name = str(x.name) || str(x.context);
    const conclusion = enumish(x.conclusion) || enumish(x.state) || enumish(x.status);
    checks.push({ name, conclusion });
  }
  return {
    state: enumish(r.state),
    isDraft: r.isDraft === true,
    headRefOid: /^[0-9a-f]{40}$/.test(r.headRefOid) ? r.headRefOid : '',
    baseRefName: str(r.baseRefName),
    mergeStateStatus: enumish(r.mergeStateStatus),
    checks,
  };
}
