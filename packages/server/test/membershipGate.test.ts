import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
// 바꾼 프로덕션 파일을 직접 부른다 — 라우트를 거치지 않고도 게이트의 판정 자체를 볼 수 있어야
// 라우트가 어떤 사유로 거절했는지가 게이트의 뜻과 어긋나는 순간이 드러난다.
import { channelMembershipGate } from '../src/services/channels.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let userId: string;
let otherId: string;
let agentId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createChannel(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name, visibility: 'private' },
  });
  return res.json().id as string;
}

async function setArchived(channelId: string, archived: boolean): Promise<void> {
  const res = await app.inject({
    method: 'PATCH', url: `/channels/${channelId}`, headers: auth(adminToken),
    payload: { archived },
  });
  expect(res.statusCode).toBe(200);
}

const addMember = (channelId: string, accountId: string) => app.inject({
  method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken),
  payload: { accountId },
});

const removeMember = (channelId: string, accountId: string) => app.inject({
  method: 'DELETE', url: `/channels/${channelId}/members/${accountId}`, headers: auth(adminToken),
});

async function memberCount(channelId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `select count(*)::text as n from channel_member where channel_id = $1`, [channelId],
  );
  return Number(res.rows[0]!.n);
}

async function messageCount(channelId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `select count(*)::text as n from message where channel_id = $1`, [channelId],
  );
  return Number(res.rows[0]!.n);
}

/** 이 채널의 메시지로 생긴 `reason='dm'` inbox 행 수. DM 에 사람이 들어갔는지가 여기 남는다. */
async function dmInboxCount(channelId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `select count(*)::text as n from inbox i
       join message m on m.id = i.message_id
      where m.channel_id = $1 and i.reason = 'dm'`,
    [channelId],
  );
  return Number(res.rows[0]!.n);
}

async function createUser(handle: string): Promise<string> {
  const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      inviteToken: inv.json().token as string,
      handle, loginId: handle, displayName: handle, password: 'pw123456',
    },
  });
  return reg.json().id as string;
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  userId = await createUser('gateuser');
  otherId = await createUser('gateother');
  ({ accountId: agentId } = await createAgent(app, adminToken, 'gateagent'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('보관 채널·DM 멤버십 게이트 (#328)', () => {
  it('1. 보관 채널에 멤버 추가는 400 이고 channel_member 에 행이 없다', async () => {
    const channelId = await createChannel('gate-add-archived');
    const before = await memberCount(channelId);
    await setArchived(channelId, true);

    const res = await addMember(channelId, userId);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('channel_archived');
    expect(await memberCount(channelId)).toBe(before);
    const rows = await pool.query(
      `select 1 from channel_member where channel_id = $1 and account_id = $2`, [channelId, userId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('2. 거절된 추가는 시스템 메시지도 남기지 않는다', async () => {
    const channelId = await createChannel('gate-add-nosysmsg');
    await setArchived(channelId, true);
    const before = await messageCount(channelId);

    const res = await addMember(channelId, userId);

    expect(res.statusCode).toBe(400);
    expect(await messageCount(channelId)).toBe(before);
  });

  it('3. 보관 채널에서 멤버 제거도 400 이고 멤버는 그대로다', async () => {
    const channelId = await createChannel('gate-remove-archived');
    expect((await addMember(channelId, userId)).statusCode).toBe(200);
    const before = await memberCount(channelId);
    await setArchived(channelId, true);
    const messagesBefore = await messageCount(channelId);

    const res = await removeMember(channelId, userId);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('channel_archived');
    expect(await memberCount(channelId)).toBe(before);
    // 퇴장 시스템 메시지(#322)도 남지 않는다 — 읽기 전용 채널에 새 메시지가 생기면 안 된다.
    expect(await messageCount(channelId)).toBe(messagesBefore);
  });

  it("4. DM 에 멤버 추가는 400 이고 reason='dm' inbox 행이 생기지 않는다", async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [userId] },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = dm.json().id as string;
    const before = await memberCount(dmId);

    const res = await addMember(dmId, otherId);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('channel_is_dm');
    // inbox 를 **멤버 수보다 먼저** 본다. 뒤에 두면 게이트를 시스템 메시지 뒤로 옮기는
    // 되돌리기에서 멤버 수 단언이 먼저 터져, 정작 이 이슈가 말하는 사실(`reason='dm'` 행이
    // 생긴다)을 이 절이 한 번도 관찰하지 못한다 — 있으나 마나 한 단언이 된다.
    expect(await dmInboxCount(dmId)).toBe(0);
    expect(await memberCount(dmId)).toBe(before);
    // 판정 자체도 DM 이라고 답한다 — 라우트의 사유와 게이트의 뜻이 같은 자리에서 나온다.
    expect(await channelMembershipGate(pool, dmId)).toBe('dm');
  });

  it('5. 보관을 해제하면 추가된다 — 게이트는 상태를 본다', async () => {
    const channelId = await createChannel('gate-unarchive');
    await setArchived(channelId, true);
    expect((await addMember(channelId, userId)).statusCode).toBe(400);

    await setArchived(channelId, false);
    expect(await channelMembershipGate(pool, channelId)).toBe('ok');

    const res = await addMember(channelId, userId);

    expect(res.statusCode).toBe(200);
    const rows = await pool.query(
      `select 1 from channel_member where channel_id = $1 and account_id = $2`, [channelId, userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('6. 팀 추가도 보관 채널에서 400 이다 — 팀이 우회로가 되지 않는다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'gateteam' },
    });
    const teamId = team.json().id as string;
    expect((await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agentId}`, headers: auth(adminToken),
    })).statusCode).toBe(200);

    const channelId = await createChannel('gate-team-archived');
    expect((await addMember(channelId, adminId)).statusCode).toBe(200);
    const before = await memberCount(channelId);
    await setArchived(channelId, true);

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('channel_archived');
    expect(await memberCount(channelId)).toBe(before);
    const rows = await pool.query(
      `select 1 from channel_member where channel_id = $1 and account_id = $2`, [channelId, agentId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("7. 팀을 DM 에 넣으면 사유가 'channel_is_dm' 이다 — 'channel_is_public' 이 아니다", async () => {
    // DM 은 `visibility` 를 지정하지 않고 만들어지므로 기본값 'public' 을 갖는다
    // (`021_channel_visibility.sql`). 그래서 팀 라우트에서 게이트가 public 판정 **뒤**로
    // 밀리면 DM 이 "public 채널에는 멤버십이 없다"로 거절된다 — 400 이라 상태 코드만 보는
    // 단언은 초록이고, 사유만 사실과 어긋난다. 순서를 여기서 못 박는다.
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'gateteamdm' },
    });
    const teamId = team.json().id as string;

    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [otherId] },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = dm.json().id as string;
    const before = await memberCount(dmId);

    const res = await app.inject({
      method: 'POST', url: `/channels/${dmId}/teams/${teamId}/add`, headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('channel_is_dm');
    expect(await memberCount(dmId)).toBe(before);
  });
});
