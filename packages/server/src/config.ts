export interface Config {
  databaseUrl: string;
  port: number;
  avcsBaseUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    port: Number(env.PORT ?? 3400),
    avcsBaseUrl: env.AVCS_BASE_URL ?? null,
  };
}
