export interface Config {
  databaseUrl: string;
  port: number;
  avcsBaseUrl: string | null;
  /**
   * `hosted` 저장소의 데이터 루트(`avcs/host.ts`). **이 디렉터리는 백업 대상이다** —
   * 여기 들어가는 것은 코드의 역사(op 그래프)이고, 잃으면 파일은 미러에 남아도 그 그래프는
   * 복원되지 않는다(`docs/hub-seat.md` §5 결정 2). hosted 저장소가 없으면 만들어지지도 않는다.
   */
  hostedAvcsDataDir: string;
  /** null 이면 모든 origin 을 반영한다(셀프호스트 기본). 목록이면 CORS·WS 핸드셰이크 양쪽에 적용된다. */
  corsOrigins: string[] | null;
  logLevel: string;
  /**
   * 앞단 리버스 프록시를 신뢰할지(`TRUST_PROXY=1`). 프록시가 **실제로 있을 때만** 켠다 —
   * 없는데 켜면 헤더 위조로 레이트 리밋을 우회할 수 있다.
   */
  trustProxy: boolean;
}

/** 데스크탑 빌드본은 `tauri://localhost`, `tauri dev` 는 Vite dev 서버 origin 을 보낸다. */
function parseOrigins(raw: string | undefined): string[] | null {
  const list = (raw ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return list.length ? list : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    port: Number(env.PORT ?? 3400),
    avcsBaseUrl: env.AVCS_BASE_URL ?? null,
    hostedAvcsDataDir: env.AVCS_HOSTED_DATA ?? './data/avcs',
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
