import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * 사람 집합을 한 handle 로 부르기(#230).
 *
 * 테스트할 시나리오:
 * 1. 집합을 멘션하면 구성원 전원에게 inbox 항목이 생긴다.
 * 2. 부른 사람 자신에게는 생기지 않는다.
 * 3. private 채널에서 그 채널을 볼 수 없는 구성원에게는 생기지 않는다.
 * 4. 에이전트를 집합에 넣으려 하면 400 이고 들어가지 않는다.
 * 5. 계정과 같은 이름의 집합을 만들 수 없다.
 * 6. 집합과 같은 이름의 계정을 만들 수 없다(양방향).
 * 7. admin 이 아니면 집합을 만들 수 없다.
 * 8. 본문이 치환되지 않는다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let memberPat: string;
let memberId: string;
let outsiderPat: string;
let humanMemberToken: string;
let humanMemberId: string;
let privateId: string;
let groupId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createChannel(name: string, visibility: 'public' | 'private'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name, visibility },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function post(token: string, channelId: string, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function inboxFor(pat: string, messageId: string): Promise<Array<{ reason: string }>> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(pat) });
  expect(res.statusCode).toBe(200);
  return (res.json().entries as Array<{ reason: string; messageId: string }>)
    .filter((e) => e.messageId === messageId);
}

async function createHandleGroup(handle: string, displayName: string, memberIds: string[]): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/handle-groups',
    headers: auth(adminToken), payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;

  if (memberIds.length > 0) {
    const memRes = await app.inject({
      method: 'POST', url: `/handle-groups/${id}/members`,
      headers: auth(adminToken), payload: { accountIds: memberIds },
    });
    expect(memRes.statusCode).toBe(200);
  }

  return id;
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: memberPat, accountId: memberId } = await createAgent(app, adminToken, 'member'));
  ({ pat: outsiderPat } = await createAgent(app, adminToken, 'outsider'));

  const inviteRes = await app.inject({
    method: 'POST', url: '/invites', headers: auth(adminToken), payload: {},
  });
  const inviteToken = inviteRes.json().token as string;
  const humanRes = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'humanmember', displayName: 'Human Member', password: 'pw123456', inviteToken },
  });
  humanMemberId = humanRes.json().id as string;
  const humanLogin = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { handle: 'humanmember', password: 'pw123456' },
  });
  humanMemberToken = humanLogin.json().token as string;

  privateId = await createChannel('secretchan', 'private');
  await app.inject({
    method: 'POST', url: `/channels/${privateId}/members`,
    headers: auth(adminToken), payload: { accountId: memberId },
  });
  await app.inject({
    method: 'POST', url: `/channels/${privateId}/members`,
    headers: auth(adminToken), payload: { accountId: humanMemberId },
  });
});
afterAll(async () => { await app.close(); await stop(); });

describe('집합 CRUD (admin만 가능)', () => {
  it('admin 만 집합을 만들 수 있다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/handle-groups',
      headers: auth(memberPat), payload: { handle: 'testgroup', displayName: 'Test Group' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin 은 집합을 만들 수 있다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/handle-groups',
      headers: auth(adminToken), payload: { handle: 'myteam', displayName: 'My Team' },
    });
    expect(res.statusCode).toBe(201);
    groupId = res.json().id as string;
  });

  it('같은 이름의 계정이 있으면 집합을 만들 수 없다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/handle-groups',
      headers: auth(adminToken), payload: { handle: 'outsider', displayName: 'Conflict' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('handle_taken');
  });

  it('집합 목록을 가져올 수 있다', async () => {
    const res = await app.inject({
      method: 'GET', url: '/handle-groups',
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const groups = res.json().groups as Array<{ handle: string }>;
    expect(groups.some((g) => g.handle === 'myteam')).toBe(true);
  });

  it('집합에 구성원을 추가한다', async () => {
    const res = await app.inject({
      method: 'POST', url: `/handle-groups/${groupId}/members`,
      headers: auth(adminToken), payload: { accountIds: [humanMemberId] },
    });
    expect(res.statusCode).toBe(200);
    const members = res.json().members as string[];
    expect(members).toContain(humanMemberId);
  });

  it('에이전트를 집합에 넣으려 하면 400', async () => {
    const { accountId: agentId } = await createAgent(app, adminToken, 'agent2');
    const res = await app.inject({
      method: 'POST', url: `/handle-groups/${groupId}/members`,
      headers: auth(adminToken), payload: { accountIds: [agentId] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('agent_not_allowed');
  });
});

describe('집합 멘션이 부르는 사람', () => {
  it('집합을 멘션하면 구성원 전원에게 inbox 항목을 만든다', async () => {
    const id = await post(adminToken, privateId, '@myteam 배포한다');

    expect(await inboxFor(humanMemberToken, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
  });

  it('부른 사람 자신에게는 만들지 않는다', async () => {
    const id = await post(humanMemberToken, privateId, '@myteam 내가 부른다');

    expect(await inboxFor(humanMemberToken, id)).toEqual([]);
  });

  it('private 채널에서 그 채널을 볼 수 없는 구성원에게는 만들지 않는다', async () => {
    const id = await post(adminToken, privateId, '@myteam 비밀이다');

    expect(await inboxFor(outsiderPat, id)).toEqual([]);
  });

  it('본문의 @그룹을 그대로 남긴다', async () => {
    const id = await post(adminToken, privateId, '@myteam 원문 그대로');

    const list = await app.inject({
      method: 'GET', url: `/channels/${privateId}/messages`, headers: auth(adminToken),
    });
    const found = (list.json().messages as Array<{ id: string; body: string }>)
      .find((m) => m.id === id);
    expect(found?.body).toBe('@myteam 원문 그대로');
  });
});

describe('계정 생성 시 집합 이름 충돌 검사', () => {
  it('집합과 같은 이름의 계정을 만들 수 없다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'invitechan' },
    });
    expect(res.statusCode).toBe(201);
    const chanId = res.json().id as string;

    const inviteRes = await app.inject({
      method: 'POST', url: '/invites', headers: auth(adminToken), payload: {},
    });
    const token = inviteRes.json().token as string;

    const accRes = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { handle: 'myteam', displayName: 'Conflict', password: 'password123', inviteToken: token },
    });
    expect(accRes.statusCode).toBe(400);
    expect(accRes.json().error.code).toBe('handle_taken');
  });
});

describe('에이전트 생성 시 집합 이름 충돌 검사', () => {
  it('집합과 같은 이름의 에이전트를 만들 수 없다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/accounts/agents',
      headers: auth(adminToken), payload: { handle: 'myteam', displayName: 'Conflict Agent' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('already exists');
  });
});