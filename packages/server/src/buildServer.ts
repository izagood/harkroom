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
import { Lifecycle } from './lifecycle.js';

export interface ServerDeps {
  pool: Pool;
  getAvcsStatus?: () => { connected: boolean };
  /** 종료 시 in-flight long-poll을 정상 마감시키는 창구. main이 SIGTERM에서 beginDrain을 부른다. */
  lifecycle?: Lifecycle;
  /** null·미지정이면 모든 origin 을 반영한다. 목록이면 CORS 와 WS 핸드셰이크에 함께 적용된다. */
  corsOrigins?: string[] | null;
  /** 소켓 뒤 자격증명 재검증 주기. 기본 60초. */
  wsRevalidateMs?: number;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const lifecycle = deps.lifecycle ?? new Lifecycle();

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
    // 인증은 Origin 이 아니라 Bearer 토큰이 한다. 목록은 브라우저 클라이언트를 좁히는 추가 방어이고,
    // 미설정 시 반영(true)이 기본인 이유는 셀프호스트가 어떤 origin 으로 뜰지 서버가 모르기 때문이다.
    origin: deps.corsOrigins ?? true,
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
  await registerWs(app, deps.pool, {
    allowedOrigins: deps.corsOrigins ?? null,
    revalidateMs: deps.wsRevalidateMs,
  });
  await registerAuthRoutes(app, deps.pool);
  await registerAccountRoutes(app, deps.pool);
  await registerChannelRoutes(app, deps.pool);
  await registerMessageRoutes(app, deps.pool);
  await registerDirectoryRoutes(app, deps.pool);
  await registerMcp(app, deps.pool, lifecycle);

  return app;
}
