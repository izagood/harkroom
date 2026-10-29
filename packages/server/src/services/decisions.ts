import type { Pool } from 'pg';
import { readAskMeta, type MessageRow } from '@harkroom/shared';
import { getMessageById, readAskRow, recordAskAnswer } from './messages.js';
import { assertChannelVisible } from './channels.js';
import { mayDecideFor } from './deciders.js';
import {
  decidePermissionRequest, PERMISSION_OPTION_APPROVE, PERMISSION_OPTION_APPROVE_HOUR, PERMISSION_OPTION_APPROVE_MANDATE, PERMISSION_OPTION_APPROVE_NEW_MANDATE,
  PERMISSION_OPTION_APPROVE_ONCE, PERMISSION_OPTION_DENY,
  type DecideRefusal, type PermissionDecision,
} from './permissionRequests.js';

/**
 * 결정 하나를 **한 자리에서** 해석하고 정한다(M2). 카드 버튼(`permission-requests/:rid/:decision`·`ask-answer`)·글 승인
 * (`chatApproval`)·거울 카드가 저마다 「무슨 카드인가·누가 정하나」를 따로 읽지 않게, 들어오는 길은 여기로 모은다.
 *
 * - `resolveDecision` — 카드 글 id 하나 → 무엇을 정하는 카드인가. 거울(`ask.mirrorOf`)은 원본으로 따라간다.
 * - `decide` — 해석한 것 + 고른 선택지 → 기존 판정(`decidePermissionRequest` · `recordAskAnswer`)을 그대로 부른다.
 *
 * 판정 자체(누가 정하나·만료·이미 정해짐·1회 머지 대조)는 바뀌지 않는다 — 이 모듈은 길을 모을 뿐이다.
 */

export type DecisionVia = 'button' | 'chat' | 'mirror';

export type DecisionRef =
  | {
    kind: 'permission'; requestId: string; agentId: string; cardMessageId: string | null;
    /** 거울 카드에서 왔으면 그 거울 글 id(`cardMessageId` 는 원본). */
    mirrorMessageId?: string;
    /** `resolveDecision` 이 서버 줄에서 읽은 소유자. 있으면 `decide` 가 대조한다 — 없으면 부른 쪽이 이미 대조했다. */
    ownerAccountId?: string | null;
  }
  | { kind: 'ask'; cardMessageId: string; mirrorMessageId?: string };

export type DecideInput = {
  /** 선택지 id. 권한 카드는 선택지 id 가 곧 결정이다(approve·approve_once·approve_hour·deny). */
  option: string;
  via: DecisionVia;
  /** 머지 거절 카드의 [이번 한 번 머지] — gh 계정·CI 완화와 카드가 보여 준 값(대조용). */
  once?: { ghUser: string | null; relaxChecks: boolean; number: number; headSha: string; failedChecks?: string[] };
  /** `via: 'chat'` 일 때 — 승인한 글과 어떻게 가리켰나(감사·카드 meta). */
  chat?: { messageId: string; target?: 'T1' | 'T2' | 'T3' };
};

type PermissionDecided = Extract<Awaited<ReturnType<typeof decidePermissionRequest>>, { ok: true }>;

export type DecideOutcome =
  | { kind: 'permission'; ok: true; result: PermissionDecided }
  | ({ kind: 'permission'; ok: false } & (DecideRefusal | { status: 400; code: 'unknown_option'; message: string }))
  | { kind: 'ask'; result: Awaited<ReturnType<typeof recordAskAnswer>> };

/**
 * 카드 글 id → 무엇을 정하는 카드인가. 지워졌거나 결정 카드가 아니면 null.
 * 권한 카드인지는 카드 meta 가 아니라 **요청 줄**(`permission_request.card_message_id`)로 정한다.
 * 거울이면 원본을 해석하고 `mirrorMessageId` 에 거울을 남긴다. 원본이 지워졌으면 거울 혼자 물음이다(`recordAskAnswer` 와 같다).
 */
export async function resolveDecision(pool: Pool, messageId: string): Promise<DecisionRef | null> {
  const meta = await readMeta(pool, messageId);
  if (!meta) return null;
  const mirrorOf = readAskMeta(meta)?.mirrorOf;
  if (mirrorOf) {
    const root = await resolveCard(pool, mirrorOf, await readMeta(pool, mirrorOf));
    return root ? { ...root, mirrorMessageId: messageId } : { kind: 'ask', cardMessageId: messageId };
  }
  return resolveCard(pool, messageId, meta);
}

async function readMeta(pool: Pool, messageId: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query<{ meta: Record<string, unknown> }>(`select meta from message where id = $1 and deleted_at is null`, [messageId]);
  return r.rows[0]?.meta ?? null;
}

