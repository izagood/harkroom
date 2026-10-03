import type { Pool } from 'pg';
import { audienceFor } from './channels.js';
import { emitEvent } from '../events.js';
import { postMessage, getMessageById } from './messages.js';

/**
 * 막힘 카드(외부 API 권한 C안 P4, 설계 스레드 07519d86 · designer v3 ④).
 *
 * 래퍼(`api`·`merge`)가 **서버 판정에서** 거절되면 서버가 그 턴의 스레드에 카드를 세운다. 에이전트의 ask 가 아니다 —
 * 10-03 사고에서 에이전트가 세운 「허용 규칙 넣음」 같은 선택지는 눌러도 아무 데도 쓰이지 않았다. 이 카드는 서버가 아는
 * 사실(누가·무엇을·왜 막혔나)만 싣고, 버튼(desktop)은 소유자 사람 세션의 REST 로만 처리된다.
 *
 * **하루 한 장**: (에이전트, 대상, UTC 날짜) 마다 카드 하나. 다시 막히면 새 카드를 세우지 않고 `count`·`lastAt`·`lastCode` 만
 * 올린다 — 같은 거절이 되풀이되어 스레드를 덮지 않게.
 *
 * 본문은 고정 문구와 서버 값뿐이다. 핸들 앞에 `@` 를 붙이지 않는다 — 본문의 멘션은 실제 부름이 된다(머지 N2).
 * 경로는 질의를 뗀다(질의에 토큰을 붙이는 API 가 있다, #1139 security L1).
 */

/** 카드를 세우는 거절. 그 밖(임대·경로 모양·사슬 깨짐)은 사람이 버튼 하나로 고칠 것이 아니라 카드를 세우지 않는다. */
export const API_CARD_CODES = new Set([
  'not_granted', 'no_connector', 'no_secret', 'secret_expired', 'expired', 'suspended',
  'method_not_allowed', 'path_not_allowed', 'cause_not_human',
]);
export const MERGE_CARD_CODES = new Set(['not_granted', 'cause_not_human']);

export interface BlockedInput {
  kind: 'api' | 'merge';
  agentId: string; channelId: string; threadRootId: string;
  code: string;
  /** api: 연결 id(있으면)·이름, merge: 저장소. */
  connectorId?: string | null; connectorName?: string; repo?: string;
  method?: string; path?: string; number?: number;
  now?: Date;
}

export interface BlockedMeta {
  key: string; kind: 'api' | 'merge'; agentId: string; ownerAccountId: string | null;
  code: string; lastCode: string; count: number; firstAt: string; lastAt: string;
  connectorId: string | null; connectorName: string | null; repo: string | null;
  method: string | null; path: string | null; number: number | null;
}

const reasonText: Record<string, string> = {
  not_granted: '권한 없음', no_connector: '연결 없음', no_secret: '키 없음', secret_expired: '키 만료',
  expired: '권한 만료', suspended: '권한 멈춤', method_not_allowed: '메서드 밖', path_not_allowed: '경로 밖',
  cause_not_human: '사람 글 턴 아님',
};

export async function recordBlocked(pool: Pool, b: BlockedInput): Promise<string | null> {
  const now = b.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const target = b.kind === 'merge' ? `repo:${b.repo ?? ''}` : b.connectorId ? `connector:${b.connectorId}` : `connector-name:${b.connectorName ?? ''}`;
  const key = `${b.kind}:${b.agentId}:${target}:${day}`;
  const path = b.path ? (b.path.split('?')[0] ?? '').slice(0, 300) : null;

  const existing = (await pool.query<{ id: string }>(
    `select id from message where meta->'blocked'->>'key' = $1 and deleted_at is null order by created_at limit 1`, [key])).rows[0];
  if (existing) {
    const r = await pool.query(
      `update message set meta = jsonb_set(jsonb_set(jsonb_set(jsonb_set(meta,
           '{blocked,count}', to_jsonb(coalesce((meta->'blocked'->>'count')::int, 1) + 1)),
           '{blocked,lastAt}', to_jsonb($2::text)),
           '{blocked,lastCode}', to_jsonb($3::text)),
           '{blocked,lastRequest}', to_jsonb($4::text))
        where id = $1 returning id`,
      [existing.id, now.toISOString(), b.code, b.kind === 'merge' ? `#${b.number ?? ''}` : `${b.method ?? ''} ${path ?? ''}`]);
    if (r.rowCount) {
      const row = await getMessageById(pool, existing.id);
      if (row) emitEvent({ type: 'message.updated', message: row, audience: await audienceFor(pool, row.channelId) });
    }
    return existing.id;
  }

  const agent = (await pool.query<{ handle: string; ownerAccountId: string | null }>(
    `select a.handle, c.owner_account_id as "ownerAccountId" from account a left join agent_config c on c.account_id = a.id where a.id = $1`,
    [b.agentId])).rows[0];
  const handle = agent?.handle ?? 'agent';
  const meta: BlockedMeta = {
    key, kind: b.kind, agentId: b.agentId, ownerAccountId: agent?.ownerAccountId ?? null,
    code: b.code, lastCode: b.code, count: 1, firstAt: now.toISOString(), lastAt: now.toISOString(),
    connectorId: b.connectorId ?? null, connectorName: b.connectorName ?? null, repo: b.repo ?? null,
    method: b.method ?? null, path, number: b.number ?? null,
  };
  const what = b.kind === 'merge'
    ? `${b.repo ?? '?'}#${b.number ?? '?'} 머지`
    : `${b.connectorName ?? '?'} ${b.method ?? ''} ${path ?? ''}`.trim();
  const body = `🔒 ${handle} 의 ${what} 가 막혔다 · ${reasonText[b.code] ?? b.code}`.replace(/@/g, '＠');
  const posted = await postMessage(pool, {
    channelId: b.channelId, threadRootId: b.threadRootId, authorId: b.agentId, body, kind: 'system',
    meta: { blocked: meta },
  });
  return posted.failure ? null : posted.message.id;
}
