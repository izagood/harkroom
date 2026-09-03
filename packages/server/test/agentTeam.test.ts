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

      // 응답만 보면 저장하지 않는 구현도 통과한다 — 다시 읽어 확인한다.
      const again = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
      expect((again.json() as { team: { name: string } }).team.name).toBe('newname');
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

      // 지운 뒤에는 없어야 한다 — 204 만 돌려주고 남겨 두는 구현도 통과할 수 있다.
      const again = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
      expect(again.statusCode).toBe(404);
    });

    /**
     * 예약은 **멘션 해석과 같은 기준**이어야 한다. `mentionedHandles` 는 소문자로
     * 정규화하므로 `@Agent1` 과 `@agent1` 은 한 대상이다 — 이름 비교를 대소문자 그대로
     * 하면 팀 `Agent1` 이 계정 `agent1` 옆에 살아남고, 멘션을 여는 날 한 이름이 두
     * 대상을 가리킨다.
     */
    it('2b. 대소문자만 다른 계정 handle 도 400 name_taken 이다', async () => {
      const res = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'Agent1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'name_taken' } });
    });

    /**
     * 집합(#230)도 계정과 같은 네임스페이스를 쓴다. spec 은 계정 handle 만 적었지만
     * 그 spec 은 #230 이 머지되기 전에 쓰였다 — 예약의 목적(`@팀` 을 열 여지)이 같으니
     * 막을 대상도 같아야 한다.
     */
    it('2c. 집합 handle 과 겹치면 400 name_taken 이다', async () => {
      const group = await app.inject({
        method: 'POST', url: '/handle-groups', headers: auth(adminToken),
        payload: { handle: 'squad', displayName: 'Squad' },
      });
      expect(group.statusCode).toBe(201);

      const res = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'squad' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'name_taken' } });
    });

    it('2d. 같은 이름의 팀을 두 번 만들면 400 이다 (500 이 아니다)', async () => {
      const first = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'dupteam' },
      });
      expect(first.statusCode).toBe(201);
      const res = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'DupTeam' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'name_taken' } });
    });

    it('2e. 이름 변경도 같은 예약을 지킨다 — 계정 handle 로는 못 바꾼다', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'renamable' },
      });
      const teamId = create.json().id as string;
      const res = await app.inject({
        method: 'PATCH', url: `/teams/${teamId}`, headers: auth(adminToken),
        payload: { name: 'agent1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'name_taken' } });

      // 거절이 실제 거절이어야 한다 — 이름은 그대로다.
      const again = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
      expect((again.json() as { team: { name: string } }).team.name).toBe('renamable');
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

    it('10b. 없는 팀에 에이전트를 넣으면 404 다 (500 이 아니다)', async () => {
      const res = await app.inject({
        method: 'PUT', url: `/teams/00000000-0000-0000-0000-000000000000/members/${agent1Id}`,
        headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it('10c. 비활성 에이전트도 팀에 넣을 수 있다 — 걸러지는 자리는 채널이다', async () => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken),
        payload: { name: 'disabledteam' },
      });
      const teamId = create.json().id as string;
      const res = await app.inject({
        method: 'PUT', url: `/teams/${teamId}/members/${disabledAgentId}`, headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(200);
      const members = (res.json() as { members: { handle: string; disabled: boolean }[] }).members;
      expect(members).toHaveLength(1);
      expect(members[0]!.disabled).toBe(true);
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