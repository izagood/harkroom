import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

/**
 * 감사 추적 기록.
 *
 * 요청 로그(`logging.ts`)와 목적이 다르다. 요청 로그는 "어떤 요청이 들어왔나"를 stdout 에
 * 남기고 회전으로 사라진다. 감사는 "누가 무엇을 바꿨나"를 DB 에 남겨 백업·조회 대상이 된다.
 * 그리고 요청 로그는 authorization 헤더를 redact 하므로 **누가 그 요청을 인증했는지가 없다.**
 */
export type AuditAction =
  | 'login.succeeded' | 'login.failed' | 'logout'
  | 'account.created' | 'agent.created' | 'agent.updated' | 'agent.disabled' | 'agent.enabled' | 'invite.created'
  | 'pat.issued' | 'pat.revoked'
  | 'password.changed'
  | 'channel.created' | 'channel.updated' | 'message.deleted';

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  actorHandle?: string | null;
  target?: string | null;
  ip?: string | null;
  /** 비밀은 넣지 않는다. 메시지 본문도 넣지 않는다 — 감사에 복사하면 삭제가 삭제가 아니다. */
  detail?: Record<string, unknown>;
}

/**
 * 기록한다. **던지지 않는다.**
 *
 * fail-open 결정: 감사 삽입 실패(디스크 꽉 참·잠김)로 로그인을 막으면 `audit_log` 하나가
 * 워크스페이스 전체를 잠근다. 감사 공백의 위험보다 그쪽이 크다고 봤다. 실패 자체는 요청
 * 로그에 남겨 조용히 사라지지 않게 한다.
 */
export async function recordAudit(pool: Pool, entry: AuditEntry, req?: FastifyRequest): Promise<void> {
  try {
    await pool.query(
      `insert into audit_log (action, actor_id, actor_handle, target, ip, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        entry.action,
        entry.actorId ?? null,
        entry.actorHandle ?? null,
        entry.target ?? null,
        entry.ip ?? req?.ip ?? null,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
  } catch (err) {
    req?.log?.warn({ err, action: entry.action }, 'audit record failed');
  }
}

/** 요청에서 행위자를 뽑는다 — 인증된 요청이면 계정, 아니면 시도된 handle 만 남는다. */
export function actorOf(req: FastifyRequest): { actorId: string | null; actorHandle: string | null } {
  return req.account
    ? { actorId: req.account.id, actorHandle: req.account.handle }
    : { actorId: null, actorHandle: null };
}

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  actorId: string | null;
  actorHandle: string | null;
  target: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
}

export async function listAudit(
  pool: Pool, opts: { limit?: number; before?: string; action?: string } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const res = await pool.query(
    `select id::text as id, at, action, actor_id as "actorId", actor_handle as "actorHandle",
       target, ip, detail
     from audit_log
     where ($1::bigint is null or id < $1::bigint)
       and ($2::text is null or action = $2::text)
     order by id desc
     limit $3`,
    [opts.before ?? null, opts.action ?? null, limit],
  );
  return res.rows;
}
