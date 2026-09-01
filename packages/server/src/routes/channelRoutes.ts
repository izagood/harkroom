import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createChannel, getOrCreateDm, listChannels, updateChannel } from '../services/channels.js';
import { recordAudit } from '../audit.js';

export async function registerChannelRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/channels', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z.object({
      name: z.string().regex(/^[a-z0-9_-]{1,48}$/),
      topic: z.string().max(256).optional(),
      repo: z.string().max(128).optional(),
    }).parse(req.body);
    const channel = await createChannel(pool, body);
    return reply.code(201).send(channel);
  });

  app.patch('/channels/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.object({
      topic: z.string().max(256).optional(),
      // null은 바인딩 해제, 키 부재는 그대로 두기 — zod에서도 이 둘을 구분해야 한다.
      repo: z.string().max(128).nullable().optional(),
    }).parse(req.body);
    const channel = await updateChannel(pool, id, patch);
    if (!channel) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    await recordAudit(pool, {
      action: 'channel.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { fields: Object.keys(patch) },
    }, req);
    return channel;
  });

  app.get('/channels', { preHandler: app.requireAccount }, async () => ({
    channels: await listChannels(pool),
  }));

  app.post('/dms', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({ accountIds: z.array(z.string().uuid()).min(1).max(16) }).parse(req.body);
    const channel = await getOrCreateDm(pool, [...body.accountIds, req.account!.id]);
    return reply.code(201).send(channel);
  });
}
