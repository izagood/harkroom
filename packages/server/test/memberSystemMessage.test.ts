import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { onEvent } from '../src/events.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
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

/** private 채널로 판다 — 멤버십이 실제로 가시성을 가르는 곳이라야 수신자 판정이 시험된다. */
async function createChannel(name: string): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name, visibility: 'private' },
  });
  return created.json().id as string;
}

async function addMember(channelId: string, accountId: string, token = adminToken) {
  return app.inject({
    method: 'POST', url: `/channels/${channelId}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { accountId },
  });
}

async function removeMember(channelId: string, accountId: string, token = adminToken) {
  return app.inject({
    method: 'DELETE', url: `/channels/${channelId}/members/${accountId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 저장된 본문을 그대로 읽는다 — 응답 가공을 거치지 않은 정본이라야 멘션 형태를 볼 수 있다. */
async function systemBodies(channelId: string): Promise<string[]> {
  const res = await pool.query<{ body: string }>(
    `select body from message where channel_id = $1 and kind = 'system' order by seq`,
    [channelId],
  );
  return res.rows.map((r) => r.body);
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: userToken, accountId: userId } = await createUser('testuser'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('멤버 입·퇴장 시스템 메시지 (#322)', () => {
  it('1. 초대되면 그 채널에 시스템 메시지가 남는다', async () => {
    const channelId = await createChannel('member-add-sys-msg');
    expect(await systemBodies(channelId)).toEqual([]);

    expect((await addMember(channelId, userId)).statusCode).toBe(200);

    // 개수까지 못박는다 — "하나 이상 있다"만 보면 같은 사건에 둘이 남아도 초록이다.
    expect(await systemBodies(channelId)).toEqual(['testuser님이 채널에 추가되었습니다.']);
  });

  it('2. 제거되면 시스템 메시지가 남는다 — 나간 것과 내보낸 것의 문구가 다르다', async () => {
    const channelId = await createChannel('member-remove-sys-msg');
    const self = await createUser('leaver');

    // admin 이 내보낸 경우.
    await addMember(channelId, userId);
    expect((await removeMember(channelId, userId)).statusCode).toBe(200);

    // 본인이 나간 경우. 라우트가 `isSelf` 로 두 경우를 실제로 가르므로 문구도 둘이다.
    await addMember(channelId, self.accountId);
    expect((await removeMember(channelId, self.accountId, self.token)).statusCode).toBe(200);

    expect(await systemBodies(channelId)).toEqual([
      'testuser님이 채널에 추가되었습니다.',
      'testuser님이 채널에서 제거되었습니다.',
      'leaver님이 채널에 추가되었습니다.',
      'leaver님이 채널에서 나갔습니다.',
    ]);
  });

  it('3. 시스템 메시지는 멘션 알림을 만들지 않는다 (inbox 에 행이 없다)', async () => {
    const channelId = await createChannel('member-no-mention');
    await addMember(channelId, userId);
    await removeMember(channelId, userId);

    const inbox = await app.inject({
      method: 'GET', url: '/inbox',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const entries = inbox.json().entries as Array<{ reason: string; channelId: string }>;
    // 이 채널에서 온 행만 본다 — 전역으로 세면 다른 테스트가 남긴 것이 섞여 판정이 흐려진다.
    expect(entries.filter((e) => e.channelId === channelId)).toEqual([]);

    // 본문 자체에 멘션 토큰이 없다. `postMessage` 는 `@handle` 을 `<@id>` 로 정규화하므로
    // 저장된 정본에서 두 형태를 모두 본다 — 하나만 보면 정규화된 쪽을 놓친다.
    for (const body of await systemBodies(channelId)) {
      expect(body).not.toMatch(/@/);
      expect(body).not.toMatch(/<@/);
    }
  });

  it('4. 감사 detail 에 본문이 없다', async () => {
    const channelId = await createChannel('member-audit-detail');
    await addMember(channelId, userId);
    await removeMember(channelId, userId);

    const audit = await app.inject({
      method: 'GET', url: '/audit',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const entries = audit.json().entries as Array<{
      action: string; target: string; detail: Record<string, unknown>;
    }>;
    const mine = entries.filter(
      (e) => e.target === channelId
        && (e.action === 'channel.member.added' || e.action === 'channel.member.removed'),
    );
    expect(mine).toHaveLength(2);
    // 본문이 감사 detail 에 복사되면 같은 사실이 두 곳에 살고, 문구를 고칠 때 한쪽만 바뀐다.
    for (const e of mine) expect(e.detail).toEqual({ accountId: userId });
  });

  it('5. 메시지는 커밋 뒤에 생긴다 — 발행 순간에 이미 멤버다', async () => {
    /**
     * `#300` 의 6번 회귀선과 **같은 기법**이다. WS 로 받은 뒤 HTTP 로 조회하면 왕복 사이에
     * 삽입이 끝나 버려, 메시지 생성을 삽입 앞으로 옮겨도 초록으로 남는다(그 파일의 실측).
     * 그래서 발행 순간을 버스에서 잡고, 그 자리에서 멤버십을 질의한다.
     */
    const channelId = await createChannel('member-commit-order');
    const joiner = await createUser('commit-joiner');

    let atEmit: Promise<boolean> | null = null;
    const off = onEvent((e) => {
      if (e.type === 'message.created' && e.message.channelId === channelId && e.message.kind === 'system') {
        atEmit = pool
          .query(`select 1 from channel_member where channel_id = $1 and account_id = $2`,
            [channelId, joiner.accountId])
          .then((r) => (r.rowCount ?? 0) > 0);
      }
    });
    try {
      expect((await addMember(channelId, joiner.accountId)).statusCode).toBe(200);
      expect(atEmit).not.toBeNull();
      expect(await atEmit!).toBe(true);
    } finally {
      off();
    }
  });

  it('5b. 실패한 요청(없는 계정 404)에서는 시스템 메시지가 남지 않는다', async () => {
    const channelId = await createChannel('member-failed-request');
    const missing = '00000000-0000-4000-8000-000000000000';

    expect((await addMember(channelId, missing)).statusCode).toBe(404);
    // 멤버가 아닌 사람을 빼는 요청은 지워진 행이 없다 — 그것도 메시지가 아니다.
    const stranger = await createUser('member-stranger');
    expect((await removeMember(channelId, stranger.accountId)).statusCode).toBe(200);

    expect(await systemBodies(channelId)).toEqual([]);
  });

  it('6. 시스템 메시지가 실시간으로 나간다 — 수신자는 메시지 층(audienceFor)이다', async () => {
    /**
     * 배선 확인. 이벤트를 내지 않으면 메시지는 DB 에만 남고, 채널을 보고 있는 사람에게는
     * 새로고침 전까지 아무 일도 일어나지 않는다.
     *
     * private 채널이라 `audienceFor` 는 멤버만 고른다 — 초대된 본인이 그 안에 있어야 한다.
     * (`channelListAudience` 로 바꾸면 admin 예외 때문에 비멤버 admin 에게 본문이 흘러간다.)
     */
    const channelId = await createChannel('member-msg-audience');
    const joiner = await createUser('audience-joiner');
    // 두 층을 실제로 가르는 것은 **멤버가 아닌 admin** 이다(`#300` 7번 절과 같은 이유).
    // 평범한 비멤버로만 확인하면 두 함수가 같은 답을 내므로 층을 바꿔도 초록으로 남는다.
    const outsider = await createUser('audience-outsider');
    await pool.query(`update account set is_admin = true where id = $1`, [outsider.accountId]);

    const seen: Array<{ body: string; audience: 'all' | string[] }> = [];
    const off = onEvent((e) => {
      if (e.type === 'message.created' && e.message.channelId === channelId) {
        seen.push({ body: e.message.body, audience: e.audience });
      }
    });
    try {
      expect((await addMember(channelId, joiner.accountId)).statusCode).toBe(200);
    } finally {
      off();
    }

    expect(seen).toHaveLength(1);
    const only = seen[0]!;
    expect(only.body).toBe('audience-joiner님이 채널에 추가되었습니다.');
    expect(Array.isArray(only.audience)).toBe(true);
    expect(only.audience).toContain(joiner.accountId);
    expect(only.audience).not.toContain(outsider.accountId);
  });
});
