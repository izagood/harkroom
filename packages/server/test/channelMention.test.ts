import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * `@channel` — 채널 전체 호출의 회귀선(#225).
 *
 * 여기서 지키는 것은 "알림이 간다"가 아니라 **누구에게 가고 누구에게 가지 않는가**다.
 * 대상 판정을 `channelVisibleSql` 이 아닌 것으로 다시 쓰면 두 방향으로 틀린다: private
 * 채널의 비멤버가 알림을 받아 **채널의 존재 자체가 새거나**, public 채널에서 볼 수 있는
 * 사람이 조용히 빠진다. 그래서 멤버·비멤버·작성자를 각각 따로 센다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let memberPat: string;
let memberId: string;
let outsiderPat: string;
let privateId: string;
let publicId: string;

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

/**
 * 그 메시지가 이 계정의 inbox 에 넣은 항목 수. 개수를 before/after 로 재지 않고 메시지
 * id 로 집는다 — 같은 파일의 다른 테스트가 남긴 항목이 섞이지 않는다.
 */
async function inboxFor(pat: string, messageId: string): Promise<Array<{ reason: string }>> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(pat) });
  expect(res.statusCode).toBe(200);
  return (res.json().entries as Array<{ reason: string; messageId: string }>)
    .filter((e) => e.messageId === messageId);
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: memberPat, accountId: memberId } = await createAgent(app, adminToken, 'member'));
  ({ pat: outsiderPat } = await createAgent(app, adminToken, 'outsider'));

  publicId = await createChannel('openchan', 'public');
  privateId = await createChannel('secretchan', 'private');
  await app.inject({
    method: 'POST', url: `/channels/${privateId}/members`,
    headers: auth(adminToken), payload: { accountId: memberId },
  });
});
afterAll(async () => { await app.close(); await stop(); });

describe('@channel 이 부르는 사람', () => {
  it('private 채널에서 멤버 전원에게 inbox 항목을 만든다', async () => {
    const id = await post(adminToken, privateId, '@channel 오늘 배포한다');

    expect(await inboxFor(memberPat, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
  });

  // 비멤버가 받으면 알림 하나가 새는 것으로 끝나지 않는다 — private 채널이 존재한다는
  // 사실과 그 메시지 id 가 함께 샌다.
  it('private 채널의 비멤버에게는 만들지 않는다', async () => {
    const id = await post(adminToken, privateId, '@channel 여기는 비공개다');

    expect(await inboxFor(outsiderPat, id)).toEqual([]);
  });

  it('public 채널에서는 볼 수 있는 사람 전부에게 만든다', async () => {
    const id = await post(adminToken, publicId, '@channel 전체 공지');

    expect(await inboxFor(memberPat, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
    expect(await inboxFor(outsiderPat, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
  });

  // 자기 발화로 자기에게 알림이 오면 inbox 는 자기가 쓴 글로 가득 찬다.
  it('부른 사람 자신에게는 만들지 않는다', async () => {
    const id = await post(memberPat, privateId, '@channel 내가 부른다');

    expect(await inboxFor(memberPat, id)).toEqual([]);
  });

  // 본문을 서버가 펼쳐 쓰면 원문이 사라진다 — 작성자가 수정하려고 열었을 때 자기가 쓰지
  // 않은 handle 나열을 보게 되고, 되돌릴 방법이 없다.
  it('본문의 @channel 을 그대로 남긴다', async () => {
    const id = await post(adminToken, publicId, '@channel 원문 그대로');

    const list = await app.inject({
      method: 'GET', url: `/channels/${publicId}/messages`, headers: auth(adminToken),
    });
    const found = (list.json().messages as Array<{ id: string; body: string }>)
      .find((m) => m.id === id);
    expect(found?.body).toBe('@channel 원문 그대로');
  });
});

// 이 계정은 앞의 테스트들이 끝난 뒤에 만든다 — 만들어지는 순간 `@channel` 의 뜻이
// 바뀌므로, 같은 파일의 앞선 테스트가 그 영향을 받으면 안 된다.
describe('@channel 이라는 handle 의 계정이 있을 때', () => {
  it('그 계정만 부르고 채널 전체로 펼치지 않는다', async () => {
    const { pat: channelPat } = await createAgent(app, adminToken, 'channel');

    const id = await post(adminToken, publicId, '@channel 너를 부른 것이다');

    expect(await inboxFor(channelPat, id)).toEqual([expect.objectContaining({ reason: 'mention' })]);
    // 사람의 이름이 예약어에 밀리면 그 사람은 영영 불릴 수 없다. 계정이 이긴다.
    expect(await inboxFor(outsiderPat, id)).toEqual([]);
    expect(await inboxFor(memberPat, id)).toEqual([]);
  });
});
