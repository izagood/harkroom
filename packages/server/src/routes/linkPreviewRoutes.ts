import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { getLinkPreviewByUrl } from '../services/linkPreviewDb.js';

export async function registerLinkPreviewRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/link-previews', { preHandler: app.requireAccount }, async (req, reply) => {
    const { url } = z.object({ url: z.string().url() }).parse(req.query);
    const preview = await getLinkPreviewByUrl(pool, url);
    if (!preview) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'link preview not found' } });
    }
    return preview;
  });
}