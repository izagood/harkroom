import type { Pool, PoolClient } from 'pg';
import type { AgentTeamRow, AgentTeamMemberRow } from '@murmur/shared';
// 멤버십 삽입·조회는 **`#156` 의 것 하나**를 그대로 쓴다. 여기서 다시 쓰지 않는다.
import { addChannelMember, isChannelMember } from './channels.js';

/** `Pool` 과 `PoolClient` 가 함께 만족하는 최소 표면. 트랜잭션 안에서도 쓰라고 둔다. */
type Queryable = Pick<Pool, 'query'>;

const COLS = `id, name, created_by as "createdBy", created_at as "createdAt"`;

export async function listTeams(db: Queryable): Promise<AgentTeamRow[]> {
  const res = await db.query(`select ${COLS} from agent_team order by name`);
  return res.rows;
}

export async function getTeam(db: Queryable, teamId: string): Promise<AgentTeamRow | null> {
  const res = await db.query(`select ${COLS} from agent_team where id = $1`, [teamId]);
  return res.rows[0] ?? null;
}

export async function getTeamByName(db: Queryable, name: string): Promise<AgentTeamRow | null> {
  const res = await db.query(`select ${COLS} from agent_team where lower(name) = lower($1)`, [name]);
  return res.rows[0] ?? null;
}

/**
 * 팀을 만든다. **이름 판정이 이 한 문장 안에 있다** — 계정 handle 도 집합 handle 도
 * 아닐 때만 삽입되고, 겹치면 `null` 이 돌아온다(`createHandleGroup` 과 같은 모양).
 *
 * 라우트에서 먼저 읽어 보고 삽입하는 방식으로는 부족하다: 그 사이에 같은 이름의 계정이
 * 만들어지면 예약이 새고, 그러면 나중에 `@팀` 멘션을 열 때 한 이름이 두 대상을 가리킨다.
 * 비교를 `lower()` 로 하는 이유도 같다 — 멘션 해석은 대소문자를 무시하므로(`mentionedHandles`)
 * `Agent1` 과 `agent1` 은 같은 이름으로 불린다.
 */
export async function createTeam(
  db: Queryable, name: string, creatorId: string,
): Promise<AgentTeamRow | null> {
  const res = await db.query(
    `insert into agent_team (name, created_by)
     select $1, $2
     where not exists (select 1 from account where lower(handle) = lower($1))
       and not exists (select 1 from handle_group where lower(handle) = lower($1))
       and not exists (select 1 from agent_team where lower(name) = lower($1))
     returning ${COLS}`,
    [name, creatorId],
  );
  return res.rowCount ? res.rows[0] : null;
}

/**
 * 이름을 바꾼다. 생성과 **같은 판정**을 쓴다 — 여기만 검사를 빼면 만들 때 못 쓰던 이름을
 * 고쳐서 차지할 수 있다.
 *
 * 반환이 세 갈래인 이유: 팀이 없는 것(404)과 이름이 겹친 것(400)은 호출부가 다르게
 * 답해야 하는 사실이라 `null` 하나로 뭉칠 수 없다.
 */
export async function updateTeamName(
  db: Queryable, teamId: string, name: string,
): Promise<{ ok: true; team: AgentTeamRow } | { ok: false; reason: 'not_found' | 'name_taken' }> {
  const res = await db.query(
    `update agent_team set name = $2
     where id = $1
       and not exists (select 1 from account where lower(handle) = lower($2))
       and not exists (select 1 from handle_group where lower(handle) = lower($2))
       and not exists (select 1 from agent_team where lower(name) = lower($2) and id <> $1)
     returning ${COLS}`,
    [teamId, name],
  );
  if (res.rowCount) return { ok: true, team: res.rows[0] };
  // 갱신이 0 행이면 팀이 없었는지 이름이 막혔는지를 갈라 말한다.
  const exists = await getTeam(db, teamId);
  return { ok: false, reason: exists ? 'name_taken' : 'not_found' };
}

/** 지운 팀을 돌려준다 — 감사에 이름을 남겨야 하고, 지운 뒤에는 물어볼 곳이 없다. */
export async function deleteTeam(db: Queryable, teamId: string): Promise<AgentTeamRow | null> {
  const res = await db.query(`delete from agent_team where id = $1 returning ${COLS}`, [teamId]);
  return res.rows[0] ?? null;
}

/**
 * 팀원 목록. handle 과 비활성 여부를 함께 준다 — 화면이 계정 목록을 따로 받아 맞출
 * 필요가 없고(`listChannelMembers` 와 같은 이유), 채널에 넣기 전에 "이 사람은 걸러진다"를
 * 미리 말할 수 있다.
 */
export async function listTeamMembers(db: Queryable, teamId: string): Promise<AgentTeamMemberRow[]> {
  const res = await db.query(
    `select tm.agent_account_id as "accountId", a.handle, a.disabled_at is not null as disabled
     from agent_team_member tm
     join account a on a.id = tm.agent_account_id
     where tm.team_id = $1
     order by a.handle`,
    [teamId],
  );
  return res.rows;
}

/** 이미 팀원이면 아무 일도 하지 않는다 — 두 번 눌렀다고 실패로 보이면 안 된다. */
export async function addAgentToTeam(db: Queryable, teamId: string, agentAccountId: string): Promise<void> {
  await db.query(
    `insert into agent_team_member (team_id, agent_account_id) values ($1, $2) on conflict do nothing`,
    [teamId, agentAccountId],
  );
}

export async function removeAgentFromTeam(db: Queryable, teamId: string, agentAccountId: string): Promise<boolean> {
  const res = await db.query(
    `delete from agent_team_member where team_id = $1 and agent_account_id = $2`,
    [teamId, agentAccountId],
  );
  return Boolean(res.rowCount);
}

/**
 * 팀을 채널에 넣는다(#172). **트랜잭션 하나다** — 중간에 실패하면 절반만 멤버가 된
 * 채널이 남고, 응답은 그 절반을 말할 방법이 없다. 팀 구성이 "이 다섯을 함께 넣는다"는
 * 뜻이니, 넣기도 함께 되거나 함께 안 돼야 한다.
 *
 * **멤버십을 직접 만들지 않는다.** 삽입은 `#156` 이 정한 `addChannelMember` 하나가 하고
 * 여기는 그것을 팀원마다 부를 뿐이다. 여기서 `insert into channel_member` 를 다시 쓰면
 * 멤버십의 뜻이 두 곳에 살고, 한쪽만 규칙이 바뀌면 가시성 계산이 갈라진다.
 *
 * 비활성 팀원은 **팀에서 지우지 않고 여기서만 건너뛴다**(`skipped`). 팀 구성은 운영자의
 * 의도 기록이라, 잠깐 꺼 뒀다고 지우면 다시 켰을 때 다시 넣어야 한다.
 */
export async function addTeamToChannel(
  pool: Pool, channelId: string, teamId: string,
): Promise<{ added: string[]; skipped: string[]; alreadyMember: string[] }> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('begin');
    const members = await listTeamMembers(client, teamId);
    const added: string[] = [];
    const skipped: string[] = [];
    const alreadyMember: string[] = [];
    for (const member of members) {
      if (member.disabled) {
        skipped.push(member.handle);
        continue;
      }
      if (await isChannelMember(client, channelId, member.accountId)) {
        alreadyMember.push(member.handle);
        continue;
      }
      await addChannelMember(client, channelId, member.accountId);
      added.push(member.handle);
    }
    await client.query('commit');
    return { added, skipped, alreadyMember };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
