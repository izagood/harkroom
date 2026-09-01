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
import { loggerConfig } from './logging.js';
import { createRateLimiter, type RateLimitRule } from './rateLimit.js';

/**
 * 인증 표면 기본 리밋.
 *
 * `/auth/login` 이 가장 낮은 이유: Argon2 검증은 **의도적으로 비싼** 연산이라 무제한 요청이
 * 브루트포스 벡터이면서 동시에 CPU 소진 벡터다. 계정 생성 표면(`/bootstrap`, `/auth/register`)은
 * 초대 토큰이 있어도 시도 자체를 좁힌다. `/ws-ticket` 은 넉넉하다 — 재연결 폭풍은 정상 동작이고,
 * 여기서 막으면 네트워크가 불안한 클라이언트가 영구히 못 붙는다.
 */
const DEFAULT_RATE_LIMITS: Record<'login' | 'signup' | 'ticket', RateLimitRule> = {
  login: { windowMs: 5 * 60_000, max: 20 },
  signup: { windowMs: 15 * 60_000, max: 10 },
  ticket: { windowMs: 60_000, max: 120 },
};

/** 어떤 경로에 어떤 리밋을 적용하는가. 인증 표면만 좁힌다 — 발화·조회는 건드리지 않는다. */
const LIMITED_ROUTES: { method: string; url: string; rule: keyof typeof DEFAULT_RATE_LIMITS }[] = [
  { method: 'POST', url: '/auth/login', rule: 'login' },
  { method: 'POST', url: '/auth/register', rule: 'signup' },
  { method: 'POST', url: '/bootstrap', rule: 'signup' },
  { method: 'POST', url: '/ws-ticket', rule: 'ticket' },
];

export interface ServerDeps {
  pool: Pool;
  getAvcsStatus?: () => { connected: boolean };
  /** 종료 시 in-flight long-poll을 정상 마감시키는 창구. main이 SIGTERM에서 beginDrain을 부른다. */
  lifecycle?: Lifecycle;
  /** null·미지정이면 모든 origin 을 반영한다. 목록이면 CORS 와 WS 핸드셰이크에 함께 적용된다. */
  corsOrigins?: string[] | null;
  /** 소켓 뒤 자격증명 재검증 주기. 기본 60초. */
  wsRevalidateMs?: number;
  /** WS ping/pong 주기(ms). 기본 30초. 테스트에서 짧게 준다. */
  wsHeartbeatMs?: number;
  /** 로그 레벨. 미지정이면 LOG_LEVEL, 그것도 없으면 info. */
  logLevel?: string;
  /** 로그 싱크 교체(테스트 전용 seam). 프로덕션은 stdout 이다. */
  logStream?: import('node:stream').Writable;
  /** 인증 표면 리밋 재정의. 미지정이면 DEFAULT_RATE_LIMITS. */
  rateLimits?: Partial<Record<'login' | 'signup' | 'ticket', RateLimitRule>>;
  /** 리밋 판정용 시계(테스트 전용 seam). */
  now?: () => number;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerConfig({
      level: deps.logLevel ?? process.env.LOG_LEVEL ?? 'info',
      stream: deps.logStream,
    }),
  });
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

  // 리밋은 인증(onRequest 훅)보다 앞에서 걸어야 한다 — 그래야 Argon2 검증에 도달하기 전에
  // 막히고, 응답이 계정 존재 여부를 드러내지 않는다.
  const limiter = createRateLimiter(deps.now);
  const rules = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  app.addHook('onRequest', async (req, reply) => {
    const route = LIMITED_ROUTES.find(
      (r) => r.method === req.method && req.url.split('?')[0] === r.url,
    );
    if (!route) return;
    // req.ip 는 프록시 뒤에서는 프록시 주소다. 앞단을 두면 Fastify `trustProxy` 를 켜야
    // 실제 클라이언트 주소로 계수된다 — 안 켜면 전체가 한 키를 공유해 서로를 밀어낸다.
    const verdict = limiter.hit(`${route.rule}:${req.ip}`, rules[route.rule]);
    if (verdict.allowed) return;
    await reply
      .code(429)
      .header('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)))
      .send({ error: { code: 'rate_limited', message: 'too many attempts, try again later' } });
  });

  await registerAuth(app, deps.pool);
  await registerWs(app, deps.pool, {
    allowedOrigins: deps.corsOrigins ?? null,
    revalidateMs: deps.wsRevalidateMs,
    heartbeatMs: deps.wsHeartbeatMs,
  });
  await registerAuthRoutes(app, deps.pool);
  await registerAccountRoutes(app, deps.pool);
  await registerChannelRoutes(app, deps.pool);
  await registerMessageRoutes(app, deps.pool);
  await registerDirectoryRoutes(app, deps.pool);
  await registerMcp(app, deps.pool, lifecycle);

  return app;
}
