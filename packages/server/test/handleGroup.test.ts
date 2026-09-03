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
 * 9. 데스크탑에서 집합 멘션이 사람 멘션과 구분돼 보인다
 *    → `packages/desktop/test/handleGroupMention.test.tsx`.
 */
let app: FastifyInstance;
let pool: import('pg').Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let memberPat: string;
let memberId: string;
let outsiderPat: string;
let humanMemberToken: string;
let humanMemberId: string;
/** 두 번째 사람 구성원. "구성원 **전원**" 이 뜻을 갖게 하려면 하나로는 안 된다. */
let secondMemberToken: string;
let secondMemberId: string;
/**
 * 집합에는 들어 있지만 private 채널은 **볼 수 없는** 사람. 가시성 필터의 회귀선이
 * 이 계정 없이는 아무것도 지키지 않는다(초판이 그랬다 — 아래 그 자리의 주석을 보라).
 */
let blindMemberToken: string;
let blindMemberId: string;
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

/** 초대 → 등록 → 로그인. 사람 계정만 집합에 들어갈 수 있어서(#230 결정 1) 사람을 만든다. */
async function registerHuman(handle: string): Promise<{ id: string; token: string }> {
  const inviteRes = await app.inject({
    method: 'POST', url: '/invites', headers: auth(adminToken), payload: {},
  });
  const inviteToken = inviteRes.json().token as string;
  const created = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle, displayName: handle, password: 'pw123456', inviteToken },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle, password: 'pw123456' },
  });
  expect(login.statusCode).toBe(200);
  return { id: created.json().id as string, token: login.json().token as string };
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
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: memberPat, accountId: memberId } = await createAgent(app, adminToken, 'member'));
  ({ pat: outsiderPat } = await createAgent(app, adminToken, 'outsider'));

  ({ id: humanMemberId, token: humanMemberToken } = await registerHuman('humanmember'));
  ({ id: secondMemberId, token: secondMemberToken } = await registerHuman('secondmember'));
  ({ id: blindMemberId, token: blindMemberToken } = await registerHuman('blindmember'));

  privateId = await createChannel('secretchan', 'private');
  // `blindmember` 는 **일부러 넣지 않는다** — 집합에는 있고 채널은 못 보는 사람이다.
  for (const accountId of [memberId, humanMemberId, secondMemberId]) {
    const res = await app.inject({
      method: 'POST', url: `/channels/${privateId}/members`,
      headers: auth(adminToken), payload: { accountId },
    });
    expect(res.statusCode).toBe(200);
  }
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
      // 셋을 넣는다: 채널을 볼 수 있는 둘과 볼 수 없는 하나(blindmember).
      headers: auth(adminToken), payload: { accountIds: [humanMemberId, secondMemberId, blindMemberId] },
    });
    expect(res.statusCode).toBe(200);
    const members = res.json().members as string[];
    expect(members).toContain(humanMemberId);
    expect(members).toContain(secondMemberId);
    expect(members).toContain(blindMemberId);
  });

  it('에이전트를 집합에 넣으려 하면 400 이고 들어가지 않는다', async () => {
    const { accountId: agentId } = await createAgent(app, adminToken, 'agent2');
    const res = await app.inject({
      method: 'POST', url: `/handle-groups/${groupId}/members`,
      headers: auth(adminToken), payload: { accountIds: [agentId] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('agent_not_allowed');

    // 400 만 확인하면 "거절했다"는 것만 안다 — 정말 안 들어갔는지는 명단을 봐야 한다.
    const after = await app.inject({
      method: 'GET', url: `/handle-groups/${groupId}`, headers: auth(adminToken),
    });
    expect(after.json().members as string[]).not.toContain(agentId);
  });

  /**
   * 사람과 에이전트를 **섞어** 보내면 요청 전체가 거절된다. 사람만 골라 넣고 200 을 주면
   * 운영자는 전부 들어갔다고 믿는다.
   */
  it('사람과 에이전트를 섞어 보내면 사람도 들어가지 않는다', async () => {
    const { accountId: agentId } = await createAgent(app, adminToken, 'agent3');
    const { id: freshId } = await registerHuman('freshhuman');
    const res = await app.inject({
      method: 'POST', url: `/handle-groups/${groupId}/members`,
      headers: auth(adminToken), payload: { accountIds: [freshId, agentId] },
    });
    expect(res.statusCode).toBe(400);

    const after = await app.inject({
      method: 'GET', url: `/handle-groups/${groupId}`, headers: auth(adminToken),
    });
    const members = after.json().members as string[];
    expect(members).not.toContain(agentId);
    expect(members).not.toContain(freshId);
  });

  // 아무것도 하지 않는 요청이 200 으로 돌아오면 부른 쪽은 넣혔다고 믿는다.
  it('빈 목록으로 구성원을 추가하려 하면 400', async () => {
    const res = await app.inject({
      method: 'POST', url: `/handle-groups/${groupId}/members`,
      headers: auth(adminToken), payload: { accountIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('구성원 변경이 감사에 남는다 — handle 과 개수만, 계정 id 는 없다', async () => {
    const audit = await app.inject({
      method: 'GET', url: '/audit?action=handle_group.members.added&limit=20',
      headers: auth(adminToken),
    });
    expect(audit.statusCode).toBe(200);
    const entries = audit.json().entries as Array<{ detail: Record<string, unknown> }>;
    const entry = entries.find((e) => e.detail.handle === 'myteam');
    expect(entry).toBeTruthy();
    expect(entry!.detail.inserted).toBe(3);
    // 집합에서 빼는 이유가 사람 사정일 수 있다 — 감사가 명단을 영구히 붙잡지 않는다.
    expect(entry!.detail.accountIds).toBeUndefined();
  });
});

describe('집합 멘션이 부르는 사람', () => {
  it('집합을 멘션하면 구성원 전원에게 inbox 항목을 만든다', async () => {
    const id = await post(adminToken, privateId, '@myteam 배포한다');

    // **전원**이 뜻을 가지려면 둘 이상이어야 한다 — 하나만 확인하면 "첫 구성원에게만
    // 넣는" 구현도 초록으로 통과한다.
    expect(await inboxFor(humanMemberToken, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
    expect(await inboxFor(secondMemberToken, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
  });

  /**
   * `reason` 은 기존 `'mention'` 을 쓴다(#230 결정 4). 새 값을 더하면 그것을 읽는 모든
   * 곳이 알아야 한다 — 모르는 곳은 그 항목을 조용히 빠뜨린다.
   */
  it('집합 멘션의 reason 은 새 값이 아니라 mention 이다', async () => {
    const id = await post(adminToken, privateId, '@myteam reason 확인');

    const entries = await inboxFor(secondMemberToken, id);
    expect(entries.map((e) => e.reason)).toEqual(['mention']);
  });

  /**
   * 평범한 멘션으로 이미 불린 사람이 집합에도 들어 있으면 inbox 항목이 **둘** 생기면 안
   * 된다. 확장 지점이 둘이던 초판은 각자 `notified` 를 보게 되어 있었지만, 그 규칙이
   * 한쪽에만 있으면 조용히 중복된다 — 그래서 `fanOutMention` 한 자리로 모았다.
   */
  it('개별 멘션과 집합 멘션이 겹쳐도 inbox 항목은 하나다', async () => {
    const id = await post(adminToken, privateId, '@secondmember @myteam 둘 다 부른다');

    expect(await inboxFor(secondMemberToken, id)).toHaveLength(1);
  });

  it('부른 사람 자신에게는 만들지 않는다', async () => {
    const id = await post(humanMemberToken, privateId, '@myteam 내가 부른다');

    expect(await inboxFor(humanMemberToken, id)).toEqual([]);
  });

  /**
   * 가시성 필터. **집합에 들어 있으면서 그 채널을 볼 수 없는 사람**으로 확인해야 한다 —
   * 초판은 집합에 들어 있지도 않은 `outsider` 로 확인해서, 필터를 통째로 지워도 초록이었다
   * (회수 중 실제로 지워 보고 확인했다). `blindmember` 는 집합의 구성원이고 이 private
   * 채널의 멤버가 아니다.
   *
   * 새면 무엇을 잃는가: private 채널의 발화가 집합을 통해 비멤버의 inbox 로 간다 —
   * 본문뿐 아니라 **그 채널이 존재한다는 사실 자체**가 샌다.
   */
  it('private 채널에서 그 채널을 볼 수 없는 구성원에게는 만들지 않는다', async () => {
    const id = await post(adminToken, privateId, '@myteam 비밀이다');

    // 같은 발화가 볼 수 있는 구성원에게는 갔다 — 그래야 "아무에게도 안 갔다"와 구분된다.
    expect(await inboxFor(humanMemberToken, id)).toHaveLength(1);
    expect(await inboxFor(blindMemberToken, id)).toEqual([]);
    // 집합에 없는 사람에게도 당연히 가지 않는다.
    expect(await inboxFor(outsiderPat, id)).toEqual([]);
  });

  /**
   * public 채널에서는 같은 사람이 받는다. 위 테스트가 "가시성 때문에 빠졌다"를 말하려면
   * 그 사람이 원래는 받는다는 것이 보여야 한다 — 아니면 명단에서 빠진 것과 구분되지 않는다.
   */
  it('public 채널에서는 그 구성원도 받는다', async () => {
    const openId = await createChannel('openchan', 'public');
    const id = await post(adminToken, openId, '@myteam 공개다');

    expect(await inboxFor(blindMemberToken, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
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

/**
 * 계정과 집합의 handle 충돌은 서버가 양방향으로 막으므로 **정상 경로로는 만들 수 없다.**
 * 그래도 판정 순서는 정해져 있고(계정이 이긴다), 그 코드가 살아 있는지 확인해야 한다 —
 * 026 마이그레이션 이전에 만들어진 행이나 동시 생성 경합으로 겹칠 수 있기 때문이다.
 *
 * 그래서 충돌을 **DB 에 직접 심어** 확인한다. 라우트를 지나가면 400 에 막혀 이 경로에
 * 닿지 못하고, 그러면 그 판정이 사라져도 아무 테스트가 빨개지지 않는다.
 */
describe('계정과 집합이 같은 이름이면 계정이 이긴다', () => {
  it('같은 이름의 계정이 있으면 집합은 펼쳐지지 않는다', async () => {
    // `outsider` 는 계정이다. 같은 이름의 집합을 DB 에 직접 심는다.
    const inserted = await pool.query<{ id: string }>(
      `insert into handle_group (handle, display_name) values ($1, $2) returning id`,
      ['outsider', 'Shadow Group'],
    );
    const shadowId = inserted.rows[0]!.id;
    await pool.query(
      `insert into handle_group_member (group_id, account_id) values ($1, $2)`,
      [shadowId, humanMemberId],
    );

    const id = await post(adminToken, privateId, '@outsider 누구를 부르나');

    // 계정이 이긴다 — 계정 `outsider` 가 받고, 집합의 구성원은 그것 때문에 받지 않는다.
    expect(await inboxFor(outsiderPat, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
    expect(await inboxFor(humanMemberToken, id)).toEqual([]);

    await pool.query(`delete from handle_group where id = $1`, [shadowId]);
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