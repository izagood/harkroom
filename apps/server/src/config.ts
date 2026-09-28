export interface Config {
  databaseUrl: string;
  port: number;
  avcsBaseUrl: string | null;
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
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
