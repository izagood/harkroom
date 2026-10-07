import type { Pool } from 'pg';
import { repoScope, toolScope, validateToolRule, type MessageRow, type ToolRuleRefusal, type ToolRuleWarning } from '@harkroom/shared';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from './channels.js';
import { deployRepoScopes } from './mergeDenials.js';
import { getMessageById, recordAskAnswer } from './messages.js';

/**
 * 에이전트 권한 요청 → 소유자 승인 → 적용(스레드 f61af808, jaebin D1~D4 10-07).
 *
 * 흐름: 에이전트가 `permission.request` MCP 로 권한 하나와 이유를 올린다(`openPermissionRequest`) → MCP 가 소유자 앞 ask 카드를
 * 세운다(선택지는 서버가 정한 [승인하고 다시 시도]·[거절] 둘, meta.permissionRequest 는 이 줄의 값만) → 소유자 **사람 세션**이
 * `POST /agents/:id/permission-requests/:rid/approve|deny` 를 누른다(`decidePermissionRequest`) → 승인이면 7일 grant 를 넣고,
 * 어느 쪽이든 소유자 이름으로 카드에 답을 적어 에이전트를 깨운다(소유자가 자기 에이전트 카드에 답함 = 사람이 띄운 턴, #1134 F4).
 *
 * **카드의 선택지를 일반 ask-answer 로는 못 누른다**(`recordAskAnswer` 의 permissionRequest 가드). 그렇지 않으면 소유자가 아닌
 * 사람이 [승인하고 다시 시도]를 눌러 grant 없이 "승인됐다"는 답만 에이전트에게 갈 수 있다.
 *
 * 적용은 다음 턴의 argv 다 — 러너가 턴마다 `GET /agent/tool-allows`·`/agent/merge-grants` 로 받아 `--allowedTools` 에 붙인다.
 * 떠 있는 claude 에 규칙을 넣는 길은 없고, 그래서 승인이 새 턴을 띄운다.
 */

/** 카드로 주는 grant 의 기한 — 7일 고정(D3). 30일·무기한은 설정 화면에서만. */
export const PERMISSION_GRANT_TTL_MS = 7 * 86_400_000;
/** 요청에 답할 수 있는 시한. 지나면 승인되지 않는다. */
export const PERMISSION_REQUEST_TTL_MS = 86_400_000;
/** 에이전트 하나가 하루에 올릴 수 있는 요청 수 — 카드 남발을 막는다. */
export const PERMISSION_REQUESTS_PER_DAY = 20;

export const PERMISSION_OPTION_APPROVE = 'approve';
export const PERMISSION_OPTION_DENY = 'deny';

export type PermissionKind = 'tool' | 'merge';

export interface PermissionRequestMeta {
  requestId: string;
  agentId: string;
  ownerAccountId: string | null;
  kind: PermissionKind;
  /** tool: 정규화한 규칙 / merge: `owner/name` */
  target: string;
  /** 규칙이 미치는 채널(D2). merge 는 저장소 단위라 null. */
  channelId: string | null;
  warnings: ToolRuleWarning[];
  deployRepo: boolean;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  /** 정해진 뒤에만. */
  status?: 'granted' | 'denied';
  decidedAt?: string;
  decidedBy?: string;
  grantExpiresAt?: string;
}

export type OpenRefusal =
  | { code: ToolRuleRefusal; message: string }
  | { code: 'bad_repo' | 'deploy_repo' | 'not_agent' | 'too_many'; message: string };

export type OpenResult =
  | { ok: false; refusal: OpenRefusal }
  | { ok: true; alreadyGranted: { expiresAt: string | null } }
  | { ok: true; existing: { requestId: string; cardMessageId: string | null } }
  | { ok: true; created: { requestId: string; meta: PermissionRequestMeta } };

const RULE_REFUSAL_MESSAGE: Record<ToolRuleRefusal, string> = {
  empty: 'rule is empty',
  too_long: 'rule is too long (300 characters max)',
  unsupported_tool: 'only Bash(<command prefix>:*), Bash(<exact command>) or one non-harkroom mcp__<server>__<tool> can be requested',
  wildcard: 'a wildcard is only allowed as the trailing :* of a Bash prefix',
  too_broad: 'rule is too broad — name the command with at least two fixed words before :*',
  shell_syntax: 'rule must be one command — no ; & | ` > < $( or newlines',
  dangerous_flag: '--dangerously-* flags are never granted',
  interpreter: 'a shell, interpreter or command runner as the first word would allow anything',
  operator_wrapper: 'the harkroom-operator wrapper is opened by the runner itself',
  merge_bypass: 'merging goes through the merge wrapper — request kind "merge" with the repository instead',
  bad_chars: 'rule may only use letters, digits, spaces and _ . / @ = : + % - — no quotes, backslashes, brackets or commas',
  gh_api_write: '`gh api` is granted only as one exact read call — no prefix rule, -X/--method, -f/-F/--input or graphql',
};

