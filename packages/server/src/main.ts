import pg from 'pg';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './buildServer.js';
import { httpAvcsClient } from './avcs/client.js';
import { ProjectionWorker, ensureSystemAccount } from './avcs/projection.js';
import { Lifecycle } from './lifecycle.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
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

const lifecycle = new Lifecycle();
const app = await buildServer({
  pool,
  lifecycle,
  getAvcsStatus: () => worker?.status() ?? { connected: false },
  corsOrigins: config.corsOrigins,
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
