import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { CommandFileDigest } from '@harkroom/shared/runnerLink';
import { repoGrantScope, repoScope, toolScope, validateExactCommand, validateToolRule, type CommandFileArg, type MessageRow, type ToolRuleRefusal, type ToolRuleWarning } from '@harkroom/shared';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from './channels.js';
import { CI_CARD_ONCE_ONLY_MESSAGE, checkNamesForBody, insertApprovalFromDenial, type MergeDenialReason } from './mergeDenials.js';
import { getMessageById, recordAskAnswer, syncAskMirrors, wakeAsker } from './messages.js';

/**
 * 에이전트 권한 요청 → 소유자 승인 → 적용(스레드 f61af808, jaebin D1~D4 10-07).
 *
 * 흐름: 에이전트가 `permission.request` MCP 로 권한 하나와 이유를 올린다(`openPermissionRequest`) → MCP 가 소유자 앞 ask 카드를
 * 세운다(선택지는 서버가 정한 [7일 허락하고 다시 시도]·[거절] 둘, meta.permissionRequest 는 이 줄의 값만) → 소유자 **사람 세션**이
 * `POST /agents/:id/permission-requests/:rid/approve|deny` 를 누른다(`decidePermissionRequest`) → 승인이면 7일 grant 를 넣고,
 * 어느 쪽이든 소유자 이름으로 카드에 답을 적어 에이전트를 깨운다(소유자가 자기 에이전트 카드에 답함 = 사람이 띄운 턴, #1134 F4).
 *
 * **카드의 선택지를 일반 ask-answer 로는 못 누른다**(`recordAskAnswer` 의 permissionRequest 가드). 그렇지 않으면 소유자가 아닌
 * 사람이 [7일 허락하고 다시 시도]를 눌러 grant 없이 "승인됐다"는 답만 에이전트에게 갈 수 있다.
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
/** kind=command 카드의 선택지(H②): 「이번 한 번」·「이 스레드 1시간」. 둘 다 이 스레드에만, 쓰지 않으면 1시간 뒤 사라진다. */
export const PERMISSION_OPTION_APPROVE_ONCE = 'approve_once';
export const PERMISSION_OPTION_APPROVE_HOUR = 'approve_hour';
/** 정확한 명령 grant 의 기한 — 1회짜리도 이 안에 써야 한다. */
export const COMMAND_GRANT_TTL_MS = 3_600_000;

export type PermissionDecision = 'approve' | 'approve_once' | 'approve_hour' | 'deny';

export type PermissionKind = 'tool' | 'merge' | 'command';

export interface PermissionRequestMeta {
  requestId: string;
  agentId: string;
  ownerAccountId: string | null;
  kind: PermissionKind;
  /** tool: 정규화한 규칙 / merge: `owner/name` / command: 정규화한 명령 그대로 */
  target: string;
  /** 규칙이 미치는 채널(D2). merge 는 저장소 단위라 null. */
  channelId: string | null;
  /** command 만: 그 스레드에서만 열린다. */
  threadRootId?: string;
  /** command 만: 내용이 요청 시점에 고정된 파일들. secret 자리는 preview 가 없다. */
  files?: { path: string; size: number; sha256: string; secret: boolean; preview?: string }[];
  warnings: ToolRuleWarning[];
  /**
   * 머지 거절에서 온 요청(스레드 1b75d7a0)이면 그 PR·head·사유 — 카드가 [이번 한 번 머지](이 PR·이 head 만)를 함께 보인다.
   * 값은 거절 기록에서 온다(에이전트가 쓴 글이 아니다).
   */
  once?: { number: number; headSha: string; reason: MergeDenialReason; failedChecks?: string[] };
  reason: string;
  requestedAt: string;
  expiresAt: string;
  /** 정해진 뒤에만. */
  status?: 'granted' | 'denied' | 'approved_once';
  /** 1회 승인으로 정해졌으면 그 계정·CI 완화·승인 기한. */
  approvedOnce?: { ghUser: string | null; relaxChecks: boolean; expiresAt: string };
  /** command 승인 갈래(once·hour). */
  grantMode?: 'once' | 'hour';
  decidedAt?: string;
  decidedBy?: string;
  grantExpiresAt?: string;
}

export type OpenRefusal =
  | { code: ToolRuleRefusal; message: string }
  | { code: 'bad_repo' | 'org_wide' | 'not_agent' | 'too_many' | 'files_unmeasured' | 'files_mismatch'; message: string };

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
  env_prefix: 'no NAME=value prefix — pass it as a flag (e.g. kubectl --kubeconfig <path>)',
  path_head: 'a script called by path is not granted as an exact command — run it yourself or ask for a tool rule',
  relative_path: 'file arguments (-f, --patch-file, --values, --kubeconfig, @file …) must be absolute, clean paths',
  glued_flag: 'write file flags apart from their value (-f /abs/path), not glued (-f/abs or -f=/abs)',
  needs_kubeconfig: 'kubectl/helm need both --kubeconfig <absolute path> and --context (helm: --kube-context)',
  unsupported_head: 'an exact command can only be kubectl or helm for now — run other tools yourself or ask for a tool rule',
  unsupported_subcommand: 'that kubectl/helm subcommand (or plugin) is not granted as an exact command',
  unsupported_flag: 'helm --post-renderer/--repo/--plugins are not granted as an exact command',
  chart_not_pinned: 'helm install/upgrade/template need `<release> oci://<chart>` right after the subcommand and --version',
};

/** 카드 meta 의 `once` 칸 — 1회 승인이 쓸 거절 기록의 PR·head·사유. CI 거절이면 실패한 체크 이름(서버가 거른 값)도 싣는다. */
function onceMeta(d: { number: number; headSha: string; reason: MergeDenialReason; failedChecks?: string[] }): { number: number; headSha: string; reason: MergeDenialReason; failedChecks?: string[] } {
  return { number: d.number, headSha: d.headSha, reason: d.reason, ...(d.reason === 'ci_not_green' ? { failedChecks: d.failedChecks ?? [] } : {}) };
}

