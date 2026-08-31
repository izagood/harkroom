import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerAuth } from './auth/plugin.js';
import { registerAuthRoutes } from './routes/authRoutes.js';

export interface ServerDeps {
  pool: Pool;
  getAvcsStatus?: () => { connected: boolean };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err.name === 'ZodError') {
      return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    }
    reply.code(500).send({ error: { code: 'internal', message: err.message } });
  });

  app.get('/healthz', async () => ({
    ok: true,
    avcs: deps.getAvcsStatus?.() ?? { connected: false },
  }));

  app.get('/readyz', async (_req, reply) => {
    await deps.pool.query('select 1');
    return { ok: true };
  });

  await registerAuth(app, deps.pool);
  await registerAuthRoutes(app, deps.pool);

  return app;
}
