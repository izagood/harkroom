import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { CommandFileDigest } from '@harkroom/shared/runnerLink';
import { orderToolRuleWarnings, PERMISSION_CARD_OPTION, repoGrantScope, TOOL_RULE_WARNING_HEAD_KO, repoScope, toolScope, validateExactCommand, validateToolRule, type CommandFileArg, type MessageRow, type PermissionCardLine, type PermissionCardMandate, type PermissionMirrorMeta, type ToolRuleRefusal, type ToolRuleWarning } from '@harkroom/shared';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from './channels.js';
import { validateCapScope, type Cap, type LineLimits } from './capabilities.js';
import { addMandateLine, revokeLinesForGrant, type LineVia } from './mandateLines.js';
import { validMandateOwner } from './mandates.js';
import { CI_CARD_ONCE_ONLY_MESSAGE, checkNamesForBody, insertApprovalFromDenial, type MergeDenialReason } from './mergeDenials.js';
import { getMessageById, recordAskAnswer, syncAskMirrors, wakeAsker } from './messages.js';

/**
 * 에이전트 권한 요청 → 소유자 승인 → 적용(스레드 f61af808, 소유자 D1~D4 10-07).
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
/** kind=command 카드의 선택지(H②): 「이번 한 번」(이 스레드에만, 쓰지 않으면 1시간 뒤 사라진다). `approve_hour`(이 스레드 1시간)는 옛 앱을 위해 라우트만 받는다(W4b ②). */
export const PERMISSION_OPTION_APPROVE_ONCE = 'approve_once';
export const PERMISSION_OPTION_APPROVE_HOUR = 'approve_hour';
/** 정확한 명령 grant 의 기한 — 1회짜리도 이 안에 써야 한다. */
export const COMMAND_GRANT_TTL_MS = 3_600_000;
/** W4b: [이 위임장 동안](tool·merge 주 버튼) · [이 스레드로 위임장 만들고 더하기](위임 없는 턴). 둘 다 7일 grant + 위임 줄. */
export const PERMISSION_OPTION_APPROVE_MANDATE = PERMISSION_CARD_OPTION.approveMandate;
export const PERMISSION_OPTION_APPROVE_NEW_MANDATE = PERMISSION_CARD_OPTION.approveNewMandate;

export type PermissionDecision = 'approve' | 'approve_mandate' | 'approve_new_mandate' | 'approve_once' | 'approve_hour' | 'deny';