export async function openPermissionRequest(
  pool: Pool,
  args: {
    agentId: string; kind: PermissionKind; rule?: string; repo?: string; reason: string;
    channelId: string; threadRootId: string; now?: Date;
  },
): Promise<OpenResult> {
  const now = args.now ?? new Date();
  const agent = (await pool.query<{ ownerAccountId: string | null }>(
    `select c.owner_account_id as "ownerAccountId" from account a join agent_config c on c.account_id = a.id
      where a.id = $1 and a.kind = 'agent'`, [args.agentId])).rows[0];
  if (!agent) return { ok: false, refusal: { code: 'not_agent', message: 'only an agent can request a permission' } };

  let target: string;
  let grantCapability: 'tool.allow' | 'repo.merge';
  let grantScope: string;
  let warnings: ToolRuleWarning[] = [];
  let deployRepo = false;
  if (args.kind === 'tool') {
    const v = validateToolRule(args.rule ?? '');
    if (!v.ok) return { ok: false, refusal: { code: v.code, message: RULE_REFUSAL_MESSAGE[v.code] } };
    target = v.rule;
    warnings = v.warnings;
    grantCapability = 'tool.allow';
    grantScope = toolScope(args.channelId, v.rule);
  } else {
    const scope = repoScope(args.repo ?? '');
    if (!scope) return { ok: false, refusal: { code: 'bad_repo', message: 'repo must be one <owner>/<name>' } };
    // 배포 저장소(머지가 곧 배포)는 카드로 주지 않는다 — 설정 화면에서 정확한 이름으로만(merge_denial C6 와 같다).
    if (deployRepoScopes().has(scope)) {
      return { ok: false, refusal: { code: 'deploy_repo', message: 'a deploy repository is not granted from a card — ask the owner to grant it in settings' } };
    }
    target = scope;
    grantCapability = 'repo.merge';
    grantScope = scope;
  }

  const live = (await pool.query<{ expiresAt: string | null }>(
    `select expires_at as "expiresAt" from account_grant
      where account_id = $1 and capability = $2 and scope = $3 and (expires_at is null or expires_at > $4)`,
    [args.agentId, grantCapability, grantScope, now])).rows[0];
  if (live) return { ok: true, alreadyGranted: { expiresAt: live.expiresAt } };

  const pending = (await pool.query<{ id: string; cardMessageId: string | null }>(
    `select id, card_message_id as "cardMessageId" from permission_request
      where agent_id = $1 and kind = $2 and target = $3 and thread_root_id = $4 and channel_id = $5
        and status = 'pending' and expires_at > $6
      order by created_at desc limit 1`,
    [args.agentId, args.kind, target, args.threadRootId, args.channelId, now])).rows[0];
  if (pending) return { ok: true, existing: { requestId: pending.id, cardMessageId: pending.cardMessageId } };

  const count = (await pool.query<{ n: number }>(
    `select count(*)::int as n from permission_request where agent_id = $1 and created_at > $2`,
    [args.agentId, new Date(now.getTime() - 86_400_000)])).rows[0]!.n;
  if (count >= PERMISSION_REQUESTS_PER_DAY) {
    return { ok: false, refusal: { code: 'too_many', message: `at most ${PERMISSION_REQUESTS_PER_DAY} permission requests a day` } };
  }

  const expiresAt = new Date(now.getTime() + PERMISSION_REQUEST_TTL_MS);
  const id = (await pool.query<{ id: string }>(
    `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [args.agentId, args.kind, target, args.reason, warnings, args.channelId, args.threadRootId, now, expiresAt])).rows[0]!.id;
  await recordAudit(pool, {
    action: 'permission.requested', actorId: args.agentId, target: args.agentId,
    detail: { requestId: id, kind: args.kind, target, warnings, channelId: args.channelId, threadRootId: args.threadRootId },
  });
  return {
    ok: true,
    created: {
      requestId: id,
      meta: {
        requestId: id, agentId: args.agentId, ownerAccountId: agent.ownerAccountId, kind: args.kind,
        target: args.kind === 'merge' ? target.slice('repo:'.length) : target,
        channelId: args.kind === 'tool' ? args.channelId : null,
        warnings, deployRepo, reason: oneLineReason(args.reason), requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      },
    },
  };
}

/** 카드 본문(옛 앱이 meta 를 모를 때 읽는 글). 권한 칸은 서버 값뿐이고, 에이전트가 쓴 것은 이유 한 줄이다. */
export function permissionCardBody(meta: PermissionRequestMeta, agentHandle: string): string {
  // n1(jaebin 10-07): 규칙은 그 채널의 **모든** 턴(위임·예약 깨우기로 뜬 턴 포함)에 붙는다 — 카드가 그렇게 말해야 한다.
  const what = meta.kind === 'tool'
    ? `명령 허용 \`${meta.target}\` — 이 채널의 모든 대화에서`
    : `머지 권한 \`${meta.target}\``;
  const warn = meta.warnings.length ? `\n⚠ ${meta.warnings.join(', ')}` : '';
  return `권한 요청 · ${agentHandle}\n${what} · 승인하면 7일${warn}\n이유: ${oneLineReason(meta.reason)}`;
}

/**
 * 에이전트가 쓴 이유는 한 줄로 납작하게 하고 백틱·마크다운 머리를 지운다(security n2) — 줄바꿈과 백틱으로 위의 서버 줄
 * (「명령 허용 `…`」)을 흉내 내지 못하게. 서버 줄보다 아래, 맨 끝에 둔다.
 */
export function oneLineReason(reason: string): string {
  // bidi·서식 문자(U+202E 등, \p{Cf})도 지운다 — 옛 앱에서 이유 줄을 거꾸로 보이게 해 서버 줄처럼 꾸미지 못하게(security 후속).
  return reason.replace(/\p{Cf}/gu, '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[`*_#>|[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function permissionCardOptions(): { id: string; label: string }[] {
  return [
    { id: PERMISSION_OPTION_APPROVE, label: '승인하고 다시 시도' },
    { id: PERMISSION_OPTION_DENY, label: '거절' },
  ];
}

export async function linkPermissionCard(pool: Pool, requestId: string, cardMessageId: string): Promise<void> {
  await pool.query(`update permission_request set card_message_id = $2 where id = $1 and card_message_id is null`, [requestId, cardMessageId]);
}

export type DecideRefusal = { status: 403 | 404 | 409; code: string; message: string };

/**
 * 소유자가 카드에서 정한다. 사람 세션·소유자 판정은 라우트가 먼저 한다. 범위·기한은 이 줄과 상수뿐이다 — 요청 본문은 읽지 않는다.
 * 승인이면 grant 를 넣고, 어느 쪽이든 카드에 소유자 이름으로 답을 적어 에이전트를 깨운다(새 턴이 그 grant 를 달고 뜬다).
 */
export async function decidePermissionRequest(
  pool: Pool,
  args: { agentId: string; requestId: string; actorId: string; decision: 'approve' | 'deny'; now?: Date },
): Promise<({ ok: true; status: 'granted' | 'denied'; grantExpiresAt: string | null; cardMessageId: string | null }) | ({ ok: false } & DecideRefusal)> {
  const now = args.now ?? new Date();
  const client = await pool.connect();
  let row: { id: string; kind: PermissionKind; target: string; channelId: string; cardMessageId: string | null } | undefined;
  let grantExpiresAt: Date | null = null;
  try {
    await client.query('begin');
    const r = (await client.query<{
      id: string; agentId: string; kind: PermissionKind; target: string; channelId: string; status: string; expired: boolean; cardMessageId: string | null;
    }>(
      `select id, agent_id as "agentId", kind, target, channel_id as "channelId", status, expires_at <= $2 as expired,
              card_message_id as "cardMessageId"
         from permission_request where id = $1 for update`, [args.requestId, now])).rows[0];
    // `:id` 가 요청의 에이전트와 다르면 없는 것과 같다 — 남의 요청 id 를 내 에이전트 경로에 꽂는 길을 닫는다.
    if (!r || r.agentId !== args.agentId) { await client.query('rollback'); return { ok: false, status: 404, code: 'not_found', message: 'no such permission request for this agent' }; }
    if (r.status !== 'pending') { await client.query('rollback'); return { ok: false, status: 409, code: 'already_decided', message: `this request is already ${r.status}` }; }
    if (r.expired) { await client.query('rollback'); return { ok: false, status: 409, code: 'request_expired', message: 'this request expired — the agent has to ask again' }; }
    if (args.decision === 'approve' && r.kind === 'merge' && deployRepoScopes().has(r.target)) {
      await client.query('rollback');
      return { ok: false, status: 403, code: 'deploy_repo', message: 'a deploy repository is not granted from a card — grant it in settings' };
    }
    if (args.decision === 'approve') {
      grantExpiresAt = new Date(now.getTime() + PERMISSION_GRANT_TTL_MS);
      const capability = r.kind === 'tool' ? 'tool.allow' : 'repo.merge';
      const scope = r.kind === 'tool' ? toolScope(r.channelId, r.target) : r.target;
      // 있던 grant(만료된 것 등)는 덮는다 — `allow_agent_cause` 는 끈다(카드는 좁히기만 한다).
      await client.query(
        `insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause)
         values ($1, $2, $3, $4, $5, false)
         on conflict (account_id, capability, scope) do update
           set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, allow_agent_cause = false`,
        [args.agentId, capability, scope, args.actorId, grantExpiresAt]);
    }
    const status = args.decision === 'approve' ? 'granted' : 'denied';
    await client.query(
      `update permission_request set status = $2, decided_at = $3, decided_by = $4, grant_expires_at = $5 where id = $1`,
      [r.id, status, now, args.actorId, grantExpiresAt]);
    if (r.cardMessageId) {
      await client.query(
        `update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb)
          where id = $1 and meta ? 'permissionRequest'`,
        [r.cardMessageId, JSON.stringify({
          status, decidedAt: now.toISOString(), decidedBy: args.actorId,
          ...(grantExpiresAt ? { grantExpiresAt: grantExpiresAt.toISOString() } : {}),
        })]);
    }
    await client.query('commit');
    row = r;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const status = args.decision === 'approve' ? 'granted' : 'denied';
  await recordAudit(pool, {
    action: args.decision === 'approve' ? 'permission.approved' : 'permission.denied', actorId: args.actorId, target: args.agentId,
    detail: { requestId: row.id, kind: row.kind, target: row.target, channelId: row.channelId, ...(grantExpiresAt ? { grantExpiresAt: grantExpiresAt.toISOString() } : {}) },
  });
  if (grantExpiresAt) {
    await recordAudit(pool, {
      action: 'grant.given', actorId: args.actorId, target: args.agentId,
      detail: {
        capability: row.kind === 'tool' ? 'tool.allow' : 'repo.merge',
        scope: row.kind === 'tool' ? toolScope(row.channelId, row.target) : row.target,
        expiresAt: grantExpiresAt.toISOString(), allowAgentCause: false, via: 'permission_request', requestId: row.id,
      },
    });
    emitEvent({ type: 'grant.changed', accountId: args.agentId, audience: 'all' });
  }
  if (row.cardMessageId) {
    // 카드에 소유자 이름으로 답을 적는다 — 이것이 에이전트를 깨운다. 이미 누가 닫았으면(ask-close) 깨우지 못할 뿐 결정은 남는다.
    const answered = await recordAskAnswer(pool, {
      messageId: row.cardMessageId, actorId: args.actorId,
      optionId: args.decision === 'approve' ? PERMISSION_OPTION_APPROVE : PERMISSION_OPTION_DENY,
      viaPermissionDecision: true,
    });
    const card = typeof answered === 'object' ? answered : await getMessageById(pool, row.cardMessageId);
    if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
  }
  return { ok: true, status, grantExpiresAt: grantExpiresAt?.toISOString() ?? null, cardMessageId: row.cardMessageId };
}

/** 러너가 턴을 띄울 때 — 이 에이전트가 이 채널에서 받은 살아 있는 allow 규칙(D2). */
export async function toolAllowsFor(pool: Pool, agentId: string, channelId: string, now = new Date()): Promise<string[]> {
  const prefix = toolScope(channelId, '');
  const rows = (await pool.query<{ scope: string }>(
    `select scope from account_grant
      where account_id = $1 and capability = 'tool.allow' and left(scope, length($2)) = $2
        and (expires_at is null or expires_at > $3)
      order by scope`, [agentId, prefix, now])).rows;
  // 저장된 뒤 판정이 좁아졌을 수 있다 — 지금 판정으로 다시 걸러서 내보낸다(넓은 규칙이 옛 grant 로 살아남지 않게).
  return rows.map((r) => r.scope.slice(prefix.length)).filter((rule) => {
    const v = validateToolRule(rule);
    return v.ok && v.rule === rule;
  });
}

/**
 * 카드의 선택지를 **어느 클라이언트에서든**(모바일·웹·데스크톱) 누르는 길(10-07 jaebin: 데스크톱을 못 쓰는 동안에도 승인돼야 한다).
 * 일반 `ask-answer` 라우트가 권한 카드를 만나면 여기로 온다. 사람 세션 판정은 라우트가, 소유자 판정은 여기서 요청 줄의
 * 에이전트로 한다(카드 meta 가 아니라 서버 줄). 선택지 id 가 곧 결정이다 — approve/deny 말고는 없다.
 */
export async function decideFromCard(
  pool: Pool, args: { messageId: string; actorId: string; optionId: string },
): Promise<{ ok: true; card: MessageRow | null } | ({ ok: false } & DecideRefusal) | { ok: false; status: 400; code: 'unknown_option'; message: string }> {
  const r = (await pool.query<{ id: string; agentId: string; ownerAccountId: string | null }>(
    `select p.id, p.agent_id as "agentId", c.owner_account_id as "ownerAccountId"
       from permission_request p join agent_config c on c.account_id = p.agent_id
      where p.card_message_id = $1`, [args.messageId])).rows[0];
  if (!r) return { ok: false, status: 404, code: 'not_found', message: 'no permission request behind this card' };
  if (r.ownerAccountId !== args.actorId) return { ok: false, status: 403, code: 'forbidden', message: 'only the owner of this agent can decide its permission requests' };
  const decision = args.optionId === PERMISSION_OPTION_APPROVE ? 'approve' : args.optionId === PERMISSION_OPTION_DENY ? 'deny' : null;
  if (!decision) return { ok: false, status: 400, code: 'unknown_option', message: 'a permission card takes approve or deny' };
  const d = await decidePermissionRequest(pool, { agentId: r.agentId, requestId: r.id, actorId: args.actorId, decision });
  if (!d.ok) return d;
  return { ok: true, card: await getMessageById(pool, args.messageId) };
}

/**
 * 에이전트가 **자기** grant 를 내려놓는다(`permission.revoke`). 좁히기만 하므로 어느 턴에서나 된다 — 설정 화면이 없는 동안
 * 소유자가 채팅으로 "그 권한 거둬"라고 하면 에이전트가 이것으로 거둔다(모바일 거두기). 옛 넓은 규칙도 원문 그대로 지울 수 있다.
 */
export async function releaseGrant(
  pool: Pool, args: { agentId: string; kind: PermissionKind; rule?: string; repo?: string; channelId: string },
): Promise<{ ok: true; capability: string; scope: string } | { ok: false; code: 'bad_repo' | 'not_found'; message: string }> {
  let capability: 'tool.allow' | 'repo.merge';
  let scopes: string[];
  if (args.kind === 'tool') {
    const raw = (args.rule ?? '').trim();
    const v = validateToolRule(raw);
    capability = 'tool.allow';
    scopes = [...new Set([toolScope(args.channelId, raw), ...(v.ok ? [toolScope(args.channelId, v.rule)] : [])])];
  } else {
    const scope = repoScope(args.repo ?? '');
    if (!scope) return { ok: false, code: 'bad_repo', message: 'repo must be one <owner>/<name>' };
    capability = 'repo.merge';
    scopes = [scope];
  }
  const del = await pool.query<{ scope: string }>(
    `delete from account_grant where account_id = $1 and capability = $2 and scope = any($3::text[]) returning scope`,
    [args.agentId, capability, scopes]);
  const scope = del.rows[0]?.scope;
  if (!scope) return { ok: false, code: 'not_found', message: 'no such grant on this agent' };
  await recordAudit(pool, { action: 'grant.revoked', actorId: args.agentId, target: args.agentId, detail: { capability, scope, via: 'permission.revoke' } });
  emitEvent({ type: 'grant.changed', accountId: args.agentId, audience: 'all' });
  return { ok: true, capability, scope };
}
