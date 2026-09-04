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
  | 'channel.created' | 'channel.updated' | 'channel.archived' | 'channel.unarchived' | 'channel.deleted' | 'message.deleted'
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
  | 'channel.visibility.changed'
  // #188: 채널 문서 수정. detail 에는 본문 없이 bodyLength 만 남긴다 — 문서 전체를
  // 감사에 복사하면 덮어쓰기마다 복사가 누적되고, 검색이 불가능해진다.
  | 'channel.doc.updated'
  // #172: 에이전트 팀의 생애주기. detail 에는 handle 만 남긴다.
  | 'team.created' | 'team.updated' | 'team.deleted'
  | 'team.member.added' | 'team.member.removed'
  // #172: 채널에 팀을 통째로 넣은 사건. 팀 이름과 결과 개수만 남긴다 — 넣은 handle 을
  // 전부 적으면 팀이 클수록 detail 이 부풀고, 누가 멤버가 됐는지는
  // 'channel.member.added' 가 아니라 멤버 목록이 답한다.
  | 'channel.team.added'
  // #230: 사람 집합의 생애주기. admin 만 할 수 있는 조작이므로 기록이 남아야 한다.
  //
  // 구성원 변경을 따로 두는 이유: 집합에서 실제로 사람을 부르는 것은 **명단**이다.
  // 'handle_group.updated' 에 묻어 두면 "누가 언제 이 사람을 이 이름에 넣었나"를 감사
  // 조회에서 골라낼 수 없다(#182 가 channel.visibility.changed 를 나눈 것과 같은 이유).
  //
  // detail 에는 handle 과 **개수**만 남긴다 — 계정 id 목록은 남기지 않는다. 집합에서
  // 빼는 이유가 사람 사정일 수 있고, 감사 로그는 그것을 영구히 붙잡는 자리가 아니다.
  | 'handle_group.created' | 'handle_group.updated' | 'handle_group.deleted'
  | 'handle_group.members.added' | 'handle_group.members.removed'
  // #173: 채널의 자동 멘션 에이전트. 어떤 에이전트를 어느 채널에 자동 투입할지는 admin 의
  // 관리 행위라 기록이 남아야 한다. detail 에는 **에이전트 handle 만** 남긴다 — 그 채널의
  // 메시지 본문도, topic 도 넣지 않는다(같은 파일 위 규칙).
  | 'channel.auto_mention.set' | 'channel.auto_mention.unset'
  // #141: 진행 중인 에이전트 터미널에 사람이 붙었다·떠났다(스펙 §5 "감사").
  //
  // detail 에는 sessionId·channelId 만 남긴다 — **PTY 바이트는 절대 넣지 않는다.** PTY
  // 출력에는 하네스가 화면에 그린 모든 것(토큰, 환경변수, 사람이 붙여 넣은 비밀)이 들어가고,
  // 감사에 복사하면 그것을 지울 방법이 없다(같은 파일 위 message.deleted 와 같은 규칙).
  // 스크롤백을 러너 메모리의 ring buffer 에만 두는 것도 같은 이유다.
  //
  // #315·#346: 사람이 타이핑해 개입한 사실은 `agent.detached` 의 detail.inputBytes 로
  // **소켓당 1회 합산**해 남긴다(스펙 §5-2 결정 3). 입력마다(또는 시간 창마다) 행을 쓰던
  // 초기 구현(`agent.input`)은 행 타임스탬프가 곧 키 입력의 리듬이라 그 자체가 부채널이었다
  // — 묶어도 남는 것이 "언제 쳤는가"라면 덜 남긴 것이 아니다. 내용은 여전히 없다:
  // 바이트 **수**는 base64 길이 산술로만 세고, 서버는 그 base64 를 열지 않는다.
  | 'agent.attached' | 'agent.detached'
  // #337: 사람이 스스로 에이전트의 인터랙티브 터미널을 열었다(스펙 §5-2 결정 4). attach
  // (관찰)와 별도 액션이다 — 셸을 여는 것은 관찰보다 강한 행위라, 감사 조회가 "봤다"와
  // "열었다"를 액션 하나로 골라낼 수 있어야 한다. detail 은 {sessionId, channelId,
  // threadRootId, created} — created 가 false 면 이미 돌던 턴에 합류한 것이다. 본문도
  // 바이트도 없다(위 규칙 그대로).
  | 'agent.interactive.opened'
  // #384: 사람이 진행 중인 멘션 턴을 **이어받겠다고 예약**했다. `opened` 와 별도 액션인
  // 이유는 같은 결이다: 아직 셸이 열리지 않았고, 그 턴이 끝난 뒤에 열린다. 하나로 뭉치면
  // 감사가 "열었다"고 말하는데 그 시각에는 아직 아무 PTY 도 없다. detail 은 {sessionId,
  // channelId, threadRootId} — sessionId 는 그 순간 도는 **멘션 턴**의 것이다.
  | 'agent.interactive.handoffReserved';

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
