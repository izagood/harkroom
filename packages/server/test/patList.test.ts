import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let pool: Pool;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

const admin = () => ({ authorization: `Bearer ${adminToken}` });

const createAgentOnly = async (handle: string): Promise<string> => {
  const created = await app.inject({
    method: 'POST', url: '/accounts/agents', headers: admin(),
    payload: { handle, displayName: handle },
  });
  return created.json().id as string;
};

describe('PAT management', () => {
  it('GET /accounts/:id/pats returns labels without tokens', async () => {
    const accountId = await createAgentOnly('listpatbot');

    await app.inject({
      method: 'POST', url: `/accounts/${accountId}/pats`, headers: admin(), payload: { label: 'runner' },
    });
    await app.inject({
      method: 'POST', url: `/accounts/${accountId}/pats`, headers: admin(), payload: { label: 'backup' },
    });

    const res = await app.inject({
      method: 'GET', url: `/accounts/${accountId}/pats`, headers: admin(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { pats: { label: string; createdAt: string; revokedAt: string | null }[] };
    const labels = body.pats.map((p) => p.label).sort();
    expect(labels).toContain('runner');
    expect(labels).toContain('backup');
    const runner = body.pats.find((p) => p.label === 'runner');
    expect(runner!.createdAt).toBeDefined();
    expect(runner!.revokedAt).toBeNull();

    const dump = JSON.stringify(body);
    expect(dump).not.toContain('token');
    expect(dump).not.toContain('murp');
    expect(dump).not.toContain('hash');
  });

  it('GET /accounts/:id/pats includes revoked PATs', async () => {
    const accountId = await createAgentOnly('revokedpatbot');

    await app.inject({
      method: 'POST', url: `/accounts/${accountId}/pats`, headers: admin(), payload: { label: 'old' },
    });

    await app.inject({
      method: 'DELETE', url: `/accounts/${accountId}/pats/old`, headers: admin(),
    });

    const res2 = await app.inject({
      method: 'GET', url: `/accounts/${accountId}/pats`, headers: admin(),
    });
    const pats = (res2.json() as { pats: { label: string; revokedAt: string | null }[] }).pats;
    const oldPat = pats.find((p) => p.label === 'old');
    expect(oldPat).toBeDefined();
    expect(oldPat!.revokedAt).not.toBeNull();
  });

  /**
   * 이 테스트는 원래 `POST /accounts/agents` 로 'user' 라는 **에이전트**를 만들고
   * `/auth/login` 에 비밀번호를 보내 토큰을 얻으려 했다. 에이전트 계정에는 비밀번호가
   * 없으므로 로그인은 실패하고 `token` 은 `undefined` 였다 — 즉 `Bearer undefined` 로
   * **인증되지 않은** 요청을 보내고 있었고, `requireAdmin` 이 미인증에도 403 을 주기
   * 때문에 초록이었다. 이름이 말하는 "non-admin 거절"은 한 번도 확인되지 않았다.
   *
   * #253 이 이 라우트를 `requireOwnerOrAdmin` 으로 바꾸면서 미인증이 401 로 갈라져
   * 드러났다. 사람 계정을 초대·등록해 **실제로 non-admin 토큰**으로 확인하고,
   * 미인증 401 도 따로 못박는다.
   */
  it('rejects non-admin GET /accounts/:id/pats', async () => {
    const accountId = await createAgentOnly('nonadminpatbot');

    const invite = await app.inject({ method: 'POST', url: '/invites', headers: admin() });
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        handle: 'patoutsider', loginId: 'patoutsider', displayName: 'Outsider', password: 'pw123456',
        inviteToken: invite.json().token as string,
      },
    });
    const userLogin = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'patoutsider', password: 'pw123456' },
    });
    const token = userLogin.json().token as string;
    expect(token).toBeTruthy();

    const res = await app.inject({
      method: 'GET', url: `/accounts/${accountId}/pats`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);

    const anon = await app.inject({ method: 'GET', url: `/accounts/${accountId}/pats` });
    expect(anon.statusCode).toBe(401);
  });

  // 라벨은 살아 있는 토큰 안에서 유일하다(마이그레이션 010). 이 제약이 없으면 같은 라벨이
  // 둘 생기고, `DELETE .../pats/:label` 이 라벨로 폐기하므로 "이 하나만" 이 **둘 다** 를
  // 지운다 — UI 가 약속하는 것과 달라진다.
  it('같은 라벨로 두 번 발급하면 409 로 거절한다', async () => {
    const bot = await createAgent(app, adminToken, 'dupbot');
    const first = await app.inject({
      method: 'POST', url: `/accounts/${bot.accountId}/pats`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { label: 'runner' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST', url: `/accounts/${bot.accountId}/pats`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { label: 'runner' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('label_in_use');
  });

  // 폐기한 라벨은 다시 쓸 수 있어야 한다 — 토큰을 잃어 폐기하고 같은 이름으로 재발급하는
  // 것이 이 기능의 주 사용 흐름이다(#93 이 그 사고에서 나왔다).
  it('폐기한 뒤에는 같은 라벨을 다시 쓸 수 있다', async () => {
    const bot = await createAgent(app, adminToken, 'reusebot');
    const auth = { authorization: `Bearer ${adminToken}` };
    await app.inject({ method: 'POST', url: `/accounts/${bot.accountId}/pats`, headers: auth, payload: { label: 'runner' } });
    await app.inject({ method: 'DELETE', url: `/accounts/${bot.accountId}/pats/runner`, headers: auth });

    const again = await app.inject({
      method: 'POST', url: `/accounts/${bot.accountId}/pats`, headers: auth, payload: { label: 'runner' },
    });
    expect(again.statusCode).toBe(201);

    // 목록에는 폐기된 것과 살아 있는 것이 함께 보인다 — 운영자가 재발급을 판단할 근거다.
    const list = await app.inject({ method: 'GET', url: `/accounts/${bot.accountId}/pats`, headers: auth });
    const runners = list.json().pats.filter((p: { label: string }) => p.label === 'runner');
    expect(runners).toHaveLength(2);
    expect(runners.filter((p: { revokedAt: string | null }) => p.revokedAt === null)).toHaveLength(1);
  });
});