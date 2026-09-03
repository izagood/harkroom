import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { HANDLE_PATTERN } from '@murmur/shared';
import {
  listTeams, getTeam, createTeam, updateTeamName, deleteTeam,
  listTeamMembers, addAgentToTeam, removeAgentFromTeam,
  addChannelMember, isChannelMember,
} from '../services/teams.js';
import { recordAudit } from '../audit.js';
import { assertChannelVisible } from '../services/channels.js';

export async function registerTeamRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const teamParam = z.object({ id: z.string().uuid() });

  app.get('/teams', { preHandler: app.requireAccount }, async () => ({
    teams: await listTeams(pool),
  }));

  app.post('/teams', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { name } = z.object({
      name: z.string().regex(new RegExp(`^${HANDLE_PATTERN}$`)),
    }).parse(req.body);

    const existing = await pool.query(`select 1 from account where handle = $1`, [name]);
    if (existing.rowCount) {
      return reply.code(400).send({ error: { code: 'name_taken', message: '이 이름은 계정 handle 과 겹친다' } });
    }

    const team = await createTeam(pool, name, req.account!.id);
    await recordAudit(pool, {
      action: 'team.created', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: team.id, detail: { handle: name },
    }, req);
    return reply.code(201).send(team);
  });

  app.patch('/teams/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = teamParam.parse(req.params);
    const { name } = z.object({
      name: z.string().regex(new RegExp(`^${HANDLE_PATTERN}$`)),
    }).parse(req.body);

    const existing = await pool.query(`select 1 from account where handle = $1`, [name]);
    if (existing.rowCount) {
      return reply.code(400).send({ error: { code: 'name_taken', message: '이 이름은 계정 handle 과 겹친다' } });
    }

    const team = await updateTeamName(pool, id, name);
    if (!team) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }
    await recordAudit(pool, {
      action: 'team.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: name },
    }, req);
    return team;
  });

  app.delete('/teams/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = teamParam.parse(req.params);
    const deleted = await deleteTeam(pool, id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }
    await recordAudit(pool, {
      action: 'team.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: {},
    }, req);
    return reply.code(204).send();
  });

  app.get('/teams/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = teamParam.parse(req.params);
    const team = await getTeam(pool, id);
    if (!team) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }
    const members = await listTeamMembers(pool, id);
    return { team, members };
  });

  app.put('/teams/:id/members/:accountId', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id, accountId } = z.object({
      id: z.string().uuid(), accountId: z.string().uuid(),
    }).parse(req.params);

    const account = await pool.query(`select kind, handle from account where id = $1`, [accountId]);
    if (!account.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
    }
    if (account.rows[0].kind !== 'agent') {
      return reply.code(400).send({ error: { code: 'not_an_agent', message: '에이전트만 팀에 넣을 수 있다' } });
    }

    await addAgentToTeam(pool, id, accountId);
    await recordAudit(pool, {
      action: 'team.member.added', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: account.rows[0].handle },
    }, req);
    return { members: await listTeamMembers(pool, id) };
  });

  app.delete('/teams/:id/members/:accountId', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id, accountId } = z.object({
      id: z.string().uuid(), accountId: z.string().uuid(),
    }).parse(req.params);

    const removed = await removeAgentFromTeam(pool, id, accountId);
    if (removed) {
      const account = await pool.query(`select handle from account where id = $1`, [accountId]);
      await recordAudit(pool, {
        action: 'team.member.removed', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { handle: account.rows[0]?.handle },
      }, req);
    }
    return { members: await listTeamMembers(pool, id) };
  });

  app.post('/channels/:id/teams/:teamId/add', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id, teamId } = z.object({
      id: z.string().uuid(), teamId: z.string().uuid(),
    }).parse(req.params);

    const channel = await pool.query(`select visibility from channel where id = $1`, [id]);
    if (!channel.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    if (channel.rows[0].visibility === 'public') {
      return reply.code(400).send({ error: { code: 'channel_is_public', message: 'public 채널에 팀을 추가할 수 없다' } });
    }

    const team = await getTeam(pool, teamId);
    if (!team) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }

    const members = await listTeamMembers(pool, teamId);
    const added: string[] = [];
    const skipped: string[] = [];
    const alreadyMember: string[] = [];

    for (const member of members) {
      if (member.disabled) {
        skipped.push(member.handle);
        continue;
      }
      const isMember = await isChannelMember(pool, id, member.accountId);
      if (isMember) {
        alreadyMember.push(member.handle);
      } else {
        await addChannelMember(pool, id, member.accountId);
        added.push(member.handle);
      }
    }

    await recordAudit(pool, {
      action: 'channel.team.added', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { teamHandle: team.name, added: added.length, skipped: skipped.length },
    }, req);

    return { added, skipped, alreadyMember };
  });
}