import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * 인용(`>`) 안 `@handle` 은 알림을 만들지 않는다(#593).
 *
 * **이 회귀선은 서버를 통과한다 — 순수 함수를 부르지 않는다.** `mentionedHandles` 만 단언하면
 * `services/messages.ts` 가 자기 정규식을 다시 적어도 전부 초록이다(#298 이 없앤 두 벌짜리
 * 판정 그 자체다). 그래서 여기서는 실제로 메시지를 올리고 **inbox 행을 센다.**
 *
 * 이 이슈가 시작된 자리: 에이전트가 앞 메시지·화면을 인용으로 옮겨 적기만 했는데 거기 있던
 * 핸들들이 실제로 불려 남의 세션이 깨어났다.
 *
 * 화면과의 대조는 `MessageBody` 를 실제로 렌더해야 하므로 데스크탑에 있다:
 * `packages/desktop/test/quoteMention.test.tsx`.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let fizzPat: string;
let teamMemberToken: string;
let teamMemberId: string;
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function post(body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 그 메시지가 이 사람의 inbox 에 남긴 행. 없으면 빈 배열 — "알림이 가지 않았다"의 정의다. */
async function inboxFor(token: string, messageId: string): Promise<Array<{ reason: string }>> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return (res.json().entries as Array<{ reason: string; messageId: string }>)
    .filter((e) => e.messageId === messageId);
}

/** 초대 → 등록 → 로그인. 집합(#230)에는 사람만 들어갈 수 있다. */
async function registerHuman(handle: string): Promise<{ id: string; token: string }> {
  const inviteRes = await app.inject({
    method: 'POST', url: '/invites', headers: auth(adminToken), payload: {},
  });
  const inviteToken = inviteRes.json().token as string;
  const created = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle, loginId: handle, displayName: handle, password: 'pw123456', inviteToken },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: handle, password: 'pw123456' },
  });
  expect(login.statusCode).toBe(200);
  return { id: created.json().id as string, token: login.json().token as string };
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: fizzPat } = await createAgent(app, adminToken, 'fizz'));
  ({ id: teamMemberId, token: teamMemberToken } = await registerHuman('teamperson'));

  const chan = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name: 'quotetalk', visibility: 'public' },
  });
  expect(chan.statusCode).toBe(201);
  channelId = chan.json().id as string;

  // 인용 안의 그룹 handle 이 확장되지 않는지 보려면 확장될 수 있는 집합이 실제로 있어야 한다.
  const group = await app.inject({
    method: 'POST', url: '/handle-groups', headers: auth(adminToken),
    payload: { handle: 'quoteteam', displayName: 'Quote Team' },
  });
  expect(group.statusCode).toBe(201);
  const members = await app.inject({
    method: 'POST', url: `/handle-groups/${group.json().id}/members`,
    headers: auth(adminToken), payload: { accountIds: [teamMemberId] },
  });
  expect(members.statusCode).toBe(200);
});
afterAll(async () => { await app.close(); await stop(); });

describe('인용 안 멘션은 알림을 만들지 않는다 (#593)', () => {
  it('인용 줄의 @handle 은 inbox 에 행을 남기지 않는다', async () => {
    const id = await post('> @fizz 를 부른다\n라고 적혀 있었다');
    expect(await inboxFor(fizzPat, id)).toEqual([]);
  });

  it('여러 줄 인용도 전부 비껴간다', async () => {
    const id = await post('> 첫 줄 @fizz\n> 둘째 줄도 @fizz');
    expect(await inboxFor(fizzPat, id)).toEqual([]);
  });

  it('한 메시지에 인용 안·밖이 같이 있으면 밖의 것만 알린다', async () => {
    // 같은 handle 이므로 "인용 밖이 살아 있다" 만 볼 수 있다 — 개수가 아니라 존재를 본다.
    const id = await post('> @fizz 라고 적혀 있었다\n@fizz 이거 봐');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('인용 밖의 @handle 은 여전히 알림이 간다', async () => {
    const id = await post('@fizz 안녕');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('인용이 아닌 부등호는 인용이 아니다 — 알림이 간다', async () => {
    const id = await post('a > b 이면 @fizz 를 부른다');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('인용 안의 집합 handle 은 확장되지 않는다', async () => {
    const id = await post('> @quoteteam 이라고 쓰면 팀을 부른다');
    expect(await inboxFor(teamMemberToken, id)).toEqual([]);
  });

  it('인용 밖의 집합 handle 은 확장된다 — 위 단언이 확장 자체가 죽은 것을 통과시키지 않는다', async () => {
    const id = await post('@quoteteam 회의합니다');
    expect((await inboxFor(teamMemberToken, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('인용 안의 @channel 도 채널 전체를 부르지 않는다', async () => {
    const id = await post('> @channel 이라고 적혀 있었다');
    expect(await inboxFor(teamMemberToken, id)).toEqual([]);
  });

  it('인용 밖의 @channel 은 채널 전체를 부른다 — 위 단언이 채널 호출 자체가 죽은 것을 통과시키지 않는다', async () => {
    const id = await post('@channel 공지합니다');
    expect((await inboxFor(teamMemberToken, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('저장된 본문은 그대로다 — 인용 안의 @handle 은 <@id> 로도 바뀌지 않는다', async () => {
    const body = '> @fizz 라고 적혀 있었다';
    const id = await post(body);
    const read = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
    });
    expect(read.statusCode).toBe(200);
    const found = (read.json().messages as Array<{ id: string; body: string }>).find((m) => m.id === id);
    expect(found?.body).toBe(body);
  });
});