/** 7일 grant 를 쓰는 결정 — 옛 `approve` 와 W4b 의 두 갈래. */
function isStandingApprove(d: PermissionDecision): boolean {
  return d === 'approve' || d === 'approve_mandate' || d === 'approve_new_mandate';
}

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
  /** 요청을 낸 턴의 위임(W4) — 서버가 턴 임대에서 읽어 적는다. 위임 없는 턴이면 칸이 없다. */
  mandateId?: string;
  /** W4b: 위임장 칩(이름은 작업 항목 제목, 없으면 소유자 첫 글 앞부분). 위임 없는 턴이면 없다. */
  mandate?: PermissionCardMandate;
  /** W4b: 선택지마다 더할 줄(미리 보기). */
  line?: PermissionCardLine;
  /** r5: 본문 속 서버가 쓴 대상 줄(줄 카드만) — 줄 상자를 그리는 화면이 본문에서 이 줄 하나만 뺀다. */
  bodyTargetLine?: string;
  /** H4: 본문 속 서버가 쓴 경고 줄(`⚠ …`) — 경고를 줄 상자에 그리는 화면이 본문에서 이 줄 하나만 뺀다. 경고가 없으면 없다. */
  bodyWarningLine?: string;
  requestedAt: string;
  expiresAt: string;
  /** 정해진 뒤에만. */
  status?: 'granted' | 'denied' | 'approved_once';
  /** 1회 승인으로 정해졌으면 그 계정·CI 완화·승인 기한. */
  approvedOnce?: { ghUser: string | null; relaxChecks: boolean; expiresAt: string };
  /** 계정을 비운 1회 승인으로 머지했을 때 오퍼레이터가 실제로 쓴 gh 이름(래퍼 보고). 머지 보고 뒤에만. */
  ghUserUsed?: string;
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
    /** 요청을 낸 턴의 위임(W4, 턴 임대의 `mandate_id`) — 부르는 쪽(MCP)이 서버 값으로 넘긴다. 없으면 줄을 더하지 않는다. */
    mandateId?: string | null;
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
    // 조직 전체(`owner/*`)는 카드로 청하지 못한다 — 승인 한 번에 그 조직이 통째로 열린다. 소유자가 설정 화면에서만 준다(소유자 10-09).
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

  // 거절에서 온 카드는 그 거절 기록(= 그 PR·head) 하나에 묶인다(D1) — 같은 기록이면 있던 카드를 가리키고, 다른 PR·head 면 새 카드를 세운다.
  // 기다리는 카드가 가리키는 PR·head 는 바꾸지 않는다: 사람이 본 카드와 승인이 쓰이는 PR 이 어긋나면 안 된다.
  const pending = (await pool.query<{ id: string; cardMessageId: string | null }>(
    `select id, card_message_id as "cardMessageId" from permission_request
      where agent_id = $1 and kind = $2 and target = $3 and thread_root_id = $4 and channel_id = $5
        and status = 'pending' and expires_at > $6 and ($7::uuid is null or denial_id = $7)
      order by created_at desc limit 1`,
    [args.agentId, args.kind, target, args.threadRootId, args.channelId, now, args.denial?.id ?? null])).rows[0];
  if (pending) return { ok: true, existing: { requestId: pending.id, cardMessageId: pending.cardMessageId } };

  const count = (await pool.query<{ n: number }>(
    `select count(*)::int as n from permission_request where agent_id = $1 and created_at > $2`,
    [args.agentId, new Date(now.getTime() - 86_400_000)])).rows[0]!.n;
  if (count >= PERMISSION_REQUESTS_PER_DAY) {
    return { ok: false, refusal: { code: 'too_many', message: `at most ${PERMISSION_REQUESTS_PER_DAY} permission requests a day` } };
  }

  const expiresAt = new Date(now.getTime() + PERMISSION_REQUEST_TTL_MS);
  const id = (await pool.query<{ id: string }>(
    `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, denial_id, mandate_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [args.agentId, args.kind, target, args.reason, warnings, args.channelId, args.threadRootId, now, expiresAt, args.denial?.id ?? null, args.mandateId ?? null])).rows[0]!.id;
  await supersedeOlderRequests(pool, { newId: id, agentId: args.agentId, kind: args.kind, target, channelId: args.channelId, threadRootId: args.threadRootId, now, denialPr: args.denial ? args.denial.number : null });
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
        warnings, ...bodyWarningLineMeta(warnings), reason: oneLineReason(args.reason),
        ...(args.denial ? { once: onceMeta(args.denial) } : {}), ...(args.mandateId ? { mandateId: args.mandateId } : {}),
        ...(await cardMandateMeta(pool, args.mandateId ?? null, args.channelId)),
        line: cardLine(args.kind, target, args.denial ? onceMeta(args.denial) : undefined, !!args.mandateId),
        ...bodyTargetLineMeta({ kind: args.kind, target: args.kind === 'merge' ? target.slice('repo:'.length) : target, once: args.denial ? onceMeta(args.denial) : undefined }),
        requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
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
    commandFiles?: CommandFileDigest[] | null; mandateId?: string | null;
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
    `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, mandate_id)
     values ($1, 'command', $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [args.agentId, v.command, args.reason, v.warnings, args.channelId, args.threadRootId, args.now, expiresAt, args.mandateId ?? null])).rows[0]!.id;
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
        channelId: args.channelId, threadRootId: args.threadRootId, warnings: v.warnings, ...bodyWarningLineMeta(v.warnings),
        ...(files.files.length ? { files: files.files } : {}),
        ...(args.mandateId ? { mandateId: args.mandateId } : {}),
        ...(await cardMandateMeta(pool, args.mandateId ?? null, args.channelId)),
        line: cardLine('command', v.command, undefined, !!args.mandateId),
        reason: oneLineReason(args.reason), requestedAt: args.now.toISOString(), expiresAt: expiresAt.toISOString(),
      },
    },
  };
}

/** 카드 본문(옛 앱이 meta 를 모를 때 읽는 글). 권한 칸은 서버 값뿐이고, 에이전트가 쓴 것은 이유 한 줄이다. */
export function permissionCardBody(meta: PermissionRequestMeta, agentHandle: string): string {
  // n1(소유자 10-07): 규칙은 그 채널의 **모든** 턴(위임·예약 깨우기로 뜬 턴 포함)에 붙는다 — 카드가 그렇게 말해야 한다.
  // H4: 코드 이름이 아니라 사람 말(머리 낱말)로 쓴다. 새 앱은 meta `bodyWarningLine` 과 같은 이 줄을 감추고 줄 상자에 문장으로 그린다.
  const warnLine = permissionBodyWarningLine(meta.warnings);
  const warn = warnLine ? `\n${warnLine}` : '';
  if (meta.kind === 'command') {
    return `권한 요청 · ${agentHandle}\n정확히 이 명령 하나 \`${meta.target}\` — 이 스레드에서만 · 「이번 한 번」${warn}${filesBlock(meta.files ?? [])}\n이유: ${oneLineReason(meta.reason)}`;
  }
  // CI 거절 카드(스레드 1fccc9a5): 뜻은 「CI 실패 무시하고 이번 한 번 머지」 하나다 — 7일이 아니다. 체크 이름(서버가 거른 값)은
  // 멘션·토큰이 되는 글자를 비슷한 글자로 바꿔 싣는다(본문은 멘션이 풀린다).
  if (meta.kind === 'merge' && meta.once?.reason === 'ci_not_green') {
    const names = checkNamesForBody(meta.once.failedChecks ?? []);
    return `권한 요청 · ${agentHandle}\nCI 실패 무시하고 이번 한 번 머지 \`${meta.target}\` PR #${meta.once.number} · head ${meta.once.headSha.slice(0, 9)}`
      + `${names ? `\n실패한 체크: ${names}` : ''}\n이유: ${oneLineReason(meta.reason)}`;
  }
  // r2(designer W4): 줄(`line`)이 있는 새 카드는 범위·기한을 줄 상자가 그린다 — 본문이 「이 채널의 모든 대화에서 · 7일」을 따로 말하면
  // [이 위임장 동안] 버튼과 어긋난다. 본문은 머리 한 줄과 이유뿐(서버 경고는 남긴다). 줄 없는 옛 카드는 아래 글 그대로.
  // r5(security F1): 대상 줄은 서버가 쓴다 — 줄 상자를 못 그리는 옛 앱도 무엇을 허락하는지 본문에서 읽는다. 새 앱은 줄 상자를 그릴 때
  // meta `bodyTargetLine` 과 똑같은 줄 하나만 숨긴다(designer F1).
  const targetLine = permissionBodyTargetLine(meta);
  if (meta.line && targetLine) return `권한 요청 · ${agentHandle}\n${targetLine}${warn}\n이유: ${oneLineReason(meta.reason)}`;
  const what = meta.kind === 'tool'
    ? `명령 허용 \`${meta.target}\` — 이 채널의 모든 대화에서`
    : `머지 권한 \`${meta.target}\``;
  return `권한 요청 · ${agentHandle}\n${what} · 승인하면 7일${warn}\n이유: ${oneLineReason(meta.reason)}`;
}

