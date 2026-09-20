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
  /** '' = 커뮤니티 전역. 'channel:<uuid>' | 'team:<uuid>' | 'agent:<uuid>' 만 첫 판에 쓴다. */
  scope: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
}

/** `can()` 의 대상. `kind` 가 소유 판정의 테이블을 고른다. */
export type PermissionTarget =
  | { kind: 'channel'; id: string }
  | { kind: 'team'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'operator'; id: string };
