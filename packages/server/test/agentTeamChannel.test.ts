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

  // admin 이 아닌 평범한 계정. 게이트가 `requireAdmin` 이 아니라 멤버십이라는 것을
  // 보이려면 admin 이 아닌 멤버가 필요하다.
  const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
  const user = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'chuser', loginId: 'chuser', displayName: 'Ch User', password: 'pw123456', inviteToken: inv.json().token as string },
  });
  userId = user.json().id as string;
  const userLogin = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'chuser', password: 'pw123456' },
  });
  userToken = userLogin.json().token as string;

  const agent1 = await createAgent(app, adminToken, 't1agent1');
  agent1Id = agent1.accountId;

  const agent2 = await createAgent(app, adminToken, 't1agent2');
  agent2Id = agent2.accountId;

  const disabledAgent = await createAgent(app, adminToken, 't1disabled');
  disabledAgentId = disabledAgent.accountId;
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${disabledAgentId}`, headers: auth(adminToken),
    payload: { disabled: true },
  });
});

afterAll(async () => { await app.close(); await stop(); });

describe('#172 팀을 채널에 추가', () => {
  it('12. private 채널에 팀 추가 → 팀원 전원이 멤버, alreadyMember 도 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam1' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });
    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent2Id}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch1', visibility: 'private' },
    });
    const channelId = channel.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken),
      payload: { accountId: agent1Id },
    });

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { added: string[]; skipped: string[]; alreadyMember: string[] };
    expect(body.added).toContain('t1agent2');
    expect(body.alreadyMember).toContain('t1agent1');

    // **응답이 아니라 멤버십을 본다.** 응답의 `added` 는 라우트가 손으로 채우는 배열이라,
    // 삽입이 아예 없어도 그대로 채워진다 — 초판 테스트는 여기까지만 봤고 그래서
    // `addChannelMember` 를 지워도 초록이었다. 실제 멤버 목록으로 단언한다.
    const members = await app.inject({
      method: 'GET', url: `/channels/${channelId}/members`, headers: auth(adminToken),
    });
    const handles = (members.json() as { members: { handle: string }[] }).members.map((m) => m.handle);
    expect(handles).toContain('t1agent1');
    expect(handles).toContain('t1agent2');
  });

  it('13. 비활성 팀원은 건너뛰고 skipped 에 handle 이 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam2' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${disabledAgentId}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch2', visibility: 'private' },
    });
    const channelId = channel.json().id as string;

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { added: string[]; skipped: string[]; alreadyMember: string[] };
    expect(body.skipped).toContain('t1disabled');
    expect(body.added).toHaveLength(0);

    // 걸러졌다는 것은 **멤버가 되지 않았다**는 뜻이다 — 응답만 보면 걸러진 척하면서
    // 넣어 버린 구현도 통과한다.
    const members = await app.inject({
      method: 'GET', url: `/channels/${channelId}/members`, headers: auth(adminToken),
    });
    const handles = (members.json() as { members: { handle: string }[] }).members.map((m) => m.handle);
    expect(handles).not.toContain('t1disabled');

    // 그리고 **팀 구성은 그대로다.** 걸러진다고 팀에서 지우면, 다시 켰을 때 운영자가
    // 다시 넣어야 한다 — 팀은 의도 기록이라는 결정이 무너진다.
    const team2 = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken) });
    const teamMembers = (team2.json() as { members: { handle: string; disabled: boolean }[] }).members;
    expect(teamMembers.map((m) => m.handle)).toContain('t1disabled');
    expect(teamMembers.find((m) => m.handle === 't1disabled')!.disabled).toBe(true);
  });

  it('14. public 채널에 팀 추가는 400 channel_is_public', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam3' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch3', visibility: 'public' },
    });
    const channelId = channel.json().id as string;

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'channel_is_public' } });

    // 400 이 문구만이면 안 된다 — 거절하면서 멤버는 넣어 두는 구현도 있을 수 있다.
    const members = await app.inject({
      method: 'GET', url: `/channels/${channelId}/members`, headers: auth(adminToken),
    });
    expect((members.json() as { members: unknown[] }).members).toHaveLength(0);
  });

  /**
   * 게이트. **`requireAdmin` 이 아니라 `#156` 의 `assertChannelVisible` 이다.**
   * 초판은 admin 이면 통과시켰고, 그러면 "admin 도 자기가 없는 private 채널에는 못
   * 부른다"는 `#156` 의 결정이 팀이라는 우회로로 무너진다 — 팀 하나로 남의 private
   * 채널에 에이전트를 밀어 넣을 수 있게 된다.
   */
  it('18. 그 private 채널의 멤버가 아니면 admin 이어도 403 이다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam4' },
    });
    const teamId = team.json().id as string;
    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });

    // admin 이 만든 뒤 **자기가 나간** private 채널. 이제 admin 은 그 채널의 멤버가
    // 아니고, `#156` 의 규칙대로 남을 부를 수 없어야 한다.
    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch4', visibility: 'private' },
    });
    const channelId = channel.json().id as string;
    // 다른 사람을 먼저 넣어 둔다 — 나간 뒤에도 채널 자체는 살아 있어야 확인이 뜻을 갖는다.
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken),
      payload: { accountId: userId },
    });
    const left = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/members/${adminId}`, headers: auth(adminToken),
    });
    expect(left.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(403);

    // 거절이 실제 거절이어야 한다 — 남아 있는 멤버 눈으로 봐도 팀원이 들어오지 않았다.
    const members = await app.inject({
      method: 'GET', url: `/channels/${channelId}/members`, headers: auth(userToken),
    });
    const handles = (members.json() as { members: { handle: string }[] }).members.map((m) => m.handle);
    expect(handles).not.toContain('t1agent1');
  });

  it('19. 멤버라면 admin 이 아니어도 팀을 넣을 수 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam5' },
    });
    const teamId = team.json().id as string;
    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch5', visibility: 'private' },
    });
    const channelId = channel.json().id as string;
    // 사람을 멤버로 넣는다 — 그 뒤로 이 사람은 팀도 넣을 수 있다.
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken),
      payload: { accountId: userId },
    });

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(userToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { added: string[] }).added).toContain('t1agent1');
  });

  /**
   * 트랜잭션. 팀 구성의 뜻은 "이 다섯을 **함께** 넣는다"다 — 중간에 실패해 절반만
   * 멤버가 되면, 응답은 그 절반을 말할 방법이 없고 운영자는 무엇이 빠졌는지 모른 채
   * 다시 눌러야 한다. 그래서 넣기는 함께 되거나 함께 안 돼야 한다.
   *
   * 실패를 실제로 만든다: 두 번째 팀원을 넣는 순간 채널 행이 사라져 FK 가 깨지도록,
   * `channel_member` 삽입에 걸리는 트리거를 이 테스트 안에서만 걸어 던지게 한다.
   */
  it('21. 도중에 실패하면 아무도 멤버가 되지 않는다 (트랜잭션 하나다)', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'txteam' },
    });
    const teamId = team.json().id as string;
    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });
    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent2Id}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch7', visibility: 'private' },
    });
    const channelId = channel.json().id as string;

    // **두 번째** 팀원의 삽입에서만 던진다. 팀원은 handle 순으로 돌므로(`t1agent1`,
    // `t1agent2`) 첫 삽입은 성공한 뒤 두 번째가 깨진다 — 트랜잭션이 없으면 첫 삽입이
    // 이미 커밋되어 `t1agent1` 하나만 멤버로 남는다. 개수로 세지 않는 이유: 채널을
    // 만든 사람이 이미 멤버라(#156) 개수 조건은 첫 삽입부터 걸려 아무것도 안 들어가고,
    // 그러면 롤백이 없어도 테스트가 초록이 된다.
    await pool.query(`
      create or replace function murmur_test_fail_second() returns trigger as $$
      begin
        if new.account_id = '${agent2Id}'::uuid then
          raise exception 'murmur test: second insert fails';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger murmur_test_fail_second_trg before insert on channel_member
        for each row execute function murmur_test_fail_second();
    `);
    try {
      const res = await app.inject({
        method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await pool.query(`drop trigger murmur_test_fail_second_trg on channel_member`);
      await pool.query(`drop function murmur_test_fail_second()`);
    }

    // 절반도 남지 않았다.
    const members = await app.inject({
      method: 'GET', url: `/channels/${channelId}/members`, headers: auth(adminToken),
    });
    const handles = (members.json() as { members: { handle: string }[] }).members.map((m) => m.handle);
    expect(handles).not.toContain('t1agent1');
    expect(handles).not.toContain('t1agent2');
  });

  it('20. 없는 팀을 넣으려 하면 404 다', async () => {
    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch6', visibility: 'private' },
    });
    const channelId = channel.json().id as string;
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/00000000-0000-0000-0000-000000000000/add`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(404);
  });
});