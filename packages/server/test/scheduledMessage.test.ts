import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { createScheduledMessageSweeper } from '../src/services/scheduledMessages.js';

async function createUser(app: FastifyInstance, adminToken: string, handle: string): Promise<{ token: string; accountId: string }> {
  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const inviteToken = inv.json().token as string;
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { inviteToken, handle, displayName: handle, password: 'pw123456' },
  });
  const accountId = reg.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { handle, password: 'pw123456' },
  });
  return { token: login.json().token as string, accountId };
}

/**
 * 라우트를 거치지 않고 예약 행을 심는다. **발송 시각을 과거로** 두려면 이 길뿐이다 —
 * 라우트는 과거를 400 으로 막으므로(그것 자체가 테스트다) sweep 을 시험하려면
 * 저장소에 직접 넣어야 한다.
 */
async function insertScheduled(
  pool: Pool, channelId: string, authorId: string, body: string, sendAt: string,
): Promise<string> {
  const res = await pool.query(
    `insert into scheduled_message (channel_id, author_id, body, send_at)
     values ($1, $2, $3, $4) returning id`,
    [channelId, authorId, body, sendAt],
  );
  return res.rows[0].id;
}

async function rowById(pool: Pool, id: string): Promise<{
  sent_message_id: string | null; failed_reason: string | null; canceled_at: string | null;
}> {
  const res = await pool.query(
    `select sent_message_id, failed_reason, canceled_at from scheduled_message where id = $1`, [id],
  );
  return res.rows[0];
}

async function countScheduled(pool: Pool): Promise<number> {
  return (await pool.query(`select count(*)::int as n from scheduled_message`)).rows[0].n;
}

/** 새 채널 하나와 그 채널의 멤버십. 테스트끼리 행을 섞지 않으려고 매번 새로 판다. */
async function makeChannel(app: FastifyInstance, adminToken: string, name: string, memberId: string): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name },
  });
  const id = created.json().id as string;
  await app.inject({
    method: 'POST', url: `/channels/${id}/members`, headers: { authorization: `Bearer ${adminToken}` },
    payload: { accountId: memberId },
  });
  return id;
}

const inAnHour = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const aMomentAgo = (): string => new Date(Date.now() - 1000).toISOString();

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let userToken: string;
let userId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const user = await createUser(app, adminToken, 'testuser');
  userToken = user.token;
  userId = user.accountId;
  channelId = await makeChannel(app, adminToken, 'scheduled-test', userId);
});
afterAll(async () => { await app.close(); await stop(); });

