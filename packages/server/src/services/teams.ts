import type { Pool } from 'pg';
import type { AgentTeamRow, AgentTeamMemberRow } from '@murmur/shared';

export async function listTeams(pool: Pool): Promise<AgentTeamRow[]> {
  const res = await pool.query(
    `select id, name, created_by as "createdBy", created_at as "createdAt" from agent_team order by name`,
  );
  return res.rows;
}

export async function getTeam(pool: Pool, teamId: string): Promise<AgentTeamRow | null> {
  const res = await pool.query(
    `select id, name, created_by as "createdBy", created_at as "createdAt" from agent_team where id = $1`,
    [teamId],
  );
  return res.rows[0] ?? null;
}

export async function createTeam(pool: Pool, name: string, creatorId: string): Promise<AgentTeamRow> {
  const res = await pool.query(
    `insert into agent_team (name, created_by) values ($1, $2) returning id, name, created_by as "createdBy", created_at as "createdAt"`,
    [name, creatorId],
  );
  return res.rows[0];
}

export async function updateTeamName(pool: Pool, teamId: string, name: string): Promise<AgentTeamRow | null> {
  const res = await pool.query(
    `update agent_team set name = $1 where id = $2 returning id, name, created_by as "createdBy", created_at as "createdAt"`,
    [name, teamId],
  );
  return res.rows[0] ?? null;
}

export async function deleteTeam(pool: Pool, teamId: string): Promise<boolean> {
  const res = await pool.query(`delete from agent_team where id = $1`, [teamId]);
  return Boolean(res.rowCount);
}

export async function listTeamMembers(pool: Pool, teamId: string): Promise<AgentTeamMemberRow[]> {
  const res = await pool.query(
    `select tm.agent_account_id as "accountId", a.handle, a.disabled_at is not null as disabled
     from agent_team_member tm
     join account a on a.id = tm.agent_account_id
     where tm.team_id = $1
     order by a.handle`,
    [teamId],
  );
  return res.rows;
}

export async function addAgentToTeam(pool: Pool, teamId: string, agentAccountId: string): Promise<void> {
  await pool.query(
    `insert into agent_team_member (team_id, agent_account_id) values ($1, $2) on conflict do nothing`,
    [teamId, agentAccountId],
  );
}

export async function removeAgentFromTeam(pool: Pool, teamId: string, agentAccountId: string): Promise<boolean> {
  const res = await pool.query(
    `delete from agent_team_member where team_id = $1 and agent_account_id = $2`,
    [teamId, agentAccountId],
  );
  return Boolean(res.rowCount);
}

export async function addChannelMember(pool: Pool, channelId: string, accountId: string): Promise<void> {
  await pool.query(
    `insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`,
    [channelId, accountId],
  );
}

export async function isChannelMember(pool: Pool, channelId: string, accountId: string): Promise<boolean> {
  const res = await pool.query(
    `select 1 from channel_member where channel_id = $1 and account_id = $2`,
    [channelId, accountId],
  );
  return Boolean(res.rowCount);
}