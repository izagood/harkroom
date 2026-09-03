import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { buildServer } from './buildServer.js';
import { httpAvcsClient } from './avcs/client.js';
import {
  ProjectionWorker, ensureSystemAccount, warnIfProjectionDisabled, DISABLED_PROJECTION_STATUS,
} from './avcs/projection.js';
import { Lifecycle } from './lifecycle.js';

const config = loadConfig();
// 가드 없는 Pool 을 만들지 않는다 — pg 는 유휴 클라이언트 에러를 리스너 없으면 uncaught
// exception 으로 던지고, Postgres 재시작이 곧 서버 사망이 된다(db/pool.ts 참조).
const pool = createPool(config.databaseUrl, (err) => {
  console.error('postgres pool error (idle client):', err.message);
});
await runMigrations(pool);

let worker: ProjectionWorker | null = null;
if (config.avcsBaseUrl) {
  worker = new ProjectionWorker({
    pool,
    avcs: httpAvcsClient(config.avcsBaseUrl),
    systemAccountId: await ensureSystemAccount(pool),
  });
  worker.start();
}
// 꺼져 있으면 기동 시 경고 한 줄(#267). 판정은 projection.ts 에 있다 — 이 파일은
// 임포트만으로 포트를 잡으므로 여기 인라인으로 두면 시험할 수 없다.
warnIfProjectionDisabled(config.avcsBaseUrl);

const lifecycle = new Lifecycle();
const app = await buildServer({
  pool,
  lifecycle,
  // 두 표면은 **다른 질문**에 답한다: /healthz 는 avcs 소켓이 붙었는가,
  // /projection/status 는 투영이 돌고 있는가다(#267).
  getAvcsStatus: () => ({ connected: (worker?.status() ?? DISABLED_PROJECTION_STATUS).connected }),
  getProjectionStatus: () => worker?.status() ?? DISABLED_PROJECTION_STATUS,
  corsOrigins: config.corsOrigins,
  logLevel: config.logLevel,
  trustProxy: config.trustProxy,
});
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`murmur server on :${config.port} (avcs: ${config.avcsBaseUrl ?? 'disabled'})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    // 순서가 중요하다. 소켓을 닫기 **전에** in-flight long-poll을 정상 마감(빈 결과 200)시킨다 —
    // 업데이트로 프로세스가 교체될 때 에이전트가 transport error 대신 정상 타임아웃을 보고
    // 다음 poll로 넘어가게 하는 지점이다. 이후 남은 응답은 grace 안에서 흘려보낸다.
    await lifecycle.beginDrain();
    await worker?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
