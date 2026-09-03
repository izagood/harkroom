import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import type { Pool } from 'pg';
import { projectionState, type ProjectionRuntime, type ProjectionStatus } from '@murmur/shared';
import { registerAuth } from './auth/plugin.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerAccountRoutes } from './routes/accountRoutes.js';
import { registerChannelRoutes } from './routes/channelRoutes.js';
import { registerMessageRoutes } from './routes/messageRoutes.js';
import { registerAttachmentRoutes } from './routes/attachmentRoutes.js';
import { registerAvatarRoutes } from './routes/avatarRoutes.js';
import { createLocalStorage } from './storage/local.js';
import { registerDirectoryRoutes } from './routes/directoryRoutes.js';
import { registerAuditRoutes } from './routes/auditRoutes.js';
import { registerSettingsRoutes } from './routes/settingsRoutes.js';
import { registerHandleGroupRoutes } from './routes/handleGroupRoutes.js';
import { registerWs } from './ws/wsPlugin.js';
import { registerMcp } from './mcp/mcpPlugin.js';
import { createAgentPresence } from './mcp/presence.js';
import { Lifecycle } from './lifecycle.js';
import { loggerConfig } from './logging.js';
import { createRateLimiter, type RateLimitRule } from './rateLimit.js';
import { createMetrics } from './metrics.js';

/**
 * 인증 표면 기본 리밋.
 *
 * `/auth/login` 이 가장 낮은 이유: Argon2 검증은 **의도적으로 비싼** 연산이라 무제한 요청이
 * 브루트포스 벡터이면서 동시에 CPU 소진 벡터다. 계정 생성 표면(`/bootstrap`, `/auth/register`)은
 * 초대 토큰이 있어도 시도 자체를 좁힌다. `/ws-ticket` 은 넉넉하다 — 재연결 폭풍은 정상 동작이고,
 * 여기서 막으면 네트워크가 불안한 클라이언트가 영구히 못 붙는다.
 */
const DEFAULT_RATE_LIMITS: Record<'login' | 'signup' | 'ticket' | 'upload', RateLimitRule> = {
  login: { windowMs: 5 * 60_000, max: 20 },
  signup: { windowMs: 15 * 60_000, max: 10 },
  ticket: { windowMs: 60_000, max: 120 },
  // 첨부는 크기 제한(25MB)만으로 부족하다 — 그건 **한 번의** 업로드만 막고, 반복하면 디스크가
  // 조용히 찬다. 분당 20건이면 사람의 정상 사용(스크린샷 몇 장)에는 걸리지 않는다.
  upload: { windowMs: 60_000, max: 20 },
};

/** 어떤 경로에 어떤 리밋을 적용하는가. 인증 표면만 좁힌다 — 발화·조회는 건드리지 않는다. */
const LIMITED_ROUTES: { method: string; url: string; rule: keyof typeof DEFAULT_RATE_LIMITS }[] = [
  { method: 'POST', url: '/auth/login', rule: 'login' },
  { method: 'POST', url: '/auth/register', rule: 'signup' },
  { method: 'POST', url: '/bootstrap', rule: 'signup' },
  { method: 'POST', url: '/ws-ticket', rule: 'ticket' },
  { method: 'POST', url: '/uploads', rule: 'upload' },
];

