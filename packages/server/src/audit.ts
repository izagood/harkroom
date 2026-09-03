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
  | 'account.created' | 'account.handle.changed' | 'agent.created' | 'agent.updated' | 'agent.disabled' | 'agent.enabled' | 'invite.created'
  // #139: 메모리 삭제. detail 에는 slug 만 남긴다 — 본문을 복사하면 삭제가 삭제가 아니다.
  | 'agent.memory.deleted'
  // #171: 새 에이전트의 기본값 변경. 이미 만들어진 에이전트는 바뀌지 않으므로, 이 기록은
  // '앞으로 만들 것의 서식이 언제 누구 손에 바뀌었나' 를 답한다.
  | 'agent.defaults.updated'
  // #129: 러너 종료 요청. 남의 러너를 멈추는 조작이라 남는 기록이 있어야 한다.
  // detail 에는 handle 만 남긴다 — 지시문도 대화 본문도 넣지 않는다(같은 파일 위 규칙).
  | 'agent.stop.requested'
  | 'pat.issued' | 'pat.revoked'
  | 'password.changed'
  | 'channel.created' | 'channel.updated' | 'channel.archived' | 'channel.unarchived' | 'message.deleted'
  // #218: 메시지 고정·해제. 채널 전역 상태를 바꾸는 조작이라 남는 기록이 있어야 한다.
  // detail 에는 messageId 만 남긴다 — 본문을 복사하면 그 메시지를 지워도 감사에 남는다
  // (같은 파일 위 message.deleted 와 agent.memory.deleted 가 같은 이유로 그렇다).
  | 'message.pinned' | 'message.unpinned'
  // #156: 채널 멤버십. 누가 누구를 private 채널에 들였고 누가 뺐는지는 접근 권한의 변경이라
  // 기록이 남아야 한다. detail 에는 대상 계정 id 만 남긴다 — 채널의 topic 도, 그 채널에서
  // 오간 메시지 본문도 넣지 않는다(같은 파일 위 규칙).
  | 'channel.member.added' | 'channel.member.removed'
  // #182: 공개 범위 전환. 이 한 번의 조작으로 채널 전체가 전원에게 열리거나 닫힌다 —
  // 'channel.updated' 에 묻어 두면 감사 조회에서 그 사건을 골라낼 수 없다.
  | 'channel.visibility.changed';

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
