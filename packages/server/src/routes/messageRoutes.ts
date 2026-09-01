import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import { assertChannelVisible, dmMemberIds } from '../services/channels.js';
import { deleteMessage, editMessage, listInbox, listMessages, markInboxRead, postMessage, searchMessages } from '../services/messages.js';

export async function registerMessageRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/channels/:id/messages', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      body: z.string().min(1).max(8000),
      threadRootId: z.string().uuid().optional(),
    }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
    const { message, notified, replayed } = await postMessage(pool, {
      channelId: id, authorId: req.account!.id, body: body.body,
      threadRootId: body.threadRootId ?? null, idempotencyKey,
    });
    if (!replayed) {
      const channel = await pool.query(`select kind from channel where id = $1`, [id]);
      const audience: 'all' | string[] =
        channel.rows[0]?.kind === 'dm' ? await dmMemberIds(pool, id) : 'all';
      emitEvent({ type: 'message.created', message, audience });
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return reply.code(replayed ? 200 : 201).send(message);
  });

  /** 채널 kind 에 따른 이벤트 수신자. DM 은 멤버에게만 간다. */
  const audienceFor = async (channelId: string): Promise<'all' | string[]> => {
    const channel = await pool.query(`select kind from channel where id = $1`, [channelId]);
    return channel.rows[0]?.kind === 'dm' ? await dmMemberIds(pool, channelId) : 'all';
  };

  app.patch('/channels/:id/messages/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId } = z.object({
      id: z.string().uuid(), messageId: z.string().uuid(),
    }).parse(req.params);
    const { body } = z.object({ body: z.string().min(1).max(8000) }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    const result = await editMessage(pool, { channelId: id, messageId, actorId: req.account!.id, body });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message' } });
    }
    if (result === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only the author can edit a user message' } });
    }
    emitEvent({ type: 'message.updated', message: result, audience: await audienceFor(id) });
    return result;
  });

  app.delete('/channels/:id/messages/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId } = z.object({
      id: z.string().uuid(), messageId: z.string().uuid(),
    }).parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    const result = await deleteMessage(pool, {
      channelId: id, messageId, actorId: req.account!.id, actorIsAdmin: req.account!.isAdmin,
    });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message' } });
    }
    if (result === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only the author or an admin can delete' } });
    }
    emitEvent({ type: 'message.deleted', channelId: id, messageId, audience: await audienceFor(id) });
    return reply.code(204).send();
  });

  app.get('/channels/:id/messages', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({
      since: z.coerce.number().int().min(0).optional(),
      thread: z.string().uuid().optional(),
    }).parse(req.query);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    return { messages: await listMessages(pool, id, { since: q.since, threadRootId: q.thread ?? null }) };
  });

  app.get('/inbox', { preHandler: app.requireAccount }, async (req) => {
    const q = z.object({ unread: z.coerce.boolean().optional() }).parse(req.query);
    return { entries: await listInbox(pool, req.account!.id, { unreadOnly: q.unread ?? false }) };
  });

  app.post('/inbox/read', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.number().int()).min(1) }).parse(req.body);
    await markInboxRead(pool, req.account!.id, body.ids);
    return reply.code(204).send();
  });

  app.get('/search', { preHandler: app.requireAccount }, async (req) => {
    const q = z.object({ q: z.string().min(1).max(256) }).parse(req.query);
    return { messages: await searchMessages(pool, req.account!.id, q.q) };
  });
}
