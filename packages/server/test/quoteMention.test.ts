import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * 인용(`>`) 안 `@handle` 은 알림을 만들지 않는다(#597).
 *
 * 옮겨 적기가 부르기가 되면 인용을 쓸 수 없다 — 화면·로그·앞 메시지를 그대로 옮긴 것만으로
 * 남의 턴이 깨어난다. 이 이슈를 만든 실측이 정확히 그것이었다.
 *
 * **이 회귀선은 서버를 통과한다 — 순수 함수를 부르지 않는다.** `mentionedHandles` 만 단언하면
 * `services/messages.ts` 가 자기 정규식을 다시 적어도 전부 초록이다(#298 이 없앤 두 벌짜리
 * 판정 그 자체다). 그래서 실제로 메시지를 올리고 **inbox 행을 센다.**
 *
 * 화면과의 대조는 `MessageBody` 를 실제로 렌더해야 하므로 데스크탑에 있다:
 * `packages/desktop/test/quoteMention.test.tsx`.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let fizzPat: string;
let fizzId: string;
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

/** 저장된 본문. 정규화가 인용을 비껴갔는지는 여기서 보인다(`@handle` 이 `<@id>` 로 바뀌었나). */
async function storedBody(messageId: string): Promise<string> {
  const read = await app.inject({
    method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
  });
  expect(read.statusCode).toBe(200);
  const found = (read.json().messages as Array<{ id: string; body: string }>)
    .find((m) => m.id === messageId);
  return found!.body;
}

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
  ({ pat: fizzPat, accountId: fizzId } = await createAgent(app, adminToken, 'fizz'));
  ({ id: teamMemberId, token: teamMemberToken } = await registerHuman('quoteperson'));

  const chan = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name: 'quotetalk', visibility: 'public' },
  });
  expect(chan.statusCode).toBe(201);
  channelId = chan.json().id as string;

  // 인용 안의 집합 handle 이 확장되지 않는지 보려면 확장될 수 있는 집합이 실제로 있어야 한다.
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

describe('인용 안 멘션은 알림을 만들지 않는다 (#597)', () => {
  it('인용 줄의 @handle 은 inbox 에 행을 남기지 않는다', async () => {
    const id = await post('> @fizz 라고 적혀 있었다');
    expect(await inboxFor(fizzPat, id)).toEqual([]);
  });

  it('여러 줄 인용도 전부 제외된다', async () => {
    const id = await post('앞 메시지 옮김:\n> 목록에\n> @fizz 가 있었다');
    expect(await inboxFor(fizzPat, id)).toEqual([]);
  });

  it('한 메시지에 인용 안·밖이 같이 있으면 밖의 것만 알린다', async () => {
    const id = await post('> @fizz 라고 적혀 있었다\n\n@fizz 이건 진짜 부르는 것이다');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('인용 밖의 @handle 은 여전히 알림이 간다 — 위 단언들이 멘션 자체가 죽은 것을 통과시키지 않는다', async () => {
    const id = await post('@fizz 안녕');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('인용 안의 집합 handle 은 확장되지 않는다', async () => {
    const id = await post('> @quoteteam 이라고 쓰면 팀을 부른다');
    expect(await inboxFor(teamMemberToken, id)).toEqual([]);
  });

  it('인용 밖의 집합 handle 은 확장된다', async () => {
    const id = await post('@quoteteam 회의합니다');
    expect((await inboxFor(teamMemberToken, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('인용이 끝난 다음 줄은 인용이 아니다 — 화면이 문단으로 그리는 것과 같은 판정이다', async () => {
    const id = await post('> 옮김\n@fizz 이제 내 말이다');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('저장도 인용을 비껴간다 — 인용 안은 @handle 글자로 남고 밖만 <@id> 가 된다', async () => {
    // 저장 정규화(`normalizeMentions`)와 알림 판정이 갈라지면, 본문에 남은 토큰을 나중에
    // 다시 읽는 자리(`mentionedIds`)에서 인용이 되살아난다.
    const id = await post('> @fizz 옮김\n@fizz 부름');
    expect(await storedBody(id)).toBe(`> @fizz 옮김\n<@${fizzId}> 부름`);
  });
});
