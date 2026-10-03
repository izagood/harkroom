import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from './channels.js';
import { getMessageById } from './messages.js';

/**
 * 머지 거절 카드 — 거절된 그 자리에서 소유자가 [7일 주기]를 누른다(스레드 febe9ff8 P3, security C1~C6).
 *
 * 흐름: 래퍼의 판정이 `not_granted` 이고 나머지는 통과하면 `checkMerge` 가 `merge_denial` 한 줄을 남기고 `denialId` 를 돌려준다
 * → 에이전트가 `message.ask` 에 `mergeDenialId` 를 실어 카드를 세운다(이 파일의 `prepareDenialCard` 가 C1·C3 을 본다) →
 * 소유자 사람 세션이 `POST /agents/:id/merge-denials/:denialId/grant` 로 7일 grant 를 만든다(`grantFromDenial`, C4~C6) →
 * 소유자가 같은 카드에서 「다시 머지」를 고르면 #1134 의 F4 경로(소유자가 에이전트 자신의 카드에 답함 = 사람이 띄운 턴)로
 * 새 턴이 뜬다. 서버가 시스템 줄을 세우지 않는 이유가 이 마지막 걸음이다 — 시스템 줄에 답해 뜬 턴은 사람 글이 아니라 F4 에 걸린다.
 *
 * **[7일 주기]는 ask 선택지가 아니다**(C5) — `recordAskAnswer` 는 소유자가 아닌 사람도 답할 수 있다. 버튼은 별도 REST 이고
 * 그 REST 는 사람 **세션**만 받는다(PAT·에이전트 토큰 403).
 *
 * 범위 밖(security, G2 위협 모델과 같다): 같은 uid 로 도는 에이전트가 사람의 세션 토큰을 읽어 이 REST 를 부르는 경우.
 */

/** grant 의 기한 — 카드에서는 7일 고정(security 판정 2). 30일·기한 없음은 설정 화면에서만. */
export const DENIAL_GRANT_TTL_MS = 7 * 86_400_000;

/**
 * 배포 저장소(머지가 곧 배포) — 카드에 주기 버튼을 띄우지 않고 서버 REST 도 거절한다(C6). 설정 화면에서는 사람이 정확한
 * 이름으로 줄 수 있다 — 클릭 한 번으로 "배포 저장소는 상시 권한 없음" 규칙을 깨지 않게 하는 것이 목적이다.
 * `HARKROOM_MERGE_DEPLOY_REPOS` = 쉼표로 나눈 `owner/name` 목록(대소문자 무시). 비우면 없음.
 */
export function deployRepoScopes(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.HARKROOM_MERGE_DEPLOY_REPOS ?? '';
  return new Set(raw.split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+$/.test(x)).map((x) => `repo:${x}`));
}

export interface MergeDenialMeta {
  /** 카드 묶음 키 — (에이전트, 저장소, 스레드, UTC 날짜)마다 한 장(C3). */
  key: string;
  /** 지금 이 카드의 버튼이 쓸 거절 기록. 같은 날 다시 막히면 새 기록으로 바뀐다. */
  denialId: string;
  agentId: string;
  ownerAccountId: string | null;
  repo: string;
  number: number;
  deployRepo: boolean;
  count: number;
  firstAt: string;
  lastAt: string;
  granted?: { by: string; at: string; expiresAt: string };
}

interface DenialRow {
  id: string; agentId: string; scope: string; number: number; channelId: string; threadRootId: string;
  expired: boolean; used: boolean; cardMessageId: string | null;
}

async function readDenial(db: Pool | PoolClient, id: string, now: Date, lock = false): Promise<DenialRow | undefined> {
  return (await db.query<DenialRow>(
    `select id, agent_id as "agentId", scope, pr_number as number, channel_id as "channelId", thread_root_id as "threadRootId",
            expires_at <= $2 as expired, used_at is not null as used, card_message_id as "cardMessageId"
       from merge_denial where id = $1${lock ? ' for update' : ''}`, [id, now])).rows[0];
}

export type DenialCardRefusal = 'denial_not_found' | 'denial_other_agent' | 'denial_other_thread' | 'denial_used' | 'denial_expired';

