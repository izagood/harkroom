import pg from 'pg';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './buildServer.js';
import { httpAvcsClient } from './avcs/client.js';
import { ProjectionWorker, ensureSystemAccount } from './avcs/projection.js';

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

const app = await buildServer({ pool, getAvcsStatus: () => worker?.status() ?? { connected: false } });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`murmur server on :${config.port} (avcs: ${config.avcsBaseUrl ?? 'disabled'})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await worker?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