async function resolveCard(pool: Pool, messageId: string, meta: Record<string, unknown> | null): Promise<DecisionRef | null> {
  if (!meta) return null;
  const p = (await pool.query<{ requestId: string; agentId: string; ownerAccountId: string | null }>(
    `select p.id as "requestId", p.agent_id as "agentId", c.owner_account_id as "ownerAccountId"
       from permission_request p join agent_config c on c.account_id = p.agent_id
      where p.card_message_id = $1`, [messageId])).rows[0];
  if (p) return { kind: 'permission', requestId: p.requestId, agentId: p.agentId, cardMessageId: messageId, ownerAccountId: p.ownerAccountId };
  return readAskMeta(meta) ? { kind: 'ask', cardMessageId: messageId } : null;
}

const OPTION_DECISION: Record<string, PermissionDecision> = {
  [PERMISSION_OPTION_APPROVE]: 'approve',
  // W4b. `approve_turn`(tool 이 턴만)은 서버가 턴 단위로 셀 수 없어 받지 않는다(unknown_option).
  [PERMISSION_OPTION_APPROVE_MANDATE]: 'approve_mandate',
  [PERMISSION_OPTION_APPROVE_NEW_MANDATE]: 'approve_new_mandate',
  [PERMISSION_OPTION_APPROVE_ONCE]: 'approve_once',
  [PERMISSION_OPTION_APPROVE_HOUR]: 'approve_hour',
  [PERMISSION_OPTION_DENY]: 'deny',
};

/**
 * 해석한 결정을 정한다. 사람 세션 판정은 부른 쪽(라우트·글 올리기)이 먼저 한다.
 *
 * 거울 카드(P3): 권한 카드의 거울이면 **서버가 세운 거울인지**(`isGenuinePermissionMirror`) 본 뒤 원본 요청으로 넘긴다 —
 * 답은 원본 카드에 한 번 적히고 거울은 `syncAskMirrors` 가 따라 닫는다. 진짜 거울이 아니면 전처럼 물음 길로 가서 거절된다.
 * 권한 요청은 **언제나** 요청 줄·에이전트 범위를 DB 에서 다시 읽어 `mayDecideFor` 로 대조한다(부른 쪽이 넘긴 `ownerAccountId` 에 기대지 않는다).
 */
export async function decide(pool: Pool, ref: DecisionRef, actorId: string, input: DecideInput): Promise<DecideOutcome> {
  if (ref.kind === 'permission' && ref.mirrorMessageId && ref.cardMessageId) {
    if (!(await isGenuinePermissionMirror(pool, ref.mirrorMessageId, ref.cardMessageId, ref.agentId))) {
      return { kind: 'ask', result: await recordAskAnswer(pool, { messageId: ref.mirrorMessageId, actorId, optionId: input.option }) };
    }
  } else {
    const askMessageId = ref.mirrorMessageId ?? (ref.kind === 'ask' ? ref.cardMessageId : null);
    if (askMessageId) return { kind: 'ask', result: await recordAskAnswer(pool, { messageId: askMessageId, actorId, optionId: input.option }) };
  }
  if (ref.kind !== 'permission') throw new Error('unreachable');
  const forbidden = { kind: 'permission', ok: false, status: 403, code: 'forbidden', message: 'only someone who may invoke this agent here can decide its permission requests' } as const;
  // 누가 정하나(소유자 결정 2026-10-29) — 요청이 선 채널에서 이 에이전트를 부를 수 있는 사람(`deciders.ts`).
  // security n1: 부른 쪽이 넘긴 값에 기대지 않고 요청 줄·에이전트 범위를 DB 에서 지금 읽는다.
  const channelId = (await pool.query<{ channelId: string }>(
    `select channel_id as "channelId" from permission_request where id = $1 and agent_id = $2`, [ref.requestId, ref.agentId])).rows[0]?.channelId ?? null;
  const verdict = await mayDecideFor(pool, { agentId: ref.agentId, actorId, channelId });
  if (!verdict.ok) return forbidden;
  const decision = Object.hasOwn(OPTION_DECISION, input.option) ? OPTION_DECISION[input.option] : undefined;
  if (!decision) return { kind: 'permission', ok: false, status: 400, code: 'unknown_option', message: 'a permission card takes approve_mandate, approve_new_mandate, approve_once, approve, approve_hour or deny' };
  let once = input.once;
  if (ref.mirrorMessageId && ref.cardMessageId) {
    // 거울로 정하는 사람도 원본 채널을 볼 수 있어야 한다 — 그 이름으로 원본에 적는다.
    const root = await readAskRow(pool, ref.cardMessageId);
    if (!root || !(await assertChannelVisible(pool, root.channelId, actorId))) return forbidden;
    // [이번 한 번]을 거울에서 누르면 PR·head 는 원본 카드가 보인 값이다. gh 계정은 비워 오퍼레이터가 고른다(G1).
    if (decision === 'approve_once' && !once) once = await onceFromCard(pool, ref.cardMessageId);
  } else if (decision === 'approve_once' && !once && ref.cardMessageId) {
    // W4b: 카드 선택지 [이번 한 번](ask-answer·글 승인) — PR·head 는 카드의 값, gh 계정은 비워 오퍼레이터가 고른다(G1).
    once = await onceFromCard(pool, ref.cardMessageId);
  }
  const via: { kind: 'chat'; messageId: string; target?: 'T1' | 'T2' | 'T3' } | { kind: 'button' } | { kind: 'mirror'; mirrorMessageId: string } =
    input.via === 'chat' && input.chat ? { kind: 'chat', ...input.chat }
    : ref.mirrorMessageId ? { kind: 'mirror', mirrorMessageId: ref.mirrorMessageId }
    : { kind: 'button' };
  const d = await decidePermissionRequest(pool, {
    agentId: ref.agentId, requestId: ref.requestId, actorId, decision, asOwner: verdict.asOwner,
    ...(once ? { once } : {}),
    via,
  });
  if (!d.ok) return { kind: 'permission', ...d };
  return { kind: 'permission', ok: true, result: d };
}

