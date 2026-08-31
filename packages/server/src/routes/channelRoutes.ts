import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createChannel, getOrCreateDm, listChannels } from '../services/channels.js';

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

  app.get('/channels', { preHandler: app.requireAccount }, async () => ({
    channels: await listChannels(pool),
  }));

  app.post('/dms', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({ accountIds: z.array(z.string().uuid()).min(1).max(16) }).parse(req.body);
    const channel = await getOrCreateDm(pool, [...body.accountIds, req.account!.id]);
    return reply.code(201).send(channel);
  });
}
