// 사람이 자기 계정을 지운다(DELETE /accounts/me). 비밀번호를 다시 받고, 같은 트랜잭션에서
// 세션·PAT·오퍼레이터·푸시 기기를 폐기하고, 알아볼 값(이름·아바타 파일·로그인 id·비밀번호)을 지운다.
// 소유한 에이전트가 있거나 마지막 관리자면 거절한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { hashToken } from '../src/auth/tokens.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let storageRoot: string;
let adminToken: string; let adminId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const del = (token: string, password: unknown) =>
  app.inject({ method: 'DELETE', url: '/accounts/me', headers: auth(token), payload: { password } as object });
const login = (loginId: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { loginId, password: 'pw123456' } });
const me = (token: string) => app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool;
  storageRoot = await mkdtemp(join(tmpdir(), 'harkroom-acctdel-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: 4096 } });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); await rm(storageRoot, { recursive: true, force: true }); });

describe('DELETE /accounts/me', () => {
  it('비밀번호가 틀리면 401 이고 아무것도 바뀌지 않는다', async () => {
    const m = await createMember(app, adminToken, 'delwrong');
    expect((await del(m.token, 'nope-nope')).statusCode).toBe(401);
    expect((await me(m.token)).statusCode).toBe(200);
    expect((await login('delwrong')).statusCode).toBe(200);
  });

  it('지우면 세션·PAT·오퍼레이터·푸시 기기가 폐기되고 다시 로그인할 수 없다', async () => {
    const m = await createMember(app, adminToken, 'delme');
    const second = (await login('delme')).json().token as string;
    await registerOperator(app, m.token, 'my-mac');
    await pool.query(
      `insert into push_device (account_id, session_token_hash, platform, apns_env, token, prefs)
       values ($1, $2, 'ios', 'production', $3, '{}')`, [m.accountId, hashToken(second), 'a'.repeat(64)]);

    expect((await del(m.token, 'pw123456')).statusCode).toBe(204);

    expect((await me(m.token)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(401);
    expect((await login('delme')).statusCode).toBe(401);
    const left = await pool.query(
      `select (select count(*)::int from session where account_id = $1) as sessions,
              (select count(*)::int from push_device where account_id = $1) as devices,
              (select count(*)::int from pat where account_id = $1 and revoked_at is null) as pats,
              (select count(*)::int from operator where owner_account_id = $1 and revoked_at is null) as operators`,
      [m.accountId]);
    expect(left.rows[0]).toEqual({ sessions: 0, devices: 0, pats: 0, operators: 0 });
  });

  it('알아볼 값을 지운다 — handle 은 deleted-<id8>, 이름·로그인 id·비밀번호, 아바타 파일까지', async () => {
    const m = await createMember(app, adminToken, 'delanon');
    const key = 'avatar-delanon';
    await writeFile(join(storageRoot, key), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const att = await pool.query(
      `insert into attachment (uploader_id, filename, content_type, size_bytes, storage_key)
       values ($1, 'me.png', 'image/png', 4, $2) returning id`, [m.accountId, key]);
    await pool.query(`update account set avatar_attachment_id = $2 where id = $1`, [m.accountId, att.rows[0].id]);

    expect((await del(m.token, 'pw123456')).statusCode).toBe(204);

    const row = (await pool.query(
      `select handle, display_name, login_id, password_hash, avatar_attachment_id, deleted_at, disabled_at
         from account where id = $1`, [m.accountId])).rows[0];
    expect(row.handle).toBe(`deleted-${m.accountId.replace(/-/g, '').slice(0, 8)}`);
    expect(row.display_name).not.toBe('delanon');
    expect(row.login_id).not.toBe('delanon');
    expect(row.password_hash).toBeNull();
    expect(row.avatar_attachment_id).toBeNull();
    expect(row.deleted_at).not.toBeNull();
    expect(row.disabled_at).not.toBeNull();
    await expect(access(join(storageRoot, key))).rejects.toThrow();
    // 옛 handle 은 풀려서 다른 사람이 쓸 수 있다.
    await createMember(app, adminToken, 'delanon');
    expect((await login('delanon')).statusCode).toBe(200);
  });

  it('지운 사람의 지난 글은 남는다', async () => {
    const m = await createMember(app, adminToken, 'delposts');
    const chan = (await app.inject({
      method: 'POST', url: '/dms', headers: auth(m.token), payload: { accountIds: [adminId] },
    })).json().id as string;
    const posted = await app.inject({
      method: 'POST', url: `/channels/${chan}/messages`, headers: auth(m.token), payload: { body: '남는 글' },
    });
    expect(posted.statusCode).toBe(201);
    expect((await del(m.token, 'pw123456')).statusCode).toBe(204);
    const msg = await pool.query(`select body from message where id = $1`, [posted.json().id]);
    expect(msg.rows[0].body).toBe('남는 글');
  });

  it('소유한 에이전트가 있으면 409 owns_agents 와 그 목록을 돌려주고 지우지 않는다', async () => {
    const m = await createMember(app, adminToken, 'delowner');
    const a = await createAgent(app, adminToken, 'delownedbot');
    const owned = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${a.accountId}`, headers: auth(adminToken),
      payload: { ownerAccountId: m.accountId },
    });
    expect(owned.statusCode).toBe(200);
    const res = await del(m.token, 'pw123456');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('owns_agents');
    expect(res.json().error.agents).toEqual([{ id: a.accountId, handle: 'delownedbot' }]);
    expect((await me(m.token)).statusCode).toBe(200);
  });

  it('마지막 관리자는 409 last_admin 이다; 관리자가 하나 더 있으면 지워진다', async () => {
    const res = await del(adminToken, 'pw123456');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('last_admin');

    const m = await createMember(app, adminToken, 'deladmin2');
    await pool.query(`update account set role = 'admin', is_admin = true where id = $1`, [m.accountId]);
    expect((await del(m.token, 'pw123456')).statusCode).toBe(204);
    // 그가 지워졌으니 처음 관리자는 다시 마지막이다.
    expect((await del(adminToken, 'pw123456')).statusCode).toBe(409);
  });

  it('에이전트(PAT)는 이 길로 자기를 지울 수 없다', async () => {
    const a = await createAgent(app, adminToken, 'delbot');
    expect((await del(a.pat, 'x')).statusCode).toBe(403);
  });

  it('비밀번호 시도는 계정마다 상한이 있다', async () => {
    const m = await createMember(app, adminToken, 'delrate');
    let last = 0;
    for (let i = 0; i < 12; i += 1) last = (await del(m.token, `wrong-${i}`)).statusCode;
    expect(last).toBe(429);
  });
});
