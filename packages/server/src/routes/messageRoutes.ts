import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import { dmMemberIds } from '../services/channels.js';
import { listInbox, listMessages, markInboxRead, postMessage, searchMessages } from '../services/messages.js';

export async function registerMessageRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/channels/:id/messages', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      body: z.string().min(1).max(8000),
      threadRootId: z.string().uuid().optional(),
    }).parse(req.body);
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

  app.get('/channels/:id/messages', { preHandler: app.requireAccount }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({
      since: z.coerce.number().int().min(0).optional(),
      thread: z.string().uuid().optional(),
    }).parse(req.query);
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
    return { messages: await searchMessages(pool, q.q) };
  });
}