export const DENIAL_CARD_REFUSAL_MESSAGE: Record<DenialCardRefusal, string> = {
  denial_not_found: 'no such merge denial — use the denialId the merge wrapper returned',
  denial_other_agent: 'that merge denial belongs to another agent',
  denial_other_thread: 'that merge denial happened in another thread; post the card in the thread where the merge was refused',
  denial_used: 'that merge denial was already used to grant permission',
  denial_expired: 'that merge denial expired; ask the wrapper again',
};

/**
 * `message.ask` 에 실린 `mergeDenialId` 를 잰다(C1) — 거절의 에이전트가 부른 에이전트와 같은지, 스레드가 같은지, 안 썼고
 * 안 만료됐는지. 통과하면 카드 meta(권한 칸은 서버 값뿐 — C3)와, 같은 날 같은 저장소 카드가 이미 있으면 그 id 를 준다.
 */
export async function prepareDenialCard(
  pool: Pool,
  args: { agentId: string; denialId: string; channelId: string; threadRootId: string | null; now?: Date },
): Promise<{ ok: false; code: DenialCardRefusal } | { ok: true; meta: MergeDenialMeta; existingCardId: string | null }> {
  const now = args.now ?? new Date();
  const d = await readDenial(pool, args.denialId, now);
  if (!d) return { ok: false, code: 'denial_not_found' };
  if (d.agentId !== args.agentId) return { ok: false, code: 'denial_other_agent' };
  if (d.channelId !== args.channelId || d.threadRootId !== (args.threadRootId ?? '')) return { ok: false, code: 'denial_other_thread' };
  if (d.used) return { ok: false, code: 'denial_used' };
  if (d.expired) return { ok: false, code: 'denial_expired' };

  const day = now.toISOString().slice(0, 10);
  const key = `merge:${d.agentId}:${d.scope}:${d.threadRootId}:${day}`;
  const owner = (await pool.query<{ ownerAccountId: string | null }>(
    `select owner_account_id as "ownerAccountId" from agent_config where account_id = $1`, [d.agentId])).rows[0];
  const existing = (await pool.query<{ id: string }>(
    `select id from message
      where meta->'mergeDenial'->>'key' = $1 and channel_id = $2 and coalesce(thread_root_id, id) = $3 and deleted_at is null
      order by created_at limit 1`, [key, d.channelId, d.threadRootId])).rows[0];
  const meta: MergeDenialMeta = {
    key, denialId: d.id, agentId: d.agentId, ownerAccountId: owner?.ownerAccountId ?? null,
    repo: d.scope.slice('repo:'.length), number: d.number, deployRepo: deployRepoScopes().has(d.scope),
    count: 1, firstAt: now.toISOString(), lastAt: now.toISOString(),
  };
  return { ok: true, meta, existingCardId: existing?.id ?? null };
}

/** 새 카드를 세운 뒤 — 거절 기록에 카드 id 를 적는다(버튼이 그 카드를 고친다). */
export async function linkDenialCard(pool: Pool, denialId: string, cardMessageId: string): Promise<void> {
  await pool.query(`update merge_denial set card_message_id = $2 where id = $1 and card_message_id is null`, [denialId, cardMessageId]);
}

/**
 * 같은 날 같은 저장소로 다시 막혔다(C3) — 새 카드를 세우지 않고 있던 카드의 횟수·시각·버튼이 쓸 거절 기록만 바꾼다.
 * 이미 준(granted) 카드면 그 표시는 지운다 — 다시 막혔다는 것은 그 권한이 지금 없다는 뜻이다(거둬졌거나 만료).
 */
export async function bumpDenialCard(pool: Pool, cardId: string, meta: MergeDenialMeta, now = new Date()): Promise<void> {
  const r = await pool.query(
    `update message set meta = jsonb_set(jsonb_set(jsonb_set(jsonb_set(meta #- '{mergeDenial,granted}',
         '{mergeDenial,count}', to_jsonb(coalesce((meta->'mergeDenial'->>'count')::int, 1) + 1)),
         '{mergeDenial,lastAt}', to_jsonb($2::text)),
         '{mergeDenial,denialId}', to_jsonb($3::text)),
         '{mergeDenial,number}', to_jsonb($4::int))
      where id = $1 returning id`, [cardId, now.toISOString(), meta.denialId, meta.number]);
  await linkDenialCard(pool, meta.denialId, cardId);
  if (r.rowCount) await emitCard(pool, cardId);
}

