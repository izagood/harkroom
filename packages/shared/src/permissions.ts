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
  // 에이전트가 사람이 정한 API 연결로 외부 API 를 부른다(외부 API 권한 C안, 스레드 07519d86). scope 는
  // `connector:<uuid>` 만 — 전역('')은 아무것도 열지 않는다. 판정은 서버 `apiGrants.ts` 가 사슬로 한다.
  'api.call',
  // 에이전트가 비밀을 만든다·들여온다·회전한다(102, 스레드 1a08d0cf). scope 는 '' 하나. **그 에이전트의 소유자**만 준다
  // (repo.merge 와 같은 틀). 판정은 서버 `secretCreate.ts` 다.
  'secret.create',
  // 에이전트의 Claude Code allow 규칙 하나(권한 요청 스레드 f61af808). scope 는 `tool:<channelId>:<규칙>` 만 — 그 채널의 턴에만
  // 붙는다(D2). 전역('')은 아무것도 열지 않는다. 판정은 `can()` 이 아니라 서버 `toolAllows.ts` 의 정확 일치다.
  'tool.allow',
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
  /** 줄 id(098). 옛 서버는 싣지 않는다. */
  id?: string;
  /**
   * `repo.merge` 정확한 이름 줄 전용: 배포 저장소(`HARKROOM_MERGE_DEPLOY_REPOS`)인가. 배포 저장소는 조직 grant 로 열리지 않으므로
   * (#1255) 화면이 「조직 전체 권한으로 에이전트가 띄운 턴에서도」를 붙이지 않는다(#1258 designer d1). 옛 서버는 싣지 않는다.
   */
  deployRepo?: boolean;
  /** 위임(098, P5): 이 줄을 준 grant. null = 사람이 준 루트. */
  parentGrantId?: string | null;
  /** 받은 쪽이 다시 줄 수 있는 단계(0~2). */
  delegateDepth?: number;
  /** `api.call` 의 좁힌 범위. */
  limits?: ApiGrantLimits | null;
  /** 연결이 바뀌어 멈춘 grant(098). */
  suspendedAt?: string | null;
  suspendReason?: string | null;
  /** `api.call` 전용(100): 쓰기 메서드는 사람 글로 띄운 턴에서만. */
  writeNeedsHumanCause?: boolean;
}

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = typeof API_METHODS[number];
/** `api.call` grant 의 범위 — 메서드는 연결이 허용한 것의 부분집합, 경로는 이 접두로 시작하는 것만. */
export interface ApiGrantLimits { methods: ApiMethod[]; pathPrefix: string }

/** `connector:<uuid>` — id 로 가리킨다(이름은 바뀔 수 있는 표시용). */
export const CONNECTOR_SCOPE_RE = /^connector:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const connectorScope = (connectorId: string): string => `connector:${connectorId}`;

/** API 연결(098) — 사람용 REST 의 응답 모양. 키 값은 없다(비밀 id 만). */
export interface ApiConnectorView {
  id: string; name: string; ownerAccountId: string; baseUrl: string;
  authKind: 'bearer' | 'header' | 'none'; authHeader: string | null; secretId: string | null;
  methods: ApiMethod[]; createdAt: string; updatedAt: string;
  /** 이 연결로 받은 grant 수(정지 포함). */
  grantCount: number;
}

/**
 * `repo.merge` 의 scope 문법. 저장소 이름은 **소문자로 정규화**해서 저장·비교한다 — GitHub 은 대소문자를
 * 구분하지 않으므로 `Izagood/Harkroom` 으로 준 grant 가 `izagood/harkroom` 머지에 안 맞는 일을 막는다.
 */
export const REPO_SCOPE_RE = /^repo:[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/;
/**
 * **실제 저장소 하나**의 scope — 머지 판정·거절 기록·카드처럼 "지금 머지하려는 저장소"를 가리키는 자리다. `*` 는 받지 않는다:
 * 여기서 `owner/*` 가 통과하면 래퍼가 `owner/*` 를 저장소로 물을 때 같은 문자열의 grant 와 정확 일치해 버린다.
 */
export function repoScope(repo: string): string | null {
  const s = `repo:${repo.trim().toLowerCase()}`;
  return REPO_SCOPE_RE.test(s) ? s : null;
}

/**
 * 조직 와일드카드 grant 의 scope — `repo:<owner>/*`, 그 owner 의 저장소 전부(jaebin 10-09). `*` 는 **저장소 자리 전체에만** 온다:
 * `*` 하나·owner 자리의 `*`·`owner/ab*` 같은 부분 패턴은 없다(전역·부분 패턴은 이름 하나 잘못 쳐서 넓게 열리는 길이다).
 */
export const REPO_ORG_SCOPE_RE = /^repo:[a-z0-9][a-z0-9._-]{0,99}\/\*$/;
/** grant 를 **주고·거두는** 자리의 scope — 정확한 `owner/name` 또는 조직 전체 `owner/*`. 판정 자리에서는 `repoScope` 를 쓴다. */
export function repoGrantScope(repo: string): string | null {
  const s = `repo:${repo.trim().toLowerCase()}`;
  return REPO_SCOPE_RE.test(s) || REPO_ORG_SCOPE_RE.test(s) ? s : null;
}
/** `repo:<owner>/*` 인가 — 화면이 「조직 전체」라고 보여 줄 때 쓴다. */
export const isOrgRepoScope = (scope: string): boolean => REPO_ORG_SCOPE_RE.test(scope);
/** 실제 저장소 scope(`repo:owner/name`)를 덮는 조직 scope(`repo:owner/*`). 모양이 아니면 null. */
export function orgScopeOf(scope: string): string | null {
  if (!REPO_SCOPE_RE.test(scope)) return null;
  return `${scope.slice(0, scope.indexOf('/'))}/*`;
}

/** `can()` 의 대상. `kind` 가 소유 판정의 테이블을 고른다. */
export type PermissionTarget =
  | { kind: 'channel'; id: string }
  | { kind: 'team'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'operator'; id: string };
