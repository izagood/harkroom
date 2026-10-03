import type { Pool } from 'pg';
import { audienceFor } from './channels.js';
import { emitEvent } from '../events.js';
import { postMessage, getMessageById } from './messages.js';
import { safePath } from '../auth/apiGrants.js';

/**
 * API 막힘 카드(외부 API 권한 C안 P4, 설계 스레드 07519d86 · designer v3 ④).
 *
 * `api` 래퍼가 **서버 판정에서** 거절되면 서버가 그 턴의 스레드에 카드를 세운다. 에이전트의 ask 가 아니다 — 10-03 사고에서
 * 에이전트가 세운 「허용 규칙 넣음」 같은 선택지는 눌러도 아무 데도 쓰이지 않았다. 이 카드는 서버가 아는 사실(누가·무엇을·
 * 왜 막혔나)만 싣고, 버튼(desktop P4b)은 소유자 사람 세션의 REST 로만 처리된다.
 *
 * **머지 카드는 여기서 만들지 않는다**(#1142 security F1) — 머지 권한 UX 스레드(febe9ff8)의 `mergeDenialId` 카드가 맡는다.
 *
 * **스레드 안에서 하루 한 장**: (에이전트, 대상, 스레드, UTC 날짜)마다 카드 하나(F2 — 키에 스레드가 없으면 다른 스레드·채널의
 * 경로가 처음 카드의 meta 로 흘렀다). 다시 막히면 `count`·`lastAt`·`lastCode`·`lastRequest` 만 올린다. 없는 연결 이름은
 * 이름이 달라도 스레드·하루에 한 장이다(L2 — 이름을 바꿔 가며 부르면 스레드가 카드로 덮인다).
 *
 * 본문은 고정 문구와 서버 값뿐이다. 경로는 `safePath` 를 지난 것만 질의를 떼고 코드 칸에 싣고, 아니면 「(경로 생략)」이다
 * (L1 — `no_connector` 는 경로 검사 전에 판정되므로 에이전트가 정한 글자가 시스템 줄로 렌더될 수 있었다). `@` 는 무력화한다.
 *
 * P5 조건(security L3, 메모): `write_needs_human_cause` 는 지금 잎 줄만 본다. 위임이 생기면 사슬 판정에 `parent.w ⇒ child.w` 를
 * 넣거나 `grant.delegate` 가 부모 값을 물려받게 해야 한다.
 */

/** 카드를 세우는 거절. 그 밖(임대·경로 모양·사슬 깨짐)은 사람이 버튼 하나로 고칠 것이 아니라 카드를 세우지 않는다. */
export const API_CARD_CODES = new Set([
  'not_granted', 'no_connector', 'no_secret', 'secret_expired', 'expired', 'suspended',
  'method_not_allowed', 'path_not_allowed', 'cause_not_human',
]);

export interface BlockedInput {
  agentId: string; channelId: string; threadRootId: string;
  code: string;
  connectorId: string | null; connectorName: string;
  method: string; path: string;
  now?: Date;
}

export interface BlockedMeta {
  key: string; kind: 'api'; agentId: string; ownerAccountId: string | null;
  code: string; lastCode: string; count: number; firstAt: string; lastAt: string;
  /** 없는 연결이면 null — 이름은 그때 사람이 만들 연결 이름으로만 쓴다. */
  connectorId: string | null; connectorName: string | null;
  method: string; path: string | null;
}

const reasonText: Record<string, string> = {
  not_granted: '권한 없음', no_connector: '연결 없음', no_secret: '키 없음', secret_expired: '키 만료',
  expired: '권한 만료', suspended: '권한 멈춤', method_not_allowed: '메서드 밖', path_not_allowed: '경로 밖',
  cause_not_human: '사람 글 턴 아님',
};

/** 카드에 실을 경로 — 안전한 모양이면 질의를 뗀 경로, 아니면 null. */
export function cardPath(path: string): string | null {
  // 백틱은 카드 본문의 코드 칸을 닫는다 — 그 뒤 글자(에이전트가 정한 것)가 마크다운·링크로 렌더된다(#1142 security nit).
  if (!safePath(path) || path.includes('`')) return null;
  return (path.split('?')[0] ?? '').slice(0, 200);
}

export async function recordBlocked(pool: Pool, b: BlockedInput): Promise<string | null> {
  const now = b.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const target = b.connectorId ? `connector:${b.connectorId}` : 'connector-name:*';
  const key = `api:${b.agentId}:${target}:${b.threadRootId}:${day}`;
  const path = cardPath(b.path);
  const request = `${b.method} ${path ?? '(경로 생략)'}`;

  const existing = (await pool.query<{ id: string }>(
    `select id from message
      where meta->'blocked'->>'key' = $1 and channel_id = $2 and coalesce(thread_root_id, id) = $3 and deleted_at is null
      order by created_at limit 1`, [key, b.channelId, b.threadRootId])).rows[0];
  if (existing) {
    const r = await pool.query(
      `update message set meta = jsonb_set(jsonb_set(jsonb_set(jsonb_set(meta,
           '{blocked,count}', to_jsonb(coalesce((meta->'blocked'->>'count')::int, 1) + 1)),
           '{blocked,lastAt}', to_jsonb($2::text)),
           '{blocked,lastCode}', to_jsonb($3::text)),
           '{blocked,lastRequest}', to_jsonb($4::text))
        where id = $1 returning id`,
      [existing.id, now.toISOString(), b.code, request]);
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
    key, kind: 'api', agentId: b.agentId, ownerAccountId: agent?.ownerAccountId ?? null,
    code: b.code, lastCode: b.code, count: 1, firstAt: now.toISOString(), lastAt: now.toISOString(),
    connectorId: b.connectorId, connectorName: b.connectorId ? b.connectorName : (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(b.connectorName) ? b.connectorName : null),
    method: b.method, path,
  };
  const name = meta.connectorName ?? '(연결 없음)';
  const body = `🔒 ${handle} 의 API 호출이 막혔다 · ${name} \`${request}\` · ${reasonText[b.code] ?? b.code}`.replace(/@/g, '＠');
  const posted = await postMessage(pool, {
    channelId: b.channelId, threadRootId: b.threadRootId, authorId: b.agentId, body, kind: 'system',
    meta: { blocked: meta },
  });
  return posted.failure ? null : posted.message.id;
}