async function emitCard(pool: Pool, id: string): Promise<void> {
  const row = await getMessageById(pool, id);
  if (row) emitEvent({ type: 'message.updated', message: row, audience: await audienceFor(pool, row.channelId) });
}

export type DenialGrantRefusal = { status: 403 | 404 | 409; code: string; message: string };

/**
 * [7일 주기] — 거절 기록을 **한 번** 써서 그 저장소 grant 를 7일 준다(C4). 사람 세션·소유자 판정은 라우트가 먼저 한다(C5).
 * scope 와 기한은 요청에서 받지 않는다 — 이 기록과 상수다. 배포 저장소는 거절한다(C6, 기록을 쓰지 않는다).
 */
export async function grantFromDenial(
  pool: Pool,
  args: { agentId: string; denialId: string; actorId: string; now?: Date },
): Promise<{ ok: true; scope: string; expiresAt: string; cardMessageId: string | null } | ({ ok: false } & DenialGrantRefusal)> {
  const now = args.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const d = await readDenial(client, args.denialId, now, true);
    // `:id` 가 거절의 에이전트와 다르면 없는 것과 같다 — 남의 거절 id 를 내 에이전트 경로에 꽂는 길을 닫는다(C4).
    if (!d || d.agentId !== args.agentId) { await client.query('rollback'); return { ok: false, status: 404, code: 'not_found', message: 'no such merge denial for this agent' }; }
    if (deployRepoScopes().has(d.scope)) {
      await client.query('rollback');
      return { ok: false, status: 403, code: 'deploy_repo', message: 'a deploy repository is not granted from a card — grant it in settings' };
    }
    if (d.used) { await client.query('rollback'); return { ok: false, status: 409, code: 'denial_used', message: 'this denial was already used' }; }
    if (d.expired) { await client.query('rollback'); return { ok: false, status: 409, code: 'denial_expired', message: 'this denial expired' }; }
    const used = await client.query(
      `update merge_denial set used_at = $2, used_by = $3 where id = $1 and used_at is null returning id`, [d.id, now, args.actorId]);
    if (!used.rowCount) { await client.query('rollback'); return { ok: false, status: 409, code: 'denial_used', message: 'this denial was already used' }; }
    const expiresAt = new Date(now.getTime() + DENIAL_GRANT_TTL_MS);
    // 있던 grant(만료된 것 등)는 덮는다 — `allow_agent_cause` 는 끈다(카드는 좁히기만 한다).
    await client.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause)
       values ($1, 'repo.merge', $2, $3, $4, false)
       on conflict (account_id, capability, scope) do update
         set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, allow_agent_cause = false`,
      [d.agentId, d.scope, args.actorId, expiresAt]);
    if (d.cardMessageId) {
      await client.query(
        `update message set meta = jsonb_set(meta, '{mergeDenial,granted}', $2::jsonb) where id = $1 and meta ? 'mergeDenial'`,
        [d.cardMessageId, JSON.stringify({ by: args.actorId, at: now.toISOString(), expiresAt: expiresAt.toISOString() })]);
    }
    await client.query('commit');
    await recordAudit(pool, {
      action: 'grant.given', actorId: args.actorId, target: d.agentId,
      detail: { capability: 'repo.merge', scope: d.scope, expiresAt: expiresAt.toISOString(), allowAgentCause: false, via: 'merge_denial', denialId: d.id },
    });
    emitEvent({ type: 'grant.changed', accountId: d.agentId, audience: 'all' });
    if (d.cardMessageId) await emitCard(pool, d.cardMessageId);
    return { ok: true, scope: d.scope, expiresAt: expiresAt.toISOString(), cardMessageId: d.cardMessageId };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
