import { isIP } from 'node:net';

export interface Config {
  databaseUrl: string;
  port: number;
  avcsBaseUrl: string | null;
  /** null 이면 모든 origin 을 반영한다(셀프호스트 기본). 목록이면 CORS·WS 핸드셰이크 양쪽에 적용된다. */
  corsOrigins: string[] | null;
  logLevel: string;
  /**
   * 앞단 리버스 프록시를 얼마나 신뢰할지(`TRUST_PROXY`). Fastify `trustProxy` 에 그대로 간다.
   * 프록시가 **실제로 있을 때만** 켠다 — 없는데 켜면 헤더 위조로 레이트 리밋을 우회할 수 있다.
   * 값의 모양은 `parseTrustProxy` 가 정한다.
   */
  trustProxy: TrustProxy;
}

/**
 * `false` = 안 믿음 · `true` = **전부 믿음**(옛 `1`/`true`, 비권장) · 숫자 = 소켓에서부터 믿을
 * hop 수 · 문자열 목록 = 믿을 프록시의 IP/CIDR.
 */
export type TrustProxy = boolean | number | string[];

const CIDR = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/;

/**
 * `TRUST_PROXY` 를 읽는다.
 *
 * **`1`/`true` 는 hop 1 이 아니라 "전부 믿음"이다** — 이 변수가 처음 생길 때의 뜻이고, 배포가 그
 * 값으로 켜져 있어 호환으로 남긴다. 전부 믿으면 `X-Forwarded-For` 의 **맨 왼쪽**(클라이언트가
 * 마음대로 쓰는 칸)이 `req.ip` 가 되므로, 앞단 프록시가 들어온 XFF 를 덮어쓰지 않는 한 요청마다
 * 값을 바꿔 레이트 리밋을 무한히 우회할 수 있다(Cloudflare·envoy 는 덮어쓰지 않고 덧붙인다).
 * 그래서 hop 수(`2` 이상) 또는 CIDR 목록을 쓴다. hop 1 이 필요하면 `hops:1` 로 적는다.
 *
 * 알 수 없는 값은 **기동을 멈춘다.** 조용히 끄면 모든 사용자가 프록시 주소 하나로 묶여 서로의
 * 리밋을 나눠 쓰고, 조용히 켜면 위조가 통한다 — 둘 다 아무 경고 없이 일어난다.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? '').trim();
  if (v === '' || v === '0' || v.toLowerCase() === 'false') return false;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  const hops = /^(?:hops:)?(\d+)$/i.exec(v);
  if (hops) {
    const n = Number(hops[1]);
    if (n >= 1 && n <= 16) return n;
  }
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!hops && list.length && list.every((s) => CIDR.test(s) && isIpOrCidr(s))) return list;
  throw new Error(
    `TRUST_PROXY=${JSON.stringify(v)} is not understood — use a hop count (2, or hops:1), `
    + 'a comma-separated list of proxy IPs/CIDRs, or 0 to disable',
  );
}

function isIpOrCidr(s: string): boolean {
  const [addr, bits] = s.split('/');
  const family = isIP(addr!);
  if (!family) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return n >= 0 && n <= (family === 4 ? 32 : 128);
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
