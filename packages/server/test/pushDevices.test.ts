// 모바일 푸시 1단계(092): 기기 등록·해제. 발송은 다음 PR 이다.
// 지키는 약속:
// - 사람의 로그인 세션만 등록한다(security G3).
// - 세션이 사라지면 기기도 사라진다(로그아웃·비밀번호 변경·커뮤니티 제거가 같은 길이다).
// - 응답에 토큰·세션 해시가 없다.
// - 계정당 20대까지다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { hashToken } from '../src/auth/tokens.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { PUSH_DEVICES_PER_ACCOUNT } from '../src/routes/pushRoutes.js';
import { mintPat } from '../src/services/pats.js';

let app: FastifyInstance; let pool: Pool; let stop: () => Promise<void>;
let adminToken: string;
const auth = (t: string, agent?: string) => ({ authorization: `Bearer ${t}`, ...(agent ? { 'x-harkroom-agent': agent } : {}) });
const tok = (n: number) => n.toString(16).padStart(64, '0');
const put = (t: string, payload: unknown, agent?: string) =>
  app.inject({ method: 'PUT', url: '/push/devices', headers: auth(t, agent), payload: payload as object });
const login = async (handle: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: handle, password: 'pw123456' } })).json().token as string;
const rows = async (accountId: string) =>
  (await pool.query(`select token, session_token_hash as s from push_device where account_id = $1 order by token`, [accountId])).rows;

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  // 이 파일은 가입·로그인을 서른 번 넘게 한다 — 기본 로그인 한도(5분 20회)를 넉넉히 푼다.
  app = await buildServer({ pool, rateLimits: { login: { windowMs: 60_000, max: 1000 }, signup: { windowMs: 60_000, max: 1000 } } });
  ({ token: adminToken } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

describe('PUT /push/devices', () => {
  it('사람 세션이면 등록된다 — 기본 prefs 는 미리보기 꺼짐, 응답에 토큰·세션 해시가 없다', async () => {
    const { token, accountId } = await createMember(app, adminToken, 'p-basic');
    const res = await put(token, { token: tok(1), platform: 'ios', env: 'production' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prefs).toEqual({ mention: true, dm: true, threadReply: true, ask: true, preview: false, badge: true });
    expect(body.env).toBe('production');
    expect(JSON.stringify(body)).not.toContain(tok(1));
    expect(JSON.stringify(body)).not.toContain(hashToken(token));
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'env', 'id', 'lastSeenAt', 'platform', 'prefs']);
    expect(await rows(accountId)).toEqual([{ token: tok(1), s: hashToken(token) }]);
  });

  it('다시 등록하면 한 행이다 — 대문자 토큰도 같은 행, prefs 는 보낸 키만 바뀐다', async () => {
    const { token, accountId } = await createMember(app, adminToken, 'p-again');
    const mixed = 'ab'.repeat(32);
    await put(token, { token: mixed, platform: 'ios', env: 'production', prefs: { preview: true } });
    const res = await put(token, { token: mixed.toUpperCase(), platform: 'ios', env: 'sandbox', prefs: { dm: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().prefs).toEqual({ mention: true, dm: false, threadReply: true, ask: true, preview: true, badge: true });
    expect(res.json().env).toBe('sandbox');
    expect(await rows(accountId)).toHaveLength(1);
  });

  it.each([
    ['hex 가 아닌 토큰', { token: 'z'.repeat(64), platform: 'ios', env: 'production' }],
    ['짧은 토큰', { token: 'ab'.repeat(10), platform: 'ios', env: 'production' }],
    ['긴 토큰', { token: 'a'.repeat(201), platform: 'ios', env: 'production' }],
    ['모르는 플랫폼', { token: tok(3), platform: 'android', env: 'production' }],
    ['모르는 env', { token: tok(3), platform: 'ios', env: 'dev' }],
    ['모르는 prefs 키', { token: tok(3), platform: 'ios', env: 'production', prefs: { all: true } }],
    ['모르는 최상위 키', { token: tok(3), platform: 'ios', env: 'production', accountId: 'x' }],
  ])('%s 는 400 이다', async (_name, payload) => {
    const { token, accountId } = await createMember(app, adminToken, `p-bad-${Math.random().toString(36).slice(2, 8)}`);
    const res = await put(token, payload);
    expect(res.statusCode).toBe(400);
    expect(await rows(accountId)).toHaveLength(0);
  });

  it('에이전트 PAT 는 403 push_session_only 다', async () => {
    const { pat, accountId } = await createAgent(app, adminToken, 'p-agent');
    const res = await put(pat, { token: tok(4), platform: 'ios', env: 'production' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('push_session_only');
    expect(await rows(accountId)).toHaveLength(0);
  });

  it('사람 계정의 PAT 도 403 이다 — 계정 종류가 아니라 자격증명 경로(authVia)로 가른다', async () => {
    const { accountId } = await createMember(app, adminToken, 'p-human-pat');
    // REST 는 이제 사람 PAT 를 발급하지 않는다(대상은 에이전트뿐). 그래도 옛 사람 PAT 가 남아 있을 수 있고
    // PAT 인증은 계정 종류를 보지 않으니, 계정 종류만 보면 이 길이 열린다 — 서비스로 직접 만든다.
    const made = await mintPat(pool, accountId, 'cli', { actorId: null, actorHandle: null });
    if (!made.ok) throw new Error('mint failed');
    const res = await put(made.token, { token: tok(8), platform: 'ios', env: 'production' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('push_session_only');
    expect(await rows(accountId)).toHaveLength(0);
  });

  it('오퍼레이터 토큰은 에이전트로 서도 403, 계정 없이는 401 이다', async () => {
    const { token: opToken } = await registerOperator(app, adminToken, 'p-box');
    // 배정 없이 헤더를 붙이면 플러그인이 먼저 403 not_assigned 로 막는다. 어느 쪽이든 등록은 안 된다.
    const { accountId: agentId } = await createAgent(app, adminToken, 'p-op-agent');
    const withAgent = await put(opToken, { token: tok(5), platform: 'ios', env: 'production' }, agentId);
    expect(withAgent.statusCode).toBe(403);
    const bare = await put(opToken, { token: tok(5), platform: 'ios', env: 'production' });
    expect(bare.statusCode).toBe(401);
    expect(await rows(agentId)).toHaveLength(0);
  });

  it('인증이 없으면 401 이다', async () => {
    const res = await app.inject({ method: 'PUT', url: '/push/devices', payload: { token: tok(6), platform: 'ios', env: 'production' } });
    expect(res.statusCode).toBe(401);
  });

  it('같은 폰의 두 계정은 둘 다 받는다 — (token, account_id) 마다 한 행', async () => {
    const a = await createMember(app, adminToken, 'p-two-a');
    const b = await createMember(app, adminToken, 'p-two-b');
    expect((await put(a.token, { token: tok(7), platform: 'ios', env: 'production' })).statusCode).toBe(200);
    expect((await put(b.token, { token: tok(7), platform: 'ios', env: 'production' })).statusCode).toBe(200);
    expect(await rows(a.accountId)).toHaveLength(1);
    expect(await rows(b.accountId)).toHaveLength(1);
  });

  it(`계정당 ${PUSH_DEVICES_PER_ACCOUNT}대 — 넘으면 가장 오래 등록하지 않은 기기부터 지운다`, async () => {
    const { token, accountId } = await createMember(app, adminToken, 'p-cap');
    for (let i = 0; i < PUSH_DEVICES_PER_ACCOUNT; i++) {
      expect((await put(token, { token: tok(100 + i), platform: 'ios', env: 'production' })).statusCode).toBe(200);
    }
    // 가장 오래된 것(100)을 다시 등록해 새로 만든다 → 이제 가장 오래된 것은 101 이다.
    await put(token, { token: tok(100), platform: 'ios', env: 'production' });
    await put(token, { token: tok(999), platform: 'ios', env: 'production' });
    const left = (await rows(accountId)).map((r) => r.token);
    expect(left).toHaveLength(PUSH_DEVICES_PER_ACCOUNT);
    expect(left).toContain(tok(100));
    expect(left).toContain(tok(999));
    expect(left).not.toContain(tok(101));
  });
});

describe('세션과 함께 사라진다', () => {
  it('로그아웃하면 그 세션의 기기가 사라진다 — 다른 세션의 기기는 남는다', async () => {
    const { token: t1, accountId } = await createMember(app, adminToken, 'p-logout');
    const t2 = await login('p-logout');
    await put(t1, { token: tok(10), platform: 'ios', env: 'production' });
    await put(t2, { token: tok(11), platform: 'ios', env: 'production' });
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(t1) })).statusCode).toBe(204);
    expect((await rows(accountId)).map((r) => r.token)).toEqual([tok(11)]);
  });

  it('다시 로그인해 같은 토큰을 등록하면 새 세션으로 옮긴다 — 옛 세션 로그아웃이 살아 있는 기기를 지우지 않는다', async () => {
    const { token: oldT, accountId } = await createMember(app, adminToken, 'p-move');
    await put(oldT, { token: tok(12), platform: 'ios', env: 'production' });
    const newT = await login('p-move');
    await put(newT, { token: tok(12), platform: 'ios', env: 'production' });
    expect(await rows(accountId)).toEqual([{ token: tok(12), s: hashToken(newT) }]);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(oldT) });
    expect(await rows(accountId)).toHaveLength(1);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(newT) });
    expect(await rows(accountId)).toHaveLength(0);
  });

  it('비밀번호를 바꿔 끊긴 다른 세션의 기기도 사라진다', async () => {
    const { token: keep, accountId } = await createMember(app, adminToken, 'p-pw');
    const other = await login('p-pw');
    await put(keep, { token: tok(13), platform: 'ios', env: 'production' });
    await put(other, { token: tok(14), platform: 'ios', env: 'production' });
    const res = await app.inject({
      method: 'POST', url: '/auth/password', headers: auth(keep),
      payload: { currentPassword: 'pw123456', newPassword: 'pw654321' },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect((await rows(accountId)).map((r) => r.token)).toEqual([tok(13)]);
  });
});

