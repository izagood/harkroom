import { loadConfig } from './config.js';
import { runMigrationsWhenReachable } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { buildServer } from './buildServer.js';
import { warnIfProjectionDisabled } from './avcs/projection.js';
import { ProjectionSupervisor } from './avcs/supervisor.js';
import { getProjectionConfig } from './services/projectionConfig.js';
import { resolveProjectionUrl } from '@harkroom/shared';
import { Lifecycle } from './lifecycle.js';
import { seedClaimToken } from './services/claimToken.js';

const config = loadConfig();
// 가드 없는 Pool 을 만들지 않는다 — pg 는 유휴 클라이언트 에러를 리스너 없으면 uncaught
// exception 으로 던지고, Postgres 재시작이 곧 서버 사망이 된다(db/pool.ts 참조).
const pool = createPool(config.databaseUrl, (err) => {
  console.error('postgres pool error (idle client):', err.message);
});
// DB 가 아직 안 떴으면 기다린다(2026-10-12) — 이유는 runMigrationsWhenReachable 주석.
await runMigrationsWhenReachable(pool);

/*
 * 처리 안 된 거절(unhandled rejection)은 **잡지 않는다** — Node 기본(`throw`)대로 프로세스가 죽는다.
 * 전역 핸들러로 로그 한 줄만 남기고 살려 두면 이번 사고(sweep 이 DB 오류를 놓쳐 죽던 것)와
 * 무관한 결함까지 조용히 묻히고, 어디서 무엇이 반쯤 끝났는지 모르는 프로세스가 계속 요청을 받는다.
 * DB 순간 장애에 살아남는 것은 **각 자리**가 한다: 주기 작업은 자기 오류를 로그로 남기고 다음
 * 주기에 다시 하고(test/dbOutage.test.ts), 빌려 간 클라이언트의 끊김은 db/pool.ts 가 받는다.
 * 그 밖에서 새는 거절은 고칠 결함이다 — 죽음과 스택이 그것을 알린다(에이전트 쪽 같은 판단:
 * packages/agent/src/main.ts 의 unhandledRejection 주석).
 */

// 클레임 토큰을 심는다(053). 마이그레이션 **뒤**라야 한다 — 그때 테이블이 생긴다.
// 값이 없으면 아무 일도 하지 않는다: 셀프호스트는 `/bootstrap` 을 쓰고 이 경로를 모른다.
const seeded = await seedClaimToken(pool, process.env.CLAIM_TOKEN_HASH);
if (seeded) console.log('claim token seeded — this workspace can be claimed once via POST /claim');

// 워커를 쥐는 자리가 supervisor 로 옮겨갔다(#537 후속). 이 파일에 `let worker` 를 두면
// 그것을 갈아 끼우는 판정도 여기 남고, 이 파일은 임포트만으로 포트를 잡아 시험할 수 없다.
const supervisor = new ProjectionSupervisor({ pool });
// 마이그레이션 뒤에 읽는다 — projection_config 테이블이 그때 생긴다.
const boot = resolveProjectionUrl(config.avcsBaseUrl, await getProjectionConfig(pool));
await supervisor.reconfigure(boot.url);
// 꺼져 있으면 기동 시 경고 한 줄(#267). **판정 결과로 묻는다** — env 가 없어도 앱에서
// 켜 뒀으면 투영은 돌고 있고, 그때 경고를 내면 화면과 로그가 서로 다른 말을 한다.
warnIfProjectionDisabled(boot.url);

const lifecycle = new Lifecycle();
const app = await buildServer({
  pool,
  lifecycle,
  // 두 표면은 **다른 질문**에 답한다: /healthz 는 avcs 소켓이 붙었는가,
  // /projection/status 는 투영이 돌고 있는가다(#267).
  getAvcsStatus: () => ({ connected: supervisor.status().connected }),
  getProjectionStatus: () => supervisor.status(),
  // 앱에서 투영을 켜는 표면. env 값은 여기서만 흘러 들어간다 — 라우트는 config 를 모른다.
  projection: {
    envBaseUrl: config.avcsBaseUrl,
    reconfigure: (url) => supervisor.reconfigure(url),
    currentUrl: () => supervisor.currentUrl(),
  },
  corsOrigins: config.corsOrigins,
  logLevel: config.logLevel,
  trustProxy: config.trustProxy,
});
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(
  `harkroom server on :${config.port} `
  + `(avcs: ${boot.url ?? 'disabled'}${boot.source ? ` via ${boot.source}` : ''})`,
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    // 순서가 중요하다. 소켓을 닫기 **전에** in-flight long-poll을 정상 마감(빈 결과 200)시킨다 —
    // 업데이트로 프로세스가 교체될 때 에이전트가 transport error 대신 정상 타임아웃을 보고
    // 다음 poll로 넘어가게 하는 지점이다. 이후 남은 응답은 grace 안에서 흘려보낸다.
    await lifecycle.beginDrain();
    await supervisor.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
