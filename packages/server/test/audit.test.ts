import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;

const PASSWORD = 'pw123456';

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const entries = async (action?: string): Promise<{
  action: string; actorId: string | null; actorHandle: string | null; target: string | null;
  ip: string | null; detail: Record<string, unknown>;
}[]> => (await pool.query(
  `select action, actor_id as "actorId", actor_handle as "actorHandle", target, ip, detail
   from audit_log ${action ? 'where action = $1' : ''} order by id`,
  action ? [action] : [],
)).rows;

const dumpAll = async (): Promise<string> =>
  JSON.stringify((await pool.query('select * from audit_log')).rows);

describe('감사 추적 — 기록', () => {
  it('records a successful login with the actor and the address', async () => {
    // bootstrapAdmin 픽스처가 이미 로그인을 한 번 한다 — 그것도 정당한 감사 대상이므로
    // 절대 개수가 아니라 델타로 단언한다.
    const before = (await entries('login.succeeded')).length;

    await app.inject({
      method: 'POST', url: '/auth/login', payload: { handle: 'admin', password: PASSWORD },
      remoteAddress: '10.1.0.1',
    });

    const rows = await entries('login.succeeded');
    expect(rows).toHaveLength(before + 1);
    const latest = rows[rows.length - 1]!;
    expect(latest.actorId).toBe(adminId);
    expect(latest.actorHandle).toBe('admin');
    expect(latest.ip).toBe('10.1.0.1');
  });

  // 실패한 로그인이 안 남으면 브루트포스 흔적을 사후에 볼 수 없다. 레이트 리밋은 막기만 하고
  // 기록하지 않는다.
  it('records a failed login with the attempted handle and no actor', async () => {
    await app.inject({
      method: 'POST', url: '/auth/login', payload: { handle: 'admin', password: 'wrong' },
      remoteAddress: '10.1.0.2',
    });
    await app.inject({
      method: 'POST', url: '/auth/login', payload: { handle: 'ghost', password: 'wrong' },
      remoteAddress: '10.1.0.2',
    });

    const rows = await entries('login.failed');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.actorHandle).toBe('admin');
    expect(rows[1]!.actorHandle).toBe('ghost');
    expect(rows[1]!.actorId).toBeNull(); // 존재하지 않는 계정
  });

  // PAT 행은 토큰을 받은 에이전트만 가리킨다 — 누가 그 권한을 줬는지는 어디에도 없었다.
  it('records who issued and who revoked an agent PAT', async () => {
    const bot = await createAgent(app, adminToken, 'auditbot');

    await app.inject({
      method: 'DELETE', url: `/accounts/${bot.accountId}/pats/test`, headers: auth(adminToken),
    });

    const issued = await entries('pat.issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.actorId).toBe(adminId);      // 발급한 admin
    expect(issued[0]!.target).toBe(bot.accountId); // 권한을 받은 에이전트
    const revoked = await entries('pat.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.actorId).toBe(adminId);
    expect(revoked[0]!.detail.revoked).toBe(1);
  });

  it('records account creation and logout', async () => {
    const token = (await app.inject({
      method: 'POST', url: '/auth/login', payload: { handle: 'admin', password: PASSWORD },
    })).json().token as string;
    await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(token) });

    expect(await entries('account.created')).toHaveLength(1); // bootstrap
    expect((await entries('agent.created'))[0]!.actorId).toBe(adminId);
    expect(await entries('logout')).toHaveLength(1);
  });

  it('records an admin channel change and a message deletion', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'audited' },
    });
    const channelId = ch.json().id as string;
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: auth(adminToken),
      payload: { topic: 'changed by admin' },
    });
    const msg = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
      payload: { body: 'to be removed' },
    });
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${msg.json().id}`, headers: auth(adminToken),
    });

    expect((await entries('channel.updated'))[0]!.target).toBe(channelId);
    const deleted = await entries('message.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.target).toBe(msg.json().id);
    expect(deleted[0]!.detail.channelId).toBe(channelId);
    // 본문은 남기지 않는다 — 감사에 복사하면 삭제가 삭제가 아니다.
    expect(JSON.stringify(deleted[0]!.detail)).not.toContain('to be removed');
  });

  // 감사 로그는 널리 읽히도록 만드는 것이 목적이다. 거기 비밀이 있으면 열람 권한이 곧 계정 권한이 된다.
  it('never stores a password or a token anywhere in the table', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { handle: 'admin', password: PASSWORD },
    });
    const token = login.json().token as string;
    const bot = await createAgent(app, adminToken, 'secretbot');

    const dump = await dumpAll();

    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(bot.pat);
    expect(dump).not.toContain('Bearer');
  });

  // PATCH /accounts/agents/:id 에 감사 기록이 누락된 것이 이슈 #85 다.
  // mentionPermission 변경은 에이전트의 파일 쓰기·명령 실행 권한을 바꾸는 중요한 작업이다.
  it('records a mentionPermission change on agent', async () => {
    const bot = await createAgent(app, adminToken, 'permbot');

    const before = (await entries('agent.updated')).length;

    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${bot.accountId}`,
      headers: auth(adminToken),
      payload: { mentionPermission: 'readonly' },
    });

    const rows = await entries('agent.updated');
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]!.actorId).toBe(adminId);
    expect(rows[rows.length - 1]!.target).toBe(bot.accountId);
  });

  // ownerAccountId 변경은 에이전트의 터미널 attach 권한을 바꾼다.
  it('records an ownerAccountId change on agent', async () => {
    const bot = await createAgent(app, adminToken, 'ownerbot');
    const other = await createAgent(app, adminToken, 'otherbot');

    const before = (await entries('agent.updated')).length;

    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${bot.accountId}`,
      headers: auth(adminToken),
      payload: { ownerAccountId: other.accountId },
    });

    const rows = await entries('agent.updated');
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]!.actorId).toBe(adminId);
    expect(rows[rows.length - 1]!.target).toBe(bot.accountId);
    expect(rows[rows.length - 1]!.detail).toHaveProperty('ownerAccountId');
  });

  // workingDir 은 mentionPermission 과 짝이다 — 'auto'(bypassPermissions)인 에이전트의
  // workingDir 을 바꾸면 같은 권한이 다른 코드베이스에 적용된다. 값 자체는 비밀이 아니다.
  it('records a workingDir change with before/after', async () => {
    const bot = await createAgent(app, adminToken, 'dirbot');
    const before = (await entries('agent.updated')).length;

    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${bot.accountId}`,
      headers: auth(adminToken),
      payload: { workingDir: '/srv/other-repo' },
    });

    const rows = await entries('agent.updated');
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]!.detail).toMatchObject({ workingDir: { after: '/srv/other-repo' } });
  });

  // instructions 는 자유 텍스트라 원문을 감사 로그에 남기지 않는다 — 바뀌었다는 사실만 남긴다.
  it('records that instructions changed without storing the text', async () => {
    const bot = await createAgent(app, adminToken, 'instrbot');
    const secret = 'sk-절대-감사로그에-남으면-안-되는-문장';
    const before = (await entries('agent.updated')).length;

    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${bot.accountId}`,
      headers: auth(adminToken),
      payload: { instructions: secret },
    });

    const rows = await entries('agent.updated');
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]!.detail).toMatchObject({ instructions: { changed: true } });
    expect(JSON.stringify(rows[rows.length - 1]!.detail)).not.toContain(secret);
  });

  // 같은 값으로 다시 저장한 PATCH 는 기록하지 않는다 — 그러면 감사 로그가 "무엇이 바뀌었나"를
  // 답하지 못하는 잡음이 된다.
  it('does not record a PATCH that changes nothing', async () => {
    const bot = await createAgent(app, adminToken, 'noopbot');
    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${bot.accountId}`,
      headers: auth(adminToken), payload: { mentionPermission: 'readonly' },
    });
    const before = (await entries('agent.updated')).length;

    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${bot.accountId}`,
      headers: auth(adminToken), payload: { mentionPermission: 'readonly' },
    });

    expect(await entries('agent.updated')).toHaveLength(before);
  });

  // 존재하지 않는 에이전트에 대한 PATCH는 404를 반환하고 감사 기록은 남지 않는다.
  it('does not record a 404 response', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const before = (await entries('agent.updated')).length;

    const res = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${fakeId}`,
      headers: auth(adminToken),
      payload: { mentionPermission: 'readonly' },
    });
    expect(res.statusCode).toBe(404);

    expect(await entries('agent.updated')).toHaveLength(before);
  });
});

describe('감사 추적 — append-only', () => {
  // 지울 수 있는 기록은 증거가 못 된다. 관례가 아니라 DB 가 강제해야 한다.
  it('refuses updates and deletes at the database level', async () => {
    await expect(pool.query(`update audit_log set action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
  });
});

describe('감사 추적 — 조회', () => {
  it('serves the newest entries to an admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit?limit=5', headers: auth(adminToken) });

    expect(res.statusCode).toBe(200);
    const rows = res.json().entries as { action: string; at: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
    // 최신순
    const times = rows.map((r) => new Date(r.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('refuses a non-admin', async () => {
    const bot = await createAgent(app, adminToken, 'nosybot');
    const res = await app.inject({ method: 'GET', url: '/audit', headers: auth(bot.pat) });

    expect(res.statusCode).toBe(403);
  });
});
