// 에이전트별 Claude in Chrome 연동(마이그레이션 126, 스레드 e8c8365d) — 기본 꺼짐·소유자/admin 만·감사·러너 노출.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let bobToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: bobToken } = await createMember(app, adminToken, 'bob'));
});
afterAll(async () => { await app.close(); await stop(); });

const view = async (id: string) => (await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(adminToken) }))
  .json().agents.find((a: { id: string }) => a.id === id);
const patch = (token: string, id: string, chromeEnabled: boolean) =>
  app.inject({ method: 'PATCH', url: `/accounts/agents/${id}`, headers: auth(token), payload: { chromeEnabled } });
const auditDetails = async (id: string) => (await pool.query<{ detail: Record<string, unknown> }>(
  `select detail from audit_log where action = 'agent.updated' and target = $1 order by id`, [id])).rows.map((r) => r.detail);

describe('Chrome 연동(chromeEnabled)', () => {
  it('기본은 꺼짐이고 러너의 /agent/config 에도 false 로 실린다', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'qa-chrome-default');
    expect((await view(accountId)).chromeEnabled).toBe(false);
    const cfg = await app.inject({ method: 'GET', url: '/agent/config', headers: auth(pat) });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json().chromeEnabled).toBe(false);
  });

  it('admin 이 켜고 끄면 값이 바뀌고, 러너가 다음 턴에 읽고, 감사 로그에 before/after 가 남는다', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'qa-chrome-on');
    expect((await patch(adminToken, accountId, true)).statusCode).toBe(200);
    expect((await view(accountId)).chromeEnabled).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/agent/config', headers: auth(pat) })).json().chromeEnabled).toBe(true);
    expect((await patch(adminToken, accountId, false)).statusCode).toBe(200);
    expect((await view(accountId)).chromeEnabled).toBe(false);
    const details = await auditDetails(accountId);
    expect(details.map((d) => d.chromeEnabled)).toEqual([{ before: false, after: true }, { before: true, after: false }]);
  });

  it('같은 값으로 다시 저장하면 감사 기록을 더하지 않는다', async () => {
    const { accountId } = await createAgent(app, adminToken, 'qa-chrome-same');
    await patch(adminToken, accountId, false);
    expect(await auditDetails(accountId)).toEqual([]);
  });

  it('에이전트 PAT 로는 켤 수 없다 — owner 로 지정된 에이전트여도 403, 끄기는 된다(security F2)', async () => {
    const lead = await createAgent(app, adminToken, 'qa-chrome-lead');
    const { accountId } = await createAgent(app, adminToken, 'qa-chrome-led');
    await pool.query(`update agent_config set owner_account_id = $1 where account_id = $2`, [lead.accountId, accountId]);
    const on = await patch(lead.pat, accountId, true);
    expect(on.statusCode).toBe(403);
    expect(on.json().error.code).toBe('human_session_required');
    expect((await view(accountId)).chromeEnabled).toBe(false);
    // 자기 자신도 못 켠다.
    expect((await patch(lead.pat, lead.accountId, true)).statusCode).toBe(403);
    // 끄기는 owner 에이전트도 한다(좁히는 쪽).
    expect((await patch(adminToken, accountId, true)).statusCode).toBe(200);
    expect((await patch(lead.pat, accountId, false)).statusCode).toBe(200);
    expect((await view(accountId)).chromeEnabled).toBe(false);
  });

  it('소유자도 admin 도 아닌 멤버는 켤 수 없다', async () => {
    const { accountId } = await createAgent(app, adminToken, 'qa-chrome-guard');
    expect((await patch(bobToken, accountId, true)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await view(accountId)).chromeEnabled).toBe(false);
  });
});
