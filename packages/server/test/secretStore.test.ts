import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { createSecretKeyring, loadSecretKeyring, parseKey } from '../src/services/secretKeyring.js';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const keyA = randomBytes(32);
const keyB = randomBytes(32);

describe('v2 봉투 (085, 보안 검토 M3·M4)', () => {
  const aad = { secretId: randomUUID(), version: 1, kind: 'text' as const };

  it('봉인한 것이 같은 AAD 로 풀린다', () => {
    const ring = createSecretKeyring(new Map([['k1', keyA]]), 'k1');
    const sealed = ring.seal(Buffer.from('hunter2-value'), aad);
    expect(sealed.startsWith('v2.k1.')).toBe(true);
    expect(sealed).not.toContain('hunter2');
    expect(ring.open(sealed, aad)?.toString()).toBe('hunter2-value');
  });

  it('다른 행·판·종류로 옮겨 붙이면 풀리지 않는다', () => {
    const ring = createSecretKeyring(new Map([['k1', keyA]]), 'k1');
    const sealed = ring.seal(Buffer.from('v'), aad);
    expect(ring.open(sealed, { ...aad, secretId: randomUUID() })).toBeNull();
    expect(ring.open(sealed, { ...aad, version: 2 })).toBeNull();
    expect(ring.open(sealed, { ...aad, kind: 'file' })).toBeNull();
  });

  it('kid 를 바꿔 끼워도 풀리지 않고, 옛 kid 는 회전 뒤에도 풀린다', () => {
    const old = createSecretKeyring(new Map([['k1', keyA]]), 'k1');
    const sealed = old.seal(Buffer.from('v'), aad);
    const rotated = createSecretKeyring(new Map([['k1', keyA], ['k2', keyB]]), 'k2');
    expect(rotated.open(sealed, aad)?.toString()).toBe('v');
    expect(rotated.seal(Buffer.from('v'), aad).startsWith('v2.k2.')).toBe(true);
    expect(rotated.open(sealed.replace('v2.k1.', 'v2.k2.'), aad)).toBeNull();
  });

  it('키는 정확히 32바이트만 받는다 — 사람이 고른 문자열은 거절', () => {
    expect(parseKey(keyA.toString('base64'))).toEqual(keyA);
    expect(parseKey(`${keyA.toString('hex')}\n`)).toEqual(keyA);
    expect(parseKey('correct horse battery staple')).toBeNull();
    expect(parseKey(randomBytes(16).toString('base64'))).toBeNull();
  });

  it('디렉터리에서 읽는다 — 점 파일은 건너뛰고, 둘 이상이면 활성 kid 가 있어야 한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-keys-'));
    writeFileSync(join(dir, 'k1'), keyA.toString('base64'));
    writeFileSync(join(dir, '..data'), 'not a key');
    expect(loadSecretKeyring(dir, undefined)?.activeKid).toBe('k1');
    writeFileSync(join(dir, 'k2'), keyB.toString('hex'));
    expect(() => loadSecretKeyring(dir, undefined)).toThrow(/HARKROOM_SECRET_KEY_ID/);
    expect(loadSecretKeyring(dir, 'k2')?.activeKid).toBe('k2');
    writeFileSync(join(dir, 'bad'), 'short');
    expect(() => loadSecretKeyring(dir, 'k2')).toThrow(/32바이트/);
    expect(loadSecretKeyring(undefined, undefined)).toBeNull();
  });
});

