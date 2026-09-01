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
let botPat: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'readbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'reads' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const post = async (token: string, body: string): Promise<number> => (await app.inject({
  method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
})).json().seq as number;

const markRead = (token: string, seq: number, channel = channelId) => app.inject({
  method: 'PUT', url: `/channels/${channel}/read`, headers: auth(token), payload: { seq },
});

const readState = async (token: string): Promise<{ lastReadSeq: number; unread: number }> => {
  const res = await app.inject({ method: 'GET', url: `/channels/${channelId}/read`, headers: auth(token) });
  return res.json();
};

describe('채널 읽음 위치', () => {
  it('starts at zero and counts everything as unread', async () => {
    await post(botPat, 'first');
    await post(botPat, 'second');

    const state = await readState(adminToken);

    expect(state.lastReadSeq).toBe(0);
    expect(state.unread).toBe(2);
  });

  it('advances to the acknowledged seq and drops the unread count', async () => {
    const seq = await post(botPat, 'third');

    const res = await markRead(adminToken, seq);

    expect(res.statusCode).toBe(204);
    const state = await readState(adminToken);
    expect(state.lastReadSeq).toBe(seq);
    expect(state.unread).toBe(0);
  });

  // 응답이 늦게 도착한 오래된 ack 가 읽음 위치를 되돌리면, 이미 읽은 대화가 다시 미읽음으로
  // 나타난다. 위치는 단조로워야 한다.
  it('never rewinds on a stale acknowledgement', async () => {
    const seq = await post(botPat, 'fourth');
    await markRead(adminToken, seq);

    await markRead(adminToken, 1);

    expect((await readState(adminToken)).lastReadSeq).toBe(seq);
  });

  // 미래의 seq 를 받아들이면 그 뒤에 오는 실제 메시지가 처음부터 읽은 것이 된다 — 조용히
  // 놓치는 경로다. 채널의 현재 최대 seq 로 자른다.
  it('clamps an acknowledgement beyond the channel to the newest message', async () => {
    const newest = await post(botPat, 'fifth');

    await markRead(adminToken, newest + 10_000);
    const clamped = (await readState(adminToken)).lastReadSeq;
    const afterwards = await post(botPat, 'sixth');

    expect(clamped).toBe(newest);
    expect((await readState(adminToken)).unread).toBe(1);
    expect(afterwards).toBeGreaterThan(newest);
  });

  // 자기가 쓴 메시지는 미읽음이 아니다. 그러지 않으면 발화할 때마다 자기 채널에 배지가 뜬다.
  it('does not count my own messages as unread', async () => {
    // 앞 테스트가 남긴 봇 메시지가 이미 미읽음이므로 절대값이 아니라 **증가하지 않는다**를 잰다.
    const before = (await readState(adminToken)).unread;

    const mine = await post(adminToken, 'written by me');

    const after = await readState(adminToken);
    expect(after.unread).toBe(before);
    expect(after.lastReadSeq).toBeLessThan(mine);
  });

  it('does not count deleted messages as unread', async () => {
    const doomed = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(botPat),
      payload: { body: 'to be deleted' },
    });
    const before = (await readState(adminToken)).unread;

    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${doomed.json().id}`, headers: auth(adminToken),
    });

    expect((await readState(adminToken)).unread).toBe(before - 1);
  });

  it('keeps positions per account', async () => {
    const seq = await post(adminToken, 'for both');
    await markRead(botPat, seq);

    const res = await app.inject({ method: 'GET', url: `/channels/${channelId}/read`, headers: auth(botPat) });

    expect(res.json().lastReadSeq).toBe(seq);
    expect((await readState(adminToken)).lastReadSeq).toBeLessThan(seq);
  });

  it('refuses a non-member of a dm channel', async () => {
    const other = await createAgent(app, adminToken, 'outsiderbot');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [] },
    });
    // DM 생성이 멤버를 요구하면 상대를 하나 넣는다.
    const dmId = dm.statusCode === 201
      ? dm.json().id
      : (await app.inject({
          method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [other.accountId] },
        })).json().id;

    const res = await markRead(botPat, 1, dmId);

    expect(res.statusCode).toBe(403);
  });
});

// 사이드바 배지는 채널 전체의 미읽음을 한 번에 알아야 한다. 채널마다 요청하면 N+1 이고,
// 채널이 늘수록 앱을 열 때마다 그만큼 왕복한다.
describe('읽음 위치 일괄 조회', () => {
  it('returns one row per visible channel', async () => {
    const second = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'reads-two' },
    });
    const secondId = second.json().id as string;
    await app.inject({
      method: 'POST', url: `/channels/${secondId}/messages`, headers: auth(botPat), payload: { body: 'hi' },
    });

    const res = await app.inject({ method: 'GET', url: '/reads', headers: auth(adminToken) });

    expect(res.statusCode).toBe(200);
    const rows = res.json().reads as { channelId: string; lastReadSeq: number; unread: number }[];
    const forSecond = rows.find((r) => r.channelId === secondId);
    expect(forSecond).toBeTruthy();
    expect(forSecond!.unread).toBeGreaterThan(0);
    // 아직 아무것도 읽지 않은 채널도 행이 있어야 한다 — 없으면 클라이언트가 0 과 '모름'을 구분 못 한다.
    expect(forSecond!.lastReadSeq).toBe(0);
  });

  // DM 은 멤버에게만 보인다. 일괄 조회가 그 경계를 무시하면 채널 존재 자체가 새어 나간다.
  it('omits dm channels I am not a member of', async () => {
    const a = await createAgent(app, adminToken, 'dmreadbot-a');
    const b = await createAgent(app, adminToken, 'dmreadbot-b');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(a.pat), payload: { accountIds: [b.accountId] },
    });
    const dmId = dm.json().id as string;

    const res = await app.inject({ method: 'GET', url: '/reads', headers: auth(botPat) });

    const rows = res.json().reads as { channelId: string }[];
    expect(rows.some((r) => r.channelId === dmId)).toBe(false);
  });

  it('reflects a mark-read immediately', async () => {
    const seq = await post(botPat, 'bulk ack');
    await markRead(adminToken, seq);

    const res = await app.inject({ method: 'GET', url: '/reads', headers: auth(adminToken) });

    const mine = (res.json().reads as { channelId: string; lastReadSeq: number; unread: number }[])
      .find((r) => r.channelId === channelId);
    expect(mine!.lastReadSeq).toBe(seq);
    expect(mine!.unread).toBe(0);
  });
});
