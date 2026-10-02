import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { parseTrustProxy, type TrustProxy } from '../src/config.js';

let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;

const MAX = 3;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const boot = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(boot));
  await boot.close();
});
afterAll(async () => stop());

const build = (trustProxy?: TrustProxy): Promise<FastifyInstance> => buildServer({
  pool, trustProxy, rateLimits: { login: { windowMs: 60_000, max: MAX } },
});

const login = (app: FastifyInstance, remoteAddress: string, forwardedFor?: string) => app.inject({
  method: 'POST', url: '/auth/login', payload: { loginId: 'admin', password: 'wrong' },
  remoteAddress,
  ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
});

describe('프록시 신뢰 — 기본값(끔)', () => {
  // 이것이 가장 중요하다. 헤더를 신뢰하면 공격자가 X-Forwarded-For 를 매 요청마다 바꿔
  // **리밋을 무한히 우회**한다. Fastify 기본값이 안전하다는 것을 고정해 둔다.
  it('ignores X-Forwarded-For so the limit cannot be escaped by spoofing it', async () => {
    const app = await build();

    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i += 1) {
      // 매번 다른 값을 보낸다 — 헤더가 키에 쓰이면 전부 통과할 것이다.
      codes.push((await login(app, '10.5.0.1', `203.0.113.${i}`)).statusCode);
    }

    expect(codes).toContain(429);
    await app.close();
  });
});

describe('프록시 신뢰 — 켬', () => {
  // 리버스 프록시 뒤에서는 소켓 주소가 프록시 하나뿐이라, 켜지 않으면 **모든 클라이언트가
  // 한 버킷을 공유**한다. compose 배포가 지금 그 상태다(모든 요청이 브리지 게이트웨이로 보인다).
  it('keys the limit per forwarded client instead of lumping everyone together', async () => {
    const app = await build(true);

    for (let i = 0; i < MAX + 1; i += 1) await login(app, '10.5.0.9', '198.51.100.7');
    const exhausted = await login(app, '10.5.0.9', '198.51.100.7');
    const other = await login(app, '10.5.0.9', '198.51.100.8');

    expect(exhausted.statusCode).toBe(429);
    expect(other.statusCode).not.toBe(429); // 같은 프록시를 거친 다른 클라이언트
    await app.close();
  });

  it('records the forwarded client in the audit log, not the proxy', async () => {
    const app = await build(true);

    await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'admin', password: 'wrong' },
      remoteAddress: '10.5.0.9', headers: { 'x-forwarded-for': '198.51.100.42' },
    });

    const row = await pool.query(
      `select ip from audit_log where action = 'login.failed' order by id desc limit 1`,
    );
    expect(row.rows[0]?.ip).toBe('198.51.100.42');
    await app.close();
  });
});

/**
 * hop 수로 믿기. 터널 배포의 실제 모양을 그대로 옮긴다 — envoy(소켓)가 받는 XFF 는
 * `<클라이언트가 보낸 값>,<Cloudflare 가 덧붙인 진짜 주소>,<cloudflared 파드>` 이다.
 * `true`(전부 믿기)면 맨 왼쪽(위조 칸)이 `req.ip` 가 되고, `2` 면 오른쪽에서 두 번째(진짜 주소)가 된다.
 */
describe('프록시 신뢰 — hop 수', () => {
  const tunnelXff = (spoofed: string) => `${spoofed},198.51.100.20,10.244.4.233`;

  it('ignores a spoofed leftmost X-Forwarded-For when trusting 2 hops', async () => {
    const app = await build(2);

    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i += 1) {
      // 위조 칸을 매번 바꾼다 — 그 칸이 키에 쓰이면 전부 통과할 것이다.
      codes.push((await login(app, '10.244.1.5', tunnelXff(`203.0.113.${i}`))).statusCode);
    }

    expect(codes).toContain(429);
    await app.close();
  });

  it('records the address the edge appended, not the spoofed one', async () => {
    const app = await build(2);

    await login(app, '10.244.1.5', tunnelXff('203.0.113.77'));

    const row = await pool.query(
      `select ip from audit_log where action = 'login.failed' order by id desc limit 1`,
    );
    expect(row.rows[0]?.ip).toBe('198.51.100.20');
    await app.close();
  });

  // 대조군: 같은 요청을 옛 설정(`true`)으로 받으면 위조 칸이 그대로 쓰인다 — 이 PR 이 고치는 구멍.
  it('documents that trusting every hop takes the spoofed value', async () => {
    const app = await build(true);

    await login(app, '10.244.1.5', tunnelXff('203.0.113.78'));

    const row = await pool.query(
      `select ip from audit_log where action = 'login.failed' order by id desc limit 1`,
    );
    expect(row.rows[0]?.ip).toBe('203.0.113.78');
    await app.close();
  });

  it('trusts only the listed proxy CIDRs', async () => {
    const app = await build(['10.244.0.0/16']);

    // 소켓(10.244.1.5)과 cloudflared(10.244.4.233)는 목록 안이라 건너뛰고, 그 다음이 클라이언트다.
    await login(app, '10.244.1.5', tunnelXff('203.0.113.79'));

    const row = await pool.query(
      `select ip from audit_log where action = 'login.failed' order by id desc limit 1`,
    );
    expect(row.rows[0]?.ip).toBe('198.51.100.20');
    await app.close();
  });
});

describe('TRUST_PROXY 읽기', () => {
  it('keeps the old values working', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    // `1` 은 hop 1 이 아니다 — 처음부터 "전부 믿기"였고 배포가 그 값으로 켜져 있다.
    expect(parseTrustProxy('1')).toBe(true);
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('reads hop counts and proxy lists', () => {
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy(' 3 ')).toBe(3);
    expect(parseTrustProxy('hops:1')).toBe(1);
    expect(parseTrustProxy('10.244.0.0/16, 192.168.1.211')).toEqual(['10.244.0.0/16', '192.168.1.211']);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
  });

  // 알 수 없는 값을 조용히 끄거나 켜면 둘 다 경고 없이 리밋이 틀어진다 — 기동을 멈춘다.
  it('refuses values it does not understand', () => {
    for (const bad of ['yes', 'hops:0', '17', '10.0.0.0/33', '10.0.0.300', 'loopback']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/TRUST_PROXY/);
    }
  });
});
