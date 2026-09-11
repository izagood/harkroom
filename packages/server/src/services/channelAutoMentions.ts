import type { Pool } from 'pg';
import type { ChannelAutoMentionMode, ChannelAutoMentionRow } from '@harkroom/shared';

/**
 * 채널의 자동 멘션 에이전트(#173).
 *
 * 이 서비스는 **행을 관리할 뿐** 멘션을 만들지 않는다. 접두는 데스크탑 작성창이 전송 직전에
 * 본문에 붙이고(`Composer.tsx`), 서버의 알림 판정(`messages.ts` 의 `mentionedHandles`)은 그
 * 본문을 평범한 멘션으로 읽는다. 서버가 저장 직후 본문에 접두하는 방식을 택하지 않은 이유:
 * 에이전트가 MCP 로 올린 답에도 접두가 붙어, 그 에이전트가 자기 답에 다시 불리는 루프가 된다.
 */
const COLS = `m.channel_id as "channelId", m.agent_account_id as "agentAccountId", a.handle,
  m.mode, m.created_by as "createdBy", m.created_at as "createdAt"`;
const FROM = `from channel_auto_mention m join account a on a.id = m.agent_account_id`;

export async function listChannelAutoMentions(pool: Pool, channelId: string): Promise<ChannelAutoMentionRow[]> {
  const res = await pool.query<ChannelAutoMentionRow>(
    `select ${COLS} ${FROM} where m.channel_id = $1 order by a.handle`, [channelId],
  );
  return res.rows;
}

export type SetAutoMentionResult =
  | { ok: true; row: ChannelAutoMentionRow }
  | { ok: false; reason: 'not_found' | 'not_an_agent' | 'agent_disabled' };

/**
 * 자동 멘션을 건다. 이미 걸려 있으면 **모드만 고쳐** 그 행을 돌려준다(멱등 PUT).
 *
 * `do update` 인 이유: 모드를 바꾸는 길이 이 하나여야 한다. 지웠다 다시 거는 길로 두면
 * 그 사이에 접두가 사라진 순간이 생기고(사람은 자동 호출이 꺼진 채널을 본다), 감사에도
 * "풀었다 → 걸었다"는 두 줄이 남아 실제로 일어난 일(세기를 바꿨다)을 가린다.
 *
 * 계정의 종류·비활성 여부를 **삽입 문장 안에서** 본다. 따로 읽고 넣으면 그 사이에
 * 비활성화된 에이전트가 들어간다 — 두 표에 걸치는 규칙이라 제약으로 쓸 수 없으므로 문장
 * 하나가 그 자리다. 거절 사유는 삽입이 0 행일 때만 따로 읽어 구분한다.
 */
export async function setChannelAutoMention(
  pool: Pool,
  input: { channelId: string; agentAccountId: string; createdBy: string; mode: ChannelAutoMentionMode },
): Promise<SetAutoMentionResult> {
  const inserted = await pool.query(
    `insert into channel_auto_mention (channel_id, agent_account_id, created_by, mode)
     select $1, a.id, $3, $4 from account a
      where a.id = $2 and a.kind = 'agent' and a.disabled_at is null
     on conflict (channel_id, agent_account_id) do update set mode = excluded.mode`,
    [input.channelId, input.agentAccountId, input.createdBy, input.mode],
  );
  if (!inserted.rowCount) {
    const existing = await pool.query<ChannelAutoMentionRow>(
      `select ${COLS} ${FROM} where m.channel_id = $1 and m.agent_account_id = $2`,
      [input.channelId, input.agentAccountId],
    );
    /**
     * 여기까지 왔다는 것은 위 `select` 가 걸러 냈다는 뜻 — 즉 그 계정은 **지금 비활성**이다
     * (또는 없거나 사람이다). 행이 이미 있고 **요청한 모드가 지금 값과 같으면** 아무것도
     * 바꿀 것이 없으므로 그대로 200 이다(멱등).
     *
     * 값이 다르면 `agent_disabled` 로 거절한다. 200 을 주면 화면은 바뀐 줄 알고 다시 그리는데
     * 표에는 옛 값이 남는다 — 새로 고치면 되돌아오는 화면이 된다.
     */
    if (existing.rowCount && existing.rows[0]!.mode === input.mode) return { ok: true, row: existing.rows[0]! };
    const account = await pool.query<{ kind: string; disabled: boolean }>(
      `select kind, disabled_at is not null as disabled from account where id = $1`, [input.agentAccountId],
    );
    if (!account.rowCount) return { ok: false, reason: 'not_found' };
    if (account.rows[0]!.kind !== 'agent') return { ok: false, reason: 'not_an_agent' };
    return { ok: false, reason: 'agent_disabled' };
  }
  const row = await pool.query<ChannelAutoMentionRow>(
    `select ${COLS} ${FROM} where m.channel_id = $1 and m.agent_account_id = $2`,
    [input.channelId, input.agentAccountId],
  );
  return { ok: true, row: row.rows[0]! };
}

/** 푼다. 없던 것을 풀면 false — 호출부가 감사를 남길지 정하는 근거다. */
export async function unsetChannelAutoMention(pool: Pool, channelId: string, agentAccountId: string): Promise<boolean> {
  const res = await pool.query(
    `delete from channel_auto_mention where channel_id = $1 and agent_account_id = $2`,
    [channelId, agentAccountId],
  );
  return (res.rowCount ?? 0) > 0;
}
