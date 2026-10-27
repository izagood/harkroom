import type { Pool } from 'pg';
import { CHAIN_BACKSTOP_CONTINUE, CHAIN_BACKSTOP_STOP, type AskMeta } from '@harkroom/shared';
import { audienceFor } from './channels.js';
import { emitEvent, emitPosted } from '../events.js';
import { postMessage } from './messages.js';
import { enqueueAskPush } from './push/pushJobs.js';

/**
 * 백스톱 카드(연쇄 한도 재설계 ③, 2026-10-27). 사람 손길 없이 이어진 에이전트 사슬이 상한(홉 `chain_limit` 또는
 * `CHAIN_BACKSTOP_MS`)에 닿아 동료를 못 부르면, 서버가 그 스레드에 **막힌 에이전트의 소유자** 앞으로 카드를 세운다.
 * 예전에는 사람이 그 스레드에 글을 한 줄 써야 풀렸다 — 이제는 버튼 하나다.
 *
 * - [계속 — 예산 리셋]: 소유자가 원본 카드를 직접 누르면 막힌 에이전트가 `ask_answered` 로 깨어나고, 그 턴은 사슬을 새로 시작한다
 *   (`causeDepth` — 깊이 1, 정체 0, 시작 시각 지금). 거울·일괄·글로 고른 답은 리셋하지 않는다(security n3).
 * - [멈춤]: 에이전트는 답을 읽고 깨어나지만 깊이는 그대로라 동료를 부르지 못한다.
 *
 * 에이전트가 같은 키를 실은 카드를 스스로 세워도 얻는 것은 없다 — 사람이 답한 보통 카드도 이미 리셋이고(①), 이 키는 리셋을 **좁힐** 뿐이다.
 * 한 스레드에 열린 백스톱 카드는 하나다 — 이미 열려 있으면 그것을 돌려준다.
 */
export interface ChainBackstopInput {
  agentId: string; channelId: string; threadRootId: string;
  /** 막힌 글. */
  sourceMessageId: string;
  cappedIds: string[];
  limit: number;
  reason: 'hops' | 'age';
}

export interface ChainBackstopMeta {
  agentId: string; sourceMessageId: string; cappedIds: string[]; limit: number; reason: 'hops' | 'age';
}

export async function raiseChainBackstop(pool: Pool, b: ChainBackstopInput): Promise<string | null> {
  const owner = (await pool.query<{ ownerId: string; handle: string }>(
    `select c.owner_account_id as "ownerId", a.handle
       from account a join agent_config c on c.account_id = a.id join account o on o.id = c.owner_account_id
      where a.id = $1 and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null`,
    [b.agentId])).rows[0];
  // 소유자가 없으면 누를 사람이 없다 — 막힘 표시(`mentionChainCapped`)만 남는다.
  if (!owner) return null;
  const open = (await pool.query<{ id: string }>(
    `select id from message
      where channel_id = $1 and coalesce(thread_root_id, id) = $2 and deleted_at is null
        and meta ? 'chainBackstop'
        and meta->'ask'->>'answeredWith' is null and meta->'ask'->>'closedAt' is null
      order by seq desc limit 1`,
    [b.channelId, b.threadRootId])).rows[0];
  if (open) return open.id;

  const meta: AskMeta & { chainBackstop: ChainBackstopMeta } = {
    kind: 'ask',
    ask: {
      prompt: '사람 없이 이어진 연쇄를 계속할까?',
      options: [
        { id: CHAIN_BACKSTOP_CONTINUE, label: '계속 — 예산 리셋', hint: '홉 수와 24시간을 처음부터 다시 센다', recommended: true },
        { id: CHAIN_BACKSTOP_STOP, label: '멈춤', hint: '에이전트는 동료를 부르지 않는다' },
      ],
      to: { kind: 'account', accountId: owner.ownerId },
      // 묶음 카드의 「추천대로 일괄」로 넘기지 않는다 — 사람이 직접 고르는 카드다.
      irreversible: true,
    },
    chainBackstop: {
      agentId: b.agentId, sourceMessageId: b.sourceMessageId, cappedIds: b.cappedIds, limit: b.limit, reason: b.reason,
    },
  };
  const why = b.reason === 'age' ? '24시간' : `${b.limit}홉`;
  // 본문에는 서버 값만 싣는다. `@` 는 무력화한다 — 이 카드가 누구를 부르면 안 된다.
  const body = `⏸ 사람 없이 이어진 연쇄가 백스톱(${why})에 닿아 ${owner.handle} 의 부름을 멈췄다. 계속하려면 [계속 — 예산 리셋]을 누른다.`
    .replace(/@/g, '＠');
  const posted = await postMessage(pool, {
    channelId: b.channelId, threadRootId: b.threadRootId, authorId: b.agentId, body, serverNotice: true,
    meta: meta as unknown as Record<string, unknown>,
  });
  if (posted.failure) return null;
  if (!posted.replayed) {
    emitPosted(posted, await audienceFor(pool, b.channelId));
    for (const accountId of posted.notified) emitEvent({ type: 'inbox.updated', accountId });
    if (!posted.notified.includes(owner.ownerId)) await enqueueAskPush(pool, owner.ownerId, posted.message.id);
  }
  return posted.message.id;
}
