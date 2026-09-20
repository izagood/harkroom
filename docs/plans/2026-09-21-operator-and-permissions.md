# 오퍼레이터와 권한 — 구현 계획 (단계 1~6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데스크탑을 순수 프론트로 되돌리고, 데몬을 **오퍼레이터**로 키워 서버에 붙는 유일한 실행측 프로세스로 세우며, 그 위에 역할·grant·소유 3층 권한과 에이전트 호출/자격증명 스코프를 놓는다.

**Architecture:** 오퍼레이터가 서버에 outbound WS 하나(`/operator`)로 붙어 능력을 등록하고 배정(`agent_assignment`)을 받아 러너를 띄운다. 러너는 오퍼레이터와만(unix 소켓) 말한다 — MCP 는 stdio 브릿지로, PTY 는 채널 다중화로 통과한다. 서버는 `(오퍼레이터, 에이전트)` 배정으로 에이전트 행위를 인가하므로 러너에서 PAT 이 사라진다. 권한은 `can()` 한 함수로 판정한다.

**Tech Stack:** Node 22 · TypeScript · Fastify 5 + `@fastify/websocket` · PostgreSQL(`pg`) · vitest + testcontainers · Tauri 2 + React(데스크탑) · `ws` · zod

**Spec:** `docs/specs/2026-09-20-operator-and-permissions-design.md` — 이 계획은 그 스펙의 §3~§11 을 태스크로 옮긴 것이다. 실행자는 둘 다 읽는다.

## Global Constraints

