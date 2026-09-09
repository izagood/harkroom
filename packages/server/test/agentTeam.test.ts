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
    payload: { handle: 'user', loginId: 'user', displayName: 'User', password: 'pw123456', inviteToken: inv.json().token as string },
  });
  const userLogin = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'user', password: 'pw123456' },
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
  /**
   * 팀장 지정(046). 여기서 지키는 것은 **"팀장은 팀원이다"** 하나다 — 그 사실이 깨지면
   * 멘션 라우팅을 켜는 날 팀 멘션이 명단에 없는 에이전트를 깨우고, 부른 사람은 그것을
   * 팀 화면에서 확인할 수 없다.
   *
   * 그래서 4번이 이 묶음의 중심이다: 규칙을 라우트가 아니라 **데이터 층**이 지키는지
   * (`on delete set null (lead_account_id)`) 를 잰다. 라우트 검사만 있으면 팀원 제거라는
   * 다른 문을 통해 그 규칙이 깨진다.
   */
  describe('팀장 지정', () => {
    const makeTeam = async (name: string): Promise<string> => {
      const create = await app.inject({
        method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name },
      });
      return create.json().id as string;
    };
    const addMember = (teamId: string, accountId: string) => app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${accountId}`, headers: auth(adminToken),
    });
    const setLead = (teamId: string, accountId: string | null) => app.inject({
      method: 'PUT', url: `/teams/${teamId}/lead`, headers: auth(adminToken), payload: { accountId },
    });

    it('1. 갓 만든 팀은 팀장이 없다 — 지정은 선택이다', async () => {
      const teamId = await makeTeam('leadfresh');
      const res = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
      expect(res.json().team.leadAccountId).toBeNull();
    });

    it('2. 팀원을 팀장으로 세운다', async () => {
      const teamId = await makeTeam('leadset');
      await addMember(teamId, agent1Id);
      const res = await setLead(teamId, agent1Id);
      expect(res.statusCode).toBe(200);
      expect(res.json().leadAccountId).toBe(agent1Id);
      // 목록에도 실린다 — 카드 격자가 그 값을 그린다.
      const list = await app.inject({ method: 'GET', url: '/teams', headers: auth(adminToken) });
      const row = (list.json().teams as { id: string; leadAccountId: string | null }[])
        .find((r) => r.id === teamId);
      expect(row?.leadAccountId).toBe(agent1Id);
    });

    it('3. 팀원이 아닌 계정은 400 not_a_member', async () => {
      const teamId = await makeTeam('leadstranger');
      await addMember(teamId, agent1Id);
      const res = await setLead(teamId, agent2Id);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('not_a_member');
      // 거절된 요청이 팀장을 건드리지 않았다.
      const after = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
      expect(after.json().team.leadAccountId).toBeNull();
    });

    it('4. 팀장을 팀에서 빼면 팀장 자리가 함께 비워진다', async () => {
      const teamId = await makeTeam('leadremoved');
      await addMember(teamId, agent1Id);
      await setLead(teamId, agent1Id);

      const removed = await app.inject({
        method: 'DELETE', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
      });
      expect(removed.statusCode).toBe(200);

      const after = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
      expect(after.json().team.leadAccountId).toBeNull();
    });

    it('5. null 을 실으면 팀장이 해제된다', async () => {
      const teamId = await makeTeam('leadclear');
      await addMember(teamId, agent1Id);
      await setLead(teamId, agent1Id);
      const res = await setLead(teamId, null);
      expect(res.statusCode).toBe(200);
      expect(res.json().leadAccountId).toBeNull();
    });

    it('6. 비활성 팀원도 팀장이 될 수 있다 — 지정은 운영자의 의도 기록이다', async () => {
      const teamId = await makeTeam('leaddisabled');
      await addMember(teamId, disabledAgentId);
      const res = await setLead(teamId, disabledAgentId);
      expect(res.statusCode).toBe(200);
      expect(res.json().leadAccountId).toBe(disabledAgentId);
    });

    it('7. 없는 팀은 404', async () => {
      const res = await setLead('00000000-0000-0000-0000-000000000000', agent1Id);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('8. admin 이 아니면 403', async () => {
      const teamId = await makeTeam('leadgate');
      await addMember(teamId, agent1Id);
      const res = await app.inject({
        method: 'PUT', url: `/teams/${teamId}/lead`, headers: auth(userToken),
        payload: { accountId: agent1Id },
      });
      expect(res.statusCode).toBe(403);
    });

    it('9. accountId 를 빠뜨린 본문은 거절된다 — 오타가 팀장을 지우지 않는다', async () => {
      const teamId = await makeTeam('leadmissing');
      await addMember(teamId, agent1Id);
      await setLead(teamId, agent1Id);
      const res = await app.inject({
        method: 'PUT', url: `/teams/${teamId}/lead`, headers: auth(adminToken), payload: {},
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const after = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
      expect(after.json().team.leadAccountId).toBe(agent1Id);
    });

    it('10. 팀장이 있는 팀도 지울 수 있다 — cascade 가 새 제약에 걸리지 않는다', async () => {
      const teamId = await makeTeam('leaddelete');
      await addMember(teamId, agent1Id);
      await setLead(teamId, agent1Id);
      const res = await app.inject({
        method: 'DELETE', url: `/teams/${teamId}`, headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(204);
    });
  });
});