/**
 * 줄 카드(tool·merge, CI 거절 아님) 본문의 대상 줄 — 서버가 정규화한 대상으로만 만든다. 그 밖의 카드는 null.
 * 화면은 줄 상자를 그릴 때 본문에서 이 줄과 똑같은 줄 하나를 뺀다(meta `bodyTargetLine`).
 */
/** 카드 본문의 경고 줄 — 알려진 경고를 그리는 순서대로 ko 머리 낱말로 잇는다. 없으면 null. */
export function permissionBodyWarningLine(warnings: readonly unknown[]): string | null {
  const ordered = orderToolRuleWarnings(warnings);
  return ordered.length ? `⚠ ${ordered.map((w) => TOOL_RULE_WARNING_HEAD_KO[w]).join(' · ')}` : null;
}

function bodyWarningLineMeta(warnings: readonly unknown[]): { bodyWarningLine?: string } {
  const l = permissionBodyWarningLine(warnings);
  return l ? { bodyWarningLine: l } : {};
}

function bodyTargetLineMeta(meta: Pick<PermissionRequestMeta, 'kind' | 'target' | 'once'>): { bodyTargetLine?: string } {
  const l = permissionBodyTargetLine(meta);
  return l ? { bodyTargetLine: l } : {};
}

export function permissionBodyTargetLine(meta: Pick<PermissionRequestMeta, 'kind' | 'target' | 'once'>): string | null {
  if (meta.kind === 'tool') return `명령 허용 \`${meta.target}\``;
  if (meta.kind === 'merge' && meta.once?.reason !== 'ci_not_green') return `머지 \`${meta.target}\``;
  return null;
}

/**
 * 에이전트가 쓴 이유는 한 줄로 납작하게 하고 백틱·마크다운 머리를 지운다(security n2) — 줄바꿈과 백틱으로 위의 서버 줄
 * (「명령 허용 `…`」)을 흉내 내지 못하게. 서버 줄보다 아래, 맨 끝에 둔다.
 */