- **매 단계가 단독 배포 가능**해야 하고 이전 단계 없이 켜지지 않는다(스펙 §11). 단계 1·2 는 독립(병렬 가능), 3→4 순서, 5 는 1·4 뒤, 6 은 2 뒤.
- **동작 변화 0 인 태스크**(1.3, 2.1)는 기존 테스트 전부 초록이 완료 조건이다. 새 동작을 섞지 않는다.
- 서버 테스트는 실제 Postgres(testcontainers)를 쓴다. `packages/server/test/helpers/{testDb,fixtures}.ts` 만 쓴다 — 새 헬퍼는 그 파일에 더한다.
- 서버 오류 응답 형태는 `{ error: { code, message } }` 하나다. 문구는 한국어, 코드는 snake_case.
- 인가 판정 함수는 `packages/server/src/auth/permissions.ts` **한 곳**에만 둔다(#253 의 원칙). 라우트에서 판정을 복사하지 않는다.
- 소켓·설정 파일 이름에 세대가 박힌다: `operator-v1.sock`, `operator.json`. 프로토콜 버전 상수는 `@harkroom/shared/operatorEndpoint` 의 `OPERATOR_PROTOCOL_VERSION = 1` 하나에서 나온다.
- 커밋 메시지는 저장소 관례(`feat(server): …`, `fix(operator): …`, 한국어 본문에 **왜**)를 따른다. 태스크 하나 = 커밋 하나.
- 주석은 저장소 관례대로 "왜"를 적는다. 이 계획의 코드 블록에 있는 주석을 지우지 않는다.

---

## §0 공유 계약 — 모든 태스크가 여기 이름을 쓴다

이 절이 **단계 사이 충돌을 막는 장치**다. 어느 태스크도 여기 없는 테이블·타입·라우트·프레임을 새로 만들지 않는다. 필요하면 이 절을 먼저 고친다.

### 0-1. 마이그레이션 번호

| 번호 | 파일 | 단계 |
|---|---|---|
| 055 | `055_account_role_and_grant.sql` | 1 |
| 056 | `056_channel_created_by.sql` | 1 |
| 057 | `057_operator.sql` | 2 |
| 058 | `058_agent_assignment.sql` | 2 |
| 059 | `059_agent_scopes.sql` | 5 |
| 060 | `060_mcp_server.sql` | 5 |

### 0-2. 권한 어휘 — `packages/shared/src/permissions.ts` (순수 타입, `index.ts` 에서 재수출)

```ts
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

/** member 가 grant 없이 갖는 것. 스펙 §6 확정: operator.register 만. */
export const MEMBER_DEFAULT_CAPABILITIES: readonly Capability[] = ['operator.register'];

export interface GrantRow {
  accountId: string;
  capability: Capability;
  /** '' = 커뮤니티 전역. 'channel:<uuid>' | 'team:<uuid>' 만 첫 판에 쓴다. */
  scope: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
}

/** can() 의 대상. kind 가 소유 판정의 테이블을 고른다. */
export type PermissionTarget =
  | { kind: 'channel'; id: string }
  | { kind: 'team'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'operator'; id: string };
```

`AccountView` 에 `role: Role` 을 더한다(단계 1.1). `isAdmin` 은 남긴다 — `role in ('owner','admin')` 과 항상 같다.

### 0-3. 서버 인가 표면 — `packages/server/src/auth/permissions.ts`

```ts
export async function hasGrant(pool: Pool, accountId: string, cap: Capability, scope: string): Promise<boolean>;
export async function isOwnerOf(pool: Pool, accountId: string, target: PermissionTarget): Promise<boolean>;
/** 스펙 §6: isOwnerOf ∨ hasGrant(scope 또는 '') ∨ role ≥ admin. 순서도 이 순서다. */
export async function can(pool: Pool, actor: AccountView, cap: Capability, target?: PermissionTarget): Promise<boolean>;
```

`registerAuth` 가 데코레이터를 하나 더 단다:

```ts
// FastifyInstance
requireCap: (cap: Capability, target?: { kind: PermissionTarget['kind']; param: string }) =>
  (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
// 거절: 401 unauthorized(계정 없음) / 403 forbidden { message: `${cap} 권한이 필요하다` }
```

### 0-4. 오퍼레이터 신원·토큰

- 토큰 접두: `hkop_` + 32바이트 base64url. 해시는 기존 `auth/tokens.ts::hashToken`.
- 등록 코드: `hkreg_` + 16바이트, TTL 5분, 인메모리(`ws/tickets.ts` 의 `createTicketStore` 코어 재사용).
- `req.operator: OperatorView | null` 을 `registerAuth` 의 `onRequest` 훅이 채운다 — `operator.token_hash` 로 조회, `revoked_at is null`. `req.account` 는 그때 **null 이다**(오퍼레이터는 계정이 아니다).

```ts
// @harkroom/shared (index.ts)
export interface OperatorView {
  id: string; ownerAccountId: string; name: string;
  createdAt: string; lastSeenAt: string | null; revokedAt: string | null;
  /** 허브가 아는 연결 상태. 목록 응답에서만 채운다. */
  online: boolean;
}
export interface OperatorCapabilities {
  agentIds: string[];
  harnesses: Record<string, { installed: boolean; loggedIn: boolean }>;
}
export interface AgentAssignmentView {
  agentId: string; operatorId: string; assignedBy: string; assignedAt: string;
}
```

### 0-5. 서버 라우트 (신규 전부)

| 메서드·경로 | 인증 | 단계 |
|---|---|---|
| `GET /accounts/:id/grants` | 본인 또는 admin | 1 |
| `PUT /accounts/:id/grants` body `{capability, scope?, expiresAt?}` | admin (role) | 1 |
| `DELETE /accounts/:id/grants/:capability?scope=` | admin | 1 |
| `PUT /accounts/:id/role` body `{role}` | owner 만 admin 임명/해제, admin 은 member↔guest | 1 |
| `POST /operators/register-codes` → `{code, expiresAt}` | `requireCap('operator.register')` | 2 |
| `POST /operators/claim` body `{code, name}` → `{operator, token}` | 없음(코드가 인증) | 2 |
| `GET /operators` → `{operators: OperatorView[]}` | 내 것; `operator.manage` 면 전부 | 2 |
| `DELETE /operators/:id` | 소유자 또는 `operator.manage` | 2 |
| `GET /operators/:id/capabilities` → `OperatorCapabilities \| null` | 소유자 또는 `operator.manage` | 2 |
| `PUT /accounts/agents/:id/assignment` body `{operatorId}` → `AgentAssignmentView` | 소유자(자기 오퍼레이터) 또는 `agent.manage` | 2 |
| `DELETE /accounts/agents/:id/assignment` | 같음 | 2 |
| `GET /operator` (WS) | `req.operator` | 2 |
| `POST /operator/agents/:agentId/pat` → `{token}` | `req.operator` + 배정 | 2 (**4 에서 삭제**) |
| `GET /mcp-servers` · `PUT /mcp-servers/:name` · `DELETE /mcp-servers/:name` | `requireCap('agent.privileged')` | 5 |

`/mcp` 와 REST 전반: 단계 4 부터 `Authorization: Bearer hkop_…` + `X-Harkroom-Agent: <agentId>` 조합이면 `req.account` = 그 에이전트(배정 확인 뒤). 헤더 이름은 이것 하나다.

### 0-6. WS 이벤트 (shared `WsServerEvent` 에 추가)

```ts
| { type: 'operator.changed'; operatorId: string; audience: 'all' | string[] }
| { type: 'agent_assignment.changed'; agentId: string; audience: 'all' }
| { type: 'grant.changed'; accountId: string; audience: 'all' | string[] }
```

### 0-7. 서버 ↔ 오퍼레이터 프레임 — `packages/shared/src/operatorProtocol.ts` (서브패스 `./operatorProtocol`, 순수)

```ts
export type OperatorToServerFrame =
  | { type: 'hello'; protocol: 1; capabilities: OperatorCapabilities;
      runners: RunnerAnnounce[]; sessions: AgentSessionView[] }
  | { type: 'runner.started'; agentId: string; runnerId: string }
  | { type: 'runner.exited'; runnerId: string; code: number | null; reason?: string }
  | { type: 'session.started'; runnerId: string; session: AgentSessionView }
  | { type: 'session.updated'; runnerId: string; session: AgentSessionView }
  | { type: 'session.ended'; runnerId: string; sessionId: string }
  | { type: 'pty.output'; runnerId: string; sessionId: string; bytes: string /* base64 */ }
  | { type: 'interactive.opened'; runnerId: string; requestId: string; sessionId: string; created: boolean }
  | { type: 'interactive.error'; runnerId: string; requestId: string; message: string };

export type ServerToOperatorFrame =
  | { type: 'assign'; agentId: string; definition: AgentDefinition }
  | { type: 'unassign'; agentId: string; drain: boolean }
  | { type: 'runner.kill'; runnerId: string }
  | { type: 'pty.input'; runnerId: string; sessionId: string; bytes: string }
  | { type: 'pty.resize'; runnerId: string; sessionId: string; cols: number; rows: number }
  | { type: 'viewer.count'; runnerId: string; sessionId: string; count: number }
  | { type: 'session.cancel'; runnerId: string; sessionId: string; byHandle: string }
  | { type: 'interactive.open'; runnerId: string; requestId: string; channelId: string;
      threadRootId: string; openedByHandle: string; cols?: number; rows?: number };

export interface RunnerAnnounce { agentId: string; runnerId: string; pid: number }
/** 서버 정의. 머신 값(workingDir 실제 경로, 계정 풀)은 여기 없다 — 오퍼레이터 로컬 설정이 준다. */
export interface AgentDefinition {
  agentId: string; handle: string; harness: string;
  instructions: string; model: string | null; effort: string | null;
  mentionPermission: string; workingDirDefault: string | null;
  /** 단계 5 부터. 그 전엔 'none'. */
  credentialScope: 'personal' | 'community' | 'none';
  ownerAccountId: string | null;
  mcpServers: string[];
}
```

`runnerId` 는 오퍼레이터가 spawn 마다 만드는 UUID(= 데몬의 `incarnationId` 와 같은 것. 이름만 통일한다).

### 0-8. 러너 ↔ 오퍼레이터 unix 프레임 — `packages/shared/src/runnerLink.ts` (서브패스, 순수)

한 러너가 오퍼레이터 소켓에 **연결 하나**를 열고 NDJSON 으로 말한다. 첫 줄은 `hello`.

```ts
export type RunnerToOperatorFrame =
  | { type: 'hello'; runnerId: string; secret: string }        // HARKROOM_RUNNER_SECRET
  | { type: 'session.started'; session: AgentSessionView }
  | { type: 'session.updated'; session: AgentSessionView }
  | { type: 'session.ended'; sessionId: string }
  | { type: 'pty.output'; sessionId: string; bytes: string }
  | { type: 'interactive.opened'; requestId: string; sessionId: string; created: boolean }
  | { type: 'interactive.error'; requestId: string; message: string }
  | { type: 'http.forward'; id: string; method: string; path: string; body?: unknown }   // 단계 4
  | { type: 'mcp.request'; id: string; payload: unknown };                              // 단계 4 (브릿지가 보낸다)

export type OperatorToRunnerFrame =
  | { type: 'hello'; ok: true; agentId: string } | { type: 'hello'; ok: false; error: string }
  | { type: 'pty.input'; sessionId: string; bytes: string }
  | { type: 'pty.resize'; sessionId: string; cols: number; rows: number }
  | { type: 'viewer.count'; sessionId: string; count: number }
  | { type: 'session.cancel'; sessionId: string; byHandle: string }
  | { type: 'interactive.open'; requestId: string; channelId: string; threadRootId: string;
      openedByHandle: string; cols?: number; rows?: number }
  | { type: 'drain' }                                                                    // unassign{drain}
  | { type: 'http.response'; id: string; status: number; body: unknown }                // 단계 4
  | { type: 'mcp.response'; id: string; payload: unknown };                              // 단계 4
```

러너 env(단계 3 부터): `HARKROOM_OPERATOR_SOCKET`, `HARKROOM_RUNNER_ID`, `HARKROOM_RUNNER_SECRET`. 단계 4 에서 `HARKROOM_URL`·`HARKROOM_PAT` 이 사라진다.

### 0-9. 오퍼레이터 패키지 파일

```
packages/operator/src/
  main.ts            # 엔트리: `run`(기본) · `register <url> <code>` · `mcp-bridge --runner <id>`
  run.ts             # (데몬 run.ts 그대로) 엔드포인트·소켓·고아 입양
  server.ts          # (데몬 server.ts) 앱과의 unix 프로토콜 — 개명 후 유지
  runners.ts         # (데몬 runners.ts) 프로세스 소유 — 개명 후 유지
  config.ts          # operator.json 읽기·쓰기 (2.6)
  community.ts       # 커뮤니티 인스턴스: {baseUrl, token, link, assignments} (2.6)
  serverLink.ts      # /operator WS 클라이언트: dial·backoff·hello·ping 감시 (2.6)
  assignments.ts     # assign/unassign → spawn/drain 결정 (2.7)
  secrets.ts         # 오퍼레이터 토큰·(단계 2~3 한정) 에이전트 PAT 보관 (2.6)
  runnerLink.ts      # 러너 unix 연결 수락·프레임 라우팅 (3.1)
  relayMux.ts        # 러너 프레임 ↔ 채널 프레임 다중화 (3.2)
  forward.ts         # http.forward / mcp.request → 서버 HTTPS (4.3)
  mcpBridge.ts       # stdio ↔ unix (4.2)
```

### 0-10. 경로·이름

| 것 | 값 |
|---|---|
| 패키지 | `@harkroom/operator` (`packages/operator`) |
| 사이드카 | `harkroom-operator` (`externalBin`, `build-sidecars.mjs`, `sign-app.mjs`) |
| 앱 데이터 하위 | `<appData>/operator/` (기존 `daemon/` 대체) |
| 소켓 | `operator-v1.sock`, 토큰 `operator-v1.token`, pid `operator-v1.pid` |
| 로컬 설정 | `<appData>/operator/operator.json` |
| 키체인 서비스 | `app.harkroom.desktop` 그대로. 항목: `harkroom.operator.token.<baseUrlHash>` |
| Rust 상수 | `DAEMON_SIDECAR_NAME` → `OPERATOR_SIDECAR_NAME = "harkroom-operator"` |

---

## 파일 구조 (단계별 생성·수정)

**단계 1 (권한)**
- Create: `packages/server/src/db/migrations/055_account_role_and_grant.sql`, `056_channel_created_by.sql`, `packages/shared/src/permissions.ts`, `packages/server/src/auth/permissions.ts`, `packages/server/src/routes/grantRoutes.ts`, `packages/server/test/permissions.test.ts`, `packages/server/test/requireCapParity.test.ts`, `packages/server/test/grantRoutes.test.ts`, `packages/server/test/channelOwnership.test.ts`
- Modify: `packages/shared/src/index.ts`(AccountView.role, 재수출, 이벤트), `packages/server/src/auth/plugin.ts`, `packages/server/src/buildServer.ts`, `channelRoutes.ts`, `teamRoutes.ts`, `accountRoutes.ts`, `handleGroupRoutes.ts`, `settingsRoutes.ts`, `auditRoutes.ts`, `skillRoutes.ts`, `services/channels.ts`(created_by)

**단계 2 (오퍼레이터)**
- Rename: `packages/daemon` → `packages/operator` (전체)
- Create: `057_operator.sql`, `058_agent_assignment.sql`, `packages/shared/src/operatorProtocol.ts`, `packages/shared/src/operatorEndpoint.ts`, `packages/server/src/routes/operatorRoutes.ts`, `packages/server/src/ws/operatorHub.ts`, `packages/server/src/routes/assignmentRoutes.ts`, `packages/operator/src/{config,community,serverLink,assignments,secrets}.ts`, `packages/desktop/src/components/settings/OperatorsSettings.tsx`, 테스트 각각
- Modify: `buildServer.ts`, `auth/plugin.ts`(req.operator), `packages/desktop/src/state/controller.ts`, `packages/desktop/src/lib/runnerLauncher.ts`(축소), `AgentsSettings.tsx`, `sections.ts`, `docs/design.md`, Tauri 설정·스크립트·Rust 상수

**단계 3 (릴레이)**
- Create: `packages/shared/src/runnerLink.ts`, `packages/operator/src/{runnerLink,relayMux}.ts`, 테스트
- Modify: `packages/agent/src/relay.ts`(dial → unix), `packages/server/src/ws/relay.ts`(addOperator), `packages/server/src/routes/agentRelayRoutes.ts`(`/agent-relay` 삭제, 뷰어 경로 유지), `packages/server/src/ws/operatorHub.ts`

**단계 4 (MCP)**
- Create: `packages/operator/src/{mcpBridge,forward}.ts`, `docs/plans/2026-09-2x-mcp-bridge-measurement.md`(실측 기록), 테스트
- Modify: `packages/server/src/auth/plugin.ts`(X-Harkroom-Agent), `mcp/mcpPlugin.ts`, `packages/agent/src/{config,harkroom,turn,main}.ts`, `operatorRoutes.ts`(PAT 라우트 삭제)

**단계 5 (스코프)**
- Create: `059_agent_scopes.sql`, `060_mcp_server.sql`, `packages/server/src/routes/mcpServerRoutes.ts`, `packages/server/src/services/invokeGate.ts`, 테스트
- Modify: `services/messages.ts`, `services/agents.ts`, `accountRoutes.ts`, `teamRoutes.ts`, `channelRoutes.ts`, `assignmentRoutes.ts`, `packages/operator/src/assignments.ts`, `packages/shared/src/index.ts`

**단계 6 (헤드리스)**
- Create: `ops/operator.plist.template`, `ops/operator.service.template`, `packages/operator/src/cli.ts`
- Modify: `packages/operator/src/main.ts`, `docs/operations.md` §8, `ops/agent-runner.plist.template`(삭제)

---

# 단계 1 — 권한 기반 (동작 변화 0)

### Task 1.1: 역할·grant 스키마와 공유 타입

**Files:**
- Create: `packages/server/src/db/migrations/055_account_role_and_grant.sql`
- Create: `packages/shared/src/permissions.ts`
- Modify: `packages/shared/src/index.ts` (`AccountView` 에 `role`, `export * from './permissions.js'`, §0-6 이벤트 셋 추가)
- Modify: `packages/server/src/auth/plugin.ts:21-22` (`ACCOUNT_COLS` 에 `a.role`)
- Test: `packages/server/test/migrate.test.ts` (기존 — 마이그레이션이 도는지만 본다)

**Interfaces:**
- Produces: §0-2 전부. `AccountView.role: Role`. `account.role` 컬럼, `account_grant` 테이블.

- [ ] **Step 1: 마이그레이션 작성**

```sql
-- 055_account_role_and_grant.sql
-- 권한의 축이 is_admin 하나였다(스펙 §6 "오늘"). 역할(누가 권한을 줄 수 있나)과
-- grant(무엇을 할 수 있나)를 갈라 둔다. is_admin 은 남긴다 — role in ('owner','admin') 과
-- 항상 같고, 기존 코드가 그것을 읽는다. 두 값이 어긋나는 것은 아래 check 가 막는다.
alter table account add column role text not null default 'member'
  check (role in ('owner', 'admin', 'member', 'guest'));

-- 첫 관리자(bootstrap 으로 만들어진 가장 오래된 admin)가 owner 다. 나머지 admin 은 admin.
update account set role = 'admin' where is_admin;
update account set role = 'owner'
  where id = (select id from account where is_admin and kind = 'human' order by created_at limit 1);

alter table account add constraint account_role_is_admin_consistent
  check (is_admin = (role in ('owner', 'admin')));

create table account_grant (
  account_id  uuid not null references account(id) on delete cascade,
  capability  text not null,
  -- '' = 커뮤니티 전역. null 이 아닌 이유: PK 에 넣으려면 값이 있어야 한다(스펙 §6).
  scope       text not null default '',
  granted_by  uuid not null references account(id),
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz,
  primary key (account_id, capability, scope)
);
create index account_grant_capability_idx on account_grant (capability, scope);
```

- [ ] **Step 2: 공유 타입 작성**

`packages/shared/src/permissions.ts` 에 §0-2 의 내용을 그대로 쓴다(코드 블록 전체). `packages/shared/src/index.ts` 끝에 `export * from './permissions.js';` 를 더하고, `AccountView` 에 아래를 더한다:

```ts
  /** 스펙 §6 (1) 역할 — 누가 권한을 줄 수 있나만 정한다. isAdmin 은 role in owner|admin 과 같다. */
  role: Role;
```

`WsServerEvent` 유니언에 §0-6 의 세 줄을 더한다.

- [ ] **Step 3: 서버가 role 을 읽게 한다**

`packages/server/src/auth/plugin.ts` 의 `ACCOUNT_COLS` 를 고친다:

```ts
const ACCOUNT_COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  a.role, a.status, a.status_text as "statusText", a.avatar_attachment_id as "avatarAttachmentId"`;
```

`ACCOUNT_COLS` 와 같은 컬럼 목록을 쓰는 곳을 찾아 같이 고친다: `grep -rn 'as "isAdmin"' packages/server/src` — `services/agents.ts` 의 `COLS`, `routes/accountRoutes.ts` 의 목록 조회. 각각 `a.role,` 을 더한다.

- [ ] **Step 4: 타입체크·기존 테스트**

Run: `cd packages/server && pnpm exec tsc --noEmit -p . && pnpm vitest run test/migrate.test.ts test/accounts.test.ts`
Expected: PASS. `role` 이 없어서 깨지는 타입 오류가 있으면 그 자리(주로 테스트 픽스처의 `AccountView` 리터럴)에 `role: 'member'` 를 더한다.

- [ ] **Step 5: 커밋**

```bash
git add packages/server/src/db/migrations/055_account_role_and_grant.sql packages/shared/src/permissions.ts packages/shared/src/index.ts packages/server/src
git commit -m "feat(server): 계정 역할과 capability grant 스키마 — 권한의 축을 is_admin 에서 3층으로 (동작 변화 0)"
```

### Task 1.2: `can()` — 판정 함수 하나

**Files:**
- Create: `packages/server/src/auth/permissions.ts`
- Test: `packages/server/test/permissions.test.ts`

**Interfaces:**
- Consumes: `account.role`, `account_grant`, `agent_config.owner_account_id`, `channel.created_by`(1.5 전엔 없음 — 아래 `isOwnerOf` 가 `channel` 을 `to_regclass` 없이 처리하도록 1.5 에서 컬럼을 더한 뒤 테스트를 켠다. 이 태스크는 `agent`·`team`·`operator` 소유만 테스트한다).
- Produces: §0-3 의 `hasGrant`·`isOwnerOf`·`can`.

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/server/test/permissions.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import type { AccountView } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { can, hasGrant } from '../src/auth/permissions.js';

let pool: Pool; let stop: () => Promise<void>;
let ownerId: string; let memberId: string; let otherId: string; let agentId: string;

const view = (id: string, role: AccountView['role']): AccountView => ({
  id, handle: `h-${id.slice(0, 4)}`, displayName: 'x', kind: 'human',
  isAdmin: role === 'owner' || role === 'admin', role,
  status: 'active', statusText: null, avatarAttachmentId: null,
});

beforeAll(async () => {
  const db = await startTestDb(); pool = db.pool as Pool; stop = db.stop;
  const ins = async (handle: string, kind: string, role: string) => (await pool.query(
    `insert into account (handle, display_name, kind, is_admin, role) values ($1, $1, $2, $3, $4) returning id`,
    [handle, kind, role === 'owner' || role === 'admin', role])).rows[0].id as string;
  ownerId = await ins('owner', 'human', 'owner');
  memberId = await ins('member', 'human', 'member');
  otherId = await ins('other', 'human', 'member');
  agentId = await ins('bot', 'agent', 'member');
  await pool.query(`insert into agent_config (account_id, owner_account_id) values ($1, $2)`, [agentId, memberId]);
});
afterAll(async () => { await stop(); });

describe('can()', () => {
  it('role >= admin 은 전부 통과한다', async () => {
    expect(await can(pool, view(ownerId, 'owner'), 'agent.create')).toBe(true);
  });
  it('member 는 grant 가 없으면 거절된다', async () => {
    expect(await can(pool, view(memberId, 'member'), 'agent.create')).toBe(false);
  });
  it('member 기본 capability(operator.register)는 grant 없이 통과한다', async () => {
    expect(await can(pool, view(memberId, 'member'), 'operator.register')).toBe(true);
  });
  it('전역 grant 가 있으면 통과한다', async () => {
    await pool.query(`insert into account_grant (account_id, capability, granted_by) values ($1, 'agent.create', $2)`, [memberId, ownerId]);
    expect(await hasGrant(pool, memberId, 'agent.create', '')).toBe(true);
    expect(await can(pool, view(memberId, 'member'), 'agent.create')).toBe(true);
  });
  it('만료된 grant 는 없는 것이다', async () => {
    await pool.query(`insert into account_grant (account_id, capability, scope, granted_by, expires_at)
      values ($1, 'team.create', '', $2, now() - interval '1 minute')`, [otherId, ownerId]);
    expect(await can(pool, view(otherId, 'member'), 'team.create')).toBe(false);
  });
  it('scope 가 있는 grant 는 그 대상에만 통과한다', async () => {
    await pool.query(`insert into account_grant (account_id, capability, scope, granted_by)
      values ($1, 'agent.manage', $2, $3)`, [otherId, `agent:${agentId}`, ownerId]);
    expect(await can(pool, view(otherId, 'member'), 'agent.manage', { kind: 'agent', id: agentId })).toBe(true);
    expect(await can(pool, view(otherId, 'member'), 'agent.manage', { kind: 'agent', id: memberId })).toBe(false);
  });
  it('소유자는 grant 없이 자기 것을 manage 한다', async () => {
    expect(await can(pool, view(memberId, 'member'), 'agent.manage', { kind: 'agent', id: agentId })).toBe(true);
    expect(await can(pool, view(otherId, 'member'), 'agent.manage', { kind: 'agent', id: agentId })).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd packages/server && pnpm vitest run test/permissions.test.ts`
Expected: FAIL — `Cannot find module '../src/auth/permissions.js'`

- [ ] **Step 3: 구현**

```ts
// packages/server/src/auth/permissions.ts
// 인가 판정은 여기 하나다(#253 의 원칙을 grant 에도 적용). 라우트는 이 함수를 부르지
// 판정을 복사하지 않는다 — 사본은 조용히 열리는 쪽으로 어긋난다.
import type { Pool } from 'pg';
import type { AccountView, Capability, PermissionTarget } from '@harkroom/shared';
import { MEMBER_DEFAULT_CAPABILITIES } from '@harkroom/shared';

export async function hasGrant(pool: Pool, accountId: string, cap: Capability, scope: string): Promise<boolean> {
  // scope 가 주어져도 전역('') grant 는 언제나 그 대상을 덮는다.
  const res = await pool.query(
    `select 1 from account_grant
      where account_id = $1 and capability = $2 and (scope = '' or scope = $3)
        and (expires_at is null or expires_at > now()) limit 1`,
    [accountId, cap, scope],
  );
  return (res.rowCount ?? 0) > 0;
}

/** 소유 판정. 테이블마다 소유 컬럼이 다르므로 kind 로 가른다. 모르는 kind 는 false 다. */
export async function isOwnerOf(pool: Pool, accountId: string, target: PermissionTarget): Promise<boolean> {
  const sql: Record<PermissionTarget['kind'], string> = {
    agent: `select 1 from agent_config where account_id = $2 and owner_account_id = $1`,
    team: `select 1 from agent_team where id = $2 and created_by = $1`,
    channel: `select 1 from channel where id = $2 and created_by = $1`,
    operator: `select 1 from operator where id = $2 and owner_account_id = $1`,
  };
  try {
    const res = await pool.query(sql[target.kind], [accountId, target.id]);
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    // 컬럼·테이블이 아직 없는 단계(channel.created_by 는 1.5, operator 는 2.2)에서는 소유가
    // 성립하지 않는다 — 예외를 삼켜 false 로 두면 "아직 없다"와 "소유 아님"이 같은 답이 되고,
    // 그것이 이 단계에서 정확한 사실이다. undefined_column/undefined_table 만 삼킨다.
    const code = (err as { code?: string }).code;
    if (code === '42703' || code === '42P01') return false;
    throw err;
  }
}

export async function can(
  pool: Pool, actor: AccountView, cap: Capability, target?: PermissionTarget,
): Promise<boolean> {
  if (target && await isOwnerOf(pool, actor.id, target)) return true;
  if (MEMBER_DEFAULT_CAPABILITIES.includes(cap) && actor.role !== 'guest') return true;
  const scope = target ? `${target.kind}:${target.id}` : '';
  if (await hasGrant(pool, actor.id, cap, scope)) return true;
  return actor.role === 'owner' || actor.role === 'admin';
}
```

`agent_team.created_by` 는 `036_agent_team.sql:7` 에 이미 있다(`not null references account(id)`) — 마이그레이션을 더하지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `cd packages/server && pnpm vitest run test/permissions.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add packages/server/src/auth/permissions.ts packages/server/test/permissions.test.ts
git commit -m "feat(server): can() — 소유 ∨ grant ∨ 역할, 인가 판정을 한 함수로"
```

### Task 1.3: `requireCap()` 과 호출부 교체 — 동작 변화 0

**Files:**
- Modify: `packages/server/src/auth/plugin.ts` (데코레이터 추가)
- Modify: `channelRoutes.ts:64,79,627,682,806,836`, `teamRoutes.ts:36,65,88,128,162,192`, `accountRoutes.ts:99,136,219,351,390`, `handleGroupRoutes.ts:24,28,61,71,89,104,149`, `settingsRoutes.ts:57,61,95,97`, `auditRoutes.ts:9`, `skillRoutes.ts:49,74`
- Test: `packages/server/test/requireCapParity.test.ts`

**Interfaces:**
- Consumes: `can()` (1.2)
- Produces: `app.requireCap(cap, target?)` (§0-3). `requireAdmin` 은 **남긴다**(다른 파일이 import 할 수 있다) — 하지만 라우트에서는 더 이상 쓰지 않는다.

- [ ] **Step 1: 대조 테스트 — admin 은 여전히 전부 통과, member 는 여전히 전부 거절**

```ts
// packages/server/test/requireCapParity.test.ts
// 이 태스크의 약속은 "동작 변화 0" 이다. 그것을 테스트가 말하게 한다: 아래 라우트 목록은
// 교체 전 requireAdmin 이 걸려 있던 전부이고, admin 은 403 이 아니고 member 는 403 이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let memberToken: string;

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken } = await createMember(app, adminToken, 'plain'));
});
afterAll(async () => { await app.close(); await stop(); });

const ROUTES: [string, string][] = [
  ['POST', '/channels'], ['PATCH', '/channels/00000000-0000-0000-0000-000000000000'],
  ['DELETE', '/channels/00000000-0000-0000-0000-000000000000'],
  ['POST', '/teams'], ['PATCH', '/teams/00000000-0000-0000-0000-000000000000'],
  ['POST', '/accounts/agents'], ['POST', '/invites'],
  ['GET', '/handle-groups'], ['GET', '/audit'], ['GET', '/settings/agent-defaults'],
  ['DELETE', '/skills/nope'],
];

describe('requireCap 은 requireAdmin 과 같은 판정을 낸다', () => {
  for (const [method, url] of ROUTES) {
    it(`${method} ${url}: member 403`, async () => {
      const res = await app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${memberToken}` }, payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    });
    it(`${method} ${url}: admin 은 403 이 아니다`, async () => {
      const res = await app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
      expect(res.statusCode).not.toBe(403);
    });
  }
});
```

`createMember` 가 픽스처에 없으면 `fixtures.ts` 에 더한다:

```ts
export async function createMember(
  app: FastifyInstance, adminToken: string, handle: string,
): Promise<{ token: string; accountId: string }> {
  const auth = { authorization: `Bearer ${adminToken}` };
  const invite = await app.inject({ method: 'POST', url: '/invites', headers: auth, payload: {} });
  const inviteToken = invite.json().token as string;
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { loginId: handle, handle, displayName: handle, password: 'pw123456', inviteToken },
  });
  const accountId = reg.json().id as string;
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: handle, password: 'pw123456' } });
  return { token: login.json().token as string, accountId };
}
```

- [ ] **Step 2: 실행 — 지금은 통과해야 한다(requireAdmin 이 그대로이므로). 이것이 기준선이다.**

Run: `cd packages/server && pnpm vitest run test/requireCapParity.test.ts`
Expected: PASS. (통과하지 않으면 라우트 목록이 틀린 것이다 — 고친 뒤 진행.)

- [ ] **Step 3: 데코레이터 추가**

`packages/server/src/auth/plugin.ts` 의 `FastifyInstance` 선언과 `registerAuth` 에 더한다:

```ts
import { can } from './permissions.js';
import type { Capability, PermissionTarget } from '@harkroom/shared';
// 선언:
    requireCap: (cap: Capability, target?: { kind: PermissionTarget['kind']; param: string }) =>
      (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
// registerAuth 안:
  app.decorate('requireCap', (cap: Capability, target?: { kind: PermissionTarget['kind']; param: string }) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.account) {
        await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
        return;
      }
      const id = target ? (req.params as Record<string, string>)[target.param] : undefined;
      const ok = await can(pool, req.account, cap, target && id ? { kind: target.kind, id } : undefined);
      if (!ok) {
        await reply.code(403).send({ error: { code: 'forbidden', message: `${cap} 권한이 필요하다` } });
      }
    });
