export interface Config {
  databaseUrl: string;
  port: number;
  avcsBaseUrl: string | null;
  /** null 이면 모든 origin 을 반영한다(셀프호스트 기본). 목록이면 CORS·WS 핸드셰이크 양쪽에 적용된다. */
  corsOrigins: string[] | null;
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
  };
}