export function oneLineReason(reason: string): string {
  // bidi·서식 문자(U+202E 등, \p{Cf})도 지운다 — 옛 앱에서 이유 줄을 거꾸로 보이게 해 서버 줄처럼 꾸미지 못하게(security 후속).
  // r4: `>` 는 줄 머리에서만 인용 표시가 된다 — 글 속 `<이 카드 링크>` 의 닫는 꺾쇠는 남기고, 맨 앞 `>` 만 지운다.
  return reason.replace(/\p{Cf}/gu, '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[`*_#|[\]]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^[>\s]+/, '').slice(0, 300);
}

/**
 * 카드 선택지(W4b, 디자인 목업). 주 버튼이 앞이다.
 * - tool: [이 위임장 동안] · 거절. ([이 턴만]은 서버가 턴 단위로 셀 수 없어 싣지 않는다 — 러너가 `--allowedTools` 를 받을 때 턴 임대 id 를 넘기지 않는다.)
 * - merge: [이 위임장 동안] · 거절. 거절 카드의 [이번 한 번]은 PermissionOncePanel 이 그린다(선택지에 없음). CI 거절 카드: 거절만(7일 허락 없음, security D4).
 * - command: [이번 한 번] · 거절.
 * 위임 없는 턴(W4-3)이면 [이 위임장 동안] 자리에 [이 스레드로 위임장 만들고 더하기].
 */
export function permissionCardOptions(
  kind: PermissionKind = 'tool',
  opts: { ciOnce?: boolean; once?: boolean; mandate?: boolean } = {},
): { id: string; label: string }[] {
  const deny = { id: PERMISSION_OPTION_DENY, label: '거절' };
  if (kind === 'command') return [{ id: PERMISSION_OPTION_APPROVE_ONCE, label: '이번 한 번' }, deny];
  // 머지 거절 카드의 [이번 한 번]은 선택지에 싣지 않는다 — 화면의 PermissionOncePanel 이 PR·head·gh 계정과 함께 그린다
  // (옛 화면에 버튼이 둘 서지 않게). 서버는 approve_once 를 계속 받는다(패널·글 승인·거울). 한도는 meta `line.limits.approve_once`.
  // CI 거절 카드에는 위임 줄이 없다 — 승인은 [CI 실패 무시하고 이번 한 번] 하나다(서버도 400 으로 막는다).
  if (kind === 'merge' && opts.ciOnce) return [deny];
  const standing = opts.mandate
    ? { id: PERMISSION_OPTION_APPROVE_MANDATE, label: '이 위임장 동안', recommended: true }
    : { id: PERMISSION_OPTION_APPROVE_NEW_MANDATE, label: '이 스레드로 위임장 만들고 더하기', recommended: true };
  return [standing, deny];
}

/** 카드 meta 의 `line`(W4b) — 선택지마다 더할 줄의 한도 미리 보기. 실제 기한은 정할 때 정한다. */
export function cardLine(kind: PermissionKind, target: string, once: PermissionRequestMeta['once'] | undefined, hasMandate: boolean): PermissionCardLine {
  const cap = CAP_FOR_KIND[kind];
  // merge 는 저장한 꼴(`repo:owner/name`) 그대로 — 줄의 scope 와 같다.
  const scope = target;
  const limits: PermissionCardLine['limits'] = {};
  if (kind === 'command') {
    limits.approve_once = { untilMs: COMMAND_GRANT_TTL_MS, uses: 1 };
  } else {
    if (!(kind === 'merge' && once?.reason === 'ci_not_green')) {
      limits[hasMandate ? 'approve_mandate' : 'approve_new_mandate'] = { untilMs: PERMISSION_GRANT_TTL_MS };
    }
    if (kind === 'merge' && once) {
      limits.approve_once = { pr: once.number, head: once.headSha, uses: 1, ...(once.reason === 'ci_not_green' ? { ciOverride: true } : {}) };
    }
  }
  return { cap, scope, limits };
}

/** 위임장 칩 이름의 길이. */
const MANDATE_NAME_MAX = 40;

/** 칩 이름 — 그 스레드 머리의 작업 항목 제목(위임 소유자 것), 없으면 위임 머리 글의 앞부분(멘션 뺀 40자). */
export async function mandateChipName(pool: Pick<Pool, 'query'>, mandateId: string): Promise<string | null> {
  const r = (await pool.query<{ title: string | null; body: string | null }>(
    `select (select w.title from work_item w
              where w.thread_root_id = d.thread_root_id and w.owner_account_id = d.owner_account_id
              order by w.updated_at desc limit 1) as title,
            m.body
       from mandate d left join message m on m.id = d.root_message_id and m.deleted_at is null
      where d.id = $1`, [mandateId])).rows[0];
  if (!r) return null;
  if (r.title && r.title.trim()) return clip(oneLineReason(r.title));
  return clip(stripMentions(r.body ?? '')) || null;
}

function stripMentions(body: string): string {
  return oneLineReason(body.replace(/<@[0-9a-f-]{36}>/gi, ' ').replace(/(^|\s)@[\w.-]+/g, ' '));
}

function clip(s: string): string {
  const t = s.trim();
  const chars = [...t];
  return chars.length > MANDATE_NAME_MAX ? `${chars.slice(0, MANDATE_NAME_MAX).join('')}…` : t;
}

/**
 * 카드의 위임장 칩. 위임장은 채널을 넘어 이어지므로 이름(뿌리 글 앞부분·작업 항목 제목)은 **위임장 뿌리 채널을 카드 채널의 청중이 다 볼 때만**
 * 싣는다(security F1 — 거울과 같은 판정). 못 보면 이름을 비우고 소유자·시작 시각만 둔다(화면은 「🔑 위임장 · 소유자 · 시작일」).
 */
async function cardMandateMeta(pool: Pool, mandateId: string | null, cardChannelId: string): Promise<{ mandate?: PermissionCardMandate }> {
  if (!mandateId) return {};
  const d = (await pool.query<{ channelId: string; ownerId: string; startedAt: Date }>(
    `select channel_id as "channelId", owner_account_id as "ownerId", created_at as "startedAt" from mandate where id = $1`, [mandateId])).rows[0];
  if (!d) return { mandate: { id: mandateId, name: '' } };
  const name = (await mirrorAudienceSeesRoot(pool, d.channelId, cardChannelId)) ? await mandateChipName(pool, mandateId) : null;
  return { mandate: { id: mandateId, name: name ?? '', ownerId: d.ownerId, startedAt: d.startedAt.toISOString() } };
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
  args: { newId: string; agentId: string; kind: PermissionKind; target: string; channelId: string; threadRootId: string; now: Date; denialPr?: number | null },
): Promise<void> {
  // 거절 카드(`denialPr`)는 **같은 PR** 의 카드만 잇는다(D1) — 다른 PR 의 카드는 따로 살아 있다. 같은 PR 의 살아 있는 카드는 다른
  // head 의 것이고(같은 기록이면 위에서 있던 카드를 돌려줬다) 그 기록은 래퍼 판정 때 이미 닫혔다 — 새 카드로 대체한다.
  await pool.query(
    `update permission_request
        set superseded_by = $6,
            status = case when status = 'pending' then 'superseded' else status end,
            decided_at = coalesce(decided_at, $7)
      where agent_id = $1 and kind = $2 and target = $3 and channel_id = $4 and thread_root_id = $5
        and id <> $6 and superseded_by is null
        and ($8::int is null or denial_id in (select d.id from merge_denial d where d.scope = $3 and d.pr_number = $8))
        -- 살아 있는 pending 은 대체하지 않는다(같은 요청이 동시에 들어와도 열린 카드가 바뀌지 않게) — 기한이 지난 것만. 거절 카드는 위대로.
        and (status = 'expired' or (status = 'pending' and (expires_at <= $7 or $8::int is not null)))`,
    [args.agentId, args.kind, args.target, args.channelId, args.threadRootId, args.newId, args.now, args.denialPr ?? null]);
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
  let row: { id: string; kind: PermissionKind; target: string; channelId: string; threadRootId: string; cardMessageId: string | null; denialId: string | null; mandateId: string | null } | undefined;
  let lineOutcome: MandateLineOutcome | null = null;
  let grantExpiresAt: Date | null = null;
  let grantMode: 'once' | 'hour' | undefined;
  let commandGrantId: string | undefined;
  const approving = args.decision !== 'deny';
  let approval: { approvalId: string; scope: string; number: number; headSha: string; reason: string; expiresAt: Date } | null = null;
  try {
    await client.query('begin');
    const r = (await client.query<{
      id: string; agentId: string; kind: PermissionKind; target: string; channelId: string; threadRootId: string; status: string; expired: boolean; cardMessageId: string | null;
      denialId: string | null; mandateId: string | null;
    }>(
      `select id, agent_id as "agentId", kind, target, channel_id as "channelId", thread_root_id as "threadRootId", status, expires_at <= $2 as expired,
              card_message_id as "cardMessageId", denial_id as "denialId", mandate_id as "mandateId"
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
    if (r.kind === 'command' && (args.decision === 'approve_mandate' || args.decision === 'approve_new_mandate')) {
      await client.query('rollback');
      return { ok: false, status: 409, code: 'bad_decision', message: 'an exact-command request is approved once (or for an hour) — not for a mandate' };
    }
    // W4-3: 위임 없는 턴의 요청 — 카드의 스레드에 정하는 사람(=에이전트 소유자, 사람 세션은 부른 쪽이 봤다) 위임을 세우고 거기에 줄을 더한다.
    if (args.decision === 'approve_new_mandate' && !r.mandateId) {
      const made = await mandateForCardThread(client, { ownerId: args.actorId, channelId: r.channelId, threadRootId: r.threadRootId, now });
      if (!made) {
        await client.query('rollback');
        return { ok: false, status: 409, code: 'mandate_unavailable', message: 'a mandate cannot be started on this thread — approve from a thread you started' };
      }
      r.mandateId = made;
      await client.query(`update permission_request set mandate_id = $2 where id = $1`, [r.id, made]);
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
    } else if (isStandingApprove(args.decision)) {
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
    // W4: 위임이 있는 요청의 승인은 그 위임에 줄을 하나 **더** 적는다 — 위의 grant 는 그대로다. 줄이 실패해도 결정은 깨지 않는다(savepoint).
    if (approving && r.mandateId) {
      lineOutcome = await addLineFromRequest(client, {
        request: r, decision: args.decision, actorId: args.actorId, now,
        via: args.via?.kind ?? 'button',
        // 7일 승인으로 적힌 줄은 같은 결정에서 쓴 account_grant 의 기한에서 끝난다.
        ...(isStandingApprove(args.decision) && r.kind !== 'command' && grantExpiresAt ? { until: grantExpiresAt } : {}),
        ...(approval && args.once ? { once: { number: approval.number, headSha: approval.headSha, ghUser: args.once.ghUser, ciOverride: approval.reason === 'ci_not_green' } } : {}),
      });
    }
    const status = args.decision === 'deny' ? 'denied' : r.kind === 'command' || isStandingApprove(args.decision) ? 'granted' : 'approved_once';
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
          // 줄 빼기(g1) — 카드가 자기가 적은 줄을 가리킨다. 이 값이 있는 카드만 [줄 빼기]를 그린다(새 서버만 싣는 값).
          ...(lineOutcome?.ok ? { lineId: lineOutcome.lineId } : {}),
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

  const status = args.decision === 'deny' ? 'denied' : row.kind === 'command' || isStandingApprove(args.decision) ? 'granted' : 'approved_once';
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
  if (lineOutcome) await auditLineOutcome(pool, { actorId: args.actorId, agentId: args.agentId, requestId: row.id, outcome: lineOutcome });
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
      optionId: await answerOptionId(pool, row.cardMessageId, args.decision === 'deny' ? [PERMISSION_OPTION_DENY]
        : row.kind === 'command' ? [grantMode === 'hour' ? PERMISSION_OPTION_APPROVE_HOUR : PERMISSION_OPTION_APPROVE_ONCE, PERMISSION_OPTION_APPROVE_ONCE]
        // 옛 카드는 `approve` 하나다. 새 카드는 고른 갈래 → 주 버튼 순으로 카드에 있는 것을 적는다.
        : [args.decision, PERMISSION_OPTION_APPROVE_MANDATE, PERMISSION_OPTION_APPROVE_NEW_MANDATE, PERMISSION_OPTION_APPROVE, PERMISSION_OPTION_APPROVE_ONCE]),
      viaPermissionDecision: true,
    });
    const card = typeof answered === 'object' ? answered : await getMessageById(pool, row.cardMessageId);
    if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
  }
  return { ok: true, status, grantExpiresAt: grantExpiresAt?.toISOString() ?? null, ...(approval ? { approvalExpiresAt: approval.expiresAt.toISOString() } : {}), cardMessageId: row.cardMessageId, ...(grantMode ? { grantMode } : {}) };
}

/** 카드에 적을 답 — 후보 중 카드 선택지에 있는 첫 것(옛 카드·새 카드 둘 다). 없으면 첫 후보(전과 같다: `unknown_option` 이면 깨우지 못할 뿐). */
async function answerOptionId(pool: Pool, cardMessageId: string, candidates: string[]): Promise<string> {
  const ids = (await pool.query<{ ids: string[] | null }>(
    `select array(select jsonb_array_elements(meta->'ask'->'options')->>'id') as ids from message where id = $1`, [cardMessageId])).rows[0]?.ids ?? [];
  return candidates.find((c) => ids.includes(c)) ?? candidates[0]!;
}

/**
 * W4-3: 카드의 스레드 머리에 소유자 위임을 세운다(이미 있으면 그것). 머리 글이 이 채널의 지워지지 않은 글이어야 하고,
 * 머리에 다른 위임이 붙어 있거나 그 위임의 소유자가 다르면 세우지 않는다(null).
 * 머리 글은 **소유자 본인이나 그 소유자의 에이전트**가 쓴 것이어야 한다(security F2) — 위임 키는 그런 글에만 있다는 W1 불변식.
 * 남의 글에 키를 찍으면 그 글로 뜬 턴이 키를 얻는다(`issueTurnLease` 는 원인 글의 `mandate_id` 를 믿는다).
 */
async function mandateForCardThread(client: PoolClient, args: { ownerId: string; channelId: string; threadRootId: string; now: Date }): Promise<string | null> {
  const root = (await client.query<{ mandateId: string | null; ownAuthor: boolean }>(
    `select m.mandate_id as "mandateId",
            (m.author_id = $3 or exists (select 1 from agent_config c where c.account_id = m.author_id and c.owner_account_id = $3)) as "ownAuthor"
       from message m where m.id = $1 and m.channel_id = $2 and m.deleted_at is null for update of m`,
    [args.threadRootId, args.channelId, args.ownerId])).rows[0];
  if (!root || !root.ownAuthor) return null;
  if (root.mandateId) {
    const owner = await validMandateOwner(client, root.mandateId, args.now);
    if (owner !== args.ownerId) return null;
    await client.query(`update mandate set last_activity_at = greatest(last_activity_at, $2) where id = $1`, [root.mandateId, args.now]);
    return root.mandateId;
  }
  const id = (await client.query<{ id: string; owner: string; ended: boolean }>(
    `insert into mandate (owner_account_id, root_message_id, channel_id, thread_root_id, created_at, last_activity_at)
     values ($1, $2, $3, $2, $4, $4)
     on conflict (root_message_id) do update set last_activity_at = greatest(mandate.last_activity_at, excluded.last_activity_at)
     returning id, owner_account_id as owner, ended_at is not null as ended`,
    [args.ownerId, args.threadRootId, args.channelId, args.now])).rows[0]!;
  if (id.owner !== args.ownerId || id.ended) return null;
  await client.query(`update message set mandate_id = $2 where id = $1 and mandate_id is null`, [args.threadRootId, id.id]);
  return id.id;
}

type MandateLineOutcome =
  | { ok: true; mandateId: string; lineId: string; cap: Cap; scope: string; via: LineVia }
  | { ok: false; mandateId: string; cap: Cap; code: string; detail?: string };

/** 요청 종류 → 위임 줄의 능력(W4). */
const CAP_FOR_KIND: Record<PermissionKind, Cap> = { tool: 'tool', command: 'command', merge: 'merge' };

/**
 * 승인된 권한 요청을 그 요청의 위임에 줄 하나로 적는다(W4). 위의 grant(account_grant·command_grant·merge_approval)와 **따로**,
 * 그 위에 더할 뿐이다 — 판정은 아직 grant 가 한다(위임 판정 스위치가 꺼져 있으면 사용자에게 바뀌는 것이 없다).
 *
 * - scope 는 능력 등록부(`validateCapScope`)로 다시 판정한다 — 정규형이 아니면 줄을 적지 않는다(`bad_scope`).
 * - 위임이 끝났거나 7일 넘게 쉬었으면 적지 않는다(`mandate_invalid`).
 * - 줄 쓰기가 던지면 savepoint 로 그 부분만 되돌린다 — 결정·grant 는 그대로 커밋된다.
 *
 * 위임 없는 턴의 요청은 여기 오지 않는다(부르는 쪽이 `mandateId` 를 본다). 나중에 「이 스레드에 위임장 만들고 줄 더하기」가
 * 오면 그 자리에서 위임을 만든 뒤 이 함수를 부르면 된다.
 */
export async function addLineFromRequest(
  client: PoolClient,
  args: {
    request: { id: string; kind: PermissionKind; target: string; mandateId: string | null };
    decision: PermissionDecision; actorId: string; via: LineVia; now: Date;
    /** 7일 승인(tool·merge) — 같은 결정에서 쓴 account_grant 의 `expires_at`. 줄의 `limits.until` 이 된다. */
    until?: Date;
    /** 머지 거절 카드의 1회 승인 — 줄을 그 PR·head 1회로 좁힌다. */
    once?: { number: number; headSha: string; ghUser: string | null; ciOverride: boolean };
  },
): Promise<MandateLineOutcome | null> {
  const mandateId = args.request.mandateId;
  if (!mandateId || args.decision === 'deny') return null;
  const cap = CAP_FOR_KIND[args.request.kind];
  const v = validateCapScope(cap, args.request.target);
  if (!v.ok) return { ok: false, mandateId, cap, code: 'bad_scope', detail: v.code };
  if (!(await validMandateOwner(client, mandateId, args.now))) return { ok: false, mandateId, cap, code: 'mandate_invalid' };
  const limits: LineLimits = {};
  if (args.request.kind === 'merge' && args.decision === 'approve_once') {
    if (!args.once) return { ok: false, mandateId, cap, code: 'no_once' };
    Object.assign(limits, { pr: args.once.number, head: args.once.headSha, uses: 1, ghUser: args.once.ghUser, ciOverride: args.once.ciOverride });
  } else if (args.request.kind === 'command') {
    // 명령 grant 와 같은 기한(1시간). 「이번 한 번」은 한 번만.
    limits.until = new Date(args.now.getTime() + COMMAND_GRANT_TTL_MS).toISOString();
    if (args.decision === 'approve_once') limits.uses = 1;
  } else if (isStandingApprove(args.decision)) {
    // 7일 승인: grant 와 같은 기한. 기한을 모르면 줄을 적지 않는다(기한 없는 줄을 만들지 않는다).
    if (!args.until) return { ok: false, mandateId, cap, code: 'no_until' };
    limits.until = args.until.toISOString();
  }
  await client.query('savepoint mandate_line_from_request');
  try {
    const added = await addMandateLine(client, {
      mandateId, cap, scope: v.scope, limits, grantedBy: args.actorId, via: args.via, requestId: args.request.id, now: args.now,
    });
    if (!added.ok) {
      await client.query('rollback to savepoint mandate_line_from_request');
      return { ok: false, mandateId, cap, code: added.code, ...(added.detail ? { detail: added.detail } : {}) };
    }
    await client.query('release savepoint mandate_line_from_request');
    return { ok: true, mandateId, lineId: added.line.id, cap, scope: added.line.scope, via: args.via };
  } catch (err) {
    await client.query('rollback to savepoint mandate_line_from_request');
    console.warn('[permission] mandate line add failed', err);
    return { ok: false, mandateId, cap, code: 'error', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' };
  }
}

async function auditLineOutcome(pool: Pool, args: { actorId: string; agentId: string; requestId: string; outcome: MandateLineOutcome }): Promise<void> {
  const o = args.outcome;
  try {
    await recordAudit(pool, o.ok
      ? { action: 'mandate.line.added', actorId: args.actorId, target: args.agentId,
          detail: { mandateId: o.mandateId, lineId: o.lineId, cap: o.cap, scope: o.scope, via: o.via, requestId: args.requestId } }
      : { action: 'mandate.line.add_failed', actorId: args.actorId, target: args.agentId,
          detail: { mandateId: o.mandateId, cap: o.cap, code: o.code, ...(o.detail ? { detail: o.detail } : {}), requestId: args.requestId } });
  } catch (err) {
    console.warn('[permission] mandate line audit failed', err);
  }
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
  // W4: grant 를 지우는 일과 그 grant 와 함께 적힌 위임 줄을 닫는 일은 한 트랜잭션 — 거둔 뒤에도 줄이 남아 머지·도구를
  // 허락하지 않게, 그리고 줄 닫기가 실패하면 grant 도 지워지지 않게.
  const client = await pool.connect();
  let scope = '';
  try {
    await client.query('begin');
    const del = await client.query<{ scope: string }>(
      `delete from account_grant where account_id = $1 and capability = $2 and scope = any($3::text[]) returning scope`,
      [args.agentId, capability, scopes]);
    scope = del.rows[0]?.scope ?? '';
    if (!scope) {
      await client.query('rollback');
      return { ok: false, code: 'not_found', message: 'no such grant on this agent' };
    }
    for (const d of del.rows) await revokeLinesForGrant(client, { agentId: args.agentId, capability, scope: d.scope });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
): Promise<{ body: string; options: { id: string; label: string }[]; prompt?: string; mirror: PermissionMirrorMeta } | null> {
  const r = (await pool.query<{ meta: Record<string, unknown>; channelId: string; handle: string | null }>(
    `select m.meta, m.channel_id as "channelId", a.handle
       from message m left join account a on a.id = m.author_id
      where m.id = $1 and m.deleted_at is null and m.meta ? 'permissionRequest'`, [rootId])).rows[0];
  if (!r) return null;
  const pr = r.meta.permissionRequest as PermissionRequestMeta;
  const ask = r.meta.ask as { options?: { id: string; label: string }[]; prompt?: string } | undefined;
  const ciOnce = pr.kind === 'merge' && pr.once?.reason === 'ci_not_green';
  const options = ask?.options?.map((o) => ({ id: o.id, label: o.label })) ?? permissionCardOptions(pr.kind, { ciOnce, once: !!pr.once, mandate: !!pr.mandateId });
  const handle = `@${r.handle ?? 'agent'}`;
  const prompt = typeof ask?.prompt === 'string' ? ask.prompt : undefined;
  if (await mirrorAudienceSeesRoot(pool, r.channelId, mirrorChannelId)) {
    // W4-2: 원본을 볼 수 있는 거울은 같은 카드를 그리도록 once(gh 계정 고르기 빼고)·line·mandate 를 싣는다.
    // 거울에서 정할 사람(표시용) — 원본 요청 행의 에이전트 소유자를 DB 에서 읽는다(원본 meta·거울을 세운 쪽의 인자가 아니다).
    // 답할 자격은 `decisions.decide` 가 다시 판정한다.
    const owner = (await pool.query<{ ownerAccountId: string | null }>(
      `select c.owner_account_id as "ownerAccountId" from permission_request p join agent_config c on c.account_id = p.agent_id
        where p.card_message_id = $1`, [rootId])).rows[0]?.ownerAccountId ?? null;
    const mirror: PermissionMirrorMeta = {
      rootId, neutral: false, kind: pr.kind,
      ...(owner ? { ownerAccountId: owner } : {}),
      ...(pr.once ? { once: { number: pr.once.number, headSha: pr.once.headSha, reason: pr.once.reason, ...(pr.once.failedChecks ? { failedChecks: [...pr.once.failedChecks] } : {}) } } : {}),
      ...(pr.line ? { line: pr.line } : {}),
      ...(pr.line ? bodyTargetLineMeta(pr) : {}),
      // H4: 같은 카드를 그리도록 경고 코드와 본문 경고 줄도 옮긴다.
      ...(pr.warnings?.length ? { warnings: orderToolRuleWarnings(pr.warnings) } : {}),
      ...bodyWarningLineMeta(pr.warnings ?? []),
      // 칩은 거울 채널을 기준으로 다시 만든다(F1) — 원본 카드의 이름을 그대로 옮기지 않는다.
      ...(pr.mandate ? await cardMandateMeta(pool, pr.mandate.id, mirrorChannelId) : {}),
    };
    return { body: permissionCardBody(pr, handle), options, ...(prompt ? { prompt } : {}), mirror };
  }
  // 원본 카드 링크(id 만)를 붙인다 — 볼 수 있는 사람은 눌러 원본을 연다. 내용은 싣지 않는다(n9).
  return { body: `권한 요청 · ${handle}\n원래 카드가 있는 채널에서 내용을 확인하고 정해 주세요.\nharkroom://message/${rootId}`, options, ...(prompt ? { prompt } : {}), mirror: { rootId, neutral: true } };
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

/**
 * 계정을 비운 1회 머지 승인(G1)으로 머지했을 때 오퍼레이터가 고른 gh 이름(래퍼 보고, n6)을 그 승인을 낸 권한 카드에 적는다 —
 * 끝난 카드가 「한 번 씀 · gh 이름」을 보이게. 원본을 볼 수 있는 거울(중립이 아닌 것)에도 같은 이름을 옮긴다. 중립 거울은 내용을 싣지 않는다(n9).
 * 이름 모양 확인·실패 보고 거르기는 부르는 쪽(`reportMerge`)이 이미 했다. 카드가 없으면 아무것도 하지 않는다.
 */
export async function noteOnceGhUserUsed(pool: Pool, args: { approvalId: string; ghUserUsed: string }): Promise<void> {
  const cards = (await pool.query(
    `update message m
        set meta = jsonb_set(m.meta, '{permissionRequest}', (m.meta->'permissionRequest') || jsonb_build_object('ghUserUsed', $2::text))
       from permission_request r join merge_approval a on a.denial_id = r.denial_id
      where a.id = $1 and a.gh_user is null and r.status = 'approved_once' and m.id = r.card_message_id
        and m.deleted_at is null and m.meta ? 'permissionRequest'
      returning m.id`,
    [args.approvalId, args.ghUserUsed])).rows as { id: string }[];
  for (const card of cards) {
    const mirrors = (await pool.query<{ id: string }>(
      `update message
          set meta = jsonb_set(meta, '{permissionMirror}', (meta->'permissionMirror') || jsonb_build_object('ghUserUsed', $2::text))
        where meta->'ask'->>'mirrorOf' = $1 and deleted_at is null and meta ? 'permissionMirror'
          and coalesce((meta->'permissionMirror'->>'neutral')::boolean, false) = false
        returning id`,
      [card.id, args.ghUserUsed])).rows;
    for (const id of [card.id, ...mirrors.map((x) => x.id)]) {
      const msg = await getMessageById(pool, id);
      if (msg) emitEvent({ type: 'message.updated', message: msg, audience: await audienceFor(pool, msg.channelId) });
    }
  }
}