```

- [ ] **Step 4: 호출부 교체 — 표대로**

| 파일:줄 | 전 | 후 |
|---|---|---|
| channelRoutes.ts:64 `POST /channels` | `app.requireAdmin` | `app.requireCap('channel.create')` |
| channelRoutes.ts:79 `PATCH /channels/:id` | | `app.requireCap('channel.manage', { kind: 'channel', param: 'id' })` |
| channelRoutes.ts:627,682 auto-mentions | | `app.requireCap('channel.auto_mention', { kind: 'channel', param: 'id' })` |
| channelRoutes.ts:806,836 delete·delete-info | | `app.requireCap('channel.manage', { kind: 'channel', param: 'id' })` |
| teamRoutes.ts:36 `POST /teams` | | `app.requireCap('team.create')` |
| teamRoutes.ts:65,88,128,162,192 | | `app.requireCap('team.manage', { kind: 'team', param: 'id' })` |
| accountRoutes.ts:219 `POST /accounts/agents` | | `app.requireCap('agent.create')` |
| accountRoutes.ts:351,390 stop·undo | | `app.requireCap('agent.manage', { kind: 'agent', param: 'id' })` |
| accountRoutes.ts:136 `POST /invites` | | `app.requireCap('member.invite')` |
| accountRoutes.ts:99 handle 변경 | | `app.requireAdmin` **그대로**(계정 관리는 역할의 일이다) |
| handleGroupRoutes.ts 전부 | | `app.requireCap('channel.manage')` (집합은 채널의 부속이다 — scope 없음) |
| settingsRoutes.ts 전부 | | `app.requireAdmin` **그대로**(워크스페이스 설정은 역할의 일이다) |
| auditRoutes.ts:9 | | `app.requireCap('audit.read')` |
| skillRoutes.ts:49,74 | | `app.requireCap('agent.privileged')` |

- [ ] **Step 5: 대조 테스트 + 전체 스위트**

Run: `cd packages/server && pnpm vitest run`
Expected: 전부 PASS. 대조 테스트는 그대로 초록이어야 한다 — admin 은 `role='admin'|'owner'` 라 `can()` 의 마지막 분기로 통과하고, member 는 grant 가 없어 403 이다.

- [ ] **Step 6: 커밋**

```bash
git add packages/server/src packages/server/test
git commit -m "refactor(server): requireAdmin 호출부를 requireCap 으로 — 동작 변화 0, 대조 테스트가 그것을 지킨다"
```

### Task 1.4: grant·역할 라우트와 감사

**Files:**
- Create: `packages/server/src/routes/grantRoutes.ts`
- Modify: `packages/server/src/buildServer.ts` (등록 — `registerAccountRoutes` 뒤)
- Test: `packages/server/test/grantRoutes.test.ts`

**Interfaces:**
- Produces: §0-5 의 grants/role 라우트 넷. 감사 액션 `grant.given`·`grant.revoked`·`role.changed`. 이벤트 `grant.changed`.

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/server/test/grantRoutes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let memberToken: string; let memberId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'grantee'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('grant 라우트', () => {
  it('admin 이 준 grant 로 member 가 채널을 만든다', async () => {
    const before = await app.inject({ method: 'POST', url: '/channels', headers: auth(memberToken), payload: { name: 'x' } });
    expect(before.statusCode).toBe(403);
    const put = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(adminToken), payload: { capability: 'channel.create' } });
    expect(put.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/channels', headers: auth(memberToken), payload: { name: 'granted' } });
    expect(after.statusCode).toBe(201);
  });
  it('member 는 grant 를 줄 수 없다', async () => {
    const res = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(memberToken), payload: { capability: 'agent.create' } });
    expect(res.statusCode).toBe(403);
  });
  it('회수하면 다시 거절되고 감사에 남는다', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/accounts/${memberId}/grants/channel.create`, headers: auth(adminToken) });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'POST', url: '/channels', headers: auth(memberToken), payload: { name: 'y' } });
    expect(res.statusCode).toBe(403);
    const audit = await pool.query(`select action from audit_log where action in ('grant.given','grant.revoked') order by id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['grant.given', 'grant.revoked']);
  });
  it('모르는 capability 는 400', async () => {
    const res = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(adminToken), payload: { capability: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
  it('owner 만 admin 을 임명한다', async () => {
    const res = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/role`, headers: auth(adminToken), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(memberToken) });
    expect(me.json().role).toBe('admin');
    expect(me.json().isAdmin).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd packages/server && pnpm vitest run test/grantRoutes.test.ts`
Expected: FAIL — `PUT /accounts/:id/grants` 가 404.

- [ ] **Step 3: 구현**

```ts
// packages/server/src/routes/grantRoutes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CAPABILITIES, ROLES, type GrantRow } from '@harkroom/shared';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';

const grantBody = z.object({
  capability: z.enum(CAPABILITIES),
  scope: z.string().regex(/^(|channel:[0-9a-f-]{36}|team:[0-9a-f-]{36}|agent:[0-9a-f-]{36})$/).default(''),
  expiresAt: z.string().datetime().nullable().optional(),
});
const roleBody = z.object({ role: z.enum(ROLES) });

async function listGrants(pool: Pool, accountId: string): Promise<GrantRow[]> {
  const res = await pool.query(
    `select account_id as "accountId", capability, scope, granted_by as "grantedBy",
            granted_at as "grantedAt", expires_at as "expiresAt"
       from account_grant where account_id = $1 order by capability, scope`, [accountId]);
  return res.rows;
}

export async function registerGrantRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Params: { id: string } }>('/accounts/:id/grants', { preHandler: app.requireAccount }, async (req, reply) => {
    // 남의 grant 는 admin 만 본다 — 권한 목록은 곧 공격 표면의 지도다.
    if (req.params.id !== req.account!.id && !req.account!.isAdmin) {
      return reply.code(403).send({ error: { code: 'forbidden', message: '남의 권한은 admin 만 본다' } });
    }
    return { grants: await listGrants(pool, req.params.id) };
  });

  // grant 를 주는 것은 역할의 일이다(스펙 §6 (1)): admin 이상만.
  app.put<{ Params: { id: string } }>('/accounts/:id/grants', { preHandler: app.requireAdmin }, async (req, reply) => {
    const parsed = grantBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const { capability, scope, expiresAt } = parsed.data;
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at)
       values ($1, $2, $3, $4, $5)
       on conflict (account_id, capability, scope) do update set granted_by = $4, granted_at = now(), expires_at = $5`,
      [req.params.id, capability, scope, req.account!.id, expiresAt ?? null]);
    await recordAudit(pool, { action: 'grant.given', ...actorOf(req), target: req.params.id, detail: { capability, scope, expiresAt: expiresAt ?? null } }, req);
    emitEvent({ type: 'grant.changed', accountId: req.params.id, audience: 'all' });
    return { grants: await listGrants(pool, req.params.id) };
  });

  app.delete<{ Params: { id: string; capability: string }; Querystring: { scope?: string } }>(
    '/accounts/:id/grants/:capability', { preHandler: app.requireAdmin }, async (req, reply) => {
      const scope = req.query.scope ?? '';
      const res = await pool.query(
        `delete from account_grant where account_id = $1 and capability = $2 and scope = $3`,
        [req.params.id, req.params.capability, scope]);
      if (!res.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 grant 가 없다' } });
      await recordAudit(pool, { action: 'grant.revoked', ...actorOf(req), target: req.params.id, detail: { capability: req.params.capability, scope } }, req);
      emitEvent({ type: 'grant.changed', accountId: req.params.id, audience: 'all' });
      return reply.code(204).send();
    });

  app.put<{ Params: { id: string } }>('/accounts/:id/role', { preHandler: app.requireAdmin }, async (req, reply) => {
    const parsed = roleBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const { role } = parsed.data;
    // owner 는 하나뿐이고 라우트로 넘기지 않는다. admin 임명·해제는 owner 만(스펙 §6 (1)).
    if (role === 'owner') return reply.code(400).send({ error: { code: 'bad_request', message: 'owner 는 이 라우트로 정하지 않는다' } });
    const touchesAdmin = role === 'admin' || (await pool.query(`select role from account where id = $1`, [req.params.id])).rows[0]?.role === 'admin';
    if (touchesAdmin && req.account!.role !== 'owner') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'admin 임명·해제는 owner 만 한다' } });
    }
    const res = await pool.query(
      `update account set role = $2, is_admin = ($2 in ('owner','admin')) where id = $1 and role <> 'owner' returning role`,
      [req.params.id, role]);
    if (!res.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 계정이 없거나 owner 다' } });
    await recordAudit(pool, { action: 'role.changed', ...actorOf(req), target: req.params.id, detail: { role } }, req);
    emitEvent({ type: 'grant.changed', accountId: req.params.id, audience: 'all' });
    return { role };
  });
}
```

`buildServer.ts` 에서 `await registerAccountRoutes(app, deps.pool);` 바로 뒤에 `await registerGrantRoutes(app, deps.pool);` 를 더하고 import 한다.

- [ ] **Step 4: 통과 확인**

Run: `cd packages/server && pnpm vitest run test/grantRoutes.test.ts test/requireCapParity.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/server/src/routes/grantRoutes.ts packages/server/src/buildServer.ts packages/server/test/grantRoutes.test.ts packages/server/test/helpers/fixtures.ts
git commit -m "feat(server): grant 부여·회수·역할 변경 라우트 — 전부 감사에 남긴다"
```

### Task 1.5: `channel.created_by` — 소유 기반 통과

**Files:**
- Create: `packages/server/src/db/migrations/056_channel_created_by.sql`
- Modify: `packages/server/src/services/channels.ts` (`createChannel` 이 `created_by` 를 쓴다 — 함수명은 `grep -n "insert into channel" packages/server/src/services/channels.ts` 로 찾는다)
- Test: `packages/server/test/channelOwnership.test.ts`

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/server/test/channelOwnership.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let aToken: string; let aId: string; let bToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: aToken, accountId: aId } = await createMember(app, adminToken, 'alice'));
  ({ token: bToken } = await createMember(app, adminToken, 'bob'));
  await app.inject({ method: 'PUT', url: `/accounts/${aId}/grants`, headers: auth(adminToken), payload: { capability: 'channel.create' } });
});
afterAll(async () => { await app.close(); await stop(); });

