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
let userToken: string;
let userId: string;
let agent1Id: string;
let agent2Id: string;
let disabledAgentId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: auth(adminToken),
  });
  const user = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'user', displayName: 'User', password: 'pw123456', inviteToken: inv.json().token as string },
  });
  const userLogin = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle: 'user', password: 'pw123456' },
  });
  userToken = userLogin.json().token as string;
  userId = user.json().id as string;

  const agent1 = await createAgent(app, adminToken, 'agent1');
  agent1Id = agent1.accountId;

  const agent2 = await createAgent(app, adminToken, 'agent2');
  agent2Id = agent2.accountId;

  const disabledAgent = await createAgent(app, adminToken, 'disabledagent');
  disabledAgentId = disabledAgent.accountId;
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${disabledAgentId}`, headers: auth(adminToken),
    payload: { disabled: true },
  });
});

afterAll(async () => { await app.close(); await stop(); });

describe('#172 에이전트 팀', () => {
  describe('팀 생성·이름 변경·삭제', () => {
    it('1. admin 이 팀을 생성할 수 있다', async () => {
      const res = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'myteam' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'myteam' });
    });

    it('2. 팀 이름이 계정 handle 과 같으면 400 name_taken', async () => {
      const res = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'agent1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'name_taken' } });
    });

    it('3. admin 이 팀 이름을 변경할 수 있다', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'oldname' },
      });
      const teamId = create.json().id as string;

      const res = await app.inject({
        method: 'PATCH', url: `/teams/${teamId}`, headers: auth(adminToken),
        payload: { name: 'newname' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'newname' });
    });

    it('4. admin 이 팀을 삭제할 수 있다', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'deleteme' },
      });
      const teamId = create.json().id as string;

      const res = await app.inject({
        method: 'DELETE', url: `/teams/${teamId}`, headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(204);
    });

    it('5. 누구든 팀 목록을 조회할 수 있다', async () => {
      await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'listtest' },
      });

      const res = await app.inject({ method: 'GET', url: '/teams', headers: auth(userToken) });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().teams)).toBe(true);
    });
  });

  describe('인가', () => {
    it('6. 비admin 은 팀을 만들 수 없다 (403)', async () => {
      const res = await app.inject({
        method: 'POST', url: '/teams', headers: auth(userToken),
        payload: { name: 'userexplicit' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('7. 비admin 은 팀 이름을 변경할 수 없다 (403)', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'adminonly' },
      });
      const teamId = create.json().id as string;

      const res = await app.inject({
        method: 'PATCH', url: `/teams/${teamId}`, headers: auth(userToken),
        payload: { name: 'hacked' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('8. 비admin 은 팀을 삭제할 수 없다 (403)', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'admindel' },
      });
      const teamId = create.json().id as string;

      const res = await app.inject({
        method: 'DELETE', url: `/teams/${teamId}`, headers: auth(userToken),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('팀원 관리', () => {
    it('9. 에이전트가 아닌 계정을 팀에 넣으면 400 not_an_agent', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'mixedteam' },
      });
      const teamId = create.json().id as string;

      const res = await app.inject({
        method: 'PUT', url: `/teams/${teamId}/members/${userId}`, headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'not_an_agent' } });
    });

    it('10. 에이전트를 팀에 추가할 수 있다', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'agentteam' },
      });
      const teamId = create.json().id as string;

      const res = await app.inject({
        method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(200);
      const members = (res.json() as { members: { accountId: string }[] }).members;
      expect(members).toHaveLength(1);
      expect(members[0]!.accountId).toBe(agent1Id);
    });

    it('11. 팀에서 에이전트를 뺄 수 있다', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'removeteam' },
      });
      const teamId = create.json().id as string;

      await app.inject({
        method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
      });

      const res = await app.inject({
        method: 'DELETE', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(200);
      const members = (res.json() as { members: { accountId: string }[] }).members;
      expect(members).toHaveLength(0);
    });
  });
});