describe('DELETE /push/devices/current', () => {
  it('지금 세션에 묶인 기기만 지운다', async () => {
    const { token: t1, accountId } = await createMember(app, adminToken, 'p-del');
    const t2 = await login('p-del');
    await put(t1, { token: tok(20), platform: 'ios', env: 'production' });
    await put(t2, { token: tok(21), platform: 'ios', env: 'production' });
    const res = await app.inject({ method: 'DELETE', url: '/push/devices/current', headers: auth(t1) });
    expect(res.statusCode).toBe(204);
    expect((await rows(accountId)).map((r) => r.token)).toEqual([tok(21)]);
  });

  it('에이전트 PAT 는 403 이다', async () => {
    const { pat } = await createAgent(app, adminToken, 'p-del-agent');
    const res = await app.inject({ method: 'DELETE', url: '/push/devices/current', headers: auth(pat) });
    expect(res.statusCode).toBe(403);
  });
});

describe('계정 삭제(security G1)', () => {
  it('에이전트를 지우면 그 계정의 push_device 도 지운다 — 등록 라우트를 우회한 행이 있어도', async () => {
    const { accountId } = await createAgent(app, adminToken, 'p-gone');
    const raw = 'raw-session-for-test';
    await pool.query(`insert into session (token_hash, account_id, expires_at) values ($1, $2, now() + interval '1 day')`,
      [hashToken(raw), accountId]);
    await pool.query(
      `insert into push_device (account_id, session_token_hash, platform, apns_env, token, prefs)
       values ($1, $2, 'ios', 'production', $3, '{}')`, [accountId, hashToken(raw), tok(30)]);
    const res = await app.inject({ method: 'DELETE', url: `/accounts/agents/${accountId}`, headers: auth(adminToken) });
    expect(res.statusCode).toBeLessThan(300);
    expect(await rows(accountId)).toHaveLength(0);
  });
});
