import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { audienceFor } from '../src/services/channels.js';

/**
 * private 채널의 회귀선(#156, #182).
 *
 * 여기서 지키는 것은 기능이 아니라 **경계**다. private 채널의 존재가 새는 표면은 여섯
 * 곳이고(목록·미읽음 배지·검색·읽기·쓰기·이벤트), 각각이 다른 방식으로 샌다 — 배지는
 * 개수로, 검색은 본문으로, 이벤트는 실시간으로. 한 표면만 고쳐도 나머지가 열려 있으면
 * private 은 이름뿐이므로, 표면마다 따로 확인한다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let memberToken: string;
let memberId: string;
let outsiderToken: string;
let outsiderId: string;
let thirdId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createChannel(
  token: string, name: string, visibility: 'public' | 'private',
): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(token), payload: { name, visibility },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function invite(token: string, channelId: string, accountId: string) {
  return app.inject({
    method: 'POST', url: `/channels/${channelId}/members`, headers: auth(token), payload: { accountId },
  });
}

async function post(token: string, channelId: string, body: string) {
  return app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
  });
}

let privateId: string;
let publicId: string;
/** admin 이 만든 뒤 스스로 나간 private 채널 — "admin 은 목록에서만 본다"의 무대다. */
let adminlessId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: memberToken, accountId: memberId } = await createAgent(app, adminToken, 'member'));
  ({ pat: outsiderToken, accountId: outsiderId } = await createAgent(app, adminToken, 'outsider'));
  ({ accountId: thirdId } = await createAgent(app, adminToken, 'third'));

  publicId = await createChannel(adminToken, 'openchan', 'public');
  privateId = await createChannel(adminToken, 'secretchan', 'private');
  await invite(adminToken, privateId, memberId);
  await post(memberToken, privateId, 'sekrit pipeline token');

  adminlessId = await createChannel(adminToken, 'adminless', 'private');
  await invite(adminToken, adminlessId, memberId);
  await post(memberToken, adminlessId, 'adminless body text');
  // admin 이 스스로 나간다 — 자기 자신 제거는 언제나 허용된다.
  await app.inject({
    method: 'DELETE', url: `/channels/${adminlessId}/members/${adminId}`, headers: auth(adminToken),
  });
});
afterAll(async () => { await app.close(); await stop(); });

