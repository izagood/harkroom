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

async function createUser(handle: string): Promise<{ token: string; accountId: string }> {
  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const inviteToken = inv.json().token as string;
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { inviteToken, handle, loginId: handle, displayName: handle, password: 'pw123456' },
  });
  const accountId = reg.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { loginId: handle, password: 'pw123456' },
  });
  return { token: login.json().token as string, accountId };
}

async function createChannel(name: string): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name },
  });
  return created.json().id as string;
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ token: userToken, accountId: userId } = await createUser('testuser'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('멤버 입·퇴장 시스템 메시지 (#322)', () => {
  it('1. 초대되면 그 채널에 시스템 메시지가 남는다', async () => {
    const channelId = await createChannel('member-add-sys-msg');
    const before = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const beforeCount = (before.json().messages as Array<{ kind: string }>).filter(
      (m) => m.kind === 'system',
    ).length;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: userId },
    });

    const after = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const messages = after.json().messages as Array<{ kind: string; body: string }>;
    const sysMsg = messages.find((m) => m.kind === 'system');

    expect(sysMsg).toBeDefined();
    expect(sysMsg!.body).toContain('testuser');
    expect(sysMsg!.body).toContain('추가되었습니다');
  });

  it('2. 제거되면 시스템 메시지가 남는다', async () => {
    const channelId = await createChannel('member-remove-sys-msg');
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: userId },
    });

    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/members/${userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const messages = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const msgs = messages.json().messages as Array<{ kind: string; body: string }>;
    const sysMsg = msgs.find((m) => m.kind === 'system' && m.body.includes('제거되었습니다'));

    expect(sysMsg).toBeDefined();
    expect(sysMsg!.body).toContain('testuser');
  });

  it('3. 시스템 메시지는 멘션 알림을 만들지 않는다 (inbox에 행이 없다)', async () => {
    const channelId = await createChannel('member-no-mention');
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: userId },
    });

    const inbox = await app.inject({
      method: 'GET', url: '/inbox',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const entries = inbox.json().entries as Array<{ reason: string }>;
    const mentionEntries = entries.filter((e) => e.reason === 'mention');

    expect(mentionEntries).toHaveLength(0);
  });

  it('4. 감사 detail에 본문이 없다 (메타에 별도 정보 없음)', async () => {
    const channelId = await createChannel('member-audit-detail');
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: userId },
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const entries = audit.json().entries as Array<{ action: string; detail: Record<string, unknown> }>;
    const memberAdded = entries.find((e) => e.action === 'channel.member.added');

    expect(memberAdded).toBeDefined();
    expect(memberAdded!.detail).toEqual({ accountId: userId });
    expect(memberAdded!.detail).not.toHaveProperty('body');
  });

  it('5. 메시지는 커밋 뒤에 생긴다 (트랜잭션 롤백 시 시스템 메시지가 없다)', async () => {
    const channelId = await createChannel('member-commit-order');
    const invalidUserId = '00000000-0000-0000-0000-000000000000';

    const addRes = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: invalidUserId },
    });
    expect(addRes.statusCode).toBe(404);

    const messages = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const msgs = messages.json().messages as Array<{ kind: string; body: string }>;
    const sysMsg = msgs.find((m) => m.kind === 'system' && m.body.includes('추가되었습니다'));

    expect(sysMsg).toBeUndefined();
  });

  it('회귀: 초대 메시지에 @멘션을 넣으면 알림이 간다 (되돌린 것)', async () => {
    const channelId = await createChannel('regression-mention');
    const addRes = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: userId },
    });
    expect(addRes.statusCode).toBe(200);

    const poolQuery = await pool.query(
      `select body from message where channel_id = $1 and kind = 'system' order by created_at desc limit 1`,
      [channelId],
    );
    if (poolQuery.rows[0]) {
      const body = poolQuery.rows[0].body as string;
      expect(body).not.toMatch(/@testuser/);
    }
  });
});