export async function openPermissionRequest(
  pool: Pool,
  args: {
    agentId: string; kind: PermissionKind; rule?: string; repo?: string; command?: string; reason: string;
    /** kind=command: 오퍼레이터가 잰 파일 해시(헤더). null 이면 재지 않았다. */
    commandFiles?: CommandFileDigest[] | null;
    channelId: string; threadRootId: string; now?: Date;
    /** 머지 거절 기록에서 온 요청(`message.ask` 의 `mergeDenialId`). 거절 기록 검증(`prepareDenialCard`)은 부르는 쪽이 먼저 한다. */
    denial?: { id: string; number: number; headSha: string; reason: MergeDenialReason; failedChecks?: string[] };
  },
): Promise<OpenResult> {
  const now = args.now ?? new Date();
  const agent = (await pool.query<{ ownerAccountId: string | null }>(
    `select c.owner_account_id as "ownerAccountId" from account a join agent_config c on c.account_id = a.id
      where a.id = $1 and a.kind = 'agent'`, [args.agentId])).rows[0];
  if (!agent) return { ok: false, refusal: { code: 'not_agent', message: 'only an agent can request a permission' } };

  if (args.kind === 'command') return openCommandRequest(pool, { ...args, now, ownerAccountId: agent.ownerAccountId });

  let target: string;
  let grantCapability: 'tool.allow' | 'repo.merge';
  let grantScope: string;
  let warnings: ToolRuleWarning[] = [];
  if (args.kind === 'tool') {
    const v = validateToolRule(args.rule ?? '');
    if (!v.ok) return { ok: false, refusal: { code: v.code, message: RULE_REFUSAL_MESSAGE[v.code] } };
    target = v.rule;
    warnings = v.warnings;
    grantCapability = 'tool.allow';
    grantScope = toolScope(args.channelId, v.rule);
  } else {
    // 조직 전체(`owner/*`)는 카드로 청하지 못한다 — 승인 한 번에 그 조직이 통째로 열린다. 소유자가 설정 화면에서만 준다(jaebin 10-09).
    if (repoGrantScope(args.repo ?? '') && !repoScope(args.repo ?? '')) {
      return { ok: false, refusal: { code: 'org_wide', message: 'an organization-wide grant (owner/*) is not requested from a card — ask for the one repository, or ask the owner to grant owner/* in settings' } };
    }
    const scope = repoScope(args.repo ?? '');
    if (!scope) return { ok: false, refusal: { code: 'bad_repo', message: 'repo must be one <owner>/<name>' } };
    target = scope;
    grantCapability = 'repo.merge';
    grantScope = scope;
  }

  const live = (await pool.query<{ expiresAt: string | null }>(
    `select expires_at as "expiresAt" from account_grant
      where account_id = $1 and capability = $2 and scope = $3 and (expires_at is null or expires_at > $4)`,
    [args.agentId, grantCapability, grantScope, now])).rows[0];
  // 거절에서 온 머지 요청은 grant 가 있어도 카드를 세운다 — `cause_not_human`(grant 는 있는데 사람이 띄운 턴이 아님)이 그 경우고,
  // 그때 소유자가 할 수 있는 것은 [이번 한 번 머지]다.
  if (live && !args.denial) return { ok: true, alreadyGranted: { expiresAt: live.expiresAt } };

  const pending = (await pool.query<{ id: string; cardMessageId: string | null }>(
    `select id, card_message_id as "cardMessageId" from permission_request
      where agent_id = $1 and kind = $2 and target = $3 and thread_root_id = $4 and channel_id = $5
        and status = 'pending' and expires_at > $6
      order by created_at desc limit 1`,
    [args.agentId, args.kind, target, args.threadRootId, args.channelId, now])).rows[0];
  if (pending) {
    // 같은 스레드에서 다시 막혔다 — 카드는 그대로 두고 1회 승인이 쓸 거절 기록만 새 것으로 바꾼다(PR·head 가 바뀌었을 수 있다).
    if (args.denial) {
      await pool.query(`update permission_request set denial_id = $2 where id = $1`, [pending.id, args.denial.id]);
      if (pending.cardMessageId) {
        await pool.query(
          `update message set meta = jsonb_set(meta, '{permissionRequest,once}', $2::jsonb) where id = $1 and meta ? 'permissionRequest'`,
          [pending.cardMessageId, JSON.stringify(onceMeta(args.denial))]);
        // 열린 화면이 옛 PR·head 를 계속 보이지 않게 알린다(security F1). 승인 쪽은 그래도 대조값으로 한 번 더 막는다.
        const card = await getMessageById(pool, pending.cardMessageId);
        if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
      }
    }
    return { ok: true, existing: { requestId: pending.id, cardMessageId: pending.cardMessageId } };
  }

  const count = (await pool.query<{ n: number }>(
    `select count(*)::int as n from permission_request where agent_id = $1 and created_at > $2`,
    [args.agentId, new Date(now.getTime() - 86_400_000)])).rows[0]!.n;
  if (count >= PERMISSION_REQUESTS_PER_DAY) {
    return { ok: false, refusal: { code: 'too_many', message: `at most ${PERMISSION_REQUESTS_PER_DAY} permission requests a day` } };
  }

  const expiresAt = new Date(now.getTime() + PERMISSION_REQUEST_TTL_MS);
  const id = (await pool.query<{ id: string }>(
    `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, denial_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [args.agentId, args.kind, target, args.reason, warnings, args.channelId, args.threadRootId, now, expiresAt, args.denial?.id ?? null])).rows[0]!.id;
  await supersedeOlderRequests(pool, { newId: id, agentId: args.agentId, kind: args.kind, target, channelId: args.channelId, threadRootId: args.threadRootId, now });
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
        warnings, reason: oneLineReason(args.reason),
        ...(args.denial ? { once: onceMeta(args.denial) } : {}), requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      },
    },
  };
}

/**
 * kind=command(H②): 명령 하나 그대로. 범위는 이 스레드, 승인 갈래(once·hour)는 소유자가 카드에서 고른다.
 * 이미 같은 명령이 살아 있으면(쓰지 않은 1회짜리·기한 안의 1시간짜리) 새 카드를 세우지 않는다.
 */
async function openCommandRequest(
  pool: Pool,
  args: {
    agentId: string; command?: string; reason: string; channelId: string; threadRootId: string; now: Date; ownerAccountId: string | null;
    commandFiles?: CommandFileDigest[] | null;
  },
): Promise<OpenResult> {
  const v = validateExactCommand(args.command ?? '');
  if (!v.ok) return { ok: false, refusal: { code: v.code, message: RULE_REFUSAL_MESSAGE[v.code] } };
  // C1: 어느 파일을 묶을지는 서버가 명령에서 뽑는다. 오퍼레이터가 잰 경로 집합이 그것과 **정확히** 같아야 한다 — 하나라도 빠지거나
  // 더 있으면(옛 오퍼레이터·위장) 거절. 파일 없는 명령은 헤더가 없어도 된다.
  const files = matchFileDigests(v.files, args.commandFiles ?? null);
  if (!files.ok) return { ok: false, refusal: { code: files.code, message: files.message } };
  const live = (await pool.query<{ expiresAt: string }>(
    `select expires_at as "expiresAt" from command_grant
      where agent_id = $1 and channel_id = $2 and thread_root_id = $3 and command = $4 and expires_at > $5
        and (not single_use or used_at is null)
      order by expires_at desc limit 1`,
    [args.agentId, args.channelId, args.threadRootId, v.command, args.now])).rows[0];
  if (live) return { ok: true, alreadyGranted: { expiresAt: live.expiresAt } };

  const pending = (await pool.query<{ id: string; cardMessageId: string | null }>(
    `select id, card_message_id as "cardMessageId" from permission_request
      where agent_id = $1 and kind = 'command' and target = $2 and thread_root_id = $3 and channel_id = $4
        and status = 'pending' and expires_at > $5
      order by created_at desc limit 1`,
    [args.agentId, v.command, args.threadRootId, args.channelId, args.now])).rows[0];
  if (pending) return { ok: true, existing: { requestId: pending.id, cardMessageId: pending.cardMessageId } };

  const count = (await pool.query<{ n: number }>(
    `select count(*)::int as n from permission_request where agent_id = $1 and created_at > $2`,
    [args.agentId, new Date(args.now.getTime() - 86_400_000)])).rows[0]!.n;
  if (count >= PERMISSION_REQUESTS_PER_DAY) {
    return { ok: false, refusal: { code: 'too_many', message: `at most ${PERMISSION_REQUESTS_PER_DAY} permission requests a day` } };
  }
  const expiresAt = new Date(args.now.getTime() + PERMISSION_REQUEST_TTL_MS);
  const id = (await pool.query<{ id: string }>(
    `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at)
     values ($1, 'command', $2, $3, $4, $5, $6, $7, $8) returning id`,
    [args.agentId, v.command, args.reason, v.warnings, args.channelId, args.threadRootId, args.now, expiresAt])).rows[0]!.id;
  await supersedeOlderRequests(pool, { newId: id, agentId: args.agentId, kind: 'command', target: v.command, channelId: args.channelId, threadRootId: args.threadRootId, now: args.now });
  await pool.query(`update permission_request set file_digests = $2::jsonb where id = $1`, [id, JSON.stringify(canonicalDigests(files.files))]);
  await recordAudit(pool, {
    action: 'permission.requested', actorId: args.agentId, target: args.agentId,
    detail: { requestId: id, kind: 'command', target: v.command, warnings: v.warnings, channelId: args.channelId, threadRootId: args.threadRootId },
  });
  return {
    ok: true,
    created: {
      requestId: id,
      meta: {
        requestId: id, agentId: args.agentId, ownerAccountId: args.ownerAccountId, kind: 'command', target: v.command,
        channelId: args.channelId, threadRootId: args.threadRootId, warnings: v.warnings,
        ...(files.files.length ? { files: files.files } : {}),
        reason: oneLineReason(args.reason), requestedAt: args.now.toISOString(), expiresAt: expiresAt.toISOString(),
      },
    },
  };
}

/** 카드 본문(옛 앱이 meta 를 모를 때 읽는 글). 권한 칸은 서버 값뿐이고, 에이전트가 쓴 것은 이유 한 줄이다. */
export function permissionCardBody(meta: PermissionRequestMeta, agentHandle: string): string {
  // n1(jaebin 10-07): 규칙은 그 채널의 **모든** 턴(위임·예약 깨우기로 뜬 턴 포함)에 붙는다 — 카드가 그렇게 말해야 한다.
  const warn = meta.warnings.length ? `\n⚠ ${meta.warnings.join(', ')}` : '';
  if (meta.kind === 'command') {
    return `권한 요청 · ${agentHandle}\n정확히 이 명령 하나 \`${meta.target}\` — 이 스레드에서만 · 「이번 한 번」 또는 「1시간」${warn}${filesBlock(meta.files ?? [])}\n이유: ${oneLineReason(meta.reason)}`;
  }
  // CI 거절 카드(스레드 1fccc9a5): 뜻은 「CI 실패 무시하고 이번 한 번 머지」 하나다 — 7일이 아니다. 체크 이름(서버가 거른 값)은
  // 멘션·토큰이 되는 글자를 비슷한 글자로 바꿔 싣는다(본문은 멘션이 풀린다).
  if (meta.kind === 'merge' && meta.once?.reason === 'ci_not_green') {
    const names = checkNamesForBody(meta.once.failedChecks ?? []);
    return `권한 요청 · ${agentHandle}\nCI 실패 무시하고 이번 한 번 머지 \`${meta.target}\` PR #${meta.once.number} · head ${meta.once.headSha.slice(0, 9)}`
      + `${names ? `\n실패한 체크: ${names}` : ''}\n이유: ${oneLineReason(meta.reason)}`;
  }
  const what = meta.kind === 'tool'
    ? `명령 허용 \`${meta.target}\` — 이 채널의 모든 대화에서`
    : `머지 권한 \`${meta.target}\``;
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

export function permissionCardOptions(kind: PermissionKind = 'tool', ciOnce = false): { id: string; label: string }[] {
  // CI 거절 카드에는 7일 허락이 없다 — 승인은 카드 안의 [CI 실패 무시하고 이번 한 번 머지] 하나다(서버도 400 으로 막는다).
  if (ciOnce) return [{ id: PERMISSION_OPTION_DENY, label: '거절' }];
  if (kind === 'command') {
    return [
      { id: PERMISSION_OPTION_APPROVE_ONCE, label: '이번 한 번 승인' },
      { id: PERMISSION_OPTION_APPROVE_HOUR, label: '이 스레드에서 1시간 승인' },
      { id: PERMISSION_OPTION_DENY, label: '거절' },
    ];
  }
  return [
    // 「7일」을 이름에 넣는다(designer s1) — 머지 거절 카드에서는 그 위의 [이번 한 번 머지]와 갈려 읽혀야 한다. tool·merge 둘 다 7일이다.
    { id: PERMISSION_OPTION_APPROVE, label: '7일 허락하고 다시 시도' },
    { id: PERMISSION_OPTION_DENY, label: '거절' },
  ];
}

export async function linkPermissionCard(pool: Pool, requestId: string, cardMessageId: string): Promise<void> {
  await pool.query(`update permission_request set card_message_id = $2 where id = $1 and card_message_id is null`, [requestId, cardMessageId]);
  await closeSupersededCards(pool, requestId, cardMessageId);
}

/**
 * 같은 요청(에이전트·종류·대상·채널·스레드 — 「이미 기다리는 것을 돌려준다」와 같은 열쇠)을 새로 냈을 때 옛 요청을 새 요청에 잇는다(132).
 *
 * 시한 안의 기다리는 요청이 있으면 `open*` 이 그것을 돌려주고 여기까지 오지 않는다. 그래서 여기서 만나는 옛 요청은
 * ① 시한이 지났는데 스윕이 아직 닫지 않은 `pending` — `superseded` 로 바꾼다(만료로 깨우지 않는다: 에이전트가 방금 다시 청했다),
 * ② 이미 `expired` — 상태는 두고 `superseded_by` 만 적는다(만료 기록은 사실이다). 한 줄은 한 번만 잇는다(`superseded_by is null`).
 */
async function supersedeOlderRequests(
  pool: Pool,
  args: { newId: string; agentId: string; kind: PermissionKind; target: string; channelId: string; threadRootId: string; now: Date },
): Promise<void> {
  await pool.query(
    `update permission_request
        set superseded_by = $6,
            status = case when status = 'pending' then 'superseded' else status end,
            decided_at = coalesce(decided_at, $7)
      where agent_id = $1 and kind = $2 and target = $3 and channel_id = $4 and thread_root_id = $5
        and id <> $6 and superseded_by is null
        -- 살아 있는 pending 은 대체하지 않는다(같은 요청이 동시에 들어와도 열린 카드가 바뀌지 않게) — 기한이 지난 것만.
        and (status = 'expired' or (status = 'pending' and expires_at <= $7))`,
    [args.agentId, args.kind, args.target, args.channelId, args.threadRootId, args.newId, args.now]);
}

/**
 * 새 요청의 카드가 서면 그것이 대체한 옛 요청의 카드를 닫는다 — `closedReason: 'superseded'`, `supersededBy` 는 새 카드 id
 * (`message.ask` 의 대체와 같은 모양). 이미 닫힌 카드(만료로 닫힘)는 그대로 둔다. 거울도 `syncAskMirrors` 로 같은 사유로 닫는다.
 * 뒤처리라 실패해도 던지지 않는다 — 새 카드는 이미 섰다.
 */
async function closeSupersededCards(pool: Pool, newRequestId: string, newCardId: string): Promise<void> {
  try {
    const old = (await pool.query<{ id: string; status: string; cardMessageId: string }>(
      `select id, status, card_message_id as "cardMessageId" from permission_request
        where superseded_by = $1 and card_message_id is not null`, [newRequestId])).rows;
    const at = new Date().toISOString();
    for (const o of old) {
      if (o.status === 'superseded') {
        await pool.query(
          `update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb)
            where id = $1 and meta ? 'permissionRequest'`,
          [o.cardMessageId, JSON.stringify({ status: 'superseded', supersededBy: newRequestId, decidedAt: at })]);
      }
      const closed = await pool.query(
        `update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb)
          where id = $1 and meta ? 'ask' and meta->'ask'->>'closedAt' is null and meta->'ask'->'answeredWith' is null`,
        [o.cardMessageId, JSON.stringify({ closedAt: at, closedReason: 'superseded', supersededBy: newCardId })]);
      if (!closed.rowCount && o.status !== 'superseded') continue;
      const card = await getMessageById(pool, o.cardMessageId);
      if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
      if (closed.rowCount) await syncAskMirrors(pool, o.cardMessageId);
    }
  } catch (err) {
    console.error('permission supersede follow-up error:', err);
  }
}

export type DecideRefusal = { status: 400 | 403 | 404 | 409; code: string; message: string };

/**
 * 소유자가 카드에서 정한다. 사람 세션·소유자 판정은 라우트가 먼저 한다. 범위·기한은 이 줄과 상수뿐이다 — 요청 본문은 읽지 않는다.
 * 승인이면 grant 를 넣고, 어느 쪽이든 카드에 소유자 이름으로 답을 적어 에이전트를 깨운다(새 턴이 그 grant 를 달고 뜬다).
 */
export async function decidePermissionRequest(
  pool: Pool,
  args: {
    agentId: string; requestId: string; actorId: string; decision: PermissionDecision; now?: Date;
    /** 머지 거절 카드의 `approve_once` 일 때만 — 머지에 쓸 gh 계정과 CI 완화 여부. 저장소·PR·head 는 요청에 묶인 거절 기록이다. */
    once?: { ghUser: string | null; relaxChecks: boolean; number: number; headSha: string; failedChecks?: string[] };
    /**
     * 어느 길로 정했나(`decisions.decide`). 글 승인(`chatApproval`)은 카드 meta(`decidedVia`)·감사 기록에, 버튼은 감사 기록에만
     * 남는다(카드 meta 는 전과 같다).
     */
    via?: { kind: 'chat'; messageId: string; target?: 'T1' | 'T2' | 'T3' } | { kind: 'button' } | { kind: 'mirror'; mirrorMessageId: string };
  },
): Promise<({ ok: true; status: 'granted' | 'denied' | 'approved_once'; grantExpiresAt: string | null; approvalExpiresAt?: string; cardMessageId: string | null; grantMode?: 'once' | 'hour' }) | ({ ok: false } & DecideRefusal)> {
  const now = args.now ?? new Date();
  const client = await pool.connect();
  let row: { id: string; kind: PermissionKind; target: string; channelId: string; threadRootId: string; cardMessageId: string | null; denialId: string | null } | undefined;
  let grantExpiresAt: Date | null = null;
  let grantMode: 'once' | 'hour' | undefined;
  let commandGrantId: string | undefined;
  const approving = args.decision !== 'deny';
  let approval: { approvalId: string; scope: string; number: number; headSha: string; reason: string; expiresAt: Date } | null = null;
  try {
    await client.query('begin');
    const r = (await client.query<{
      id: string; agentId: string; kind: PermissionKind; target: string; channelId: string; threadRootId: string; status: string; expired: boolean; cardMessageId: string | null;
      denialId: string | null;
    }>(
      `select id, agent_id as "agentId", kind, target, channel_id as "channelId", thread_root_id as "threadRootId", status, expires_at <= $2 as expired,
              card_message_id as "cardMessageId", denial_id as "denialId"
         from permission_request where id = $1 for update`, [args.requestId, now])).rows[0];
    // `:id` 가 요청의 에이전트와 다르면 없는 것과 같다 — 남의 요청 id 를 내 에이전트 경로에 꽂는 길을 닫는다.
    if (!r || r.agentId !== args.agentId) { await client.query('rollback'); return { ok: false, status: 404, code: 'not_found', message: 'no such permission request for this agent' }; }
    // PR 이 머지되거나 닫혀 카드가 닫혔다(Q3-c) — 승인·7일 허락·거절 어느 결정도 받지 않는다.
    if (r.status === 'obsolete') { await client.query('rollback'); return { ok: false, status: 409, code: 'pr_closed', message: 'that pull request was already merged or closed — this card is closed' }; }
    // 같은 요청을 에이전트가 다시 내서 새 카드가 대신했다(132) — 결정은 새 카드에서.
    if (r.status === 'superseded') { await client.query('rollback'); return { ok: false, status: 409, code: 'superseded', message: 'the agent asked again — decide on the newer card' }; }
    if (r.status !== 'pending') { await client.query('rollback'); return { ok: false, status: 409, code: 'already_decided', message: `this request is already ${r.status}` }; }
    if (r.expired) {
      await client.query('rollback');
      // 스윕을 기다리지 않고 이 자리에서 카드를 닫는다 — 누른 사람의 화면이 곧바로 「만료됨」으로 바뀐다.
      await expirePermissionRequests(pool, { now, requestId: r.id });
      return { ok: false, status: 409, code: 'request_expired', message: 'this request expired — the agent has to ask again' };
    }
    // 「한 번」은 종류마다 뜻이 다르다: command 는 그 명령 1회 grant(아래), merge 는 거절 카드의 이 PR·이 head 1회 머지(스레드 1b75d7a0).
    if (args.decision === 'approve_once' && r.kind !== 'command') {
      if (r.kind !== 'merge' || !r.denialId || !args.once) {
        await client.query('rollback');
        return { ok: false, status: 409, code: 'not_once', message: 'only a card raised from a merge refusal can approve one merge' };
      }
      const made = await insertApprovalFromDenial(client, { agentId: args.agentId, denialId: r.denialId, actorId: args.actorId, ghUser: args.once.ghUser, relaxChecks: args.once.relaxChecks, expect: { number: args.once.number, headSha: args.once.headSha, ...(args.once.failedChecks ? { failedChecks: args.once.failedChecks } : {}) }, now });
      if (!made.ok) { await client.query('rollback'); return made; }
      approval = made;
    }
    if (r.kind === 'command' && args.once) {
      await client.query('rollback');
      return { ok: false, status: 409, code: 'not_once', message: 'only a card raised from a merge refusal can approve one merge' };
    }
    if (r.kind !== 'command' && args.decision === 'approve_hour') {
      await client.query('rollback');
      return { ok: false, status: 409, code: 'bad_decision', message: 'once/hour is only for an exact-command request' };
    }
    if (approving && r.kind === 'command') {
      // 승인 시점에 다시 판정한다 — 저장 뒤 판정이 좁아졌으면 열지 않는다(목록 조회·hook 도 같은 판정을 다시 한다).
      const v = validateExactCommand(r.target);
      if (!v.ok || v.command !== r.target) {
        await client.query('rollback');
        return { ok: false, status: 409, code: 'not_grantable', message: 'this command is no longer grantable — the agent has to ask again' };
      }
      grantMode = args.decision === 'approve_hour' ? 'hour' : 'once';
      grantExpiresAt = new Date(now.getTime() + COMMAND_GRANT_TTL_MS);
      commandGrantId = (await client.query<{ id: string }>(
        `insert into command_grant (agent_id, channel_id, thread_root_id, command, single_use, expires_at, granted_by, request_id, created_at, file_digests)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9, r.file_digests from permission_request r where r.id = $8 returning id`,
        [args.agentId, r.channelId, r.threadRootId, r.target, grantMode === 'once', grantExpiresAt, args.actorId, r.id, now])).rows[0]!.id;
    } else if (args.decision === 'approve') {
      // CI 거절 카드는 7일 허락을 주지 않는다(security D4 — 화면 버튼만 숨기지 않고 서버가 막는다). 권한은 이미 있다.
      if (r.kind === 'merge' && r.denialId) {
        const reason = (await client.query<{ reason: string }>(`select reason from merge_denial where id = $1`, [r.denialId])).rows[0]?.reason;
        if (reason === 'ci_not_green') {
          await client.query('rollback');
          return { ok: false, status: 400, code: 'ci_card_once_only', message: CI_CARD_ONCE_ONLY_MESSAGE };
        }
      }
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
    const status = args.decision === 'deny' ? 'denied' : r.kind === 'command' || args.decision === 'approve' ? 'granted' : 'approved_once';
    await client.query(
      `update permission_request set status = $2, decided_at = $3, decided_by = $4, grant_expires_at = $5, grant_mode = $6 where id = $1`,
      [r.id, status, now, args.actorId, grantExpiresAt, grantMode ?? null]);
    if (r.cardMessageId) {
      await client.query(
        `update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb)
          where id = $1 and meta ? 'permissionRequest'`,
        [r.cardMessageId, JSON.stringify({
          status, decidedAt: now.toISOString(), decidedBy: args.actorId,
          ...(grantExpiresAt ? { grantExpiresAt: grantExpiresAt.toISOString() } : {}),
          ...(approval && args.once ? { approvedOnce: { ghUser: args.once.ghUser, relaxChecks: args.once.relaxChecks, expiresAt: approval.expiresAt.toISOString() } } : {}),
          ...(grantMode ? { grantMode } : {}),
          ...(args.via?.kind === 'chat' || args.via?.kind === 'mirror' ? { decidedVia: args.via } : {}),
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

  const status = args.decision === 'deny' ? 'denied' : row.kind === 'command' || args.decision === 'approve' ? 'granted' : 'approved_once';
  if (approval && args.once) {
    await recordAudit(pool, {
      action: 'repo.merge.approved_once', actorId: args.actorId, target: approval.scope,
      detail: { agentId: args.agentId, requestId: row.id, approvalId: approval.approvalId, denialId: row.denialId, reason: approval.reason, number: approval.number, headSha: approval.headSha, ghUser: args.once.ghUser, ...(args.once.ghUser ? {} : { ghUserChosenBy: 'operator' }), relaxChecks: args.once.relaxChecks, expiresAt: approval.expiresAt.toISOString() },
    });
  }
  await recordAudit(pool, {
    action: args.decision === 'deny' ? 'permission.denied' : 'permission.approved', actorId: args.actorId, target: args.agentId,
    detail: {
      requestId: row.id, kind: row.kind, target: row.target, channelId: row.channelId,
      ...(row.kind === 'command' ? { threadRootId: row.threadRootId } : {}),
      ...(grantExpiresAt ? { grantExpiresAt: grantExpiresAt.toISOString() } : {}),
      ...(grantMode ? { grantMode, commandGrantId } : {}),
      ...(args.via?.kind === 'chat' ? { via: args.via.kind, messageId: args.via.messageId, ...(args.via.target ? { chatTarget: args.via.target } : {}) }
        : args.via?.kind === 'mirror' ? { via: 'mirror', mirrorMessageId: args.via.mirrorMessageId }
        : args.via ? { via: args.via.kind } : {}),
    },
  });
  if (grantExpiresAt && row.kind === 'command') {
    emitEvent({ type: 'grant.changed', accountId: args.agentId, audience: 'all' });
  } else if (grantExpiresAt) {
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
      // 1회 머지 승인도 「승인」으로 답한다 — 에이전트가 깨어나 같은 명령을 한 번 더 부른다(그 턴에서 래퍼가 승인을 쓴다).
      optionId: args.decision === 'deny' ? PERMISSION_OPTION_DENY
        : row.kind !== 'command' ? PERMISSION_OPTION_APPROVE
        : grantMode === 'hour' ? PERMISSION_OPTION_APPROVE_HOUR : PERMISSION_OPTION_APPROVE_ONCE,
      viaPermissionDecision: true,
    });
    const card = typeof answered === 'object' ? answered : await getMessageById(pool, row.cardMessageId);
    if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
  }
  return { ok: true, status, grantExpiresAt: grantExpiresAt?.toISOString() ?? null, ...(approval ? { approvalExpiresAt: approval.expiresAt.toISOString() } : {}), cardMessageId: row.cardMessageId, ...(grantMode ? { grantMode } : {}) };
}

/** 만료 스윕 주기. 요청 시한은 하루라 1분이면 화면이 늦어도 1분이다(누르면 그 자리에서 닫힌다). */
export const PERMISSION_EXPIRE_SWEEP_INTERVAL_MS = 60_000;
/** 한 번의 스윕에서 닫을 요청 수의 상한. */
const PERMISSION_EXPIRE_BATCH = 50;

/**
 * 시한이 지난 기다리는 요청을 닫는다(스레드 65f3b26e, 2026-10-19). 전에는 요청만 만료되고 카드는 열린 채 버튼을 보였다 —
 * 누르면 409 `request_expired` 가 돌아올 뿐 화면은 그대로여서 「승인 버튼이 안 눌린다」로 보였다.
 *
 * 요청은 `expired`, 카드 meta 의 `permissionRequest.status` 도 `expired`, 카드의 선택 카드는 `closedReason: 'expired'` 로 닫는다(닫은 사람이 없으므로 `closedBy` 는 없다)
 * (`obsoleteMergeCards` 와 같은 모양). 닫은 뒤 `syncAskMirrors` 로 거울·묶음 줄을 같은 사유로 닫는다 — 다른 채널에 세운 거울도
 * 열린 채 남지 않는다. 카드를 실제로 닫았으면 요청한 에이전트를 한 번 깨운다(`ask_closed`). 닫은 요청 수를 돌려준다.
 * `requestId` 가 있으면 그 요청만(결정 경로가 만료를 만났을 때).
 */
export async function expirePermissionRequests(pool: Pool, args: { now: Date; requestId?: string }): Promise<number> {
  const client = await pool.connect();
  let rows: { id: string; agentId: string; cardMessageId: string | null }[] = [];
  /** 이번 만료가 실제로 닫은 카드 — 그 카드의 에이전트만 깨운다(이미 사람이 닫은 카드는 그때 깨웠다). */
  const closedCards = new Set<string>();
  try {
    await client.query('begin');
    rows = (await client.query<{ id: string; agentId: string; cardMessageId: string | null }>(
      `update permission_request set status = 'expired', decided_at = $1
        where id in (select id from permission_request
                      where status = 'pending' and expires_at <= $1 and ($2::uuid is null or id = $2)
                      order by expires_at limit $3 for update skip locked)
        returning id, agent_id as "agentId", card_message_id as "cardMessageId"`,
      [args.now, args.requestId ?? null, PERMISSION_EXPIRE_BATCH])).rows;
    const at = args.now.toISOString();
    for (const r of rows) {
      if (!r.cardMessageId) continue;
      await client.query(
        `update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb)
          where id = $1 and meta ? 'permissionRequest'`,
        [r.cardMessageId, JSON.stringify({ status: 'expired', decidedAt: at })]);
      const closed = await client.query(
        `update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb)
          where id = $1 and meta ? 'ask' and meta->'ask'->>'closedAt' is null and meta->'ask'->'answeredWith' is null`,
        [r.cardMessageId, JSON.stringify({ closedAt: at, closedReason: 'expired' })]);
      if (closed.rowCount) closedCards.add(r.cardMessageId);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const r of rows) {
    // 만료는 이미 커밋됐다 — 한 줄의 뒤처리가 실패해도 나머지 카드는 알린다.
    try {
      // 만료는 서버가 한 일이다 — 행위자는 없다(security n2). 대상은 그 에이전트.
      await recordAudit(pool, { action: 'permission.expired', actorId: null, target: r.agentId, detail: { requestId: r.id } });
      if (!r.cardMessageId) continue;
      const card = await getMessageById(pool, r.cardMessageId);
      if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
      await syncAskMirrors(pool, r.cardMessageId);
      // 요청한 에이전트를 한 번 깨운다(`ask_closed`, 카드 자신을 가리킨다) — 러너는 `closedReason: 'expired'` 를 보고
      // 「만료됐다, 아직 필요하면 다시 청해라」로 알린다. 한 줄은 위의 `status = 'pending'` 갱신에서 한 번만 돌아오므로 깨움도 한 번이다.
      // 행위자는 서버다 — 빈 값을 넘겨 자기 깨움 거름(`askerId === actorId`)에 걸리지 않게 한다.
      if (closedCards.has(r.cardMessageId)) await wakeAsker(pool, r.agentId, '', r.cardMessageId, 'ask_closed');
    } catch (err) {
      console.error('permission expiry follow-up error:', err);
    }
  }
  return rows.length;
}

/** 만료 스위퍼 — 다른 스위퍼와 같은 모양(프로세스 안 겹침은 깃발, `onClose` 에서 interval 정리). */
export function createPermissionExpirySweeper(pool: Pool, opts: { now?: () => Date } = {}): {
  startSweep(app: { addHook(hook: 'onClose', fn: () => void | Promise<void>): void }): void;
  sweep(): Promise<void>;
} {
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      while ((await expirePermissionRequests(pool, { now: opts.now?.() ?? new Date() })) >= PERMISSION_EXPIRE_BATCH) { /* 다음 묶음 */ }
    } catch (err) {
      // 던지면 `void sweep()` 이 처리 안 된 거절이 되어 프로세스가 죽는다(agentWakes 의 10-12 사고). 다음 주기에 다시 한다.
      console.error('permission expiry sweep error:', err);
    } finally {
      running = false;
    }
  };
  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(() => { void sweep(); }, PERMISSION_EXPIRE_SWEEP_INTERVAL_MS);
      app.addHook('onClose', () => {
        if (sweepInterval) clearInterval(sweepInterval);
        sweepInterval = null;
      });
    },
    sweep,
  };
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
    // 내려놓기는 조직 전체(`owner/*`)도 받는다 — 좁히는 쪽이다.
    const scope = repoGrantScope(args.repo ?? '');
    if (!scope) return { ok: false, code: 'bad_repo', message: 'repo must be one <owner>/<name> or <owner>/*' };
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

export interface CommandGrantView { id: string; command: string; singleUse: boolean; expiresAt: string }

/**
 * 오퍼레이터 hook 이 캐시할 목록(H②) — 이 에이전트가 이 스레드에서 받은 살아 있는 정확한 명령 grant. **읽기만** 한다.
 * 지금 판정으로 다시 거른다(저장 뒤 판정이 좁아졌으면 내보내지 않는다).
 */
export async function commandGrantsFor(
  pool: Pool, agentId: string, channelId: string, threadRootId: string, now = new Date(),
): Promise<CommandGrantView[]> {
  const rows = (await pool.query<{ id: string; command: string; singleUse: boolean; expiresAt: Date }>(
    `select id, command, single_use as "singleUse", expires_at as "expiresAt" from command_grant
      where agent_id = $1 and channel_id = $2 and thread_root_id = $3 and expires_at > $4
        and (not single_use or used_at is null)
      order by created_at`, [agentId, channelId, threadRootId, now])).rows;
  return rows.filter((r) => {
    const v = validateExactCommand(r.command);
    return v.ok && v.command === r.command;
  }).map((r) => ({ id: r.id, command: r.command, singleUse: r.singleUse, expiresAt: new Date(r.expiresAt).toISOString() }));
}

/**
 * hook 이 도구 호출 하나를 열지 정한다(H②). 명령을 정규형으로 판정하고(셸 문법이면 열지 않는다) **정확히 같은** 살아 있는
 * grant 하나를 원자적으로 쓴다 — 1회짜리는 `used_at is null` 조건의 update 가 한 번만 성공한다. 여러 번짜리를 먼저 쓴다
 * (1회짜리를 아껴 둔다). 연 것마다 감사 기록을 남긴다(명령은 sha256 으로만).
 */
export async function matchCommandGrant(
  pool: Pool,
  args: {
    agentId: string; channelId: string; threadRootId: string; command: string; toolUseId?: string | null; now?: Date;
    /** 오퍼레이터가 지금 잰 파일 해시 — 명령의 파일 자리와 경로 집합이 같아야 하고, grant 와 모두 같아야 연다. */
    files?: { path: string; sha256: string }[];
    /** hook 입력의 cwd. 1시간 grant 는 첫 사용 cwd 에 묶인다. */
    cwd?: string | null;
  },
): Promise<{ allow: true; grantId: string; singleUse: boolean } | { allow: false }> {
  const now = args.now ?? new Date();
  const v = validateExactCommand(args.command);
  if (!v.ok) return { allow: false };
  // 정규화는 한 곳(canonicalDigests)에서만 — 요청 때 저장한 것과 같은 함수·같은 꼴로 비교한다(security 3).
  const measured = args.files ?? [];
  const want = new Set(v.files.map((f) => f.path));
  if (measured.length !== want.size || new Set(measured.map((f) => f.path)).size !== want.size || measured.some((f) => !want.has(f.path))) return { allow: false };
  const digests = JSON.stringify(canonicalDigests(measured));
  // cwd 가 없으면 1시간 grant 는 열지 않는다(security 1) — null 로 첫 사용을 지나면 묶이지 않은 채 남는다. 1회 grant 는 cwd 를 보지 않는다.
  const cwd = typeof args.cwd === 'string' && args.cwd.startsWith('/') ? args.cwd : null;
  const hit = (await pool.query<{ id: string; singleUse: boolean }>(
    `update command_grant c set use_count = c.use_count + 1, used_at = coalesce(c.used_at, $5),
            bound_cwd = case when c.single_use then c.bound_cwd else coalesce(c.bound_cwd, $7) end
      where c.id = (
        select id from command_grant
         where agent_id = $1 and channel_id = $2 and thread_root_id = $3 and command = $4 and expires_at > $5
           and (not single_use or used_at is null)
           and file_digests = $6::jsonb
           and (single_use or ($7::text is not null and (bound_cwd is null or bound_cwd = $7)))
         order by single_use asc, created_at
         limit 1
         for update skip locked)
        and (not c.single_use or c.used_at is null)
        and (c.single_use or ($7::text is not null and (c.bound_cwd is null or c.bound_cwd = $7)))
      returning c.id, c.single_use as "singleUse"`,
    [args.agentId, args.channelId, args.threadRootId, v.command, now, digests, cwd])).rows[0];
  if (!hit) return { allow: false };
  await recordAudit(pool, {
    action: 'permission.command_used', actorId: args.agentId, target: args.agentId,
    detail: {
      grantId: hit.id, singleUse: hit.singleUse, channelId: args.channelId, threadRootId: args.threadRootId,
      commandSha256: createHash('sha256').update(v.command).digest('hex'), toolUseId: args.toolUseId ?? null,
    },
  });
  return { allow: true, grantId: hit.id, singleUse: hit.singleUse };
}

/** grant·요청 줄에 두는 꼴 — 경로 순으로 정렬한 `{path, sha256}` 뿐(jsonb 같음 비교가 순서·크기·미리 보기에 흔들리지 않게). */
export function canonicalDigests(files: readonly { path: string; sha256: string }[]): { path: string; sha256: string }[] {
  return [...files].map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

type FileMatch =
  | { ok: true; files: { path: string; size: number; sha256: string; secret: boolean; preview?: string }[] }
  | { ok: false; code: 'files_unmeasured' | 'files_mismatch'; message: string };

/** C1: 명령이 읽는 파일(서버가 뽑은 것)과 오퍼레이터가 잰 것의 경로 집합이 같아야 한다. secret 자리의 미리 보기는 버린다. */
function matchFileDigests(want: readonly CommandFileArg[], got: CommandFileDigest[] | null): FileMatch {
  if (!want.length) return { ok: true, files: [] };
  if (!got) return { ok: false, code: 'files_unmeasured', message: 'this command reads files — it can only be requested through an up-to-date operator that measures them' };
  const byPath = new Map(got.map((d) => [d.path, d]));
  if (got.length !== want.length || byPath.size !== want.length || want.some((w) => !byPath.has(w.path))) {
    return { ok: false, code: 'files_mismatch', message: 'the measured files do not match the files this command reads' };
  }
  return {
    ok: true,
    files: want.map((w) => {
      const d = byPath.get(w.path)!;
      return { path: w.path, size: d.size, sha256: d.sha256, secret: w.secret, ...(!w.secret && d.preview !== undefined ? { preview: d.preview } : {}) };
    }),
  };
}

/** 카드 본문의 파일 줄 — 경로·크기·해시 앞 12자, 비밀 아닌 자리는 앞 4KB 내용(펜스를 깨는 글자는 바꾼다). */
function filesBlock(files: readonly NonNullable<PermissionRequestMeta['files']>[number][]): string {
  if (!files.length) return '';
  const lines = [`\n파일 ${files.length}개 — 내용은 요청 시점에 고정됨(바뀌면 열리지 않는다):`];
  for (const f of files) {
    lines.push(`· ${f.path} (${f.size}B, sha256 ${f.sha256.slice(0, 12)}…)${f.secret ? ' — 내용 비공개' : ''}`);
    // n1: 미리 보기는 에이전트가 고른 파일 내용이다 — 멘션(`@이름`·`<@id>`)·채널 토큰·링크로 사람을 부르지 못하게 `@` 를 전각으로 바꾼다.
    // 펜스(```)도 서버 멘션 파서가 건너뛰는 꼴이지만(splitCode) 그것에만 기대지 않는다. 펜스를 닫는 글자·Cf 는 지운다.
    if (f.preview !== undefined) lines.push('```', neutralizePreview(f.preview), '```');
  }
  return lines.join('\n');
}

/** 카드 미리 보기 글자 — 멘션·펜스 탈출·서식 문자를 무력화한다(security n1). */
export function neutralizePreview(text: string): string {
  return text.replace(/\p{Cf}/gu, '').replace(/`{3,}|~{3,}/g, (m) => '‵'.repeat(m.length)).replace(/@/g, '＠').replace(/harkroom:\/\//gi, 'harkroom∶//');
}

/**
 * 권한 카드 거울(P3)의 본문·선택지 — 에이전트가 쓴 거울 본문이 아니라 **원본 요청**으로 서버가 다시 쓴다. 원본이 권한 카드가
 * 아니면 null(일반 거울은 전과 같다). 거울 채널을 보는 사람 중 원본 채널을 못 보는 사람이 있을 수 있으면 대상·이유 없이
 * 중립 한 줄만 싣는다 — 정하는 것은 어차피 원본을 볼 수 있는 소유자다.
 */
export async function renderPermissionMirror(
  pool: Pool, rootId: string, mirrorChannelId: string,
): Promise<{ body: string; options: { id: string; label: string }[]; prompt?: string } | null> {
  const r = (await pool.query<{ meta: Record<string, unknown>; channelId: string; handle: string | null }>(
    `select m.meta, m.channel_id as "channelId", a.handle
       from message m left join account a on a.id = m.author_id
      where m.id = $1 and m.deleted_at is null and m.meta ? 'permissionRequest'`, [rootId])).rows[0];
  if (!r) return null;
  const pr = r.meta.permissionRequest as PermissionRequestMeta;
  const ask = r.meta.ask as { options?: { id: string; label: string }[]; prompt?: string } | undefined;
  const ciOnce = pr.kind === 'merge' && pr.once?.reason === 'ci_not_green';
  const options = ask?.options?.map((o) => ({ id: o.id, label: o.label })) ?? permissionCardOptions(pr.kind, ciOnce);
  const handle = `@${r.handle ?? 'agent'}`;
  const prompt = typeof ask?.prompt === 'string' ? ask.prompt : undefined;
  if (await mirrorAudienceSeesRoot(pool, r.channelId, mirrorChannelId)) {
    return { body: permissionCardBody(pr, handle), options, ...(prompt ? { prompt } : {}) };
  }
  return { body: `권한 요청 · ${handle}\n원래 카드가 있는 채널에서 내용을 확인하고 정해 주세요.`, options, ...(prompt ? { prompt } : {}) };
}

/** 거울 채널의 이벤트를 받는 사람이 모두 원본 채널도 보는가. 같은 채널이거나 원본이 모두에게 열려 있으면 참. */
async function mirrorAudienceSeesRoot(pool: Pool, rootChannelId: string, mirrorChannelId: string): Promise<boolean> {
  if (rootChannelId === mirrorChannelId) return true;
  const rootAudience = await audienceFor(pool, rootChannelId);
  if (rootAudience === 'all') return true;
  const mirrorAudience = await audienceFor(pool, mirrorChannelId);
  if (mirrorAudience === 'all') return false;
  const seen = new Set(rootAudience);
  return mirrorAudience.every((id) => seen.has(id));
}
