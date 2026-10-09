import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { createSecretKeyring } from '../src/services/secretKeyring.js';
import { RevealLimiter } from '../src/services/secretAccess.js';
import { STEP_UP_RULE } from '../src/routes/authRoutes.js';
import { STEP_UP_IDLE_MS, STEP_UP_MAX_MS } from '../src/services/stepUp.js';
import { hashToken } from '../src/auth/tokens.js';

/**
 * 소유자 보기(114, 스레드 464aff1c) — 비밀번호를 다시 확인한 **세션**의 **소유자 본인**만 값을 받는다.
 * 운영자(admin)·에이전트·오퍼레이터 경로는 열리지 않는다. 보기·복사·내려받기는 한 번마다 access log 한 줄이다.
 */
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const TEXT_VALUE = 'owner-reveal-text-value-0001';

describe('비밀 소유자 보기 (114)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let off: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let textId: string;
  let fileId: string;
  const fileBytes = randomBytes(300);
  const ring = createSecretKeyring(new Map([['k1', randomBytes(32)]]), 'k1');

  const stepUp = (token: string, password = 'pw123456') =>
    app.inject({ method: 'POST', url: '/auth/step-up', headers: auth(token), payload: { password } });
  const reveal = (token: string, id: string, payload: Record<string, unknown> = { action: 'view' }, server = app) =>
    server.inject({ method: 'POST', url: `/secrets/${id}/reveal`, headers: auth(token), payload });
  const accessRows = async (id: string) =>
    (await pool.query(
      `select actor_account_id as "actorAccountId", action, client, ip, result, reason, version, agent_id as "agentId"
         from secret_access_log where secret_id = $1 order by id`, [id])).rows;
  const login = async (handle: string) =>
    (await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: handle, password: 'pw123456' } })).json().token as string;

  beforeAll(async () => {
    db = await startTestDb();
    pool = db.pool;
    app = await buildServer({ pool, secretKeyring: ring, secretOwnerRevealLimiter: new RevealLimiter(6, 60_000) });
    off = await buildServer({ pool, secretKeyring: null });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    textId = (await app.inject({
      method: 'POST', url: '/secrets', headers: auth(alice.token),
      payload: { name: 'api-key', kind: 'text', value: TEXT_VALUE },
    })).json().secret.id as string;
    fileId = (await app.inject({
      method: 'POST', url: '/secrets', headers: auth(alice.token),
      payload: { name: 'tls-key', kind: 'file', filename: 'key.pem', valueBase64: fileBytes.toString('base64') },
    })).json().secret.id as string;
  });
  afterAll(async () => { await app.close(); await off.close(); await db.stop(); });

  it('다시 확인 없이는 소유자도 못 받는다 — 거절도 access log 에 남는다', async () => {
    const res = await reveal(alice.token, textId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('step_up_required');
    expect(res.body).not.toContain(TEXT_VALUE);
    const rows = await accessRows(textId);
    expect(rows.at(-1)).toMatchObject({ actorAccountId: alice.accountId, action: 'view', result: 'denied', reason: 'step_up_required', version: null });
  });

  it('틀린 비밀번호는 401 이고 창이 열리지 않는다 — 감사 기록에 비밀번호는 없다', async () => {
    const res = await stepUp(alice.token, 'wrong-password-xyz');
    expect(res.statusCode).toBe(401);
    expect((await reveal(alice.token, textId)).statusCode).toBe(403);
    const audit = await pool.query(`select detail::text from audit_log where action = 'step_up.failed' and actor_id = $1`, [alice.accountId]);
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(audit.rows.map((r) => r.detail).join()).not.toContain('wrong-password-xyz');
  });

  it('다시 확인한 세션은 값을 받는다 — no-store, access log 에 사람·action·client·ip, 감사엔 값 없음', async () => {
    const up = await stepUp(alice.token);
    expect(up.statusCode).toBe(200);
    // 처음 풀면 15분 — 화면은 이 값으로만 「HH:MM까지」를 그린다.
    const firstUntil = Date.parse(up.json().steppedUpUntil);
    expect(firstUntil - Date.now()).toBeGreaterThan(STEP_UP_IDLE_MS - 10_000);
    expect(firstUntil - Date.now()).toBeLessThanOrEqual(STEP_UP_IDLE_MS);

    const res = await reveal(alice.token, textId, { action: 'view', client: 'Harkroom 0.4.15\n macOS 26' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ name: 'api-key', kind: 'text', version: 1, value: TEXT_VALUE });
    expect(Date.parse(res.json().steppedUpUntil)).toBeGreaterThanOrEqual(firstUntil);

    const copy = await reveal(alice.token, textId, { action: 'copy' });
    expect(copy.json().value).toBe(TEXT_VALUE);

    const rows = (await accessRows(textId)).filter((r) => r.result === 'granted');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorAccountId: alice.accountId, action: 'view', version: 1, agentId: null });
    // 제어문자는 기록 전에 지운다 — 감사 화면에 줄바꿈이 끼어들지 못한다.
    expect(rows[0].client).toBe('Harkroom 0.4.15  macOS 26');
    expect(rows[0].ip).toBeTruthy();
    expect(rows[1]).toMatchObject({ action: 'copy', client: null });

    const audit = await pool.query(`select detail from audit_log where action = 'secret.revealed' and target = $1`, [textId]);
    expect(audit.rows.map((r) => r.detail.action)).toEqual(['view', 'copy']);
    expect(JSON.stringify(audit.rows)).not.toContain(TEXT_VALUE);
  });

  it('소유자 화면의 access 목록에 사람 줄이 실린다', async () => {
    const res = await app.inject({ method: 'GET', url: `/secrets/${textId}/access`, headers: auth(alice.token) });
    const human = (res.json().access as { actorAccountId: string | null; action: string | null }[])
      .filter((r) => r.actorAccountId === alice.accountId);
    expect(human.map((r) => r.action)).toContain('copy');
  });

  it('file 종류는 base64 로 준다', async () => {
    const res = await reveal(alice.token, fileId, { action: 'download' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'file', filename: 'key.pem' });
    expect(Buffer.from(res.json().valueBase64 as string, 'base64').equals(fileBytes)).toBe(true);
    expect(res.json().value).toBeUndefined();
  });

  it('창은 세션마다 따로다 — 같은 사람의 다른 세션은 열리지 않는다', async () => {
    const other = await login('alice');
    expect((await reveal(other, textId)).statusCode).toBe(403);
  });

  it('창이 지나면 다시 막힌다', async () => {
    const t = await login('alice');
    expect((await stepUp(t)).statusCode).toBe(200);
    await pool.query(`update session set stepped_up_until = now() - interval '1 second' where stepped_up_until is not null and account_id = $1`, [alice.accountId]);
    expect((await reveal(t, textId)).json().error.code).toBe('step_up_required');
    expect((await stepUp(alice.token)).statusCode).toBe(200);
  });

  it('볼 때마다 15분 밀리고, 처음 푼 때부터 1시간을 넘지 못한다 — 응답의 시각이 DB 와 같다', async () => {
    const until = async () => (await pool.query(
      `select stepped_up_until as u from session where token_hash = $1`, [hashToken(alice.token)])).rows[0].u as Date;
    // 열린 지 10분, 1분 남은 창 → 보면 지금부터 15분.
    await pool.query(
      `update session set stepped_up_at = now() - interval '10 minutes', stepped_up_until = now() + interval '1 minute'
        where account_id = $1 and stepped_up_until is not null`, [alice.accountId]);
    let res = await reveal(alice.token, textId);
    expect(res.statusCode).toBe(200);
    let left = Date.parse(res.json().steppedUpUntil) - Date.now();
    expect(left).toBeGreaterThan(STEP_UP_IDLE_MS - 10_000);
    expect((await until()).getTime()).toBe(Date.parse(res.json().steppedUpUntil));
    // 열린 지 55분 → 15분이 아니라 처음 푼 때 + 1시간(= 5분 뒤)에서 멈춘다.
    await pool.query(
      `update session set stepped_up_at = now() - interval '55 minutes' where account_id = $1 and stepped_up_until is not null`,
      [alice.accountId]);
    res = await reveal(alice.token, textId);
    expect(res.statusCode).toBe(200);
    left = Date.parse(res.json().steppedUpUntil) - Date.now();
    expect(left).toBeLessThanOrEqual(STEP_UP_MAX_MS - 55 * 60_000);
    expect(left).toBeGreaterThan(STEP_UP_MAX_MS - 55 * 60_000 - 10_000);
  });

  it('잠그기(DELETE /auth/step-up)는 바로 막고 멱등이다 — 실제로 닫았을 때만 감사 한 줄', async () => {
    const t = await login('alice');
    expect((await stepUp(t)).statusCode).toBe(200);
    const lock = () => app.inject({ method: 'DELETE', url: '/auth/step-up', headers: auth(t) });
    const before = (await pool.query(`select count(*)::int as n from audit_log where action = 'step_up.ended'`)).rows[0].n as number;
    expect((await lock()).statusCode).toBe(204);
    expect((await reveal(t, textId)).json().error.code).toBe('step_up_required');
    expect((await lock()).statusCode).toBe(204);
    const after = (await pool.query(`select count(*)::int as n from audit_log where action = 'step_up.ended'`)).rows[0].n as number;
    expect(after - before).toBe(1);
    // 다른 세션(alice.token)의 창은 그대로다.
    expect((await reveal(alice.token, fileId, { action: 'download' })).statusCode).toBe(200);
  });

  it('남의 비밀은 다시 확인해도 404 — admin 도 마찬가지(운영자 경로 없음)', async () => {
    expect((await stepUp(bob.token)).statusCode).toBe(200);
    expect((await reveal(bob.token, textId)).statusCode).toBe(404);
    expect((await stepUp(admin.token)).statusCode).toBe(200);
    const res = await reveal(admin.token, textId);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(TEXT_VALUE);
  });

  it('에이전트(PAT·오퍼레이터 경유)는 다시 확인도 보기도 못 한다', async () => {
    const { accountId: agentId, pat } = await createAgent(app, admin.token, 'worker');
    await pool.query(`update agent_config set owner_account_id = $1 where account_id = $2`, [alice.accountId, agentId]);
    expect((await stepUp(pat)).statusCode).toBe(403);
    expect((await reveal(pat, textId)).statusCode).toBe(403);
    const op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`,
      [agentId, op.operatorId, admin.accountId]);
    const h = { ...auth(op.token), 'x-harkroom-agent': agentId };
    expect((await app.inject({ method: 'POST', url: '/auth/step-up', headers: h, payload: { password: 'pw123456' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/secrets/${textId}/reveal`, headers: h, payload: { action: 'view' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/auth/step-up', headers: auth(pat) })).statusCode).toBe(403);
  });

  it('action 이 틀리면 400, 보관소가 꺼져 있으면 409', async () => {
    expect((await reveal(alice.token, textId, { action: 'print' })).statusCode).toBe(400);
    expect((await reveal(alice.token, textId, { action: 'view' }, off)).statusCode).toBe(409);
  });

  it('계정당 속도 제한 — 넘치면 429 이고 denied 로 남는다', async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await reveal(alice.token, textId)).statusCode;
    expect(last).toBe(429);
    const limited = await reveal(alice.token, textId);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await accessRows(textId)).at(-1)).toMatchObject({ result: 'denied', reason: 'rate_limited' });
  });

  it('다시 확인 시도는 계정마다 센다 — 막힌 동안엔 맞는 비밀번호도 429', async () => {
    const carol = await createMember(app, admin.token, 'carol');
    for (let i = 0; i < STEP_UP_RULE.max; i++) expect((await stepUp(carol.token, 'nope-nope')).statusCode).toBe(401);
    const limited = await stepUp(carol.token);
    expect(limited.statusCode).toBe(429);
    // 화면이 「{n}분 뒤에 다시」를 그릴 근거.
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