describe('채널 가시성 — private', () => {
  // 1
  it('비멤버의 채널 목록에 private 채널이 없다', async () => {
    const res = await app.inject({ method: 'GET', url: '/channels', headers: auth(outsiderToken) });
    const ids = res.json().channels.map((c: { id: string }) => c.id);
    expect(ids).toContain(publicId);
    expect(ids).not.toContain(privateId);
  });

  it('멤버의 채널 목록에는 private 채널이 있다', async () => {
    const res = await app.inject({ method: 'GET', url: '/channels', headers: auth(memberToken) });
    expect(res.json().channels.map((c: { id: string }) => c.id)).toContain(privateId);
  });

  // 2 — 배지로 존재가 새지 않는다.
  it('비멤버의 읽음 상태 일괄 조회에 private 채널이 없다', async () => {
    const res = await app.inject({ method: 'GET', url: '/reads', headers: auth(outsiderToken) });
    const ids = res.json().reads.map((r: { channelId: string }) => r.channelId);
    expect(ids).toContain(publicId);
    expect(ids).not.toContain(privateId);
  });

  // 3 — 검색은 목록을 우회해 본문에 바로 닿는다.
  it('비멤버의 검색 결과에 private 채널의 메시지가 없다', async () => {
    const res = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: auth(outsiderToken),
    });
    expect(res.statusCode).toBe(200);
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).not.toContain('sekrit pipeline token');
    // 멤버에게는 보인다 — 술어가 검색을 통째로 막아 버린 것이 아님을 같은 자리에서 확인한다.
    const mine = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: auth(memberToken),
    });
    expect(mine.json().messages.map((m: { body: string }) => m.body)).toContain('sekrit pipeline token');
  });

  // 4 — 403 이고, 본문이 응답에 없다.
  it('비멤버의 메시지 읽기는 403 이고 본문이 응답에 없다', async () => {
    const res = await app.inject({
      method: 'GET', url: `/channels/${privateId}/messages`, headers: auth(outsiderToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('sekrit');
  });

  // 5
  it('비멤버의 메시지 쓰기는 403 이다', async () => {
    const res = await post(outsiderToken, privateId, 'barging in');
    expect(res.statusCode).toBe(403);
  });

  // 6 — 이 절충의 회귀선.
  it('admin 은 자기가 멤버가 아닌 private 채널을 목록에서 보되 메시지는 403 이다', async () => {
    const list = await app.inject({ method: 'GET', url: '/channels', headers: auth(adminToken) });
    const row = list.json().channels.find((c: { id: string }) => c.id === adminlessId);
    expect(row).toBeTruthy();
    expect(row.name).toBe('adminless');
    expect(row.visibility).toBe('private');

    const read = await app.inject({
      method: 'GET', url: `/channels/${adminlessId}/messages`, headers: auth(adminToken),
    });
    expect(read.statusCode).toBe(403);
    expect(read.body).not.toContain('adminless body text');

    const write = await post(adminToken, adminlessId, 'admin barging in');
    expect(write.statusCode).toBe(403);

    // 목록에서 보이는 채널의 멤버 목록까지는 준다(운영). 메시지만 막힌다.
    const members = await app.inject({
      method: 'GET', url: `/channels/${adminlessId}/members`, headers: auth(adminToken),
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members.map((m: { accountId: string }) => m.accountId)).toContain(memberId);

    // 배지도 새지 않는다 — 목록에 보인다고 미읽음까지 주지 않는다.
    const reads = await app.inject({ method: 'GET', url: '/reads', headers: auth(adminToken) });
    expect(reads.json().reads.map((r: { channelId: string }) => r.channelId)).not.toContain(adminlessId);
  });

  // 7
  it('멤버는 초대할 수 있고 비멤버는 초대할 수 없다', async () => {
    const byOutsider = await invite(outsiderToken, privateId, outsiderId);
    expect(byOutsider.statusCode).toBe(403);

    const byMember = await invite(memberToken, privateId, thirdId);
    expect(byMember.statusCode).toBe(200);
    expect(byMember.json().members.map((m: { accountId: string }) => m.accountId)).toContain(thirdId);
  });

  // 8
  it('자기 자신은 나갈 수 있고 남을 빼는 것은 admin 만이다', async () => {
    const chId = await createChannel(adminToken, 'leavetest', 'private');
    await invite(adminToken, chId, memberId);
    await invite(adminToken, chId, thirdId);

    // 멤버가 남을 빼려 하면 403.
    const byMember = await app.inject({
      method: 'DELETE', url: `/channels/${chId}/members/${thirdId}`, headers: auth(memberToken),
    });
    expect(byMember.statusCode).toBe(403);

    // 자기 자신은 나갈 수 있다.
    const self = await app.inject({
      method: 'DELETE', url: `/channels/${chId}/members/${memberId}`, headers: auth(memberToken),
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().members.map((m: { accountId: string }) => m.accountId)).not.toContain(memberId);

    // admin 은 남을 뺄 수 있다.
    const byAdmin = await app.inject({
      method: 'DELETE', url: `/channels/${chId}/members/${thirdId}`, headers: auth(adminToken),
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().members.map((m: { accountId: string }) => m.accountId)).not.toContain(thirdId);
  });

  // 9 — 기존 동작이 안 깨졌다.
  it('public 채널은 멤버가 아니어도 읽고 쓸 수 있다', async () => {
    const write = await post(outsiderToken, publicId, 'hello from outsider');
    expect(write.statusCode).toBe(201);

    const read = await app.inject({
      method: 'GET', url: `/channels/${publicId}/messages`, headers: auth(outsiderToken),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().messages.map((m: { body: string }) => m.body)).toContain('hello from outsider');

    const list = await app.inject({ method: 'GET', url: '/channels', headers: auth(outsiderToken) });
    expect(list.json().channels.map((c: { id: string }) => c.id)).toContain(publicId);
  });

  // 10 — 이벤트가 비멤버에게 가지 않는다.
  it('private 채널의 이벤트 수신자는 멤버뿐이고 public 은 전원이다', async () => {
    expect(await audienceFor(pool, publicId)).toBe('all');
    const audience = await audienceFor(pool, privateId);
    expect(Array.isArray(audience)).toBe(true);
    expect(audience).toContain(memberId);
    expect(audience).not.toContain(outsiderId);
  });

  // 11
  it('private 으로 만들면 만든 사람이 첫 멤버다', async () => {
    const chId = await createChannel(adminToken, 'firstmember', 'private');
    const res = await app.inject({
      method: 'GET', url: `/channels/${chId}/members`, headers: auth(adminToken),
    });
    expect(res.json().members.map((m: { accountId: string }) => m.accountId)).toEqual([adminId]);
  });

  it('기존 채널과 새 public 채널의 기본 공개 범위는 public 이다', async () => {
    const res = await app.inject({ method: 'GET', url: '/channels', headers: auth(adminToken) });
    const open = res.json().channels.find((c: { id: string }) => c.id === publicId);
    expect(open.visibility).toBe('public');
  });

  it('admin 이 public 채널을 private 으로 바꾸면 비멤버 목록에서 사라진다', async () => {
    const chId = await createChannel(adminToken, 'flipme', 'public');
    const before = await app.inject({ method: 'GET', url: '/channels', headers: auth(outsiderToken) });
    expect(before.json().channels.map((c: { id: string }) => c.id)).toContain(chId);

    const patched = await app.inject({
      method: 'PATCH', url: `/channels/${chId}`, headers: auth(adminToken), payload: { visibility: 'private' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().visibility).toBe('private');

    const after = await app.inject({ method: 'GET', url: '/channels', headers: auth(outsiderToken) });
    expect(after.json().channels.map((c: { id: string }) => c.id)).not.toContain(chId);

    // 감사에 남는다 — 채널 하나가 통째로 닫히는 사건이다.
    const audit = await app.inject({
      method: 'GET', url: '/audit?action=channel.visibility.changed', headers: auth(adminToken),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries.some((e: { target: string }) => e.target === chId)).toBe(true);
  });

  it('멤버 추가·제거가 감사에 남는다', async () => {
    const res = await app.inject({
      method: 'GET', url: '/audit?action=channel.member.added', headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.some((e: { target: string }) => e.target === privateId)).toBe(true);
  });
});