export interface ServerDeps {
  pool: Pool;
  /** avcs 연결 상태 — /healthz 에서 쓴다. */
  getAvcsStatus?: () => { connected: boolean };
  /**
   * 투영 상태의 **원자료** — `/projection/status` 에서 쓴다. `state` 는 이 라우트가
   * `projectionState` 로 뽑는다(shared). 미지정이면 `configured: false` 로 답한다:
   * 투영을 물어봤는데 아무도 답할 수 없는 상태가 곧 "설정되지 않았다"다.
   */
  getProjectionStatus?: () => ProjectionRuntime;
  /** 종료 시 in-flight long-poll을 정상 마감시키는 창구. main이 SIGTERM에서 beginDrain을 부른다. */
  lifecycle?: Lifecycle;
  /** null·미지정이면 모든 origin 을 반영한다. 목록이면 CORS 와 WS 핸드셰이크에 함께 적용된다. */
  corsOrigins?: string[] | null;
  /** 소켓 뒤 자격증명 재검증 주기. 기본 60초. */
  wsRevalidateMs?: number;
  /** WS ping/pong 주기(ms). 기본 30초. 테스트에서 짧게 준다. */
  wsHeartbeatMs?: number;
  /** '입력 중' 상태의 수명(ms). 기본 6초. */
  typingTtlMs?: number;
  /** 에이전트 online 상태의 수명(ms). 기본 30초. */
  agentPresenceTtlMs?: number;
  /** 로그 레벨. 미지정이면 LOG_LEVEL, 그것도 없으면 info. */
  logLevel?: string;
  /** 로그 싱크 교체(테스트 전용 seam). 프로덕션은 stdout 이다. */
  logStream?: import('node:stream').Writable;
  /** 인증 표면 리밋 재정의. 미지정이면 DEFAULT_RATE_LIMITS. */
  rateLimits?: Partial<Record<'login' | 'signup' | 'ticket' | 'upload', RateLimitRule>>;
  /** 리밋 판정용 시계(테스트 전용 seam). */
  now?: () => number;
  /**
   * 앞단 리버스 프록시를 신뢰할지. **켜면 `X-Forwarded-For` 를 클라이언트 주소로 받아들인다.**
   *
   * 켜야 하는 이유: 프록시 뒤에서는 소켓 주소가 프록시 하나뿐이라 **모든 클라이언트가 레이트
   * 리밋 버킷 하나를 공유하고**(서로를 밀어낸다) 감사 로그의 ip 가 전부 같은 값이 된다.
   * compose 기본 배포가 지금 그 상태다 — 모든 요청이 Docker 브리지 게이트웨이로 보인다.
   *
   * 켜면 안 되는 이유: 프록시가 **없는데** 켜면 누구나 헤더를 위조해 리밋을 무한히 우회한다.
   * 그래서 기본값은 끔이고, 실제로 앞단을 둔 배포에서만 켠다.
   */
  trustProxy?: boolean;
  /**
   * 첨부 스토리지. 미지정이면 ATTACHMENT_ROOT·ATTACHMENT_MAX_BYTES(기본 25MB)를 쓴다.
   * S3 호환으로 바꿀 때는 storage/local.ts 만 갈아 끼우면 된다.
   */
  storage?: { root: string; maxBytes: number };
}

