import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { newToken } from '../auth/tokens.js';
import { checkOwnerOrAdmin } from '../auth/plugin.js';
import { ACCOUNT_STATUSES, CREDENTIAL_SCOPES, INVOKE_SCOPES, MENTION_PERMISSIONS, RUNNABLE_HARNESSES } from '@harkroom/shared';
import {
  ackAgentStop, createAgentAccount, deleteAgentAccount, getAgent, listAgents, recordAgentTurn, requestAgentStop,
  revokeAllPats, setAgentMcpServers, setInvoker, undoAgentStopRequest, updateAgent, validateMcpServers, validateScopeChange,
} from '../services/agents.js';
import { actorOf, recordAudit } from '../audit.js';
import { mintPat } from '../services/pats.js';
import { emitEvent } from '../events.js';
import { deleteMemory, listMemoryEntries } from '../services/memory.js';
import { getHandleGroupByHandle } from '../services/handleGroups.js';

export interface AccountRouteDeps {
  /** 오퍼레이터 허브 — 에이전트 목록에 배정 거절 사유를 붙인다(`OperatorHub.refusalOf`). 테스트는 생략한다. */
  operatorHub?: { refusalOf(agentId: string): { reason: string; at: string } | null };
}

export async function registerAccountRoutes(app: FastifyInstance, pool: Pool, routeDeps: AccountRouteDeps = {}): Promise<void> {
  /**
   * 사람이 자기 상태를 직접 정한다(#186). presence 를 **덮지 않는다** — 별도 컬럼·별도
   * 이벤트다. 여기서 `presence.changed` 를 내면 소켓 연결에서 파생되는 사실과 사람이 고른
   * 신호가 한 표시로 뭉쳐, 하트비트가 잡아내려던 것(죽은 연결을 online 으로 남기지 않는다)을
   * 잃는다.
   *
   * 에이전트를 거절하는 이유: 에이전트에게는 이미 러너 상태라는 **기계가 파생하는 사실**이
   * 따로 있다(#124/#125). 사람이 손으로 고르는 사회적 신호를 같은 자리에 허용하면 "대화
   * 가능"이라고 표시하면서 러너가 없는 상태를 만들 수 있다. 코드는 `POST /auth/password`
   * 의 선례를 그대로 따른다 — 같은 이유이므로 같은 코드(`invalid_account`)를 쓴다.
   *
   * 감사 로그는 남기지 않는다: 권한도 도달 범위도 바꾸지 않고, 문구는 자유 텍스트라
   * 원문을 감사에 복사하면 "지웠다"가 지운 것이 아니게 된다.
   */
  app.put('/accounts/me/status', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({
      status: z.enum(ACCOUNT_STATUSES),
      // **키 부재와 null 을 구분한다.** 부재는 '손대지 않음', null 은 '지우기'다.
      // `undefined` 로 지우기를 표현하면 `JSON.stringify` 가 그 키를 버려 조작이 조용히
      // 무시된다 — 사용자는 지웠다고 믿는데 문구가 그대로 남는다.
      // 80자 상한은 이 문구가 사이드바·DM 행 같은 좁은 자리에 그대로 실리기 때문이다.
      statusText: z.string().max(80).nullable().optional(),
    }).parse(req.body);

    const account = req.account!;
    if (account.kind !== 'human') {
      return reply.code(400).send({ error: { code: 'invalid_account', message: 'status is only for human accounts' } });
    }

    // 부재는 기존 값을 그대로 둔다 — coalesce 가 아니라 `$3::boolean` 플래그로 가른다.
    // coalesce($4, status_text) 로 쓰면 null(지우기)이 '손대지 않음'과 같아져 버린다.
    const touchText = body.statusText !== undefined;
    const res = await pool.query(
      `update account
          set status = $2,
              status_text = case when $3::boolean then $4::text else status_text end
        where id = $1
        returning status, status_text as "statusText"`,
      [account.id, body.status, touchText, body.statusText ?? null],
    );
    const row = res.rows[0] as { status: typeof body.status; statusText: string | null };

    emitEvent({ type: 'status.changed', accountId: account.id, status: row.status, statusText: row.statusText });
    return row;
  });

  /**
   * 사람이 **자기** handle 을 바꾼다(#271). 유니크는 대소문자 무시, 충돌은 409.
   * 감사 로그와 WS 이벤트를 보낸다.
   *
   * 에이전트는 여기서 400 이다. #843 전의 이유("러너 상태가 handle 스코프다")는 사라졌지만
   * 거절 자체는 남긴다 — 이제 이유가 다르다. **에이전트의 이름은 소유자가 정한다.** 러너가
   * 자기 PAT 로 자기 이름을 바꿀 수 있으면, 사람이 부르려던 이름이 턴 도중에 사라질 수 있다.
   * 바꾸는 문은 `PATCH /accounts/agents/:id`(소유자 또는 admin) 하나다.
   */
  app.patch('/accounts/me/handle', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({ handle: z.string().regex(/^[a-z0-9_-]{2,32}$/) }).parse(req.body);
    const account = req.account!;

    if (account.kind !== 'human') {
      return reply.code(400).send({
        error: {
          code: 'agent_handle_not_self_serve',
          message: "an agent's name is changed by its owner via PATCH /accounts/agents/:id",
        },
      });
    }

    // 충돌 검사: 대소문자 무시
    const existing = await pool.query(
      `select id from account where lower(handle) = lower($1) and id != $2`,
      [body.handle, account.id],
    );
    if (existing.rowCount) {
      return reply.code(409).send({ error: { code: 'handle_taken', message: 'this handle is already taken' } });
    }
    /**
     * 집합도 본다. 이름공간은 계정·집합·팀이 나눠 쓰는데(`026_handle_group.sql` 결정 3),
     * 생성 경로만 막혀 있고 **이름 변경 경로는 뚫려 있었다** — 만들 때는 못 쓰는 이름을
     * 나중에 바꿔서 차지할 수 있었다. 그러면 `@foo` 가 사람인지 집합인지 갈린다.
     */
    if (await getHandleGroupByHandle(pool, body.handle)) {
      return reply.code(409).send({ error: { code: 'handle_taken', message: 'a group with this handle already exists' } });
    }

    const oldHandle = account.handle;
    await pool.query(`update account set handle = $1 where id = $2`, [body.handle, account.id]);

    await recordAudit(pool, {
      action: 'account.handle.changed', actorId: account.id, actorHandle: body.handle,
      detail: { from: oldHandle, to: body.handle },
    }, req);

    emitEvent({ type: 'account.handle_changed', accountId: account.id, newHandle: body.handle });

    return { handle: body.handle };
  });

  /**
   * Admin 이 다른 계정의 handle 을 바꾼다(#271). 같은 유니크·감사·WS 규칙.
   *
   * #843: **에이전트도 여기를 지난다.** 그 전에는 `agent_handle_immutable` 로 거절했는데,
   * 에이전트 PATCH(`/accounts/agents/:id`)가 이름 변경을 받게 된 뒤로 그 400 은 거짓말이
   * 된다 — 문이 둘인데 서로 다른 말을 하면, 하나가 막혔다고 읽은 사람은 기능이 없다고 믿는다.
   */
  app.patch('/accounts/:id/handle', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ handle: z.string().regex(/^[a-z0-9_-]{2,32}$/) }).parse(req.body);

    // 대상 계정 조회
    const target = await pool.query(`select handle, kind from account where id = $1`, [id]);
    if (!target.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
    }
    const targetRow = target.rows[0];

    // 충돌 검사 — 계정과 집합 둘 다(위 self 라우트와 같은 근거).
    const existing = await pool.query(
      `select id from account where lower(handle) = lower($1) and id != $2`,
      [body.handle, id],
    );
    if (existing.rowCount) {
      return reply.code(409).send({ error: { code: 'handle_taken', message: 'this handle is already taken' } });
    }
    if (await getHandleGroupByHandle(pool, body.handle)) {
      return reply.code(409).send({ error: { code: 'handle_taken', message: 'a group with this handle already exists' } });
    }

    const oldHandle = targetRow.handle;
    await pool.query(`update account set handle = $1 where id = $2`, [body.handle, id]);

    await recordAudit(pool, {
      action: 'account.handle.changed', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { from: oldHandle, to: body.handle },
    }, req);

    emitEvent({ type: 'account.handle_changed', accountId: id, newHandle: body.handle });

    return { handle: body.handle };
  });

  app.post('/invites', { preHandler: app.requireCap('member.invite') }, async (req, reply) => {
    const { token, hash } = newToken('hrki');
    await pool.query(`insert into invite (token_hash, created_by) values ($1, $2)`, [hash, req.account!.id]);
    await recordAudit(pool, {
      action: 'invite.created', actorId: req.account!.id, actorHandle: req.account!.handle,
    }, req);
    return reply.code(201).send({ token });
  });

  // UI 로 등록·수정하는 '에이전트 정의'. 설정은 서버에 살아야 UI 수정이 러너에 반영된다.
  // harness 검증은 `AGENT_HARNESSES`(스키마가 아는 이름) 가 아니라 `RUNNABLE_HARNESSES`
  // (러너가 실제로 돌릴 수 있는 것) 로 좁힌다 — 데스크탑 드롭다운은 이미 그렇게 잠그는데
  // API 만 열려 있어서, admin 이 실행 불가능한 harness 를 저장할 수 있었다(#83).
  // 이미 DB 에 그 값이 저장된 에이전트는 읽기·다른 필드 수정에 영향받지 않는다(harness 키를
  // 안 보내면 `.optional()` 로 통과한다) — 새로 그 값으로 **바꾸는 것**만 막는다.
  const configFields = {
    instructions: z.string().max(8000).optional(),
    harness: z.enum(RUNNABLE_HARNESSES).optional(),
    model: z.string().max(64).nullable().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    workingDir: z.string().max(512).nullable().optional(),
    mentionPermission: z.enum(MENTION_PERMISSIONS).optional(),
    ownerAccountId: z.string().uuid().nullable().optional(),
    // 스코프(스펙 2026-09-20 §6). 소유자도 고친다 — 좁히는 것은 자기 에이전트의 일이다. 불변식·넓히기
    // 금지는 `validateScopeChange` 가 생성·PATCH 양쪽에서 판정한다.
    invokeScope: z.enum(INVOKE_SCOPES).optional(),
    credentialScope: z.enum(CREDENTIAL_SCOPES).optional(),
  };

  const ADMIN_ONLY_FIELDS = ['ownerAccountId', 'disabled', 'mentionPermission'] as const;

  /**
   * 감사에 남길 에이전트 설정 필드와, 값을 그대로 남겨도 되는지의 표.
   * `if` 사슬로 두면 `configFields` 에 필드가 늘 때 이쪽에 더하는 것을 잊는다 — 표로 둬야
   * 두 목록을 나란히 놓고 볼 수 있다.
   *
   * - `'value'`: 값 자체가 비밀이 아니므로 before/after 를 그대로 남긴다.
   * - `'changed'`: 자유 텍스트라 원문을 감사 로그에 남기지 않는다. 바뀌었다는 사실만 남긴다.
   *
   * `model`·`effort`·`displayName` 은 빠져 있다 — 권한이나 도달 범위를 바꾸지 않는다.
   * 나머지가 왜 권한 값인가:
   * - `mentionPermission`: `readonly` vs `auto`(bypassPermissions). 무인 에이전트가 파일을
   *   쓰고 명령을 실행할 수 있는지를 가른다(agent/turn.ts 의 `preset.permission[...]`).
   * - `workingDir`: 그 권한이 **어느 코드베이스**에 적용되는지를 가른다. `auto` 와 겹치면
   *   대상을 바꾸는 것만으로 다른 저장소를 쓰게 만들 수 있다(agent/mentionTurn.ts 의
   *   `resolveWorkspaceDir` 주석이 같은 위험을 설명한다).
   * - `ownerAccountId`: 누가 이 에이전트의 진행 중 턴에 터미널로 attach 할 수 있는지의 게이트.
   * - `harness`: 어느 CLI 바이너리가 실제로 실행되는지.
   * - `instructions`: 에이전트가 무엇을 하도록 지시받는지. 원문은 남기지 않는다.
   */
  const AUDITED_FIELDS = {
    mentionPermission: 'value', workingDir: 'value', ownerAccountId: 'value',
    harness: 'value', instructions: 'changed',
  } as const;

  type AuditedField = keyof typeof AUDITED_FIELDS;
  type AgentSnapshot = Awaited<ReturnType<typeof getAgent>>;

  /**
   * `before` 가 null 이어도(=수정 직전에 사라진 경합) 감사 기록을 통째로 건너뛰지 않는다 —
   * 기록이 없는 것보다 before 를 모른 채 남기는 편이 낫다.
   */
  function diffAudited(before: AgentSnapshot, after: NonNullable<AgentSnapshot>) {
    const changes: Record<string, { before?: unknown; after?: unknown; changed?: true }> = {};
    for (const key of Object.keys(AUDITED_FIELDS) as AuditedField[]) {
      const prev = before ? before[key] : undefined;
      const next = after[key];
      if (before && prev === next) continue;
      changes[key] = AUDITED_FIELDS[key] === 'changed'
        ? { changed: true }
        : { before: prev, after: next };
    }
    return changes;
  }

  /**
   * 에이전트 목록. #299 에서 `requireAdmin` 에서 `requireAccount` 로 바꾸고,
   * admin 은 전부, 비admin 은 자기 것만 필터한다. 필터는 SQL 에서 바로 적용한다(가져와서
   * 걸러내면 남의 설정이 응답에 실렸다가 지워지는 모양이 된다).
   * 소유한 것이 없으면 빈 배열이고 403 이 아니다 — "권한이 없다"가 아니라 "내 것이 없다"다.
   */
  app.get('/accounts/agents', { preHandler: app.requireAccount }, async (req) => {
    const account = req.account!;
    const ownerId = account.isAdmin ? null : account.id;
    const agents = await listAgents(pool, ownerId);
    // 거절 사유는 서버 메모리의 사실이다(허브) — DB 의 뷰에 붙여 준다. 허브가 없으면 필드도 없다.
    const hub = routeDeps.operatorHub;
    return { agents: hub ? agents.map((a) => ({ ...a, runnerRefusal: hub.refusalOf(a.id) })) : agents };
  });

  app.post('/accounts/agents', { preHandler: app.requireCap('agent.create') }, async (req, reply) => {
    const body = z.object({
      handle: z.string().regex(/^[a-z0-9_-]{2,32}$/),
      displayName: z.string().min(1).max(64),
      ...configFields,
    }).parse(req.body);
    const scopeError = validateScopeChange(null, {
      invokeScope: body.invokeScope ?? 'community', credentialScope: body.credentialScope ?? 'none',
    });
    if (scopeError) return reply.code(400).send({ error: scopeError });
    try {
      const created = await createAgentAccount(pool, body, req.account!.id);
      await recordAudit(pool, {
        action: 'agent.created', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: created.id, detail: { handle: body.handle },
      }, req);
      return reply.code(201).send(created);
    } catch (err) {
      if ((err as { code?: string }).code === 'handle_taken') {
        return reply.code(400).send({
          error: { code: 'handle_taken', message: 'a group with this handle already exists' },
        });
      }
      throw err;
    }
  });

  /**
   * 가드가 `requireOwnerOrAdmin` preHandler 가 **아닌** 이유: 이 라우트는 필드별로 게이트가
   * 갈린다(#253). preHandler 는 본문을 보기 전에 통째로 판정하므로 여기서는 쓸 수 없다.
   * 대신 `requireAccount` 로 인증만 preHandler 에서 세우고 — 이걸 빼면 익명 요청이 소유자
   * 판정까지 흘러들어 존재 여부(404)를 흘리거나 `req.account!` 에서 터진다 — 인가는
   * `checkOwnerOrAdmin`(auth/plugin.ts 의 그 하나뿐인 술어)을 직접 부른다.
   *
   * 순서가 중요하다: **admin 전용 필드 검사가 소유자 조회보다 앞이다.** 소유자가 admin 전용
   * 필드를 섞어 보내면 403 이고 **아무것도 바꾸지 않는다**(부분 적용 금지). 일부만 적용하면
   * 사람은 전부 됐다고 믿는다 — 그리고 안 된 쪽이 하필 권한 필드다.
   */
  /**
   * `invokeScope === 'list'` 의 명단(스펙 2026-09-20 §6). 소유자·admin 이 관리한다 — 누가 내
   * 에이전트를 부를 수 있는지는 그 에이전트를 가진 사람이 정한다. 명단은 스코프가 list 가 아니어도
   * 남는다(판정에만 안 쓰인다) — 스코프를 잠깐 바꿨다 되돌릴 때 명단을 다시 짜지 않게.
   */
  const invokerParams = z.object({ id: z.string().uuid(), accountId: z.string().uuid() });
  for (const [method, present] of [['PUT', true], ['DELETE', false]] as const) {
    app.route<{ Params: { id: string; accountId: string } }>({
      method, url: '/accounts/agents/:id/invokers/:accountId',
      preHandler: app.requireOwnerOrAdmin('id'),
      handler: async (req, reply) => {
        const { id, accountId } = invokerParams.parse(req.params);
        const target = await pool.query(`select 1 from account where id = $1`, [accountId]);
        if (!target.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
        const view = await setInvoker(pool, id, accountId, present);
        if (!view) return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
        await recordAudit(pool, {
          action: present ? 'agent.invoker.added' : 'agent.invoker.removed', ...actorOf(req), target: id, detail: { accountId },
        }, req);
        return view;
      },
    });
  }

  app.patch('/accounts/agents/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.object({
      /**
       * 에이전트의 이름을 바꾼다(#843). 사람 계정과 같은 문법·같은 유니크 규칙이다.
       *
       * 오래 400 `agent_handle_immutable` 로 막아 두었던 자리다. 막았던 이유는 러너의 상태
       * 디렉터리가 `<handle>-<id>` 라서 이름이 바뀌면 러너가 다음 기동에 남의 이름으로 빈
       * 디렉터리를 새로 파고 세션·워크스페이스를 통째로 잃기 때문이었다. 그 근거는
       * `agent/stateDir.ts` 에서 없앴다 — 디렉터리를 **id 로 찾아 쓰기** 때문에 이름이
       * 바뀌어도 같은 자리로 돌아온다. handle 은 거기서도 사람이 알아보라고 붙인 꼬리표다.
       */
      handle: z.string().regex(/^[a-z0-9_-]{2,32}$/).optional(),
      displayName: z.string().min(1).max(64).optional(),
      disabled: z.boolean().optional(),
      ...configFields,
      // MCP 이름 목록(스펙 2026-09-20 §6). 레지스트리의 부분집합이어야 하고, personal 이름은
      // credentialScope=personal 을 요구한다 — `validateMcpServers`.
      mcpServers: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(32).optional(),
    }).parse(req.body);

    const account = req.account!;
    if (!account.isAdmin) {
      // `Object.keys` 를 보는 이유: zod 는 보내지 않은 키를 만들지 않으므로 키의 **존재**가
      // "이 필드를 건드리려 한다"와 같다. 값으로 판정하면 `disabled: false` 나
      // `ownerAccountId: null` 처럼 "지우기"를 뜻하는 요청이 게이트를 빠져나간다.
      const hasAdminOnlyField = Object.keys(patch)
        .some((f) => (ADMIN_ONLY_FIELDS as readonly string[]).includes(f));
      if (hasAdminOnlyField) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'admin required for this field' } });
      }
      const verdict = await checkOwnerOrAdmin(pool, account, id);
      if (!verdict.ok) {
        return reply.code(verdict.status).send({ error: { code: verdict.code, message: verdict.message } });
      }
    }

    const before = await getAgent(pool, id);
    // 존재 확인을 **먼저** 한다. 없는 에이전트에 대해 비활성화를 처리하면 update 는 0 행이라
    // 무해하지만 감사 로그에는 "비활성화했다"가 남는다 — 응답은 404 인데 기록은 남는 모양이다.
    // (같은 이유로 설정 변경 감사도 404 에서는 남기지 않는다.)
    if (!before) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    /**
     * 이름은 워크스페이스 **전역 이름공간**이다 — 사람·에이전트·집합이 한 자리를 나눠 쓴다.
     * 그래서 계정과 집합 양쪽을 본다. 한쪽만 보면 `@foo` 가 에이전트인지 팀인지 갈린다
     * (`createAgentAccount` 가 생성 때 막는 것과 같은 규칙).
     *
     * 값이 실제로 바뀔 때만 본다 — 자기 이름을 그대로 다시 저장한 PATCH 가 자기 자신과
     * 부딪혀 409 로 죽으면, 이름 말고 다른 것을 고치러 온 사람이 아무것도 저장하지 못한다.
     */
    const renamedTo = patch.handle !== undefined && patch.handle !== before.handle ? patch.handle : null;
    if (renamedTo) {
      const taken = await pool.query(
        `select id from account where lower(handle) = lower($1) and id != $2`,
        [renamedTo, id],
      );
      if (taken.rowCount && taken.rowCount > 0) {
        return reply.code(409).send({ error: { code: 'handle_taken', message: 'this handle is already taken' } });
      }
      if (await getHandleGroupByHandle(pool, renamedTo)) {
        return reply.code(409).send({ error: { code: 'handle_taken', message: 'a group with this handle already exists' } });
      }
      /**
       * 표시 이름이 옛 이름 **그대로**였다면 함께 따라간다. 에이전트는 만들 때
       * `displayName = handle` 로 생기므로(desktop `submit`), 둘이 같다는 것은 "아무도
       * 손대지 않았다"는 뜻이다. 그대로 두면 설정 카드가 굵게 옛 이름, 아래 옅게 새
       * `@이름` 을 그려 이름을 바꾼 사람이 자기 조작이 반만 먹었다고 읽는다.
       *
       * 직접 지은 표시 이름은 건드리지 않는다 — 그것은 이름 변경이 아니라 **덮어쓰기**다.
       * 명시적으로 함께 보낸 `displayName` 도 그대로 이긴다.
       */
      if (patch.displayName === undefined && before.displayName === before.handle) {
        patch.displayName = renamedTo;
      }
    }
    if (patch.invokeScope !== undefined || patch.credentialScope !== undefined) {
      const scopeError = validateScopeChange(before, {
        invokeScope: patch.invokeScope ?? before.invokeScope,
        credentialScope: patch.credentialScope ?? before.credentialScope,
      });
      if (scopeError) return reply.code(400).send({ error: scopeError });
    }
    // MCP 목록은 스코프가 바뀌는 PATCH 와 같이 와도, 스코프만 바뀌어도 다시 본다 — personal 이름을
    // 단 채로 credentialScope 를 넓히는 길을 막는다.
    if (patch.mcpServers !== undefined || patch.credentialScope !== undefined) {
      const mcpError = await validateMcpServers(
        pool, patch.mcpServers ?? before.mcpServers, patch.credentialScope ?? before.credentialScope);
      if (mcpError) return reply.code(400).send({ error: mcpError });
    }
    if (patch.mcpServers !== undefined) await setAgentMcpServers(pool, id, patch.mcpServers);

    let revokedLabels: string[] = [];
    if (patch.disabled !== undefined && patch.disabled !== before.disabled) {
      // 값이 실제로 바뀔 때만 처리한다 — 같은 값으로 다시 저장한 요청까지 기록하면 감사
      // 로그가 "언제 껐나"를 답하지 못하는 잡음이 되고, 이미 꺼진 계정의 disabled_at 이
      // 매번 now() 로 밀려 처음 껐던 시각을 잃는다.
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (patch.disabled) {
          await client.query(`update account set disabled_at = now() where id = $1`, [id]);
          // 러너가 멈추는 것은 PAT 가 죽어서다 — 401 을 받으면 policy.ts::isCredentialFailure
          // 가 자격증명 실패로 판정해 러너를 세우고 운영자 안내를 낸다. PAT 를 안 죽이면
          // 비활성화한 에이전트가 계속 폴링하며 답한다.
          revokedLabels = await revokeAllPats(client, id);
        } else {
          // 되돌리는 것은 disabled_at 하나다. **PAT 는 되살리지 않는다** — 해시만 저장하므로
          // 되살릴 방법이 없다. 운영자가 새로 발급해야 한다. 이 비대칭은 의도적이다.
          await client.query(`update account set disabled_at = null where id = $1`, [id]);
        }
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
      // 감사 기록은 커밋 뒤에 남긴다 — 롤백된 일을 기록하면 감사 추적이 거짓을 말한다.
      await recordAudit(pool, patch.disabled
        ? {
          action: 'agent.disabled', actorId: req.account!.id, actorHandle: req.account!.handle,
          target: id, detail: { revokedPats: revokedLabels },
        }
        : {
          action: 'agent.enabled', actorId: req.account!.id, actorHandle: req.account!.handle,
          target: id, detail: { patsNotRestored: true },
        }, req);
    }

    const updated = await updateAgent(pool, id, patch);
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    // 실제로 값이 바뀐 것만 남긴다 — 같은 값으로 다시 저장한 PATCH 까지 기록하면 감사 로그가
    // "무엇이 바뀌었나"를 답하지 못하는 잡음이 된다.
    const changes = diffAudited(before, updated);
    if (Object.keys(changes).length > 0) {
      await recordAudit(pool, {
        action: 'agent.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: changes,
      }, req);
    }
    /**
     * 이름 변경은 `agent.updated` 에 묻지 않고 사람 계정과 **같은 감사 항목**으로 남긴다 —
     * "언제 누가 이 이름이 되었나"는 계정 종류와 무관하게 한 줄로 찾을 수 있어야 한다.
     *
     * WS 이벤트도 사람 쪽과 같은 것을 쓴다. 이미 열려 있는 화면들이 `applyHandle` 로
     * 스토어의 이름을 갈아끼우므로, 사이드바·멘션 자동완성·지난 메시지의 이름표가
     * 새로고침 없이 따라온다.
     */
    if (renamedTo) {
      await recordAudit(pool, {
        action: 'account.handle.changed', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { from: before.handle, to: renamedTo },
      }, req);
      emitEvent({ type: 'account.handle_changed', accountId: id, newHandle: renamedTo });
    }
    return updated;
  });

  /**
   * 러너에게 **종료를 요청한다**(#129). 재시작 버튼이 아니다.
   *
   * harkroom 는 러너를 띄우지 않는다(docs/design.md §1 외부 접속형, §6 스코프 제외) — 그
   * 머신에도, harness 로그인 세션에도, 파일시스템에도 닿지 못한다. 여기서 하는 일은
   * 정의에 시각을 하나 남기는 것뿐이고, 러너가 다음에 자기 정의를 읽을 때 그것을 보고
   * **지금 턴을 끝낸 뒤** 스스로 물러난다. 다시 띄우는 것은 사람(또는 그 사람의
   * launchd/systemd 감독)의 몫이다.
   *
   * 가드가 `requireAdmin` 인 이유: 이 파일의 에이전트 관리 라우트가 전부 그렇고, 남의
   * 러너를 세우는 것은 그중에서도 도달 범위가 큰 조작이다.
   */
  app.post('/accounts/agents/:id/stop', { preHandler: app.requireCap('agent.manage', { kind: 'agent', param: 'id' }) }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const updated = await requestAgentStop(pool, id, req.account!.id);
    // 존재 확인은 서비스가 한다 — 없는 에이전트에 감사만 남는 모양(위 PATCH 주석)을 피한다.
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    await recordAudit(pool, {
      // 지시문도 대화 본문도 넣지 않는다 — 감사에 본문을 복사하면 삭제가 삭제가 아니다.
      // 누가·언제·누구를 멈추라고 했는지만 남긴다.
      action: 'agent.stop.requested', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: updated.handle },
    }, req);
    return updated;
  });

  /**
   * 그 종료 요청을 **되돌린다**(#427). 위 `POST .../stop` 의 대칭이다.
   *
   * ## 왜 필요한가
   *
   * 한 번 누른 요청을 되돌리는 길이 UI 에도 API 에도 없어서, 그 에이전트는 앱 자동 기동
   * 대상에서 **영구히** 빠졌다(`runnerLauncher.startAll` 의 `!a.stopRequestedAt` 필터).
   * 사람이 DB 를 손으로 고쳐야 풀렸고, 그 우회는 감사에 아무것도 남기지 않는다.
   *
   * ## 되살리는 것이 아니라 **의도를 지우는 것**이다
   *
   * 이 라우트도 러너를 띄우지 않는다 — 그 점에서 `019` 주석의 원칙은 그대로다. 하는 일은
   * 정의에서 시각 둘을 지우는 것뿐이고, 그러면 **다음 기동 때 daemon 이 그 에이전트를 다시
   * 고른다**(`#431` 2단계에서 운영자가 daemon 이 됐다). 지금 도는 앱을 즉시 움직이지는
   * 않는다 — 이름을 'start' 나 'restart' 로 짓지 않은 이유가 그것이다(§4).
   *
   * ## 가드가 `requireAdmin` 인 이유 — **되돌리기는 요청보다 느슨하면 안 된다**
   *
   * 위 요청과 **같은 관문**이다. 되돌리기를 소유자에게까지 열면, 관리자가 세운 러너를
   * 소유자가 되살릴 수 있게 되어 종료 요청이 남에게 강제할 수 없는 부탁으로 바뀐다.
   * 어느 쪽이 더 위험한 조작인지를 따질 자리가 아니라 **한 쌍이 같은 문을 써야 하는**
   * 자리다 — 문이 갈리면 그 쌍은 더 이상 대칭이 아니다.
   */
  app.post('/accounts/agents/:id/stop/undo', { preHandler: app.requireCap('agent.manage', { kind: 'agent', param: 'id' }) }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // 되돌린 뒤에는 정의에서 사라지므로 **먼저** 읽는다 — 감사에 "무엇을 되돌렸나"를
    // 남길 수 있는 마지막 순간이다.
    const before = await getAgent(pool, id);
    const updated = await undoAgentStopRequest(pool, id, req.account!.id);
    // 존재 확인은 서비스가 한다(위 요청 라우트와 같은 이유).
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    // **요청이 없었으면 감사에 남기지 않는다.** 되돌릴 것이 없었으므로 아무 일도 일어나지
    // 않았고(서비스의 조건절이 행을 건드리지도 않는다), 그런 호출까지 쌓으면 감사가
    // "이 러너를 누가 다시 돌게 했나"를 답하지 못하는 잡음이 된다 — PATCH 가 값이 실제로
    // 바뀐 것만 남기는 것과 같은 규칙이다. 응답은 그래도 200 이다: 부르는 쪽이 원한 상태가
    // 이미 성립해 있는 것이라 실패가 아니다(`undoAgentStopRequest` 주석).
    if (before?.stopRequestedAt) {
      await recordAudit(pool, {
        // 요청 기록과 같은 규칙 — 지시문도 대화 본문도 넣지 않는다. 되돌린 대상 요청
        // 시각만 함께 남긴다: 그 값은 이 조작으로 정의에서 사라졌다.
        action: 'agent.stop.undone', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { handle: updated.handle, stopRequestedAt: before.stopRequestedAt },
      }, req);
    }
    return updated;
  });

  /**
   * 에이전트를 **삭제한다**(#836). 만들기·고치기는 있는데 내리는 길이 없어서, 잘못 만든
   * 에이전트가 목록에 영원히 남거나 운영자가 DB 를 손으로 고쳐야 했다(#427 이 종료 요청에서
   * 닫은 것과 같은 모양의 구멍이다 — 그 우회는 감사에 아무것도 남기지 않는다).
   *
   * **비활성화와 다른 것**: 비활성화는 "꺼 뒀다"이고 다시 켤 수 있다. 삭제는 "명부에 없다"
   * 이고 되돌리지 않는다. 화면이 둘을 나란히 두는 이유도, 서버가 컬럼을 따로 두는 이유도
   * 그것이다(061).
   *
   * 메시지는 남는다 — `deleteAgentAccount` 주석. 그래서 이 라우트는 이력을 지우는 수단이
   * 아니고, 응답도 지운 개수 같은 것을 주지 않는다.
   *
   * 가드는 종료 요청과 **같은 문**(`agent.manage`)이다. 삭제가 더 센 조작이니 더 좁혀야
   * 한다고 생각하기 쉽지만, 이 문을 지나는 사람은 이미 PAT 를 전부 폐기하고 러너를 세울 수
   * 있다 — 문을 하나 더 만들면 권한이 아니라 헷갈림만 는다.
   */
  app.delete('/accounts/agents/:id', { preHandler: app.requireCap('agent.manage', { kind: 'agent', param: 'id' }) }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const removed = await deleteAgentAccount(pool, id);
    // 존재 확인은 서비스가 한다 — 없는(또는 이미 지운) 에이전트에 감사만 남는 모양을 피한다
    // (위 PATCH 주석과 같은 규칙).
    if (!removed) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    await recordAudit(pool, {
      // 지시문도 기억 본문도 넣지 않는다 — 감사에 본문을 복사하면 삭제가 삭제가 아니다
      // (종료 요청 기록과 같은 규칙). 누가·언제·누구를, 그리고 함께 죽은 PAT 만 남긴다.
      action: 'agent.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: removed.handle, revokedPats: removed.revokedPats },
    }, req);
    return reply.code(204).send();
  });

  // 러너가 자기 정의를 읽는 자리. 이것이 없으면 UI 수정이 도는 러너에 도달하지 않는다.
  app.get('/agent/config', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent') {
      return reply.code(403).send({ error: { code: 'agent_only', message: 'agents only' } });
    }
    const self = await getAgent(pool, req.account!.id);
    if (!self) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    // #129: 종료 요청은 이 응답을 타고 러너에게 간다(새 채널을 만들지 않는다 — 러너는
    // 이미 매 턴 여기를 읽는다). 읽어 간 사실을 지금 남긴다: 러너가 종료하면 그 다음
    // 요청 자체가 오지 않으므로, 서버가 관측할 수 있는 마지막 사실이 이 수령이다.
    // 응답에도 그 값을 실어 준다 — 러너와 화면이 같은 뷰를 봐야 한다.
    //
    // #427: 되돌린 뒤에는 이 분기가 **거짓**이다 — 되돌리기가 두 시각을 함께 지우므로
    // `stopRequestedAt` 이 null 이고, 따라서 수령도 찍히지 않는다. 이것이 맞는 동작이다:
    // 되돌린 뒤에 수령이 찍히면 요청 없이 수령만 있는 행이 되어 화면이 어느 상태에도
    // 속하지 않는 값을 받는다. `ackAgentStop` 의 `stop_requested_at is not null` 조건이
    // 같은 것을 한 겹 더 막는다 — 이 분기와 그 조건이 되돌리기를 사이에 둔 경합(러너가
    // 요청을 읽는 순간 사람이 되돌리는 경우)에서도 서로를 지킨다.
    if (self.stopRequestedAt && !self.stopAckedAt) {
      const ackedAt = await ackAgentStop(pool, req.account!.id);
      if (ackedAt) {
        self.stopAckedAt = ackedAt;
        // #126: 요청을 받았다/처리했다는 사실은 로그에도 남긴다.
        req.log.info({ agentId: req.account!.id, handle: req.account!.handle },
          'runner picked up stop request');
      }
    }
    return self;
  });

  /**
   * 러너가 **턴을 마쳤다**고 보고하는 자리(#176). 러너 자신의 PAT 로 부르고, **자기 행만**
   * 갱신한다 — 대상 id 를 받지 않는 이유가 그것이다. 받으면 러너 하나가 남의 활동 시각을
   * 쓸 수 있게 되고, 그 값은 더 이상 그 에이전트가 움직였다는 증거가 아니다.
   *
   * **본문이 없다.** 시각은 서버가 `now()` 로 찍는다: 러너 시계가 서버보다 앞선 머신에서
   * 러너가 보낸 값을 그대로 저장하면 "3분 뒤에 활동함"이 화면에 뜨고, 그건 활동 시각이
   * 아니라 시계 오차다(마이그레이션 020 주석).
   *
   * 사람 계정을 400 으로 거절한다. `GET /agent/config` 는 같은 자리에서 403 을 쓰는데,
   * 거기는 '남의 정의를 읽으려는 시도'라 권한 문제인 반면 여기는 사람 계정에 **뜻이 없는
   * 요청**이다 — `PUT /accounts/me/status` 가 에이전트를 400 `invalid_account` 로 돌려보내는
   * 것과 같은 결이다. 거절했으면 아무것도 쓰지 않는다.
   *
   * 감사 기록을 남기지 않는다: 이것은 매 턴 일어나는 일이라, 감사에 쌓으면 감사 로그가
   * 사람이 읽을 수 없는 잡음이 된다(감사는 권한·도달 범위를 바꾼 조작을 남기는 자리다).
   */
  app.post('/agent/activity', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent') {
      return reply.code(400).send({ error: { code: 'invalid_account', message: 'activity is only for agent accounts' } });
    }
    const lastTurnAt = await recordAgentTurn(pool, req.account!.id);
    return { lastTurnAt };
  });

  /**
   * 그 계정의 PAT 라벨 목록. **토큰도 토큰 해시도 절대 주지 않는다** — 해시만 저장하므로
   * 잃어버린 토큰은 설계상 복구 불가능하고, 그 사실이 이 화면의 존재 이유다(#93).
   *
   * 폐기된 것도 함께 준다: 운영자가 "이 라벨이 살아 있나"를 봐야 재발급을 판단할 수 있고,
   * 폐기 시각 자체가 감사에 쓸모 있는 사실이다. 라벨은 살아 있는 토큰 안에서 유일하다
   * (마이그레이션 010) — `DELETE .../pats/:label` 이 라벨로 폐기하기 때문이다.
   */
  /**
   * 에이전트 메모리 조회·삭제(#139 3단계). **사람이 쓰는 경로다.**
   *
   * MCP 로는 안 된다 — `registerMcp` 가 `kind !== 'agent'` 를 걸러 사람 계정은 MCP 에
   * 붙지 못한다. 그래서 REST 가 필요하다.
   *
   * 가드가 `requireAdmin` 에서 `requireOwnerOrAdmin` 으로 **바뀌었다**(#253). 원래 여기
   * 적혀 있던 근거는 "아무 사람이나 남의 에이전트 기억을 읽고 지울 수 있으면
   * `ownerAccountId` 가 attach 를 게이트하는 것과 어긋난다"였다. 그 문장은 지금도 맞지만
   * 결론이 뒤집혔다 — 어긋나는 것은 **소유자에게 열어 주는 것**이 아니라 소유자에게도
   * 닫아 두는 것이다. `ownerAccountId` 가 attach 를 게이트한다는 사실은 곧 소유자가 이미
   * 그 에이전트의 진행 중 턴에 붙을 수 있다는 뜻이고, 거기서 보이는 것이 메모리보다 넓다.
   *
   * 민감도 순서도 같은 방향이다: #253 이 소유자에게 PAT(그 에이전트로서 발화하고 채널을
   * 읽는 가장 센 자격증명)를 열었으므로, 그보다 약한 메모리를 닫아 두면 순서가 뒤집힌다.
   * "아무 사람이나"는 여전히 막힌다 — 소유자와 admin 뿐이고, 소유자가 없는
   * 에이전트(`null`)는 admin 만이다.
   *
   * 질의는 `services/memory.ts` 를 그대로 부른다 — 여기서 다시 쓰면 계정 스코프가 두
   * 곳에 생기고 한쪽만 고치는 사고가 난다.
   */
  app.get('/accounts/agents/:id/memory', { preHandler: app.requireOwnerOrAdmin('id') }, async (req) => ({
    memories: await listMemoryEntries(pool, z.object({ id: z.string().uuid() }).parse(req.params).id),
  }));

  app.delete('/accounts/agents/:id/memory/:slug', { preHandler: app.requireOwnerOrAdmin('id') }, async (req, reply) => {
    const { id, slug } = z.object({
      id: z.string().uuid(),
      slug: z.string().min(1).max(255),
    }).parse(req.params);
    await deleteMemory(pool, id, slug);
    await recordAudit(pool, {
      // 본문은 남기지 않는다 — docs/design.md 가 "감사에 본문을 복사하면 삭제가 삭제가
      // 아니다" 를 못박았다. slug 만 남긴다.
      action: 'agent.memory.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { slug },
    }, req);
    return reply.code(204).send();
  });

  app.get('/accounts/:id/pats', { preHandler: app.requireOwnerOrAdmin('id') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await pool.query(
      `select label, created_at, revoked_at from pat where account_id = $1 order by created_at desc`,
      [id],
    );
    return {
      pats: res.rows.map((r) => ({
        label: r.label,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      })),
    };
  });

  app.post('/accounts/:id/pats', { preHandler: app.requireOwnerOrAdmin('id') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ label: z.string().min(1).max(64) }).parse(req.body);
    // 발급 규칙은 services/pats.ts 한 곳이다 — 오퍼레이터 경로와 같은 규칙을 쓴다.
    const minted = await mintPat(pool, id, body.label, { actorId: req.account!.id, actorHandle: req.account!.handle }, req);
    if (!minted.ok) {
      return reply.code(409).send({
        error: { code: 'label_in_use', message: 'a live token already uses this label — revoke it first or pick another' },
      });
    }
    return reply.code(201).send({ token: minted.token });
  });

  // 라벨 단위 폐기다. pat.label 에 유일성이 없어 같은 라벨의 토큰이 여러 개면 전부 폐기된다 —
  // 폐기에서는 하나 남기는 것보다 하나 더 끊는 쪽이 안전하다.
  app.delete('/accounts/:id/pats/:label', { preHandler: app.requireOwnerOrAdmin('id') }, async (req) => {
    const { id, label } = z.object({ id: z.string().uuid(), label: z.string().min(1).max(64) }).parse(req.params);
    const res = await pool.query(
      `update pat set revoked_at = now() where account_id = $1 and label = $2 and revoked_at is null`,
      [id, label],
    );
    const revoked = res.rowCount ?? 0;
    await recordAudit(pool, {
      action: 'pat.revoked', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { label, revoked },
    }, req);
    return { revoked };
  });

  app.put('/accounts/:id/keys', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!req.account!.isAdmin && req.account!.id !== id) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not your account' } });
    }
    const body = z.object({
      keyId: z.string().min(1).max(128),
      publicKeyPem: z.string().includes('BEGIN PUBLIC KEY'),
    }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(
        `insert into account_key (key_id, account_id, public_key_pem) values ($1, $2, $3)
         on conflict (key_id) do update set public_key_pem = excluded.public_key_pem
         where account_key.account_id = excluded.account_id`,
        [body.keyId, id, body.publicKeyPem],
      );
      if (!result.rowCount) {
        await client.query('rollback');
        return reply.code(409).send({ error: { code: 'key_conflict', message: 'key already registered to another account' } });
      }
      await client.query('commit');
      return reply.code(204).send();
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  });
}
