import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import { registerAuth } from './auth/plugin.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerAccountRoutes } from './routes/accountRoutes.js';
import { registerChannelRoutes } from './routes/channelRoutes.js';
import { registerMessageRoutes } from './routes/messageRoutes.js';
import { registerDirectoryRoutes } from './routes/directoryRoutes.js';
import { registerWs } from './ws/wsPlugin.js';
import { registerMcp } from './mcp/mcpPlugin.js';

export interface ServerDeps {
  pool: Pool;
  getAvcsStatus?: () => { connected: boolean };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.name === 'ZodError') {
      return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    }
    reply.code(500).send({ error: { code: 'internal', message: err.message } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: `route not found: ${req.method} ${req.url}` } });
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
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
  await registerWs(app, deps.pool);
  await registerAuthRoutes(app, deps.pool);
  await registerAccountRoutes(app, deps.pool);
  await registerChannelRoutes(app, deps.pool);
  await registerMessageRoutes(app, deps.pool);
  await registerDirectoryRoutes(app, deps.pool);
  await registerMcp(app, deps.pool);

  return app;
}