describe('비밀 보관소 REST (085)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let off: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string;
  let opToken: string;
  let operatorId: string;
  let channelId: string;
  const ring = createSecretKeyring(new Map([['k1', keyA]]), 'k1');

  beforeAll(async () => {
    db = await startTestDb();
    pool = db.pool;
    app = await buildServer({ pool, secretKeyring: ring });
    off = await buildServer({ pool, secretKeyring: null });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    agentId = (await createAgent(app, admin.token, 'worker')).accountId;
    const op = await registerOperator(app, admin.token, 'mac');
    opToken = op.token;
    operatorId = op.operatorId;
    // 배정 라우트는 살아 있는 오퍼레이터의 능력 신고를 요구한다 — 여기서 재는 것은 배정이 아니라 부여다.
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`,
      [agentId, operatorId, admin.accountId]);
    channelId = (await app.inject({
      method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'secret-test' },
    })).json().id as string;
  });
  afterAll(async () => { await app.close(); await off.close(); await db.stop(); });

  const create = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/secrets', headers: auth(token), payload });

  it('만들면 메타만 돌려준다 — 값도 암호문도 응답에 없다', async () => {
    const res = await create(alice.token, { name: 'gh-token', kind: 'text', value: 'ghp_value_should_never_echo', description: 'GitHub' });
    expect(res.statusCode).toBe(201);
    const body = res.body;
    expect(body).not.toContain('ghp_value_should_never_echo');
    expect(body).not.toContain('v2.');
    expect(res.json().secret).toMatchObject({ name: 'gh-token', kind: 'text', version: 1, sizeBytes: 27, grantCount: 0 });

    const row = await pool.query(`select sealed from secret_version v join secret s on s.id = v.secret_id where s.name = 'gh-token'`);
    expect(row.rows[0].sealed).not.toContain('ghp_value');
    // 감사에도 값은 없다.
    const audit = await pool.query(`select detail::text from audit_log where action = 'secret.created'`);
    expect(audit.rows[0].detail).not.toContain('ghp_value');
  });

  it('같은 이름은 409, 설명에 값을 적으면 400, 이름 형식이 틀리면 400', async () => {
    expect((await create(bob.token, { name: 'gh-token', kind: 'text', value: 'x' })).statusCode).toBe(409);
    const desc = await create(alice.token, { name: 'd', kind: 'text', value: 'x', description: 'token is ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(desc.statusCode).toBe(400);
    expect(desc.json().error.code).toBe('secret_in_description');
    expect(desc.body).not.toContain('ghp_abcdef');
    expect((await create(alice.token, { name: '../etc', kind: 'text', value: 'x' })).statusCode).toBe(400);
  });

  it('파일은 base64·파일 이름이 필요하고 64KB 를 넘으면 거절', async () => {
    const ok = await create(alice.token, { name: 'kubeconfig', kind: 'file', filename: 'config', valueBase64: Buffer.from([0, 1, 2, 255]).toString('base64') });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().secret.sizeBytes).toBe(4);
    expect((await create(alice.token, { name: 'nofn', kind: 'file', valueBase64: 'AA==' })).statusCode).toBe(400);
    expect((await create(alice.token, { name: 'badfn', kind: 'file', filename: '..', valueBase64: 'AA==' })).statusCode).toBe(400);
    const big = await create(alice.token, { name: 'big', kind: 'file', filename: 'b', valueBase64: randomBytes(64 * 1024 + 1).toString('base64') });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.code).toBe('bad_value');
  });

  it('키가 없으면 만들기는 409, 목록은 enabled:false', async () => {
    const res = await off.inject({ method: 'POST', url: '/secrets', headers: auth(alice.token), payload: { name: 'z', kind: 'text', value: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('secret_store_disabled');
    expect((await off.inject({ method: 'GET', url: '/secrets', headers: auth(alice.token) })).json().enabled).toBe(false);
  });

  it('남의 비밀은 목록에도 없고 id 로도 404 — admin 은 메타를 본다', async () => {
    const mine = (await app.inject({ method: 'GET', url: '/secrets', headers: auth(bob.token) })).json();
    expect(mine.secrets).toEqual([]);
    const id = (await pool.query(`select id from secret where name = 'gh-token'`)).rows[0].id as string;
    expect((await app.inject({ method: 'GET', url: `/secrets/${id}`, headers: auth(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/secrets/${id}`, headers: auth(admin.token) })).statusCode).toBe(200);
  });

  it('에이전트(오퍼레이터 경유)는 어느 표면도 못 쓴다', async () => {
    const h = { ...auth(opToken), 'x-harkroom-agent': agentId };
    expect((await app.inject({ method: 'GET', url: '/secrets', headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/secrets', headers: h, payload: { name: 'a', kind: 'text', value: 'x' } })).statusCode).toBe(403);
  });

  it('부여는 소유자만 — admin 은 못 주고, 회수는 할 수 있다', async () => {
    const id = (await pool.query(`select id from secret where name = 'gh-token'`)).rows[0].id as string;
    const byAdmin = await app.inject({ method: 'PUT', url: `/secrets/${id}/grants`, headers: auth(admin.token), payload: { agentId } });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json().error.code).toBe('owner_only');
    const byBob = await app.inject({ method: 'PUT', url: `/secrets/${id}/grants`, headers: auth(bob.token), payload: { agentId } });
    expect(byBob.statusCode).toBe(404);

    const given = await app.inject({ method: 'PUT', url: `/secrets/${id}/grants`, headers: auth(alice.token), payload: { agentId, channelId } });
    expect(given.statusCode).toBe(200);
    // 기본은 지금 배정된 오퍼레이터에 묶인다(M1).
    expect(given.json().operatorId).toBe(operatorId);
    const any = await app.inject({ method: 'PUT', url: `/secrets/${id}/grants`, headers: auth(alice.token), payload: { agentId, operator: 'any' } });
    expect(any.json().operatorId).toBeNull();

    const list = (await app.inject({ method: 'GET', url: `/secrets/${id}/grants`, headers: auth(alice.token) })).json().grants;
    expect(list).toHaveLength(2);
    // 같은 (에이전트, 채널) 에 다시 주면 갱신이고 정지가 풀린다.
    await pool.query(`update secret_grant set suspended_at = now(), suspend_reason = 'assignment' where secret_id = $1`, [id]);
    await app.inject({ method: 'PUT', url: `/secrets/${id}/grants`, headers: auth(alice.token), payload: { agentId, channelId } });
    const after = await pool.query(`select count(*)::int as n, count(suspended_at)::int as s from secret_grant where secret_id = $1`, [id]);
    expect(after.rows[0]).toEqual({ n: 2, s: 1 });

    const revoke = await app.inject({ method: 'DELETE', url: `/secrets/${id}/grants/${list[0].id}`, headers: auth(admin.token) });
    expect(revoke.statusCode).toBe(204);
  });

  it('배정 없는 에이전트에 current 로 주면 409', async () => {
    const lone = (await createAgent(app, admin.token, 'lonely')).accountId;
    const id = (await pool.query(`select id from secret where name = 'gh-token'`)).rows[0].id as string;
    const res = await app.inject({ method: 'PUT', url: `/secrets/${id}/grants`, headers: auth(alice.token), payload: { agentId: lone } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_assigned');
  });

  it('값을 바꾸면 새 판이 생기고 옛 판의 암호문은 지워진다', async () => {
    const id = (await pool.query(`select id from secret where name = 'gh-token'`)).rows[0].id as string;
    const res = await app.inject({ method: 'PUT', url: `/secrets/${id}/value`, headers: auth(alice.token), payload: { value: 'new-value-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret.version).toBe(2);
    const rows = (await pool.query(`select version, sealed is null as gone from secret_version where secret_id = $1 order by version`, [id])).rows;
    expect(rows).toEqual([{ version: 1, gone: true }, { version: 2, gone: false }]);
    const sealed = (await pool.query(`select sealed from secret_version where secret_id = $1 and version = 2`, [id])).rows[0].sealed as string;
    expect(ring.open(sealed, { secretId: id, version: 2, kind: 'text' })?.toString()).toBe('new-value-123');
    // admin 은 값을 바꾸지 못한다(소유자의 것).
    expect((await app.inject({ method: 'PUT', url: `/secrets/${id}/value`, headers: auth(admin.token), payload: { value: 'x' } })).statusCode).toBe(404);
  });

  it('지우면 판·부여가 사라지고 감사 기록은 남는다', async () => {
    const id = (await pool.query(`select id from secret where name = 'gh-token'`)).rows[0].id as string;
    await pool.query(
      `insert into secret_access_log (secret_id, secret_name, version, agent_id, result) values ($1, 'gh-token', 2, $2, 'granted')`,
      [id, agentId]);
    const access = await app.inject({ method: 'GET', url: `/secrets/${id}/access`, headers: auth(alice.token) });
    expect(access.json().access).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/secrets/${id}`, headers: auth(admin.token) })).statusCode).toBe(204);
    expect((await pool.query(`select 1 from secret_version where secret_id = $1`, [id])).rowCount).toBe(0);
    expect((await pool.query(`select 1 from secret_grant where secret_id = $1`, [id])).rowCount).toBe(0);
    expect((await pool.query(`select 1 from secret_access_log where secret_id = $1`, [id])).rowCount).toBe(1);
  });
});