describe('예약 발송 (#222)', () => {
  // 1. 발송 전에는 `message` 에 아무것도 없다. seq 를 먼저 점유하면 다른 사람의
  //    실시간 뷰에 구멍이 생긴다 — 그래서 별도 테이블이다.
  it('예약은 scheduled_message 에만 들어가고 message 에는 없다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-isolated', userId);
    const res = await app.inject({
      method: 'POST', url: `/channels/${ch}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '예약 테스트', sendAt: inAnHour() },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().scheduled.id).toBeTruthy();

    const messages = await app.inject({
      method: 'GET', url: `/channels/${ch}/messages`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(messages.json().messages).toHaveLength(0);

    const list = await app.inject({
      method: 'GET', url: `/channels/${ch}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(list.json().scheduled).toHaveLength(1);
    expect(list.json().scheduled[0]).toMatchObject({ body: '예약 테스트' });

    // spec 1 은 "**다른 사람이 채널을 읽어도** 안 보인다"까지 요구한다. 작성자 시점만
    // 보면 "내 화면에 아직 안 뜬다"만 지켜지고, 남의 실시간 뷰에 구멍이 생기는 것을
    // (별도 테이블을 만든 그 이유를) 아무도 지키지 않는다.
    const reader = await createUser(app, adminToken, 'sched-reader');
    await app.inject({
      method: 'POST', url: `/channels/${ch}/members`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: reader.accountId },
    });
    const asOther = await app.inject({
      method: 'GET', url: `/channels/${ch}/messages`,
      headers: { authorization: `Bearer ${reader.token}` },
    });
    expect(asOther.json().messages).toHaveLength(0);
  });

  // 2. 남에게는 **존재 자체가** 보이지 않는다. 보이면 초안과 다를 게 없다.
  it('다른 사람의 목록에는 내 예약이 없다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-private', userId);
    await app.inject({
      method: 'POST', url: `/channels/${ch}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '비밀 예약', sendAt: inAnHour() },
    });

    const other = await createUser(app, adminToken, 'otheruser');
    const list = await app.inject({
      method: 'GET', url: `/channels/${ch}/scheduled`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().scheduled).toEqual([]);
  });

  // 3. 시각이 지난 것만 나간다. 아직 안 된 것은 손대지 않는다.
  it('sweep 은 시각이 지난 것만 보내고 나머지는 그대로 둔다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-due', userId);
    const dueId = await insertScheduled(pool, ch, userId, '지금 발송', aMomentAgo());
    const laterId = await insertScheduled(pool, ch, userId, '나중 발송', inAnHour());

    await createScheduledMessageSweeper(pool).sweep();

    const due = await rowById(pool, dueId);
    expect(due.sent_message_id).not.toBeNull();
    const later = await rowById(pool, laterId);
    expect(later.sent_message_id).toBeNull();
    expect(later.failed_reason).toBeNull();

    const messages = await app.inject({
      method: 'GET', url: `/channels/${ch}/messages`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(messages.json().messages).toHaveLength(1);
    expect(messages.json().messages[0].body).toBe('지금 발송');
    expect(messages.json().messages[0].id).toBe(due.sent_message_id);
  });

  // 4. **일반 발송과 같은 부작용**이 나야 한다. 이것이 `postMessage` 를 그대로 통과시키는
  //    이유다 — 우회해 직접 insert 하면 멘션이 아무에게도 닿지 않는 조용한 메시지가 된다.
  it('발송된 예약은 멘션 inbox 를 채운다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-mention', userId);
    const target = await createUser(app, adminToken, 'mentionee');
    await app.inject({
      method: 'POST', url: `/channels/${ch}/members`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: target.accountId },
    });

    const id = await insertScheduled(pool, ch, userId, '@mentionee 예약으로 부른다', aMomentAgo());
    await createScheduledMessageSweeper(pool).sweep();

    const sent = await rowById(pool, id);
    expect(sent.sent_message_id).not.toBeNull();

    const inbox = await app.inject({
      method: 'GET', url: '/inbox', headers: { authorization: `Bearer ${target.token}` },
    });
    const entries = inbox.json().entries as Array<{ messageId: string; reason: string }>;
    expect(entries.map((e) => e.messageId)).toContain(sent.sent_message_id);
  });

  // 5. 보관된 채널에는 나가지 않고 사유가 남는다. 우회 경로로 밀어 넣지 않는다.
  it('보관된 채널이면 발송되지 않고 failed_reason 이 channel_archived 다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-archive', userId);
    const id = await insertScheduled(pool, ch, userId, '보관된 채널 예약', aMomentAgo());

    await app.inject({
      method: 'PATCH', url: `/channels/${ch}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    await createScheduledMessageSweeper(pool).sweep();

    const row = await rowById(pool, id);
    expect(row.failed_reason).toBe('channel_archived');
    expect(row.sent_message_id).toBeNull();

    // 그리고 실제로 채널에 아무것도 없어야 한다 — 사유만 적고 메시지는 나가 버리면
    // 사유가 거짓말이 된다.
    const messages = await app.inject({
      method: 'GET', url: `/channels/${ch}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(messages.json().messages).toHaveLength(0);
  });

  // 6. 에이전트는 예약할 수 없다. 403 이고 **행도 남지 않는다**.
  it('에이전트 PAT 로 예약하면 403 이고 행이 생기지 않는다', async () => {
    const { pat } = await createAgent(app, adminToken, 'scheduling-agent');
    const before = await countScheduled(pool);

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${pat}` },
      payload: { body: '에이전트 예약', sendAt: inAnHour() },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('agents_cannot_schedule');
    expect(await countScheduled(pool)).toBe(before);
  });

  // 7. 과거·30일 초과는 400 이고 역시 행이 남지 않는다.
  it('과거 시각은 400 send_at_in_past 이고 행이 생기지 않는다', async () => {
    const before = await countScheduled(pool);
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '과거 예약', sendAt: new Date(Date.now() - 60 * 1000).toISOString() },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('send_at_in_past');
    expect(await countScheduled(pool)).toBe(before);
  });

  it('30일을 넘기면 400 send_at_too_far 이고 행이 생기지 않는다', async () => {
    const before = await countScheduled(pool);
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '너무 먼 미래', sendAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString() },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('send_at_too_far');
    expect(await countScheduled(pool)).toBe(before);

    // 상한 **바로 아래**는 통과해야 한다 — 상한이 아무거나 막는 것이 아님을 못박는다.
    const ok = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '29일 뒤', sendAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString() },
    });
    expect(ok.statusCode).toBe(201);
  });

  // 8. 취소는 행을 지우지 않고 `canceled_at` 을 찍으며, sweep 이 그것을 건너뛴다.
  it('취소하면 canceled_at 이 찍히고 sweep 이 건너뛴다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-cancel', userId);
    const create = await app.inject({
      method: 'POST', url: `/channels/${ch}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '취소할 예약', sendAt: inAnHour() },
    });
    const id = create.json().scheduled.id as string;

    const cancel = await app.inject({
      method: 'DELETE', url: `/scheduled/${id}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(cancel.statusCode).toBe(204);

    // 시각을 지나게 당겨 놓아도 sweep 이 집지 않아야 한다.
    await pool.query(`update scheduled_message set send_at = now() - interval '1 minute' where id = $1`, [id]);
    await createScheduledMessageSweeper(pool).sweep();

    const row = await rowById(pool, id);
    expect(row.canceled_at).not.toBeNull();
    expect(row.sent_message_id).toBeNull();
  });

  it('남의 예약은 취소하지 못한다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-cancel-other', userId);
    const id = await insertScheduled(pool, ch, userId, '내 예약', inAnHour());
    const other = await createUser(app, adminToken, 'canceler');

    const res = await app.inject({
      method: 'DELETE', url: `/scheduled/${id}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(res.statusCode).toBe(404);
    expect((await rowById(pool, id)).canceled_at).toBeNull();
  });

  // 9. 두 sweeper 를 **동시에** 돌려도 한 번만 나간다. `for update skip locked` 가 없으면
  //    둘 다 같은 행을 읽어 같은 예약을 두 번 보낸다 — 그 선을 여기서 지킨다.
  it('sweep 을 동시에 둘 돌려도 중복 발송이 없다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-race', userId);
    for (let i = 0; i < 5; i++) {
      await insertScheduled(pool, ch, userId, `동시 발송 ${i}`, aMomentAgo());
    }

    await Promise.all([
      createScheduledMessageSweeper(pool).sweep(),
      createScheduledMessageSweeper(pool).sweep(),
    ]);

    const messages = await app.inject({
      method: 'GET', url: `/channels/${ch}/messages`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    const bodies = (messages.json().messages as Array<{ body: string }>).map((m) => m.body);
    expect(bodies).toHaveLength(5);
    expect(new Set(bodies).size).toBe(5);

    const pending = await pool.query(
      `select count(*)::int as n from scheduled_message
       where channel_id = $1 and sent_message_id is null`, [ch],
    );
    expect(pending.rows[0].n).toBe(0);
  });

  // 본문 상한은 즉시 발송과 **같아야** 한다. 여기만 넉넉하면 예약을 거쳐 8000자를
  // 넘기는 우회로가 된다 — 발송은 `postMessage` 를 그대로 통과하므로 그 글이 그대로
  // 채널에 들어간다.
  it('본문 상한은 즉시 발송과 같다 — 8000자를 넘기면 400 이고 행이 생기지 않는다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-too-long', userId);
    const before = await countScheduled(pool);

    const res = await app.inject({
      method: 'POST', url: `/channels/${ch}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: 'ㄱ'.repeat(8001), sendAt: inAnHour() },
    });

    expect(res.statusCode).toBe(400);
    expect(await countScheduled(pool)).toBe(before);

    // 8000자는 통과해야 한다 — 상한을 한 칸 잘못 잡은 것을 잡는 경계선이다.
    const ok = await app.inject({
      method: 'POST', url: `/channels/${ch}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: 'ㄱ'.repeat(8000), sendAt: inAnHour() },
    });
    expect(ok.statusCode).toBe(201);
  });

  // 채널 삭제(#155)는 그 채널의 예약도 함께 지운다. 남겨 두면 sweep 이 매번 없는 채널을
  // 집어 들고, 애초에 FK 가 채널 삭제 자체를 막는다.
  it('채널을 지우면 그 채널의 예약도 사라진다', async () => {
    const ch = await makeChannel(app, adminToken, 'sched-deleted', userId);
    await insertScheduled(pool, ch, userId, '사라질 예약', inAnHour());

    await app.inject({
      method: 'PATCH', url: `/channels/${ch}`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { archived: true },
    });
    const del = await app.inject({
      method: 'DELETE', url: `/channels/${ch}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);

    const left = await pool.query(`select 1 from scheduled_message where channel_id = $1`, [ch]);
    expect(left.rowCount).toBe(0);
  });
});
