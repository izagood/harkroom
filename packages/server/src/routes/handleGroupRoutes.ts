import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import {
  createHandleGroup, deleteHandleGroup, getHandleGroup, listHandleGroupMembers,
  listHandleGroups, updateHandleGroup, addHandleGroupMembers, removeHandleGroupMembers,
  getHandleGroupByHandle,
} from '../services/handleGroups.js';

export async function registerHandleGroupRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/handle-groups', { preHandler: app.requireAdmin }, async () => ({
    groups: await listHandleGroups(pool),
  }));

  app.post('/handle-groups', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z.object({
      handle: z.string().regex(/^[a-zA-Z0-9_-]{2,32}$/),
      displayName: z.string().min(1).max(64),
    }).parse(req.body);

    const existingGroup = await getHandleGroupByHandle(pool, body.handle);
    if (existingGroup) {
      return reply.code(400).send({
        error: { code: 'handle_taken', message: 'a group with this handle already exists' },
      });
    }

    const existingAccount = await pool.query(
      `select id from account where lower(handle) = lower($1) limit 1`,
      [body.handle],
    );
    if (existingAccount.rowCount) {
      return reply.code(400).send({
        error: { code: 'handle_taken', message: 'an account with this handle already exists' },
      });
    }

    const created = await createHandleGroup(pool, body);
    await recordAudit(pool, {
      action: 'handle_group.created', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: created.id, detail: { handle: body.handle },
    }, req);
    return reply.code(201).send(created);
  });

  app.get('/handle-groups/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const group = await getHandleGroup(pool, id);
    if (!group) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }
    const members = await listHandleGroupMembers(pool, id);
    return { group, members: members.map((m) => m.accountId) };
  });

  app.patch('/handle-groups/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.object({
      displayName: z.string().min(1).max(64),
    }).parse(req.body);
    const updated = await updateHandleGroup(pool, id, patch);
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }
    await recordAudit(pool, {
      action: 'handle_group.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { displayName: patch.displayName },
    }, req);
    return updated;
  });

  app.delete('/handle-groups/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const deleted = await deleteHandleGroup(pool, id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }
    await recordAudit(pool, {
      action: 'handle_group.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id,
    }, req);
    return reply.code(204).send();
  });

  app.post('/handle-groups/:id/members', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      accountIds: z.array(z.string().uuid()),
    }).parse(req.body);

    const group = await getHandleGroup(pool, id);
    if (!group) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }

    const memberCheck = await pool.query(
      `select id from account where id = any($1) and kind = 'agent'`,
      [body.accountIds],
    );
    if (memberCheck.rowCount) {
      return reply.code(400).send({
        error: { code: 'agent_not_allowed', message: 'agents cannot be added to groups' },
      });
    }

    await addHandleGroupMembers(pool, id, body.accountIds);
    const members = await listHandleGroupMembers(pool, id);
    return { members: members.map((m) => m.accountId) };
  });

  app.delete('/handle-groups/:id/members', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      accountIds: z.array(z.string().uuid()),
    }).parse(req.body);

    const group = await getHandleGroup(pool, id);
    if (!group) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }

    await removeHandleGroupMembers(pool, id, body.accountIds);
    const members = await listHandleGroupMembers(pool, id);
    return { members: members.map((m) => m.accountId) };
  });
}