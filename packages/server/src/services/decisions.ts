import type { Pool } from 'pg';
import { readAskMeta, type MessageRow } from '@harkroom/shared';
import { getMessageById, recordAskAnswer } from './messages.js';
import {
  decidePermissionRequest, PERMISSION_OPTION_APPROVE, PERMISSION_OPTION_APPROVE_HOUR, PERMISSION_OPTION_APPROVE_ONCE, PERMISSION_OPTION_DENY,
  type DecideRefusal, type PermissionDecision,
} from './permissionRequests.js';

/**
 * 결정 하나를 **한 자리에서** 해석하고 정한다(M2). 카드 버튼(`permission-requests/:rid/:decision`·`ask-answer`)·글 승인
 * (`chatApproval`)·거울 카드가 저마다 「무슨 카드인가·누가 정하나」를 따로 읽지 않게, 들어오는 길은 여기로 모은다.
 *
 * - `resolveDecision` — 카드 글 id 하나 → 무엇을 정하는 카드인가. 거울(`ask.mirrorOf`)은 원본으로 따라간다.
 * - `decide` — 해석한 것 + 고른 선택지 → 기존 판정(`decidePermissionRequest` · `recordAskAnswer`)을 그대로 부른다.
 *
 * 판정 자체(소유자·만료·이미 정해짐·1회 머지 대조)는 바뀌지 않는다 — 이 모듈은 길을 모을 뿐이다.
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
  [PERMISSION_OPTION_APPROVE_ONCE]: 'approve_once',
  [PERMISSION_OPTION_APPROVE_HOUR]: 'approve_hour',
  [PERMISSION_OPTION_DENY]: 'deny',
};

/**
 * 해석한 결정을 정한다. 사람 세션 판정은 부른 쪽(라우트·글 올리기)이 먼저 한다.
 *
 * 거울 카드는 지금 **물음 길**로 간다 — `recordAskAnswer` 가 권한 카드의 거울을 거절한다(111). 거울에서 권한을 정하게 하려면
 * 여기 `mirrorMessageId` 갈래만 바꾸면 된다.
 */
export async function decide(pool: Pool, ref: DecisionRef, actorId: string, input: DecideInput): Promise<DecideOutcome> {
  const askMessageId = ref.mirrorMessageId ?? (ref.kind === 'ask' ? ref.cardMessageId : null);
  if (askMessageId) return { kind: 'ask', result: await recordAskAnswer(pool, { messageId: askMessageId, actorId, optionId: input.option }) };
  if (ref.kind !== 'permission') throw new Error('unreachable');
  if (ref.ownerAccountId !== undefined && ref.ownerAccountId !== actorId) {
    return { kind: 'permission', ok: false, status: 403, code: 'forbidden', message: 'only the owner of this agent can decide its permission requests' };
  }
  const decision = Object.hasOwn(OPTION_DECISION, input.option) ? OPTION_DECISION[input.option] : undefined;
  if (!decision) return { kind: 'permission', ok: false, status: 400, code: 'unknown_option', message: 'a permission card takes approve, approve_once, approve_hour or deny' };
  const d = await decidePermissionRequest(pool, {
    agentId: ref.agentId, requestId: ref.requestId, actorId, decision,
    ...(input.once ? { once: input.once } : {}),
    via: input.via === 'chat' && input.chat ? { kind: 'chat', ...input.chat } : { kind: 'button' },
  });
  if (!d.ok) return { kind: 'permission', ...d };
  return { kind: 'permission', ok: true, result: d };
}

/** 카드에서 정한 뒤 화면에 돌려줄 카드(답이 적힌 원본). */
export async function decidedCard(pool: Pool, ref: DecisionRef): Promise<MessageRow | null> {
  return ref.cardMessageId ? getMessageById(pool, ref.cardMessageId) : null;
}
