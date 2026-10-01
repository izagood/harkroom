// APNs 전송부(토큰 인증 .p8). 의존성 없이 node:http2 와 node:crypto 로 만든다.
//
// - JWT 는 ES256 이고 서명은 **`ieee-p1363`** 이다. node 의 기본값(DER)으로 서명하면 APNs 는
//   InvalidProviderToken(403)으로 거절한다.
// - JWT 는 50분마다 새로 만든다. APNs 는 20분보다 자주 바꾸면 TooManyProviderTokenUpdates,
//   60분이 넘으면 ExpiredProviderToken 을 낸다.
// - TLS 검증을 끄는 옵션은 쓰지 않는다. 시험은 `origins` 로 로컬 h2c 서버를 가리킬 뿐이다.
// - 로그에 기기 토큰은 앞 8자만 남기고, JWT 는 남기지 않는다(security).
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

export type ApnsEnv = 'production' | 'sandbox';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** `.p8` 파일 내용(PEM). */
  keyPem: string;
  /** 번들 id. */
  topic: string;
}

export interface ApnsSendInput {
  token: string;
  env: ApnsEnv;
  payload: unknown;
  collapseId: string;
}

export interface ApnsResult {
  status: number;
  /** APNs 가 준 `reason`(BadDeviceToken 등). 성공이면 없다. 네트워크 오류는 status 0. */
  reason?: string;
}

export interface PushTransport {
  send(input: ApnsSendInput): Promise<ApnsResult>;
  close(): void;
}

export const APNS_ORIGINS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** JWT 를 새로 만드는 주기. */
export const APNS_JWT_TTL_MS = 50 * 60_000;

/** 기기 토큰을 로그에 남길 때. */
export const redactToken = (token: string): string => `${token.slice(0, 8)}…`;

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export function signApnsJwt(cfg: Pick<ApnsConfig, 'keyId' | 'teamId'>, key: KeyObject, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: nowSec }));
  const input = `${head}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

/**
 * env 에서 설정을 읽는다. **넷 다 없으면 null**(푸시를 끈다). 일부만 있으면 기동을 멈춘다 —
 * "켰다고 생각했는데 조용히 꺼져 있다"가 가장 찾기 어렵다. 키가 PEM 으로 읽히지 않을 때도 같다.
 * 오류 문구에는 값이 아니라 **이름**만 싣는다.
 */
export function loadApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const names = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_P8', 'APNS_TOPIC'] as const;
  const present = names.filter((n) => (env[n] ?? '').trim() !== '');
  if (present.length === 0) return null;
  if (present.length !== names.length) {
    const missing = names.filter((n) => !present.includes(n));
    throw new Error(`push: ${missing.join(', ')} is missing (set all of ${names.join(', ')} or none)`);
  }
  const cfg: ApnsConfig = {
    keyId: env.APNS_KEY_ID!.trim(), teamId: env.APNS_TEAM_ID!.trim(),
    keyPem: env.APNS_KEY_P8!, topic: env.APNS_TOPIC!.trim(),
  };
  try {
    createPrivateKey(cfg.keyPem);
  } catch {
    throw new Error('push: APNS_KEY_P8 is not a readable PEM private key');
  }
  return cfg;
}

export function createApnsTransport(
  cfg: ApnsConfig,
  opts: { origins?: Record<ApnsEnv, string>; now?: () => number; timeoutMs?: number } = {},
): PushTransport {
  const origins = opts.origins ?? APNS_ORIGINS;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const key = createPrivateKey(cfg.keyPem);
  let jwt: { value: string; at: number } | null = null;
  const sessions = new Map<ApnsEnv, ClientHttp2Session>();

  const token = () => {
    const t = now();
    if (!jwt || t - jwt.at >= APNS_JWT_TTL_MS) jwt = { value: signApnsJwt(cfg, key, Math.floor(t / 1000)), at: t };
    return jwt.value;
  };

  /** 환경마다 연결 하나를 이어 쓴다(APNs 권장). 닫히거나 오류가 나면 다음 요청이 새로 연다. */
  const session = (env: ApnsEnv): ClientHttp2Session => {
    const open = sessions.get(env);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(origins[env]);
    s.on('error', () => { sessions.delete(env); });
    s.on('close', () => { if (sessions.get(env) === s) sessions.delete(env); });
    s.unref();
    sessions.set(env, s);
    return s;
  };

  return {
    send(input) {
      return new Promise<ApnsResult>((resolve) => {
        let s: ClientHttp2Session;
        try { s = session(input.env); } catch { resolve({ status: 0, reason: 'connect_failed' }); return; }
        const req = s.request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${input.token}`,
          authorization: `bearer ${token()}`,
          'apns-topic': cfg.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': input.collapseId,
          'content-type': 'application/json',
        });
        let status = 0;
        let body = '';
        const timer = setTimeout(() => { req.close(constants.NGHTTP2_CANCEL); resolve({ status: 0, reason: 'timeout' }); }, timeoutMs);
        req.setEncoding('utf8');
        req.on('response', (h) => { status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0); });
        req.on('data', (c: string) => { if (body.length < 4096) body += c; });
        req.on('end', () => {
          clearTimeout(timer);
          let reason: string | undefined;
          if (status !== 200) {
            try { reason = (JSON.parse(body) as { reason?: string }).reason; } catch { reason = undefined; }
          }
          resolve(reason ? { status, reason } : { status });
        });
        req.on('error', () => { clearTimeout(timer); resolve({ status: 0, reason: 'stream_error' }); });
        req.end(JSON.stringify(input.payload));
      });
    },
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}