describe('내가 만든 채널은 grant 없이 내가 관리한다', () => {
  it('생성자는 PATCH 할 수 있고 남은 못 한다', async () => {
    const created = await app.inject({ method: 'POST', url: '/channels', headers: auth(aToken), payload: { name: 'mine' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const mine = await app.inject({ method: 'PATCH', url: `/channels/${id}`, headers: auth(aToken), payload: { topic: 't' } });
    expect(mine.statusCode).toBe(200);
    const theirs = await app.inject({ method: 'PATCH', url: `/channels/${id}`, headers: auth(bToken), payload: { topic: 'u' } });
    expect(theirs.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run test/channelOwnership.test.ts` → FAIL(생성자 PATCH 가 403).

- [ ] **Step 3: 마이그레이션과 서비스**

```sql
-- 056_channel_created_by.sql
-- 소유는 grant 가 아니다(스펙 §6 (3)). channel 에 그 컬럼이 없었다. 기존 채널은 null —
-- 008 판례대로 추측 backfill 은 안 한다: null 은 "아직 아무도"이지 "아무나"가 아니다.
alter table channel add column created_by uuid references account(id) on delete set null;
```

`services/channels.ts` 의 채널 insert 에 `created_by` 를 더한다 — 생성 함수의 시그니처에 `createdBy: string` 을 추가하고, `channelRoutes.ts:64` 의 호출부에서 `req.account!.id` 를 넘긴다. `ChannelRow` 에는 싣지 않는다(화면이 아직 안 쓴다).

- [ ] **Step 4: 통과 + 전체** — Run: `pnpm vitest run` → PASS
- [ ] **Step 5: 커밋** — `git commit -m "feat(server): channel.created_by — 생성자는 grant 없이 자기 채널을 관리한다"`

### Task 1.6: `/auth/me` 가 유효 capability 를 준다 (데스크탑 게이트용)

**Files:**
- Modify: `packages/server/src/routes/authRoutes.ts` (`/auth/me` 응답에 `capabilities: Capability[]`)
- Modify: `packages/shared/src/index.ts` (`AccountView` 가 아니라 `/auth/me` 전용 `MeView extends AccountView { capabilities: Capability[] }`)
- Test: `packages/server/test/authMe.test.ts`

- [ ] **Step 1: 테스트** — member 는 `['operator.register']`, grant 를 받으면 그것이 더해지고, admin 은 `CAPABILITIES` 전부.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — `authRoutes.ts` 의 `/auth/me` 핸들러에서 `const caps = await effectiveCapabilities(pool, req.account!)` 를 `permissions.ts` 에 더해 부른다:

```ts
export async function effectiveCapabilities(pool: Pool, actor: AccountView): Promise<Capability[]> {
  if (actor.role === 'owner' || actor.role === 'admin') return [...CAPABILITIES];
  const res = await pool.query<{ capability: Capability }>(
    `select distinct capability from account_grant
      where account_id = $1 and scope = '' and (expires_at is null or expires_at > now())`, [actor.id]);
  const set = new Set<Capability>(actor.role === 'guest' ? [] : MEMBER_DEFAULT_CAPABILITIES);
  for (const r of res.rows) set.add(r.capability);
  return [...set];
}
```

- [ ] **Step 4: 통과** · **Step 5: 커밋** — `git commit -m "feat(server): /auth/me 가 유효 capability 목록을 준다 — 화면 게이트의 근거"`

**단계 1 완료 정의:** `pnpm -r test` 전부 초록. `grep -rn "app.requireAdmin" packages/server/src/routes` 결과가 `accountRoutes.ts:99`·`settingsRoutes.ts`·`grantRoutes.ts` 뿐이다.

---

# 단계 2 — 오퍼레이터

### Task 2.1: 개명 — `packages/daemon` → `packages/operator` (동작 변화 0)

**Files:**
- Rename: `packages/daemon/**` → `packages/operator/**`
- Modify: `packages/operator/package.json` (`"name": "@harkroom/operator"`), `pnpm-workspace.yaml`(패턴이면 무변경), 루트 `package.json` 스크립트에 `daemon` 이 있으면 교체
- Modify: `packages/desktop/scripts/build-sidecars.mjs:44` (`name: 'harkroom-operator'`, 진입 `packages/operator/src/main.ts`), `sign-app.mjs:60,332` 주석·이름, `src-tauri/tauri.conf.json:36` (`binaries/harkroom-operator`), `src-tauri/src/daemon_client.rs:60` (`OPERATOR_SIDECAR_NAME`), 앱 데이터 하위 디렉터리 `daemon/` → `operator/`(`daemon_client.rs` 의 경로 조립부 — `grep -n '"daemon"' src-tauri/src/daemon_client.rs`)
- Modify: `packages/shared/src/daemonEndpoint.ts` — 파일은 그대로 두고 `packages/shared/src/operatorEndpoint.ts` 를 새로 만들어 `export * from './daemonEndpoint.js'; export const OPERATOR_PROTOCOL_VERSION = 1;` 로 시작한다. 소켓 파일명 상수(`daemon-v1.sock`)를 만드는 함수에 이름 인자를 더해 `operator-v1.sock` 을 만들게 한다(`grep -n "daemon-v" packages/shared/src/daemonEndpoint.ts`).
- Test: 기존 `packages/operator/test/*` 전부 + `packages/desktop/test/*` 전부

**Interfaces:**
- Produces: §0-10 의 이름 전부. `@harkroom/shared/operatorEndpoint`.

- [ ] **Step 1: git mv 와 참조 교체**

```bash
git mv packages/daemon packages/operator
sed -i '' 's/@harkroom\/daemon/@harkroom\/operator/g' packages/operator/package.json packages/desktop/package.json
grep -rln "packages/daemon\|harkroom-daemon\|@harkroom/daemon" --include='*.ts' --include='*.mjs' --include='*.json' --include='*.rs' --include='*.md' packages scripts docs 2>/dev/null | grep -v node_modules
```

목록의 파일마다 `packages/daemon`→`packages/operator`, `harkroom-daemon`→`harkroom-operator`, `DAEMON_SIDECAR_NAME`→`OPERATOR_SIDECAR_NAME` 으로 바꾼다. **`docs/` 의 역사 기록(spec·plan)은 바꾸지 않는다** — 그 문서들은 당시 이름으로 쓰였다. `design.md`·`operations.md`·`README.md` 만 바꾼다.

- [ ] **Step 2: 소켓·데이터 경로 세대 교체**

`daemon_client.rs` 에서 앱 데이터 하위 `daemon` 디렉터리와 `daemon-v1.*` 파일명을 만드는 자리를 `operator`·`operator-v1.*` 로 바꾼다. 데스크탑 `lib/runnerLauncher.ts`·`lib/daemonFacts.ts` 가 같은 이름을 만들면 함께 바꾼다. **키체인 서비스명(`app.harkroom.desktop`)은 바꾸지 않는다** — 바꾸면 사용자의 PAT 이 전부 사라진다(단계 4 에서 사람이 지운다).

- [ ] **Step 3: 전체 테스트·타입체크·빌드**

Run: `pnpm -r typecheck && pnpm -r test && cd packages/desktop && node scripts/build-sidecars.mjs`
Expected: 전부 PASS, `binaries/harkroom-operator` 생성.

- [ ] **Step 4: 실물 확인** — 앱을 개발 모드로 띄워 `ps` 에 `harkroom-operator` 가 뜨고 러너가 이전과 같이 뜨는지 본다. `~/Library/Application Support/app.harkroom.desktop/operator/operator-v1.sock` 이 생긴다. 옛 `daemon/` 디렉터리는 지우지 않는다(고아 러너 장부가 거기 있다 — 다음 기동의 입양이 옛 장부도 읽도록 `run.ts` 의 장부 경로 후보에 `daemon/runners-v1.json` 을 더한다).

- [ ] **Step 5: 커밋** — `git commit -m "refactor: daemon → operator 개명 — 역할이 커지기 전에 이름부터, 동작 변화 0"`

### Task 2.2: `operator` 테이블·등록·토큰 라우트

**Files:**
- Create: `packages/server/src/db/migrations/057_operator.sql`, `packages/server/src/routes/operatorRoutes.ts`
- Modify: `packages/server/src/auth/plugin.ts` (`req.operator`), `packages/shared/src/index.ts` (`OperatorView`), `buildServer.ts`
- Test: `packages/server/test/operatorRoutes.test.ts`

**Interfaces:**
- Consumes: `requireCap('operator.register')` (1.3), `createTicketStore` 코어(`ws/tickets.ts`)
- Produces: §0-4 `req.operator`, §0-5 의 `/operators/*` 라우트. `operatorRoutes.ts` 가 `export function createOperatorRegistry(pool, hub)` 로 목록·능력 조회를 내놓는다(2.5 가 쓴다).

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/server/test/operatorRoutes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let memberToken: string; let otherToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken } = await createMember(app, adminToken, 'mac'));
  ({ token: otherToken } = await createMember(app, adminToken, 'other'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('오퍼레이터 등록', () => {
  let code: string; let operatorId: string; let opToken: string;
  it('member 는 기본 capability 로 등록 코드를 받는다', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(memberToken) });
    expect(res.statusCode).toBe(200);
    code = res.json().code; expect(code).toMatch(/^hkreg_/);
  });
  it('코드로 토큰을 교환한다 — 인증 없이', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '맥북' } });
    expect(res.statusCode).toBe(200);
    opToken = res.json().token; operatorId = res.json().operator.id;
    expect(opToken).toMatch(/^hkop_/);
    expect(res.json().operator.name).toBe('맥북');
  });
  it('코드는 1회용이다', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '또' } });
    expect(res.statusCode).toBe(401);
  });
  it('소유자는 자기 오퍼레이터를 본다, 남은 못 본다', async () => {
    const mine = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(mine.json().operators.map((o: { id: string }) => o.id)).toEqual([operatorId]);
    const theirs = await app.inject({ method: 'GET', url: '/operators', headers: auth(otherToken) });
    expect(theirs.json().operators).toEqual([]);
    const admin = await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) });
    expect(admin.json().operators).toHaveLength(1);
  });
  it('오퍼레이터 토큰으로 요청하면 req.operator 가 서고 req.account 는 비어 있다', async () => {
    const res = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(opToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(operatorId);
    const asHuman = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(opToken) });
    expect(asHuman.statusCode).toBe(401);
  });
  it('폐기하면 토큰이 죽는다', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/operators/${operatorId}`, headers: auth(memberToken) });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(opToken) });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run test/operatorRoutes.test.ts` → FAIL(404).

- [ ] **Step 3: 마이그레이션**

```sql
-- 057_operator.sql — 스펙 §3 신원. 오퍼레이터는 사람의 기기다.
create table operator (
  id               uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null references account(id) on delete cascade,
  name             text not null,
  token_hash       text not null unique,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  revoked_at       timestamptz
);
create index operator_owner_idx on operator (owner_account_id);
```

- [ ] **Step 4: `req.operator`**

`auth/plugin.ts`:

```ts
import type { OperatorView } from '@harkroom/shared';
declare module 'fastify' { interface FastifyRequest { operator: OperatorView | null; } }
// registerAuth:
  app.decorateRequest('operator', null);
  // onRequest 훅 끝에(세션·PAT 둘 다 실패한 뒤):
    if (header.startsWith('Bearer hkop_')) {
      const op = await pool.query(
        `select id, owner_account_id as "ownerAccountId", name, created_at as "createdAt",
                last_seen_at as "lastSeenAt", revoked_at as "revokedAt"
           from operator where token_hash = $1 and revoked_at is null`, [hash]);
      if (op.rowCount) { req.operator = { ...op.rows[0], online: false }; req.credentialHash = hash; }
    }
  app.decorate('requireOperator', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.operator) await reply.code(401).send({ error: { code: 'unauthorized', message: '오퍼레이터 토큰이 필요하다' } });
  });
```

`FastifyInstance` 선언에 `requireOperator` 를 더한다.

- [ ] **Step 5: 라우트**

```ts
// packages/server/src/routes/operatorRoutes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { OperatorView } from '@harkroom/shared';
import { hashToken } from '../auth/tokens.js';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { can } from '../auth/permissions.js';
import type { OperatorHub } from '../ws/operatorHub.js'; // 2.4 에서 만든다. 이 태스크에서는 `{ isOnline(id): boolean; capabilities(id) }` 두 메서드를 가진 스텁을 buildServer 가 넘긴다

const REGISTER_CODE_TTL_MS = 5 * 60_000;
const claimBody = z.object({ code: z.string().startsWith('hkreg_'), name: z.string().min(1).max(64) });

const OP_COLS = `id, owner_account_id as "ownerAccountId", name, created_at as "createdAt",
  last_seen_at as "lastSeenAt", revoked_at as "revokedAt"`;

export interface OperatorRoutesDeps { hub: Pick<OperatorHub, 'isOnline' | 'capabilities'> }

/**
 * 등록 코드 저장소. `ws/tickets.ts` 의 `createOneShotStore` 는 export 돼 있지 않고 접두를 정할
 * 수 없다 — 열다섯 줄을 여기 두는 편이 그 파일의 경계를 흔드는 것보다 낫다. 1회용·TTL 은 같다.
 */
function createRegisterCodes(ttlMs: number) {
  const live = new Map<string, { ownerAccountId: string; expiresAt: number }>();
  return {
    issue(claim: { ownerAccountId: string }): string {
      const code = `hkreg_${randomBytes(16).toString('base64url')}`;
      live.set(code, { ...claim, expiresAt: Date.now() + ttlMs });
      return code;
    },
    consume(code: string): { ownerAccountId: string } | null {
      const entry = live.get(code);
      live.delete(code); // 있든 없든 지운다 — 두 번째 시도는 언제나 실패다
      if (!entry || entry.expiresAt < Date.now()) return null;
      return { ownerAccountId: entry.ownerAccountId };
    },
  };
}

export async function registerOperatorRoutes(app: FastifyInstance, pool: Pool, deps: OperatorRoutesDeps): Promise<void> {
  const codes = createRegisterCodes(REGISTER_CODE_TTL_MS);

  const view = (row: Omit<OperatorView, 'online'>): OperatorView => ({ ...row, online: deps.hub.isOnline(row.id) });

  app.post('/operators/register-codes', { preHandler: app.requireCap('operator.register') }, async (req) => ({
    code: codes.issue({ ownerAccountId: req.account!.id }),
    expiresAt: new Date(Date.now() + REGISTER_CODE_TTL_MS).toISOString(),
  }));

  // 인증 없음 — 코드가 인증이다. 코드는 1회용·5분이라 URL 노출보다 짧게 산다.
  app.post('/operators/claim', async (req, reply) => {
    const parsed = claimBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const claim = codes.consume(parsed.data.code);
    if (!claim) return reply.code(401).send({ error: { code: 'invalid_code', message: '등록 코드가 없거나 만료됐다' } });
    const token = `hkop_${randomBytes(32).toString('base64url')}`;
    const res = await pool.query(
      `insert into operator (owner_account_id, name, token_hash) values ($1, $2, $3) returning ${OP_COLS}`,
      [claim.ownerAccountId, parsed.data.name, hashToken(token)]);
    const operator = view(res.rows[0]);
    await recordAudit(pool, { action: 'operator.registered', actorId: claim.ownerAccountId, actorHandle: null, target: operator.id, detail: { name: operator.name } }, req);
    emitEvent({ type: 'operator.changed', operatorId: operator.id, audience: [claim.ownerAccountId] });
    return { operator, token };
  });

  app.get('/operators', { preHandler: app.requireAccount }, async (req) => {
    const all = await can(pool, req.account!, 'operator.manage');
    const res = await pool.query(
      `select ${OP_COLS} from operator where revoked_at is null and ($1::bool or owner_account_id = $2) order by created_at`,
      [all, req.account!.id]);
    return { operators: res.rows.map(view) };
  });

  app.get('/operators/self', { preHandler: app.requireOperator }, async (req) => view(req.operator!));

  app.get<{ Params: { id: string } }>('/operators/:id/capabilities', { preHandler: app.requireCap('operator.manage', { kind: 'operator', param: 'id' }) }, async (req) => (
    deps.hub.capabilities(req.params.id) ?? null
  ));

  app.delete<{ Params: { id: string } }>('/operators/:id', { preHandler: app.requireCap('operator.manage', { kind: 'operator', param: 'id' }) }, async (req, reply) => {
    const res = await pool.query(`update operator set revoked_at = now() where id = $1 and revoked_at is null returning owner_account_id`, [req.params.id]);
    if (!res.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 오퍼레이터가 없다' } });
    await recordAudit(pool, { action: 'operator.revoked', ...actorOf(req), target: req.params.id, detail: {} }, req);
    emitEvent({ type: 'operator.changed', operatorId: req.params.id, audience: 'all' });
    return reply.code(204).send();
  });
}
```

`requireCap('operator.manage', {kind:'operator', param:'id'})` 는 `can()` 의 `isOwnerOf` 분기로 **소유자도 통과**한다 — 그것이 "소유자 또는 operator.manage" 의 구현이다. `buildServer.ts` 에서 `registerAgentRelayRoutes` 앞에 등록한다(WS 플러그인 뒤). 2.4 전까지 `hub` 는 `{ isOnline: () => false, capabilities: () => null }` 이다.

- [ ] **Step 6: 통과** — Run: `pnpm vitest run test/operatorRoutes.test.ts` → PASS
- [ ] **Step 7: 커밋** — `git commit -m "feat(server): 오퍼레이터 신원 — 등록 코드로 장기 토큰 교환, 폐기, 목록"`

### Task 2.3: 공유 프로토콜 타입

**Files:**
- Create: `packages/shared/src/operatorProtocol.ts` (§0-7 그대로 + `parseOperatorFrame(raw: string): OperatorToServerFrame | null`, `parseServerFrame(raw): ServerToOperatorFrame | null` — 타입 필드만 검사하는 얕은 파서)
- Modify: `packages/shared/package.json` exports 에 `"./operatorProtocol": "./src/operatorProtocol.ts"`, `"./operatorEndpoint"`, `"./runnerLink"`(3.1 에서 채운다 — 지금은 빈 파일)
- Test: `packages/shared/test/operatorProtocol.test.ts` (모르는 type → null, 정상 → 그대로)

- [ ] Step 1 테스트 → 2 실패 확인 → 3 구현(§0-7 코드 + 파서) → 4 통과 → 5 커밋 `feat(shared): 서버↔오퍼레이터 프레임 타입`

### Task 2.4: `/operator` WS 채널과 허브

**Files:**
- Create: `packages/server/src/ws/operatorHub.ts`
- Modify: `packages/server/src/routes/operatorRoutes.ts` (WS 라우트 등록), `buildServer.ts` (허브 생성, `heartbeatMs: deps.wsHeartbeatMs`)
- Test: `packages/server/test/operatorChannel.test.ts`

**Interfaces:**
- Consumes: `req.operator` (2.2), `createHeartbeat` (`ws/heartbeat.ts`), §0-7
- Produces:

```ts
export interface OperatorHub {
  addOperator(operatorId: string, socket: RelaySocket): () => void;
  onOperatorMessage(operatorId: string, raw: string): void;
  isOnline(operatorId: string): boolean;
  capabilities(operatorId: string): OperatorCapabilities | null;
  send(operatorId: string, frame: ServerToOperatorFrame): boolean;
  /** 이 에이전트의 러너가 지금 어느 오퍼레이터에 살아 있나. */
  runnerOf(agentId: string): { operatorId: string; runnerId: string } | null;
  onFrame(listener: (operatorId: string, frame: OperatorToServerFrame) => void): () => void;
}
```

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/server/test/operatorChannel.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { OperatorToServerFrame } from '@harkroom/shared/operatorProtocol';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let opToken: string; let operatorId: string; let baseUrl: string;
const HEARTBEAT_MS = 120;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool, wsHeartbeatMs: HEARTBEAT_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: opToken, operatorId } = await registerOperator(app, adminToken, '테스트기기'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address(); baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${baseUrl}/operator`, { headers: auth(token) });
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); ws.on('unexpected-response', (_r, r) => rej(new Error(`http ${r.statusCode}`))); });
  return ws;
}
const hello = (): OperatorToServerFrame => ({ type: 'hello', protocol: 1, capabilities: { agentIds: ['a1'], harnesses: { 'claude-code': { installed: true, loggedIn: true } } }, runners: [], sessions: [] });
const waitFor = async (pred: () => Promise<boolean>, ms = 4000) => { const t = Date.now(); while (!(await pred())) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

describe('/operator 채널', () => {
  it('사람 토큰으로는 401', async () => {
    await expect(connect(adminToken)).rejects.toThrow('http 401');
  });
  it('hello 뒤 목록에 online 과 능력이 보인다', async () => {
    const ws = await connect(opToken);
    ws.send(JSON.stringify(hello()));
    await waitFor(async () => (await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) })).json().operators[0].online === true);
    const caps = await app.inject({ method: 'GET', url: `/operators/${operatorId}/capabilities`, headers: auth(adminToken) });
    expect(caps.json().agentIds).toEqual(['a1']);
    ws.close();
    await waitFor(async () => (await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) })).json().operators[0].online === false);
  });
  it('wedge 되면 heartbeat 가 끊고 offline 이 된다', async () => {
    const ws = await connect(opToken);
    ws.send(JSON.stringify(hello()));
    await waitFor(async () => (await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) })).json().operators[0].online === true);
    (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await waitFor(async () => (await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) })).json().operators[0].online === false, 5000);
  });
});
```

`fixtures.ts` 에 더한다:

```ts
export async function registerOperator(
  app: FastifyInstance, ownerToken: string, name: string,
): Promise<{ token: string; operatorId: string }> {
  const code = (await app.inject({ method: 'POST', url: '/operators/register-codes', headers: { authorization: `Bearer ${ownerToken}` } })).json().code;
  const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name } });
  return { token: res.json().token, operatorId: res.json().operator.id };
}
```

- [ ] **Step 2: 실패 확인** — Run → FAIL(`/operator` 404 → `http 404`).

- [ ] **Step 3: 허브**

```ts
// packages/server/src/ws/operatorHub.ts
// 스펙 §4. 러너 릴레이 허브(relay.ts)와 별개다 — 3 단계에서 relay.ts 가 이 허브 위로 올라온다.
import { EventEmitter } from 'node:events';
import type { OperatorCapabilities } from '@harkroom/shared';
import { parseOperatorFrame, type OperatorToServerFrame, type ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import type { RelaySocket } from './relay.js';

interface LiveOperator { socket: RelaySocket; capabilities: OperatorCapabilities | null; runners: Map<string, string> /* runnerId → agentId */ }

export interface OperatorHub {
  addOperator(operatorId: string, socket: RelaySocket): () => void;
  onOperatorMessage(operatorId: string, raw: string): void;
  isOnline(operatorId: string): boolean;
  capabilities(operatorId: string): OperatorCapabilities | null;
  send(operatorId: string, frame: ServerToOperatorFrame): boolean;
  runnerOf(agentId: string): { operatorId: string; runnerId: string } | null;
  onFrame(listener: (operatorId: string, frame: OperatorToServerFrame) => void): () => void;
}

export function createOperatorHub(): OperatorHub {
  const live = new Map<string, LiveOperator>();
  const bus = new EventEmitter();
  return {
    addOperator(operatorId, socket) {
      const previous = live.get(operatorId);
      // 같은 오퍼레이터가 두 번 붙으면 앞의 것을 끊는다 — 재접속이 앞 소켓의 close 보다 먼저 도착하는 순서가 실제로 있다.
      if (previous && previous.socket !== socket) previous.socket.close(4409, 'replaced by a newer operator connection');
      const entry: LiveOperator = { socket, capabilities: null, runners: new Map() };
      live.set(operatorId, entry);
      return () => { if (live.get(operatorId) === entry) live.delete(operatorId); };
    },
    onOperatorMessage(operatorId, raw) {
      const frame = parseOperatorFrame(raw);
      const entry = live.get(operatorId);
      if (!frame || !entry) return;
      if (frame.type === 'hello') {
        entry.capabilities = frame.capabilities;
        entry.runners = new Map(frame.runners.map((r) => [r.runnerId, r.agentId]));
      } else if (frame.type === 'runner.started') entry.runners.set(frame.runnerId, frame.agentId);
      else if (frame.type === 'runner.exited') entry.runners.delete(frame.runnerId);
      bus.emit('frame', operatorId, frame);
    },
    isOnline: (id) => live.has(id),
    capabilities: (id) => live.get(id)?.capabilities ?? null,
    send(id, frame) {
      const entry = live.get(id); if (!entry) return false;
      try { entry.socket.send(JSON.stringify(frame)); return true; } catch { return false; }
    },
    runnerOf(agentId) {
      for (const [operatorId, entry] of live) for (const [runnerId, a] of entry.runners) if (a === agentId) return { operatorId, runnerId };
      return null;
    },
    onFrame(listener) { bus.on('frame', listener); return () => bus.off('frame', listener); },
  };
}
```

- [ ] **Step 4: WS 라우트** (`operatorRoutes.ts` 에 더한다; `deps.hub` 는 이제 진짜 허브)

```ts
  const heartbeat = createHeartbeat();
  const beat = setInterval(() => heartbeat.tick(), deps.heartbeatMs ?? 30_000); beat.unref?.();
  app.addHook('onClose', async () => clearInterval(beat));

  app.get('/operator', { websocket: true, preHandler: app.requireOperator }, (socket, req) => {
    const operatorId = req.operator!.id;
    const detach = deps.hub.addOperator(operatorId, socket);
    heartbeat.track(socket);
    socket.on('pong', () => heartbeat.pong(socket));
    socket.on('message', (raw) => {
      void pool.query(`update operator set last_seen_at = now() where id = $1`, [operatorId]).catch(() => {});
      deps.hub.onOperatorMessage(operatorId, String(raw));
    });
    socket.on('close', () => { heartbeat.untrack(socket); detach(); emitEvent({ type: 'operator.changed', operatorId, audience: 'all' }); });
    emitEvent({ type: 'operator.changed', operatorId, audience: 'all' });
  });
```

`OperatorRoutesDeps` 에 `hub: OperatorHub; heartbeatMs?: number` 를 둔다. `buildServer.ts` 에서 `const operatorHub = createOperatorHub();` 를 만들어 넘기고 반환 객체에 노출한다(2.5·3.2 가 쓴다).

- [ ] **Step 5: 통과** — Run: `pnpm vitest run test/operatorChannel.test.ts test/operatorRoutes.test.ts` → PASS
- [ ] **Step 6: 커밋** — `git commit -m "feat(server): /operator 채널 — 능력 등록, 생존은 heartbeat 가 판정한다"`

### Task 2.5: 배정 테이블·라우트·push

**Files:**
- Create: `packages/server/src/db/migrations/058_agent_assignment.sql`, `packages/server/src/routes/assignmentRoutes.ts`
- Modify: `packages/server/src/services/agents.ts` (`AgentView` 에 `assignment: AgentAssignmentView | null` — `COLS` 에 left join), `packages/shared/src/index.ts` (`AgentConfig` 는 그대로, `AgentView` 에 `assignment`), `buildServer.ts`
- Test: `packages/server/test/assignmentRoutes.test.ts`

**Interfaces:**
- Consumes: `OperatorHub.send/isOnline/capabilities` (2.4), `can()` (1.2), `getAgent` (`services/agents.ts`)
- Produces: `agent_assignment`, §0-5 의 assignment 라우트, `export async function definitionFor(pool, agentId): Promise<AgentDefinition>` (`services/agents.ts` — 2.7·4.x·5.x 가 쓴다), 이벤트 `agent_assignment.changed`. **배정 push 규칙**: 배정 생성·변경 시 서버가 이전 오퍼레이터에 `unassign{drain:true}`, 새 오퍼레이터에 `assign` 을 보낸다. 오퍼레이터가 오프라인이면 보내지 않고, 그 오퍼레이터가 `hello` 로 붙을 때 **그 오퍼레이터의 배정 전부를 `assign` 으로 다시 보낸다**(허브 `onFrame` 의 hello 처리 — 이 태스크에서 배선한다).

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/server/test/assignmentRoutes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let baseUrl: string;
let adminToken: string; let aliceToken: string; let aliceId: string; let bobToken: string;
let agentId: string; let opA: { token: string; operatorId: string }; let opB: { token: string; operatorId: string };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function attachOperator(op: { token: string }, agentIds: string[]): Promise<{ frames: ServerToOperatorFrame[]; ws: WebSocket }> {
  const ws = new WebSocket(`ws://${baseUrl}/operator`, { headers: auth(op.token) });
  const frames: ServerToOperatorFrame[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, capabilities: { agentIds, harnesses: {} }, runners: [], sessions: [] }));
  return { frames, ws };
}
const waitFor = async (pred: () => boolean, ms = 4000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: aliceToken, accountId: aliceId } = await createMember(app, adminToken, 'alice'));
  ({ token: bobToken } = await createMember(app, adminToken, 'bob'));
  ({ accountId: agentId } = await createAgent(app, adminToken, 'murmur'));
  await app.inject({ method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(adminToken), payload: { ownerAccountId: aliceId } });
  opA = await registerOperator(app, aliceToken, 'A');
  opB = await registerOperator(app, bobToken, 'B');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address(); baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('배정', () => {
  it('능력에 없는 에이전트는 배정할 수 없다 (양쪽 동의)', async () => {
    const { ws } = await attachOperator(opA, []);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken), payload: { operatorId: opA.operatorId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_capable');
    ws.close();
  });
  it('소유자가 자기 오퍼레이터에 배정하면 assign 이 push 된다', async () => {
    const a = await attachOperator(opA, [agentId]);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken), payload: { operatorId: opA.operatorId } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => a.frames.some((f) => f.type === 'assign' && f.agentId === agentId));
    const agent = await app.inject({ method: 'GET', url: `/accounts/agents/${agentId}`, headers: auth(aliceToken) });
    expect(agent.json().assignment.operatorId).toBe(opA.operatorId);
    a.ws.close();
  });
  it('소유자가 남의 오퍼레이터에 배정하려면 agent.manage 가 필요하다', async () => {
    const b = await attachOperator(opB, [agentId]);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken), payload: { operatorId: opB.operatorId } });
    expect(res.statusCode).toBe(403);
    b.ws.close();
  });
  it('admin 이 재배정하면 이전에 unassign{drain}, 새 곳에 assign', async () => {
    const a = await attachOperator(opA, [agentId]);
    const b = await attachOperator(opB, [agentId]);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(adminToken), payload: { operatorId: opB.operatorId } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => a.frames.some((f) => f.type === 'unassign' && f.agentId === agentId && f.drain === true));
    await waitFor(() => b.frames.some((f) => f.type === 'assign' && f.agentId === agentId));
    a.ws.close(); b.ws.close();
  });
  it('오퍼레이터가 다시 붙으면 자기 배정을 assign 으로 다시 받는다', async () => {
    const b = await attachOperator(opB, [agentId]);
    await waitFor(() => b.frames.some((f) => f.type === 'assign' && f.agentId === agentId));
    b.ws.close();
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL(404).

- [ ] **Step 3: 마이그레이션·정의 함수**

```sql
-- 058_agent_assignment.sql — 스펙 §3 배정. 에이전트당 하나.
create table agent_assignment (
  agent_id     uuid primary key references account(id) on delete cascade,
  operator_id  uuid not null references operator(id) on delete cascade,
  assigned_by  uuid not null references account(id),
  assigned_at  timestamptz not null default now()
);
create index agent_assignment_operator_idx on agent_assignment (operator_id);
```

`services/agents.ts` 에 더한다:

```ts
export async function definitionFor(pool: Pool, agentId: string): Promise<AgentDefinition | null> {
  const res = await pool.query(
    `select a.id, a.handle, c.harness, c.instructions, c.model, c.effort, c.mention_permission as "mentionPermission",
            c.working_dir as "workingDirDefault", c.owner_account_id as "ownerAccountId"
       from account a join agent_config c on c.account_id = a.id where a.id = $1 and a.kind = 'agent'`, [agentId]);
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return { agentId: r.id, handle: r.handle, harness: r.harness, instructions: r.instructions, model: r.model, effort: r.effort,
    mentionPermission: r.mentionPermission, workingDirDefault: r.workingDirDefault, ownerAccountId: r.ownerAccountId,
    credentialScope: 'none', mcpServers: [] }; // 단계 5 가 이 둘을 실제 값으로 바꾼다
}
export async function assignmentOf(pool: Pool, agentId: string): Promise<AgentAssignmentView | null> {
  const res = await pool.query(`select agent_id as "agentId", operator_id as "operatorId", assigned_by as "assignedBy", assigned_at as "assignedAt" from agent_assignment where agent_id = $1`, [agentId]);
  return res.rowCount ? res.rows[0] : null;
}
```

`getAgent`/목록의 `COLS` 에 `assignment` 를 left join 으로 싣는다(`json_build_object` 또는 두 번째 쿼리). `AgentView` 에 `assignment: AgentAssignmentView | null`.

- [ ] **Step 4: 라우트**

```ts
// packages/server/src/routes/assignmentRoutes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { assignmentOf, definitionFor } from '../services/agents.js';
import type { OperatorHub } from '../ws/operatorHub.js';

const body = z.object({ operatorId: z.string().uuid() });

export async function registerAssignmentRoutes(app: FastifyInstance, pool: Pool, hub: OperatorHub): Promise<void> {
  // 오퍼레이터가 붙을 때 그 오퍼레이터의 배정 전부를 다시 민다 — 서버는 끊기면 잊고, 오퍼레이터는 재접속마다 처음부터다.
  hub.onFrame((operatorId, frame) => {
    if (frame.type !== 'hello') return;
    void (async () => {
      const rows = await pool.query<{ agent_id: string }>(`select agent_id from agent_assignment where operator_id = $1`, [operatorId]);
      for (const r of rows.rows) {
        const definition = await definitionFor(pool, r.agent_id);
        if (definition) hub.send(operatorId, { type: 'assign', agentId: r.agent_id, definition });
      }
    })();
  });

  app.put<{ Params: { id: string } }>('/accounts/agents/:id/assignment', { preHandler: app.requireAccount }, async (req, reply) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const agentId = req.params.id; const { operatorId } = parsed.data;
    const op = await pool.query<{ owner_account_id: string }>(`select owner_account_id from operator where id = $1 and revoked_at is null`, [operatorId]);
    if (!op.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 오퍼레이터가 없다' } });
    // 소유자는 자기 오퍼레이터에만. 남의 오퍼레이터는 agent.manage(스펙 §3 배정).
    const mine = op.rows[0].owner_account_id === req.account!.id;
    const allowed = mine
      ? await can(pool, req.account!, 'agent.manage', { kind: 'agent', id: agentId })
      : await can(pool, req.account!, 'agent.manage') ;
    if (!allowed) return reply.code(403).send({ error: { code: 'forbidden', message: '이 에이전트를 그 오퍼레이터에 배정할 권한이 없다' } });
    // 양쪽 동의: 오퍼레이터가 능력으로 이 에이전트를 등록했어야 한다.
    const caps = hub.capabilities(operatorId);
    if (!caps || !caps.agentIds.includes(agentId)) {
      return reply.code(409).send({ error: { code: 'not_capable', message: '그 오퍼레이터가 이 에이전트를 돌릴 수 있다고 등록하지 않았다(오프라인이거나 로컬 설정에 없다)' } });
    }
    const previous = await assignmentOf(pool, agentId);
    await pool.query(
      `insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)
       on conflict (agent_id) do update set operator_id = $2, assigned_by = $3, assigned_at = now()`, [agentId, operatorId, req.account!.id]);
    if (previous && previous.operatorId !== operatorId) hub.send(previous.operatorId, { type: 'unassign', agentId, drain: true });
    const definition = await definitionFor(pool, agentId);
    if (definition) hub.send(operatorId, { type: 'assign', agentId, definition });
    await recordAudit(pool, { action: 'agent.assigned', ...actorOf(req), target: agentId, detail: { operatorId, previous: previous?.operatorId ?? null } }, req);
    emitEvent({ type: 'agent_assignment.changed', agentId, audience: 'all' });
    return assignmentOf(pool, agentId);
  });

  app.delete<{ Params: { id: string } }>('/accounts/agents/:id/assignment', { preHandler: app.requireCap('agent.manage', { kind: 'agent', param: 'id' }) }, async (req, reply) => {
    const previous = await assignmentOf(pool, req.params.id);
    if (!previous) return reply.code(404).send({ error: { code: 'not_found', message: '배정이 없다' } });
    await pool.query(`delete from agent_assignment where agent_id = $1`, [req.params.id]);
    hub.send(previous.operatorId, { type: 'unassign', agentId: req.params.id, drain: true });
    await recordAudit(pool, { action: 'agent.unassigned', ...actorOf(req), target: req.params.id, detail: { operatorId: previous.operatorId } }, req);
    emitEvent({ type: 'agent_assignment.changed', agentId: req.params.id, audience: 'all' });
    return reply.code(204).send();
  });
}
```

- [ ] **Step 5: 통과** → PASS · **Step 6: 커밋** — `feat(server): 에이전트 배정 — 양쪽 동의, 재배정은 drain 뒤 넘긴다`

### Task 2.6: 오퍼레이터 — 로컬 설정·커뮤니티 인스턴스·서버 링크

**Files:**
- Create: `packages/operator/src/config.ts`, `community.ts`, `serverLink.ts`, `secrets.ts`
- Test: `packages/operator/test/config.test.ts`, `serverLink.test.ts`, `community.test.ts`

**Interfaces:**
- Consumes: §0-7 프레임, `@harkroom/shared/operatorProtocol`
- Produces:

```ts
// config.ts
export interface OperatorConfig { communities: Record<string /* baseUrl */, { agents: Record<string, { workingDir?: string; claudePool?: string }> }> }
export async function readConfig(path: string): Promise<OperatorConfig>;   // 없으면 { communities: {} }
export async function writeConfig(path: string, cfg: OperatorConfig): Promise<void>; // 원자적(rename)
// secrets.ts — 데몬 claudeAccounts 와 같은 이유로 오퍼레이터가 소유. 키체인은 Rust 가 아니라 여기서 `keytar` 대신 파일(0600)로 시작한다(6 에서 headless 도 같은 코드를 쓴다).
export interface OperatorSecrets { getToken(baseUrl: string): Promise<string | null>; setToken(baseUrl: string, token: string): Promise<void>; getAgentPat(baseUrl, agentId): Promise<string|null>; setAgentPat(...): Promise<void> }
export function fileSecrets(dir: string): OperatorSecrets;
// serverLink.ts — 러너 relay.ts 의 dial/backoff 를 그대로 옮긴 것 + ping 감시
export interface ServerLinkOptions {
  baseUrl: string; token: string;
  hello: () => OperatorToServerFrame & { type: 'hello' };
  onFrame: (frame: ServerToOperatorFrame) => void;
  onOpen?: () => void; onClose?: (reason?: string) => void;
  dial?: LinkDialer; schedule?: (fn: () => void, ms: number) => void; initialBackoffMs?: number;
  /** 서버 ping 이 이만큼 없으면 죽은 것으로 보고 끊는다. 기본 75초(30초 ping × 2 + 여유). */
  silenceMs?: number; now?: () => number;
}
export interface ServerLink { start(): void; stop(): void; send(frame: OperatorToServerFrame): boolean; connected(): boolean }
export function createServerLink(opts: ServerLinkOptions): ServerLink;
export function operatorUrl(baseUrl: string): string; // http(s)→ws(s) + '/operator'
// community.ts
export interface CommunityInstance { baseUrl: string; link: ServerLink; assignments: Map<string, AgentDefinition>; stop(): void }
export function createCommunity(opts: { baseUrl: string; token: string; agents: OperatorConfig['communities'][string]['agents']; onAssign; onUnassign; onFrame }): CommunityInstance;
```

- [ ] **Step 1: 실패하는 테스트 (serverLink — 가짜 dialer, 시간 주입)**

```ts
// packages/operator/test/serverLink.test.ts
import { describe, it, expect } from 'vitest';
import { createServerLink, operatorUrl, type LinkDialer } from '../src/serverLink.js';

describe('serverLink', () => {
  it('operatorUrl 은 http→ws + /operator', () => {
    expect(operatorUrl('https://x.harkroom.com/')).toBe('wss://x.harkroom.com/operator');
  });
  it('열리면 hello 를 보낸다', () => {
    const sent: string[] = [];
    const dial: LinkDialer = (_url, _token, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const link = createServerLink({ baseUrl: 'http://s', token: 't', dial, hello: () => ({ type: 'hello', protocol: 1, capabilities: { agentIds: ['a'], harnesses: {} }, runners: [], sessions: [] }), onFrame: () => {} });
    link.start();
    expect(JSON.parse(sent[0]!).type).toBe('hello');
  });
  it('ping 이 silenceMs 동안 없으면 스스로 끊고 재접속을 예약한다', () => {
    let now = 0; let closed = 0; const scheduled: number[] = [];
    const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: () => {}, close: () => { closed += 1; h.onClose('silence'); } }); };
    const link = createServerLink({ baseUrl: 'http://s', token: 't', dial, now: () => now, silenceMs: 1000,
      schedule: (fn, ms) => { scheduled.push(ms); if (ms < 100) fn(); }, // 감시 tick 은 짧고 재접속 backoff 는 길다
      hello: () => ({ type: 'hello', protocol: 1, capabilities: { agentIds: [], harnesses: {} }, runners: [], sessions: [] }), onFrame: () => {} });
    link.start();
    now = 500; link.noteServerPing(); // 테스트용 훅: 실제 dialer 는 ws 'ping' 이벤트에서 부른다
    now = 1400; link.tick(); expect(closed).toBe(0);   // 마지막 ping 으로부터 900ms
    now = 1600; link.tick(); expect(closed).toBe(1);   // 1100ms → 끊는다
    expect(scheduled.some((ms) => ms >= 1000)).toBe(true); // 재접속 backoff 가 예약됐다
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL(모듈 없음).

- [ ] **Step 3: 구현** — `packages/agent/src/relay.ts` 의 `createRelayClient` 에서 dial·backoff·settle 구조를 옮긴다(복사가 아니라 **이관**: 3.1 에서 러너 쪽 relay.ts 는 unix 로 바뀐다). 핵심 차이만 적는다:

```ts
// packages/operator/src/serverLink.ts (발췌 — dial/backoff 는 agent/relay.ts 의 것과 같은 구조)
export interface LinkTransport { send(data: string): void; close(): void }
export interface LinkHandlers { onOpen(t: LinkTransport): void; onMessage(raw: string): void; onClose(reason?: string): void; onPing?(): void }
export type LinkDialer = (url: string, token: string, h: LinkHandlers) => void;

export function operatorUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/operator`;
}

export function createServerLink(opts: ServerLinkOptions): ServerLink & { noteServerPing(): void; tick(): void } {
  const now = opts.now ?? Date.now; const silenceMs = opts.silenceMs ?? 75_000;
  let transport: LinkTransport | null = null; let lastPingAt = 0; let stopped = false; let backoffMs = opts.initialBackoffMs ?? 1_000;
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const tick = () => {
    if (!transport) return;
    // 이 채널은 신규라 heartbeat 없는 구 서버가 없다 — ping 부재는 곧 죽음이다(스펙 §4).
    if (now() - lastPingAt > silenceMs) { transport.close(); return; }
    schedule(tick, Math.min(silenceMs / 3, 10_000));
  };
  const connect = () => {
    if (stopped) return;
    (opts.dial ?? nodeWsDialer)(operatorUrl(opts.baseUrl), opts.token, {
      onOpen: (t) => { transport = t; lastPingAt = now(); backoffMs = opts.initialBackoffMs ?? 1_000; t.send(JSON.stringify(opts.hello())); opts.onOpen?.(); schedule(tick, Math.min(silenceMs / 3, 10_000)); },
      onMessage: (raw) => { const f = parseServerFrame(raw); if (f) opts.onFrame(f); },
      onPing: () => { lastPingAt = now(); },
      onClose: (reason) => { transport = null; opts.onClose?.(reason); if (stopped) return; schedule(connect, backoffMs); backoffMs = Math.min(backoffMs * 2, 30_000); },
    });
  };
  return {
    start: connect, stop() { stopped = true; transport?.close(); transport = null; },
    send(frame) { if (!transport) return false; try { transport.send(JSON.stringify(frame)); return true; } catch { return false; } },
    connected: () => transport !== null,
    noteServerPing() { lastPingAt = now(); }, tick,
  };
}
```

`nodeWsDialer` 는 `ws` 의 `socket.on('ping', () => h.onPing?.())` 을 배선한다 — Node `ws` 는 ping 을 이벤트로 준다(브라우저와 다르다). `config.ts`·`secrets.ts`·`community.ts` 는 위 인터페이스대로 쓴다. `community.ts` 는 `assign` 을 받으면 `assignments` 에 넣고 `onAssign(definition, localAgentConfig)` 을, `unassign` 이면 `onUnassign(agentId, drain)` 을 부른다.

- [ ] **Step 4: 통과** · **Step 5: 커밋** — `feat(operator): 로컬 설정·커뮤니티 인스턴스·서버 링크 — ping 부재로 서버 죽음을 판정한다`

### Task 2.7: 오퍼레이터 — 배정을 러너로 (spawn env 주입, 임시 PAT 경로)

**Files:**
- Create: `packages/operator/src/assignments.ts`
- Modify: `packages/operator/src/run.ts` (기동 시 `readConfig` → 커뮤니티마다 `createCommunity` → `serverLink.start()`), `packages/operator/src/runners.ts` (`spawnForAssignment`)
- Modify: `packages/server/src/routes/operatorRoutes.ts` (`POST /operator/agents/:agentId/pat` — **단계 4 에서 지운다**, 파일 상단 주석에 그렇게 적는다)
- Test: `packages/operator/test/assignments.test.ts`, `packages/server/test/operatorRoutes.test.ts` (PAT 라우트 케이스 추가)

**Interfaces:**
- Consumes: `CommunityInstance` (2.6), `RunnerRegistry.spawn(command, args, env, logFd)` (기존), `definitionFor` 의 `AgentDefinition`
- Produces: `export function createAssignmentReconciler(deps): { onAssign(baseUrl, definition, local): Promise<void>; onUnassign(baseUrl, agentId, drain): Promise<void>; announce(): RunnerAnnounce[] }`. 러너 env 는 **이 단계에서는 그대로**(`HARKROOM_URL`·`HARKROOM_PAT`·`PATH`·`AGENT_VERSION`) — 주입 주체만 데스크탑에서 오퍼레이터로 옮긴다. PAT 은 `secrets.getAgentPat` 이 없으면 `POST /operator/agents/:agentId/pat` 로 받아 저장한다.

- [ ] **Step 1: 테스트** — 가짜 spawner 로: `onAssign` 이 env 에 `HARKROOM_URL=baseUrl`·`HARKROOM_PAT` 를 넣어 spawn 한다 / 이미 살아 있는 러너면 다시 띄우지 않는다 / `onUnassign(drain:true)` 는 SIGTERM(러너 main.ts 가 drain 으로 받는다 — 기존 #551 경로) 을 보내고 `drainTimeoutMs`(기본 10분, 테스트 100ms) 뒤 SIGKILL / `announce()` 가 살아 있는 러너를 `{agentId, runnerId, pid}` 로 낸다.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 데스크탑 `runnerLauncher.ts:1105-1140 spawnRunner` 의 env 조립을 옮겨 온다(`PATH` 는 오퍼레이터 자신의 로그인 셸 PATH — `run.ts` 기동 시 한 번 `sh -lc 'echo $PATH'`; `AGENT_VERSION` 은 `--app-version` 인자). 서버 PAT 라우트:

```ts
  // 단계 2~3 한정. 단계 4(배정이 곧 인가)에서 삭제한다 — 그때까지 러너는 PAT 로 직접 붙는다.
  app.post<{ Params: { agentId: string } }>('/operator/agents/:agentId/pat', { preHandler: app.requireOperator }, async (req, reply) => {
    const a = await pool.query(`select 1 from agent_assignment where agent_id = $1 and operator_id = $2`, [req.params.agentId, req.operator!.id]);
    if (!a.rowCount) return reply.code(403).send({ error: { code: 'not_assigned', message: '이 오퍼레이터에 배정된 에이전트가 아니다' } });
    const token = await mintPat(pool, req.params.agentId, `operator:${req.operator!.id}`);
    return { token };
  });
```

`mintPat` 은 이 태스크에서 **새로 뽑는다**: `packages/server/src/services/pats.ts` 를 만들고 `accountRoutes.ts:536` `POST /accounts/:id/pats` 핸들러 안의 발급 부분(토큰 생성 → `hashToken` → `insert into pat`)을 `export async function mintPat(pool: Pool, accountId: string, label: string): Promise<string>` 로 옮긴 뒤, 그 라우트도 이 함수를 부르게 한다. 발급 규칙이 두 곳에 살면 접두·길이가 갈린다.

- [ ] **Step 4: 통과** · **Step 5: 실물** — 오퍼레이터를 손으로 띄워(`pnpm --filter @harkroom/operator exec tsx src/main.ts run`) 등록·배정 뒤 러너가 뜨고 멘션에 답하는지 본다.
- [ ] **Step 6: 커밋** — `feat(operator): 배정을 받아 러너를 띄운다 — spawn env 주입 주체가 앱에서 오퍼레이터로`

### Task 2.8: 데스크탑 축소 + 오퍼레이터·배정 UI

**Files:**
- Modify: `packages/desktop/src/state/controller.ts` — `startRunners`·`launchInput`·`restartRunner`·`restartStaleRunners`·`reissueRunnerPat`·`startCreated` 호출(1613)·`runnerLauncher` 필드 전부 삭제. `ensureDaemon()` 만 남긴다(로컬 오퍼레이터를 띄우는 것은 여전히 앱의 편의다 — 이름을 `ensureOperator` 로).
- Modify: `packages/desktop/src/lib/runnerLauncher.ts` — `RunnerLauncher` 클래스에서 spawn·PAT·restart 경로 삭제. 남기는 것: `ensureDaemon`(→`ensureOperator`), `DaemonObserver`(러너 상태 관측 — 화면이 아직 쓴다), `tauriSecretStore` 의 PAT 읽기·쓰기 삭제(`PAT_KEY` 삭제).
- Create: `packages/desktop/src/components/settings/OperatorsSettings.tsx` — 내 오퍼레이터 목록(online 점, 이름, 폐기), [기기 등록] 버튼 → 코드 표시 + "이 기기에서 등록" (로컬 오퍼레이터 소켓에 `registerCommunity{baseUrl, code}` 요청 — `operatorProtocol` 의 앱↔오퍼레이터 요청 타입에 더한다) + 로컬 설정 편집(에이전트별 workingDir/claudePool).
- Modify: `AgentsSettings.tsx` — 에이전트 카드에 배정 선택(능력에 이 에이전트가 있는 오퍼레이터만 목록) + 현재 배정·online 표시.
- Modify: `packages/desktop/src/lib/api.ts` — `operators()`, `registerCode()`, `revokeOperator(id)`, `operatorCapabilities(id)`, `assignAgent(id, operatorId)`, `unassignAgent(id)`.
- Modify: `packages/desktop/src/i18n/{ko,en}.ts`
- Test: `packages/desktop/test/noRunnerLaunch.test.ts` (회귀선), `OperatorsSettings.test.tsx`

- [ ] **Step 1: 회귀선 먼저**

```ts
// packages/desktop/test/noRunnerLaunch.test.ts
// 스펙 §2 책임표: 프론트는 PAT 도 기동 결정도 갖지 않는다. 이 파일은 그 경계가 다시 열리지 않는지 지킨다.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}
describe('데스크탑은 러너를 띄우지 않는다', () => {
  const files = walk(join(__dirname, '..', 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
  it('HARKROOM_PAT 문자열이 소스에 없다', () => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('HARKROOM_PAT'));
    expect(hits).toEqual([]);
  });
  it('spawnRunner 요청을 만드는 코드가 없다', () => {
    const hits = files.filter((f) => /type:\s*'spawnRunner'/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL(두 테스트 모두 hits 가 있다).
- [ ] **Step 3: 삭제와 UI** — 위 Files 대로. `OperatorsSettings.tsx` 의 골격:

```tsx
export function OperatorsSettings() {
  const t = useT(); const api = getController().api;
  const [operators, setOperators] = useState<OperatorView[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  useEffect(() => { void api.operators().then(setOperators); }, [api]);
  return (
    <section aria-label={t('settings.operators.title')}>
      <ul>{operators.map((o) => (
        <li key={o.id}>
          <span aria-label={o.online ? t('settings.operators.online') : t('settings.operators.offline')}>{o.online ? '●' : '○'}</span> {o.name}
          <button onClick={() => api.revokeOperator(o.id).then(() => api.operators()).then(setOperators)}>{t('settings.operators.revoke')}</button>
        </li>))}</ul>
      <button onClick={() => api.registerCode().then(setCode)}>{t('settings.operators.register')}</button>
      {code && <p><code>{code.code}</code> — {t('settings.operators.codeHint')}</p>}
    </section>
  );
}
```

- [ ] **Step 4: 통과 + 데스크탑 전체 테스트** — Run: `cd packages/desktop && pnpm vitest run` → PASS. 삭제로 깨지는 기존 테스트(runnerLauncher 의 spawn 테스트들)는 **지운다** — 그 동작이 더 이상 데스크탑의 것이 아니다.
- [ ] **Step 5: 실물** — 앱을 재시작해도 러너를 띄우지 않고, 배정 UI 로 배정하면 오퍼레이터가 띄운다. 앱을 끄고 멘션해도 답이 온다.
- [ ] **Step 6: 커밋** — `feat(desktop): 러너 기동·PAT 을 앱에서 걷어내고 오퍼레이터·배정 UI 를 둔다 — 앱은 프론트다`

### Task 2.9: 문서 갱신

**Files:** `docs/design.md` §1(#250·#431 문단 뒤에 오퍼레이터 문단), §2 「daemon 과 server 의 경계」 절을 스펙 §8 표로 교체, monorepo 목록 `packages/operator`; `docs/operations.md` §8(launchd 문단에 "단계 6 에서 오퍼레이터로 바뀐다" 표시); `README.md` 의 데몬 언급.

- [ ] Step 1 수정 → Step 2 `pnpm -r test` → Step 3 커밋 `docs: design.md — daemon 과 server 의 경계를 뒤집은 근거를 적는다`

**단계 2 완료 정의:** B컴퓨터 데스크탑에서 A컴퓨터에 배정된 에이전트를 불러 답을 받는다. 데스크탑을 꺼도 러너가 뜬다. `grep -rn HARKROOM_PAT packages/desktop/src` 가 비어 있다.

---

# 단계 3 — 릴레이를 오퍼레이터 채널로

### Task 3.1: 러너 ↔ 오퍼레이터 unix 링크

**Files:**
- Create: `packages/shared/src/runnerLink.ts` (§0-8 + `parseRunnerFrame`/`parseOperatorToRunnerFrame`), `packages/operator/src/runnerLink.ts`
- Modify: `packages/agent/src/relay.ts` — `nodeWsDialer` 를 `unixDialer` 로 교체: `net.connect(HARKROOM_OPERATOR_SOCKET)` → NDJSON, 첫 줄 `hello{runnerId, secret}`. `RelayClientOptions.harkroomUrl/pat` → `socketPath/runnerId/secret`. `announce`/`session.*`/`pty.output` 프레임은 §0-8 형태로.
- Modify: `packages/agent/src/config.ts` (`HARKROOM_OPERATOR_SOCKET`·`HARKROOM_RUNNER_ID`·`HARKROOM_RUNNER_SECRET` 읽기 — 이 단계에서는 셋이 있으면 unix, 없으면 옛 WS 로 **폴백**한다: 오퍼레이터 없이 손으로 띄운 러너(operations.md §8)가 아직 있다)
- Modify: `packages/operator/src/assignments.ts` (spawn env 에 셋 추가, secret 은 spawn 마다 랜덤)
- Test: `packages/operator/test/runnerLink.test.ts`, `packages/agent/test/relayUnix.test.ts`

**Interfaces:**
- Produces: 오퍼레이터 쪽 `createRunnerLinkServer(socketPath, { authenticate(runnerId, secret): string | null /* agentId */, onFrame(runnerId, frame) }): { send(runnerId, frame): boolean; close() }`. 오퍼레이터 소켓은 앱 프로토콜과 **같은 파일**을 쓰되 첫 줄의 `type` 으로 가른다(`hello` 에 `runnerId` 가 있으면 러너).

- [ ] Step 1 테스트(가짜 소켓 페어로: hello 인증 실패 → 연결 종료 / 성공 뒤 `session.started` 가 `onFrame` 에 온다 / `send` 가 러너에 도착한다) → Step 2 실패 → Step 3 구현 → Step 4 통과 → Step 5 커밋 `feat(agent,operator): 러너가 오퍼레이터에 unix 소켓으로 붙는다 — 폴백은 옛 WS`

### Task 3.2: 채널 다중화와 서버 허브 통합

**Files:**
- Create: `packages/operator/src/relayMux.ts` — 러너 프레임에 `runnerId` 를 붙여 `serverLink.send`, 서버 프레임의 `runnerId` 로 러너를 골라 `runnerLink.send`.
- Modify: `packages/server/src/ws/relay.ts` — `addRunner(agentAccountId, socket)` → `addOperatorRunner(operatorId, runnerId, agentAccountId, sender: (frame) => boolean)`. 세션 맵은 `(operatorId, runnerId)` 키. `onRunnerMessage` 는 `OperatorHub.onFrame` 에서 `runnerId` 가 있는 프레임을 받아 부른다. `openInteractive`·`cancelSession`·뷰어 입력은 `hub.send(operatorId, {…, runnerId})` 로.
- Modify: `packages/server/src/routes/agentRelayRoutes.ts` — `/agent-relay` 라우트와 `addRunner` 호출 **삭제**. 뷰어(`/agent-attach`)·`/agent-sessions`·`interactive`·`cancel` 은 유지.
- Modify: `packages/server/test/agentRelay.test.ts`, `agentRelayHeartbeat.test.ts` — `connectRunner` 를 `attachOperator + hello{runners, sessions}` 로 바꾼다. 세션 announce 는 `session.started{runnerId, session}`. wedge 테스트는 오퍼레이터 소켓을 wedge 한다.
- Test: 위 두 파일 + `packages/operator/test/relayMux.test.ts`

- [ ] Step 1 테스트 수정(먼저 빨강) → Step 2 구현 → Step 3 `pnpm vitest run` 전체 → Step 4 실물(원격 서버에서 터미널 관찰·개입, 오퍼레이터 링크를 `kill -STOP` 으로 얼렸다 풀어 60초 안에 복구) → Step 5 커밋 `feat(server,operator): PTY 릴레이를 오퍼레이터 채널에 다중화 — /agent-relay 폐기`

### Task 3.3: 러너 폴백 제거 준비 표시

- [ ] `packages/agent/src/config.ts` 의 WS 폴백 분기에 `console.warn('오퍼레이터 없이 도는 러너다 — 단계 4 에서 이 경로가 사라진다')` 를 남기고 커밋. (실제 삭제는 4.5)

**단계 3 완료 정의:** `nettop` 으로 머신당 서버 WS 가 오퍼레이터 것 하나다. `/agent-relay` 가 404.

---

# 단계 4 — MCP 브릿지, 배정이 곧 인가

### Task 4.1: 실측 스파이크 — stdio 브릿지가 long-poll 을 붙잡는가

**Files:** Create: `docs/plans/2026-09-2x-mcp-bridge-measurement.md` (날짜는 실행일)

- [ ] **Step 1:** 최소 stdio MCP 서버(도구 둘: `slow` 25초 대기, `fast` 즉시)를 `packages/operator/spike/` 에 만들고 claude-code·codex 각각을 `--mcp-config` 로 붙인다.
- [ ] **Step 2:** 하네스가 `slow` 를 부른 동안 `fast` 를 부르게 프롬프트한다. JSON-RPC 요청 id 가 동시에 둘 열리는지 stdio 로그로 확인한다.
- [ ] **Step 3:** 결과를 문서에 적는다: "직렬" 이면 4.2 의 브릿지는 단순 파이프, "병렬" 이면 4.2 에서 `id` 기반 다중화(요청 맵)를 넣는다. 스파이크 코드는 **지운다**.
- [ ] **Step 4:** 커밋 `docs: MCP stdio 브릿지 실측 — 하네스의 요청 직렬성`

### Task 4.2: `harkroom-operator mcp-bridge`

**Files:**
- Create: `packages/operator/src/mcpBridge.ts` — stdin 의 JSON-RPC 줄을 `mcp.request{id, payload}` 로 오퍼레이터 소켓에, `mcp.response` 를 stdout 으로. 인증은 `HARKROOM_RUNNER_ID`·`HARKROOM_RUNNER_SECRET`(브릿지 프로세스가 러너 env 를 상속한다).
- Modify: `packages/operator/src/main.ts` (`mcp-bridge` 서브커맨드)
- Test: `packages/operator/test/mcpBridge.test.ts` (가짜 소켓: stdin 한 줄 → 소켓에 `mcp.request`, 소켓의 `mcp.response` → stdout 한 줄; 4.1 결과가 병렬이면 id 둘 교차 순서 테스트 추가)

- [ ] Step 1~5 (테스트 → 실패 → 구현 → 통과 → 커밋 `feat(operator): mcp-bridge — 하네스와 오퍼레이터 사이의 stdio 파이프`)

### Task 4.3: 오퍼레이터 forward — MCP 와 REST 를 서버로

**Files:**
- Create: `packages/operator/src/forward.ts` — `mcp.request` → `POST {baseUrl}/mcp` (Streamable HTTP, `Authorization: Bearer hkop_…`, `X-Harkroom-Agent: <agentId>`), 응답을 `mcp.response` 로. `http.forward{method, path, body}` → `fetch(baseUrl + path)` 같은 헤더, `http.response{status, body}`.
- Modify: `packages/operator/src/runnerLink.ts` (두 프레임을 forward 로 라우팅)
- Test: `packages/operator/test/forward.test.ts` (가짜 fetch 로 헤더 둘과 경로를 검증)

- [ ] Step 1~5, 커밋 `feat(operator): MCP·REST 전달 — 인증 치환 규칙은 하나`

### Task 4.4: 서버 — `X-Harkroom-Agent` 로 에이전트 인가

**Files:**
- Modify: `packages/server/src/auth/plugin.ts` — `onRequest` 훅: `req.operator` 가 섰고 `x-harkroom-agent` 헤더가 있으면 `agent_assignment` 를 확인해 `req.account = <에이전트 AccountView>`, `req.credentialHash = 오퍼레이터 토큰 해시`. 배정이 없으면 403 `not_assigned` 로 **즉시 응답**(훅에서 `reply.code(403).send`).
- Modify: `packages/server/src/mcp/mcpPlugin.ts:957` — 조건은 그대로(`req.account.kind === 'agent'`). 문구만 "agent PAT or operator assignment".
- Test: `packages/server/test/operatorAgentAuth.test.ts` — 오퍼레이터 토큰 + 배정된 agentId 로 `/mcp` `initialize` 가 200 / 미배정 agentId 는 403 / 헤더 없이 `/agent/config` 는 401 / 사람 세션 + 헤더는 무시(사람 그대로).

- [ ] Step 1~5, 커밋 `feat(server): 배정이 곧 인가 — 오퍼레이터 토큰 + X-Harkroom-Agent 로 에이전트 행위를 인가한다`

### Task 4.5: 러너에서 서버를 지운다

**Files:**
- Modify: `packages/agent/src/config.ts` — `harkroomUrl`·`harkroomPat` 삭제, `HARKROOM_OPERATOR_SOCKET`·`HARKROOM_RUNNER_ID`·`HARKROOM_RUNNER_SECRET` 필수. WS 폴백 삭제(3.3).
- Modify: `packages/agent/src/harkroom.ts` — `HarkroomAgentClient` 생성자를 `(link: RunnerLinkClient)` 로. MCP 클라이언트 transport 는 **오퍼레이터 링크 위의 커스텀 Transport**(`mcp.request/response`)로; REST(`/agent/config` 등)는 `link.forward(method, path, body)`.
- Modify: `packages/agent/src/turn.ts:585 writeMcpConfigOnce(dir, harkroomUrl)` → `writeMcpConfigOnce(dir, bridge: { command: string; runnerId: string })`: `harkroom` 항목을 stdio 로.
- Modify: `packages/agent/src/main.ts:43-44, 259, 296-307, 328, 366`
- Modify: `packages/operator/src/assignments.ts` — env 에서 `HARKROOM_URL`·`HARKROOM_PAT` 제거, `HARKROOM_OPERATOR_BIN`(브릿지 명령 절대경로) 추가.
- Test: `packages/agent/test/*` 중 `HARKROOM_URL` 을 쓰는 테스트 전부 수정, `packages/agent/test/noServerInRunner.test.ts` (소스에 `HARKROOM_PAT`·`/agent-relay`·`mcpUrl(` 이 없다)

- [ ] Step 1~5, 실물(러너 프로세스 env 에 PAT 없음: `ps eww` 로 확인 — SIP 때문에 안 되면 러너가 `console.log(Object.keys(process.env).filter(k=>k.startsWith('HARKROOM_')))` 를 기동 로그에 남기게 한다), 커밋 `feat(agent): 러너는 서버를 모른다 — MCP 는 stdio 브릿지, REST 는 http.forward`

### Task 4.6: 임시 PAT 경로 제거

**Files:** Modify: `operatorRoutes.ts` (2.7 의 `/operator/agents/:agentId/pat` 삭제), `packages/operator/src/secrets.ts` (`getAgentPat/setAgentPat` 삭제), `docs/operations.md` 에 "키체인의 `harkroom.runner.pat.*` 항목은 손으로 지운다 — 절차" 추가.

- [ ] Step 1 삭제 → Step 2 `pnpm -r test` → Step 3 커밋 `chore: 오퍼레이터의 임시 PAT 발급 경로를 지운다 — 배정이 인가다`

**단계 4 완료 정의:** 러너 env·디스크 어디에도 PAT 이 없다. 외부 접속형 PAT 경로(`createAgent` 픽스처의 `/accounts/:id/pats`)는 그대로 산다.

---

# 단계 5 — 호출·자격증명 스코프

### Task 5.1: `invoke_scope`·`credential_scope`·불변식

**Files:**
- Create: `059_agent_scopes.sql`
- Modify: `packages/shared/src/index.ts` (`AgentConfig` 에 `invokeScope: 'owner'|'list'|'channel'|'community'`, `credentialScope: 'personal'|'community'|'none'`, `invokers: string[]`), `services/agents.ts` (`upsertConfig`·`COLS`·`definitionFor` 의 `credentialScope`), `accountRoutes.ts` (`configFields`·`ADMIN_ONLY_FIELDS` 에 둘 추가, PATCH 에서 불변식 검사), `PUT/DELETE /accounts/agents/:id/invokers/:accountId`
- Test: `packages/server/test/agentScopes.test.ts`

```sql
-- 059_agent_scopes.sql — 스펙 §6. backfill 은 현행 동작 유지(확정): community / none.
alter table agent_config
  add column invoke_scope text not null default 'community' check (invoke_scope in ('owner','list','channel','community')),
  add column credential_scope text not null default 'none' check (credential_scope in ('personal','community','none'));
-- 양방향 불변식은 DB 가 아니라 서비스가 지킨다(넓히기 금지는 이전 값이 필요해서 DB check 로 못 적는다).
create table agent_invoker (
  agent_id   uuid not null references account(id) on delete cascade,
  account_id uuid not null references account(id) on delete cascade,
  primary key (agent_id, account_id)
);
```

PATCH 검사(서비스 `validateScopeChange(before, after)`):
- `after.credentialScope === 'personal'` ⟺ `after.invokeScope === 'owner'` 아니면 400 `scope_invariant`.
- `before.invokeScope === 'owner' && after.invokeScope !== 'owner'` 이면 400 `scope_widening` ("넓히려면 새 에이전트를 만든다").

- [ ] 테스트 4건(불변식 위반 400 / 넓히기 400 / 좁히기 200 / invokers 추가·삭제) → 실패 → 구현 → 통과 → 커밋 `feat(server): invoke_scope·credential_scope — personal ⟺ owner, 넓히기는 일방통행`

### Task 5.2: `mcp_server` 레지스트리

**Files:** Create: `060_mcp_server.sql` (`mcp_server(name text pk check(name ~ '^[a-z0-9-]{1,32}$'), credential_kind text check in ('community','personal'), created_by, created_at)`, `agent_mcp_server(agent_id, name references mcp_server on delete cascade, pk(agent_id,name))`), `routes/mcpServerRoutes.ts` (§0-5 셋, `requireCap('agent.privileged')`), `accountRoutes.ts` PATCH 에 `mcpServers: string[]` (부분집합 검사 + `personal` 이름이 있으면 `credentialScope` 가 `personal` 이어야 400), `definitionFor` 가 `mcpServers` 를 싣는다.
- Test: `packages/server/test/mcpServerRoutes.test.ts`

- [ ] Step 1~5, 커밋 `feat(server): mcp_server 레지스트리 — 이름만 서버에, 정의와 토큰은 오퍼레이터 머신에`

### Task 5.3: fan-out 게이트와 400 거절

**Files:**
- Create: `packages/server/src/services/invokeGate.ts` — `export async function mayInvoke(client, { agentId, callerId, channelId, viaTeam: boolean, viaAutoMention: boolean }): Promise<boolean>`: `community` → true; `channel` → 호출자가 그 채널 멤버; `list` → `agent_invoker` 에 있음; `owner` → 호출자 = 소유자. `viaTeam`/`viaAutoMention` 이면 `community` 만 true.
- Modify: `services/messages.ts:437 fanOutMention` — `audience` 를 만든 뒤 `mayInvoke` 로 거른다. 걸러진 에이전트 id 를 `meta.mentionDenied: string[]` 에 싣는다(`mentionChainCapped` 와 같은 자리, 695 근처).
- Modify: `teamRoutes.ts:162` 팀원 추가 · `channelRoutes.ts:627` auto-mention — `invoke_scope != 'community'` 면 400 `invoke_scope_restricted`.
- Modify: 데스크탑 `MessageMeta` 렌더에 `mentionDenied` 표시(`mentionChainCapped` 와 같은 컴포넌트).
- Test: `packages/server/test/invokeGate.test.ts` (owner 에이전트를 남이 부르면 inbox 에 안 들어가고 `meta.mentionDenied` 에 남는다 / list / channel / 팀원 추가 400 / auto-mention 400)

- [ ] Step 1~5, 커밋 `feat(server): 호출 게이트 — 막힌 부름은 mentionDenied 로 보인다`

### Task 5.4: 교차 불변식 — 서버 배정 거절 + 오퍼레이터 재검사 + personal MCP 합치기

**Files:**
- Modify: `assignmentRoutes.ts` PUT — `credential_scope='personal'` 이고 `operator.owner_account_id !== agent.owner_account_id` 면 403 `personal_on_foreign_operator`.
- Modify: `packages/operator/src/assignments.ts` — `assign` 수신 시 `definition.credentialScope === 'personal' && definition.ownerAccountId !== community.ownerAccountId`(오퍼레이터가 `hello` 응답 또는 `/operators/self` 로 자기 소유자 id 를 안다) 면 spawn 하지 않고 `runner.exited{reason:'personal_on_foreign_operator'}`.
- Modify: `packages/agent/src/turn.ts writeMcpConfigOnce` → 오퍼레이터가 spawn 전에 `mcp.json` 을 **직접** 쓴다: `harkroom`(stdio 브릿지) + `avcs` + `definition.mcpServers` 각각을 `~/.claude/…`(`CLAUDE_CONFIG_DIR`)의 정의에서 이름으로 찾아 합친다. 러너는 `HARKROOM_MCP_CONFIG` 경로만 받는다.
- Test: `packages/server/test/assignmentRoutes.test.ts` 케이스 추가, `packages/operator/test/assignments.test.ts` 케이스 추가, `packages/operator/test/mcpConfig.test.ts`

- [ ] Step 1~5, 실물(slack personal 에이전트를 남이 불러도 안 깨어남·표시 보임·남의 오퍼레이터 배정 거절), 커밋 `feat(operator,server): personal 자격증명은 소유자 자신의 오퍼레이터에만 — 서버가 거절하고 오퍼레이터가 재검사한다`

**단계 5 완료 정의:** 스펙 §11 5 행 그대로.

---

# 단계 6 — 헤드리스 오퍼레이터

### Task 6.1: CLI — `register` · `run`

**Files:**
- Create: `packages/operator/src/cli.ts` — `harkroom-operator register <baseUrl> <code> [--name]` (claim → `secrets.setToken`, `operator.json` 에 커뮤니티 항목 생성), `harkroom-operator run [--data-dir]` (앱 없이 `run.ts` 기동: 앱 소켓도 열되 `--launch-nonce` 없이).
- Modify: `main.ts` 서브커맨드 분기, `args.ts`
- Test: `packages/operator/test/cli.test.ts` (가짜 fetch 로 register 가 토큰을 저장하고 설정을 만든다)

- [ ] Step 1~5, 커밋 `feat(operator): register·run CLI — 앱 없는 머신의 길`

### Task 6.2: 감독 템플릿

**Files:** Create: `ops/operator.plist.template` (launchd, `harkroom-operator run`, `KeepAlive`, `PATH`·`HOME` 명시 — 기존 plist 의 함정 주석 그대로), `ops/operator.service.template` (systemd user unit, `Restart=always`). Delete: `ops/agent-runner.plist.template`.

- [ ] Step 1 작성 → Step 2 실물(`launchctl load` → `kill -9` → PID 바뀜) → Step 3 커밋 `ops: 오퍼레이터 감독 템플릿 — 러너 plist 를 대체한다`

### Task 6.3: 운영 문서

**Files:** `docs/operations.md` §8 — 확인 순서 2·3 을 오퍼레이터 기준으로("`launchctl list | grep dev.harkroom.operator`", 로그 경로), 키체인 정리 절차(4.6), "앱 없는 머신" 절을 6.1·6.2 로.

- [ ] Step 1 수정 → Step 2 커밋 `docs(operations): 에이전트가 답하지 않을 때 — 오퍼레이터 기준으로`

**단계 6 완료 정의:** 앱 없는 머신에 오퍼레이터 하나로 에이전트 N개가 돈다.

---

## 자체 검토 기록

- **스펙 커버리지:** §3 이름(2.1) · 신원(2.2) · 격리(2.6) · 능력(2.4, 2.6) · 배정(2.5, 2.7) / §4 채널(2.3, 2.4) / §5 세 경로(3.1, 3.2, 4.2~4.5) / §6 3층(1.1~1.6) · 에이전트 스코프(5.1) · 레지스트리(5.2) · 게이트(5.3) / §7 교차 불변식(5.4) / §8 문서(2.9) / §9 drain 상한(2.7) · 토큰 폐기(2.2) · 크래시 입양(2.1 Step 4) / §11 순서 그대로.
- **타입 일관성:** `OperatorHub` 의 여섯 메서드는 2.4 에서 정의하고 2.2(스텁)·2.5·3.2 가 같은 이름을 쓴다. `definitionFor` 는 2.5 에서 만들고 2.7·5.2·5.4 가 쓴다. `RunnerAnnounce.runnerId` 는 §0-7 에서 정하고 2.7 `announce()`·3.2 가 쓴다. 러너 env 이름 셋은 §0-8 에서 정하고 3.1·4.5 가 쓴다.
- **확인 완료(2026-09-21):** `agent_team.created_by` 는 있다(036:7). `ws/tickets.ts` 는 제네릭 코어를 export 하지 않는다 → 2.2 가 자기 저장소(15줄)를 둔다. PAT 발급은 `accountRoutes.ts:536` 인라인 → 2.7 이 `services/pats.ts::mintPat` 으로 뽑는다.