/** 원본 권한 카드의 `permissionRequest.once`(서버가 거절 기록으로 채운 값)로 1회 머지 입력을 만든다. */
async function onceFromCard(pool: Pool, cardMessageId: string): Promise<DecideInput['once']> {
  const meta = await readMeta(pool, cardMessageId);
  const o = (meta?.permissionRequest as { once?: { number?: unknown; headSha?: unknown; reason?: unknown; failedChecks?: unknown } } | undefined)?.once;
  if (!o || typeof o.number !== 'number' || typeof o.headSha !== 'string') return undefined;
  const failed = Array.isArray(o.failedChecks) ? o.failedChecks.filter((x): x is string => typeof x === 'string') : undefined;
  return { ghUser: null, relaxChecks: o.reason === 'ci_not_green', number: o.number, headSha: o.headSha, ...(failed ? { failedChecks: failed } : {}) };
}

/**
 * 서버가 받아 세운 거울인가(security n2) — `checkAskMirror` 가 거울을 만들 때 본 조건을 지금 다시 본다:
 * 거울은 에이전트가 쓴 사람 앞 물음이고, 원본을 가리키며, 자기는 권한 카드가 아니고, 선택지 id 가 원본과 같고,
 * 쓴 에이전트가 원본 채널을 볼 수 있으며, 요청 에이전트와 **같은 소유자**의 에이전트다.
 */
export async function isGenuinePermissionMirror(pool: Pool, mirrorId: string, rootId: string, requestAgentId: string): Promise<boolean> {
  const m = (await pool.query<{ meta: Record<string, unknown>; authorId: string | null; authorKind: string | null; ownerAccountId: string | null }>(
    `select m.meta, m.author_id as "authorId", a.kind as "authorKind", c.owner_account_id as "ownerAccountId"
       from message m left join account a on a.id = m.author_id left join agent_config c on c.account_id = m.author_id
      where m.id = $1 and m.deleted_at is null`, [mirrorId])).rows[0];
  if (!m || !m.authorId || m.authorKind !== 'agent' || !m.ownerAccountId) return false;
  if (m.meta.kind !== 'ask' || m.meta.permissionRequest !== undefined) return false;
  const ask = readAskMeta(m.meta);
  if (!ask || ask.mirrorOf !== rootId || ask.to.kind !== 'human') return false;
  const root = await readAskRow(pool, rootId);
  if (!root || root.ask.mirrorOf || root.ask.to.kind !== 'human') return false;
  const a = ask.options.map((o) => o.id).sort();
  const b = root.ask.options.map((o) => o.id).sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) return false;
  if (!(await assertChannelVisible(pool, root.channelId, m.authorId))) return false;
  const owner = (await pool.query<{ ownerAccountId: string | null }>(
    `select owner_account_id as "ownerAccountId" from agent_config where account_id = $1`, [requestAgentId])).rows[0]?.ownerAccountId ?? null;
  return owner !== null && owner === m.ownerAccountId;
}

/** 카드에서 정한 뒤 화면에 돌려줄 카드(답이 적힌 원본). */
export async function decidedCard(pool: Pool, ref: DecisionRef): Promise<MessageRow | null> {
  return ref.cardMessageId ? getMessageById(pool, ref.cardMessageId) : null;
}