/** 25MB. 스크린샷·로그 파일에는 넉넉하고, 디스크가 조용히 차지 않을 만큼은 좁다. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // 기본값 false 를 유지한다 — 프록시가 없는데 신뢰하면 헤더 위조로 리밋이 무의미해진다.
    trustProxy: deps.trustProxy ?? false,
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

  const metrics = createMetrics();
  let socketCount: () => number = () => 0;
  metrics.registerGauge('murmur_ws_connections', 'live websocket connections', () => socketCount());
  // 투영 커서를 스크레이프 시점에 읽는다. #48 이 고정한 결함(avcs 를 커서 뒤로 되돌리면
  // 조용히 건너뛴다)은 **관측되지 않기 때문에** 위험하다 — 채널에는 아무 일도 없어 보인다.
  // 커서가 숫자로 보이면 그 침묵이 눈에 띈다.
  metrics.registerLabeledGauge(
    'murmur_projection_cursor', 'last projected avcs log index per repo', 'repo',
    async () => {
      const res = await deps.pool.query(`select repo, last_log_index from projection_cursor`);
      return Object.fromEntries(
        res.rows.map((r: { repo: string; last_log_index: string }) => [r.repo, Number(r.last_log_index)]),
      );
    },
  );


  /**
   * 에이전트가 부름을 얼마나 오래 방치했는가(초). **2026-09-01 도그푸딩에서 난 실패를 보이게
   * 하려고 만들었다**: 사용자가 에이전트를 불렀는데 러너 프로세스가 죽어 답이 없었고, 서버·
   * 기존 메트릭은 전부 정상이었다. inbox 에 부름이 쌓이는 것만 사실이었으므로 그 나이를 낸다.
   *
   * **답할 의무가 있는 계정만 센다.** 두 겹으로 좁힌다:
   * - 사람을 뺀다. 사람이 멘션을 늦게 읽는 것은 장애가 아니라 일상이다(자고 있을 수 있다).
   * - `kind='agent'` 라도 **정의(`agent_config`)가 없는 계정을 뺀다.** avcs 투영용 시스템 계정
   *   (`murmur`)과 정의 없이 만들어진 계정에는 답할 러너가 없고 앞으로도 없다. 사용자는
   *   사이드바에 보이니 자연스럽게 부르고, 그 미처리는 **영원히 쌓이며 절대 내려오지 않는다.**
   *   경보가 몇 번 반복되면 사람이 경보를 무시하게 되고, 그때 진짜 러너가 죽으면 아무도 안 본다
   *   (2026-09-01 실사용에서 드러났다).
   *
   * 미처리가 없는 계정은 시계열을 만들지 않는다 — 0 을 내면 "처리됐다"와 "부름이 없었다"가
   * 같아진다.
   */
  metrics.registerLabeledGauge(
    'murmur_agent_oldest_unread_seconds',
    'age of the oldest unhandled inbox entry per agent — a dead runner shows up here',
    'handle',
    async () => {
      const res = await deps.pool.query(
        `select a.handle,
                extract(epoch from (now() - min(i.created_at))) as seconds
         from inbox i
         join account a on a.id = i.account_id
         -- 정의가 있는 에이전트만. join 이 곧 "murmur 가 실행할 수 있는 에이전트"의 정의다.
         join agent_config ac on ac.account_id = a.id
         where i.read_at is null and a.kind = 'agent'
         group by a.handle`,
      );
      return Object.fromEntries(
        res.rows.map((r: { handle: string; seconds: string }) => [r.handle, Math.round(Number(r.seconds))]),
      );
    },
  );

  // 요청 계측. **라우트 패턴**을 쓴다 — 구체 경로를 라벨로 넣으면 채널 id·메시지 id 마다
  // 시계열이 하나씩 생겨 스크레이프가 곧 메모리 사고가 된다.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    // /metrics 가 자기 자신을 세면 스크레이프 주기가 곧 트래픽으로 보인다.
    if (route === '/metrics') return;
    metrics.observeRequest({
      method: req.method, route, status: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
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

  // 에이전트 presence 레지스트리를 한 번 만들고 두 곳에 넘긴다.
  // - registerWs: presence.snapshot 에 에이전트를 합집합으로 얹는다.
  // - registerMcp: inbox.poll 에서 mark() 를 부른다.
  const agentPresence = createAgentPresence({
    ttlMs: deps.agentPresenceTtlMs ?? 30_000,
    now: deps.now,
  });
  agentPresence.startSweep(app);

  await registerWs(app, deps.pool, {
    onSocketCount: (read) => { socketCount = read; },
    allowedOrigins: deps.corsOrigins ?? null,
    revalidateMs: deps.wsRevalidateMs,
    heartbeatMs: deps.wsHeartbeatMs,
    typingTtlMs: deps.typingTtlMs,
    agentPresence,
  });
  await registerAuthRoutes(app, deps.pool);
  await registerAccountRoutes(app, deps.pool);
  const storageOpts = deps.storage ?? {
    root: process.env.ATTACHMENT_ROOT ?? './.attachments',
    maxBytes: Number(process.env.ATTACHMENT_MAX_BYTES ?? DEFAULT_MAX_ATTACHMENT_BYTES),
  };
  const storage = createLocalStorage(storageOpts);
  // multipart 의 자체 제한도 같은 값으로 맞춘다 — 스토리지만 막으면 파서가 먼저 메모리를 쓴다.
  await app.register(fastifyMultipart, { limits: { fileSize: storageOpts.maxBytes, files: 1 } });
  // #155: 채널 라우트가 storage 를 받는다 — 채널을 지울 때 그 안의 첨부 **파일**까지
  // 지워야 하고, 그 경로를 아는 것이 storage 다. 그래서 등록 순서가 main 과 다르다:
  // 채널·메시지 라우트가 createLocalStorage 뒤로 내려왔다.
  await registerChannelRoutes(app, deps.pool, storage);
  await registerMessageRoutes(app, deps.pool);
  await registerAttachmentRoutes(app, deps.pool, storage);
  // 아바타는 같은 스토리지를 쓴다 — 파일 저장소를 하나로 유지하기 위해서다(avatarRoutes 주석).
  await registerAvatarRoutes(app, deps.pool, storage);
  await registerDirectoryRoutes(app, deps.pool);
  await registerAuditRoutes(app, deps.pool);
  await registerSettingsRoutes(app, deps.pool);
  await registerHandleGroupRoutes(app, deps.pool);

  // **registerAuth 뒤에 등록해야 한다.** `app.requireAccount` 는 registerAuth 가 데코레이트하므로,
  // 앞에서 등록하면 preHandler 가 undefined 로 박혀 인증 없이 열린다(테스트가 이걸 잡았다).
  // 스크레이프에 인증을 요구하는 이유: 집계라도 워크스페이스 활동량을 드러낸다. admin 까지는
  // 요구하지 않는다 — 스크레이퍼가 쓸 실용적 자격증명은 만료 없는 에이전트 PAT 이고, 사람
  // 세션 토큰은 14일에 만료돼 스크레이퍼로 부적합하다.
  app.get('/metrics', { preHandler: app.requireAccount }, async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return metrics.renderAsync();
  });

  /**
   * avcs 투영 상태(#267). 화면이 "투영이 꺼졌다·멈췄다·비어 있다"를 **서로 다르게**
   * 말할 수 있게 하는 것이 전부다 — "없다"와 "못 읽었다"를 한 화면에 두지 않는다
   * (docs/design.md §4).
   *
   * 판정은 여기서 하지 않고 `projectionState`(shared)가 한다. 라우트에 인라인으로
   * 두면 5분 임계값이 서버·클라이언트·문서에 세 벌 생긴다.
   *
   * **위 `/metrics` 와 같은 이유로 `registerAuth` 뒤에 있어야 한다.** 처음에는
   * `/healthz` 옆(앞쪽)에 뒀는데, 그 자리에서는 `app.requireAccount` 가 아직
   * undefined 라 `preHandler` 가 통째로 사라지고 라우트가 **인증 없이 열린다**.
   * 이 응답은 저장소 이름과 에러 메시지(내부 URL 이 섞일 수 있다)를 담으므로 로그인
   * 하지 않은 사람에게 줄 것이 아니다. 401 을 확인하는 테스트가 이 자리를 지킨다.
   */
  app.get('/projection/status', { preHandler: app.requireAccount }, async () => {
    const runtime: ProjectionRuntime = deps.getProjectionStatus?.() ?? {
      configured: false, repo: null, lastLogIndex: 0,
      lastPolledAt: null, lastAdvancedAt: null, lastError: null,
    };
    // 원자료를 그대로 싣고 파생만 더한다 — 필드를 하나씩 베끼면 새 필드가 조용히 빠진다.
    return { ...runtime, state: projectionState(runtime) } satisfies ProjectionStatus;
  });
  await registerMcp(app, deps.pool, lifecycle, agentPresence);

  return app;
}
