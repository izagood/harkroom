import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import { assertChannelVisible, dmMemberIds } from '../services/channels.js';
import {
  deleteMessage, editMessage, listInbox, listMessages, markInboxRead, postMessage, searchMessages,
} from '../services/messages.js';

export async function registerMessageRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  // 수정·삭제의 audience 는 발화와 같아야 한다. DM 의 수정 이벤트가 전원에게 가면 본문이
  // 채널 밖으로 새고, 삭제 이벤트가 전원에게 가면 누가 무엇을 지웠는지가 새어 나간다.
  const audienceOf = async (channelId: string): Promise<'all' | string[]> => {
    const channel = await pool.query(`select kind from channel where id = $1`, [channelId]);
    return channel.rows[0]?.kind === 'dm' ? await dmMemberIds(pool, channelId) : 'all';
  };

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
      emitEvent({ type: 'message.created', message, audience: await audienceOf(id) });
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return reply.code(replayed ? 200 : 201).send(message);
  });

  const targetParams = z.object({ id: z.string().uuid(), messageId: z.string().uuid() });

  app.patch('/channels/:id/messages/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId } = targetParams.parse(req.params);
    const body = z.object({ body: z.string().min(1).max(8000) }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const result = await editMessage(pool, id, messageId, req.account!.id, body.body);
    if (!result.ok) {
      return reply.code(result.reason === 'not_found' ? 404 : 403).send({
        error: {
          code: result.reason,
          message: result.reason === 'not_found'
            ? 'message does not exist in this channel'
            : 'only the author can edit a message, and system messages are never editable',
        },
      });
    }
    emitEvent({ type: 'message.updated', message: result.message, audience: await audienceOf(id) });
    // 수정으로 새로 생긴 @멘션은 inbox 를 만들지 않는다 — 수정이 알림 경로가 되면 조용히
    // 사람을 부르는 수단이 되고, 같은 멘션이 반복 통지되는 것도 막아야 한다.
    return result.message;
  });

  app.delete('/channels/:id/messages/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId } = targetParams.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const result = await deleteMessage(pool, id, messageId, {
      id: req.account!.id, isAdmin: req.account!.isAdmin,
    });
    if (!result.ok) {
      return reply.code(result.reason === 'not_found' ? 404 : 403).send({
        error: {
          code: result.reason,
          message: result.reason === 'not_found'
            ? 'message does not exist in this channel'
            : 'only the author or an admin can delete a message',
        },
      });
    }
    emitEvent({ type: 'message.deleted', channelId: id, messageId, audience: await audienceOf(id) });
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
