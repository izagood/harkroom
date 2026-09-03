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
let botPat: string;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'unreadbot'));
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// 테스트마다 새 채널을 쓴다 — 미읽음은 누적 상태라 채널을 공유하면 앞 테스트가 뒤 테스트의
// 절대값을 바꾼다.
let channelNo = 0;
const newChannel = async (): Promise<string> => {
  channelNo += 1;
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: `unread-${channelNo}` },
  });
  return res.json().id as string;
};

const post = async (channelId: string, token: string, body: string): Promise<number> => (await app.inject({
  method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
})).json().seq as number;

const markRead = (channelId: string, token: string, seq: number) => app.inject({
  method: 'PUT', url: `/channels/${channelId}/read`, headers: auth(token), payload: { seq },
});

const markUnread = (channelId: string, token: string, seq: number | null) => app.inject({
  method: 'PUT', url: `/channels/${channelId}/unread`, headers: auth(token), payload: { seq },
});

const readState = async (channelId: string, token: string): Promise<{ lastReadSeq: number; unread: number }> => (
  await app.inject({ method: 'GET', url: `/channels/${channelId}/read`, headers: auth(token) })
).json();

const bulkState = async (channelId: string, token: string): Promise<{ lastReadSeq: number; unread: number }> => {
  const rows = (await app.inject({ method: 'GET', url: '/reads', headers: auth(token) }))
    .json().reads as { channelId: string; lastReadSeq: number; unread: number }[];
  return rows.find((r) => r.channelId === channelId)!;
};

/** 저장된 원본 컬럼. 응답의 `lastReadSeq` 는 경계라서 단조성 자체는 여기로만 확인된다. */
const storedLastReadSeq = async (channelId: string, accountId: string): Promise<number> => {
  const res = await pool.query(
    'select last_read_seq::int as v from channel_read where account_id = $1 and channel_id = $2',
    [accountId, channelId],
  );
  return res.rows[0]?.v ?? 0;
};

describe('채널 미읽음 표시 (#154)', () => {
  it('표시하면 미읽음 수가 늘어난다', async () => {
    const ch = await newChannel();
    await post(ch, botPat, 'one');
    const last = await post(ch, botPat, 'two');
    await markRead(ch, adminToken, last);
    expect((await readState(ch, adminToken)).unread).toBe(0);

    const res = await markUnread(ch, adminToken, last);

    expect(res.statusCode).toBe(204);
    const state = await readState(ch, adminToken);
    // 마지막 메시지부터 미읽음 — "이 채널 다시 보라"는 표시라 1 이다.
    expect(state.unread).toBe(1);
    expect(state.lastReadSeq).toBe(last - 1);
  });

  // 이 결정의 핵심. 낡은 ack 는 채널 최대 seq 보다 작으므로 표시를 지우지 못한다 — 그러지
  // 않으면 다른 기기에서 늦게 도착한 ack 하나가 사람이 방금 누른 표시를 조용히 되돌린다.
  it('낡은(작은) seq 의 읽음 ack 는 표시를 지우지 못한다', async () => {
    const ch = await newChannel();
    await post(ch, botPat, 'one');
    const last = await post(ch, botPat, 'two');
    await markRead(ch, adminToken, last);
    await markUnread(ch, adminToken, last);

    await markRead(ch, adminToken, 1);

    expect((await readState(ch, adminToken)).unread).toBe(1);
  });

  it('채널 최대 seq 의 읽음 ack 는 표시를 지운다', async () => {
    const ch = await newChannel();
    await post(ch, botPat, 'one');
    const last = await post(ch, botPat, 'two');
    await markUnread(ch, adminToken, last);

    await markRead(ch, adminToken, last);

    const state = await readState(ch, adminToken);
    expect(state.unread).toBe(0);
    expect(state.lastReadSeq).toBe(last);
  });

  it('seq: null 이 표시를 지운다', async () => {
    const ch = await newChannel();
    const last = await post(ch, botPat, 'only');
    await markRead(ch, adminToken, last);
    await markUnread(ch, adminToken, last);
    expect((await readState(ch, adminToken)).unread).toBe(1);

    const res = await markUnread(ch, adminToken, null);

    expect(res.statusCode).toBe(204);
    expect((await readState(ch, adminToken)).unread).toBe(0);
  });

  // 지우기는 명시적 null 이어야 한다. 키가 없으면 400 이다 — `JSON.stringify` 가 undefined
  // 키를 버리는 클라이언트 실수를 서버가 조용히 삼키면 조작이 사라진다.
  it('seq 키가 없으면 거절한다', async () => {
    const ch = await newChannel();

    const res = await app.inject({
      method: 'PUT', url: `/channels/${ch}/unread`, headers: auth(adminToken), payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  // 표시는 별개 컬럼이라 단조성을 건드리지 않는다. 이 회귀선이 죽으면 #154 가 막으려던
  // 사고(늦게 온 옛 ack 가 위치를 되돌림)가 되살아난다.
  it('last_read_seq 는 여전히 되돌아가지 않는다', async () => {
    const ch = await newChannel();
    await post(ch, botPat, 'one');
    const last = await post(ch, botPat, 'two');
    await markRead(ch, adminToken, last);
    await markUnread(ch, adminToken, last);

    await markRead(ch, adminToken, 1);

    expect(await storedLastReadSeq(ch, adminId)).toBe(last);
    // 표시를 지운 뒤에는 경계가 원래 위치로 되돌아온다 — 값이 내려간 적이 없다는 증거다.
    await markUnread(ch, adminToken, null);
    expect((await readState(ch, adminToken)).lastReadSeq).toBe(last);
  });

  // 사이드바 배지(`allReadStates`)와 채널 안 표시(`readState`)가 각각 세면 한쪽만 고쳐졌을 때
  // 두 표면이 서로 다른 말을 한다.
  it('일괄 조회와 단건 조회가 같은 수를 준다 — 표시가 있을 때와 없을 때 모두', async () => {
    const ch = await newChannel();
    await post(ch, botPat, 'one');
    const last = await post(ch, botPat, 'two');
    await markRead(ch, adminToken, last);

    expect(await bulkState(ch, adminToken)).toMatchObject(await readState(ch, adminToken));

    await markUnread(ch, adminToken, last);

    const single = await readState(ch, adminToken);
    expect(single.unread).toBe(1);
    expect(await bulkState(ch, adminToken)).toMatchObject(single);
  });

  it('남의 계정 것은 바뀌지 않는다', async () => {
    const ch = await newChannel();
    const last = await post(ch, adminToken, 'from admin');
    await markRead(ch, botPat, last);

    await markUnread(ch, adminToken, last);

    const other = await readState(ch, botPat);
    expect(other.unread).toBe(0);
    expect(other.lastReadSeq).toBe(last);
  });

  it('dm 채널의 비멤버는 거절한다', async () => {
    const a = await createAgent(app, adminToken, 'unread-dm-a');
    const b = await createAgent(app, adminToken, 'unread-dm-b');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(a.pat), payload: { accountIds: [b.accountId] },
    });

    const res = await markUnread(dm.json().id as string, botPat, 1);

    expect(res.statusCode).toBe(403);
  });
});
