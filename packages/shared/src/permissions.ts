/**
 * 권한 어휘 — 스펙 `docs/specs/2026-09-20-operator-and-permissions-design.md` §6.
 *
 * 세 층으로 나뉜다: 역할(누가 권한을 줄 수 있나) · capability grant(무엇을 할 수 있나) ·
 * 소유(내가 만든 것은 grant 없이). 판정은 서버 `auth/permissions.ts::can()` 하나가 한다 —
 * 이 파일은 그 판정이 쓰는 **이름**만 정한다. Node 의존이 없는 순수 타입이라 `index.ts` 가
 * 재수출하고 데스크탑 웹뷰가 그대로 import 한다.
 */

export const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type Role = typeof ROLES[number];

export const CAPABILITIES = [
  'channel.create', 'channel.manage', 'channel.auto_mention',
  'team.create', 'team.manage',
  'agent.create', 'agent.manage', 'agent.privileged',
  'member.invite', 'audit.read',
  'operator.register', 'operator.manage',
  // 에이전트가 PR 을 머지한다(설계 스레드 3deac356). scope 는 `repo:<owner>/<name>` 만 — 전역('')은
  // 이 capability 에 한해 아무것도 열지 않는다(security F1). 판정은 서버 `canMergeRepo` 하나다.
  'repo.merge',
] as const;
export type Capability = typeof CAPABILITIES[number];

/**
 * member 가 grant 없이 갖는 것. 스펙 §6 확정: `operator.register` 만 — 자기 에이전트를 자기
 * 기기에서 돌리는 것은 에이전트를 가진 사람의 기본 행위다. `agent.create` 는 **아니다**
 * (요구 4 "권한 부여 받으면"; 에이전트 하나 = 러너 하나 = 호스트 비용).
 */
export const MEMBER_DEFAULT_CAPABILITIES: readonly Capability[] = ['operator.register'];

export interface GrantRow {
  accountId: string;
  capability: Capability;
  /** '' = 커뮤니티 전역. 'channel:<uuid>' | 'team:<uuid>' | 'agent:<uuid>' — `repo.merge` 는 'repo:<owner>/<name>' 만. */
  scope: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  /** `repo.merge` 전용(090): 에이전트가 띄운 턴에서도 머지를 허용하나. 기본 false(security F4). */
  allowAgentCause?: boolean;
}

/**
 * `repo.merge` 의 scope 문법. 저장소 이름은 **소문자로 정규화**해서 저장·비교한다 — GitHub 은 대소문자를
 * 구분하지 않으므로 `Izagood/Harkroom` 으로 준 grant 가 `izagood/harkroom` 머지에 안 맞는 일을 막는다.
 */
export const REPO_SCOPE_RE = /^repo:[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/;
export function repoScope(repo: string): string | null {
  const s = `repo:${repo.trim().toLowerCase()}`;
  return REPO_SCOPE_RE.test(s) ? s : null;
}

/** `can()` 의 대상. `kind` 가 소유 판정의 테이블을 고른다. */
export type PermissionTarget =
  | { kind: 'channel'; id: string }
  | { kind: 'team'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'operator'; id: string };
