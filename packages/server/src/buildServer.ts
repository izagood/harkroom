import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export interface ServerDeps {
  pool: Pool | null;
  getAvcsStatus?: () => { connected: boolean };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({
    ok: true,
    avcs: deps.getAvcsStatus?.() ?? { connected: false },
  }));

  app.get('/readyz', async (_req, reply) => {
    if (!deps.pool) return reply.code(503).send({ error: { code: 'not_ready', message: 'no db' } });
    await deps.pool.query('select 1');
    return { ok: true };
  });

  return app;
}
