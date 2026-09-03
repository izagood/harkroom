import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * 코드 블록 안 `@handle` 은 알림을 만들지 않는다(#298).
 *
 * **이 회귀선은 서버를 통과한다 — 순수 함수를 부르지 않는다.** `mentionedHandles` 만 단언하면
 * `services/messages.ts` 가 자기 정규식을 다시 적어도 전부 초록이다(그것이 #298 이 없애려는
 * 두 벌짜리 판정 그 자체다). 그래서 여기서는 실제로 메시지를 올리고 **inbox 행을 센다.**
 *
 * 화면과의 대조(요구 4·6)는 `MessageBody` 를 실제로 렌더해야 하므로 데스크탑에 있다:
 * `packages/desktop/test/codeBlockMention.test.tsx`.
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
    payload: { name: 'codetalk', visibility: 'public' },
  });
  expect(chan.statusCode).toBe(201);
  channelId = chan.json().id as string;

  // 코드 안의 그룹 handle 이 확장되지 않는지 보려면 확장될 수 있는 집합이 실제로 있어야 한다.
  const group = await app.inject({
    method: 'POST', url: '/handle-groups', headers: auth(adminToken),
    payload: { handle: 'codeteam', displayName: 'Code Team' },
  });
  expect(group.statusCode).toBe(201);
  const members = await app.inject({
    method: 'POST', url: `/handle-groups/${group.json().id}/members`,
    headers: auth(adminToken), payload: { accountIds: [teamMemberId] },
  });
  expect(members.statusCode).toBe(200);
});
afterAll(async () => { await app.close(); await stop(); });

describe('코드 블록 안 멘션은 알림을 만들지 않는다 (#298)', () => {
  it('펜스 코드 블록 안의 @handle 은 inbox 에 행을 남기지 않는다', async () => {
    const id = await post('이렇게 쓰면 돼\n```\n@fizz 를 부르는 예시\n```\n끝');
    expect(await inboxFor(fizzPat, id)).toEqual([]);
  });

  it('인라인 코드 안의 @handle 도 행을 남기지 않는다', async () => {
    const id = await post('`@fizz` 라고 적어');
    expect(await inboxFor(fizzPat, id)).toEqual([]);
  });

  it('한 메시지에 코드 안·밖이 같이 있으면 밖의 것만 알린다', async () => {
    // 같은 handle 이므로 "코드 밖이 살아 있다"만 볼 수 있다 — 개수가 아니라 존재를 본다.
    const id = await post('@fizz 이거 봐\n```\n@fizz\n```');
    const rows = await inboxFor(fizzPat, id);
    expect(rows.map((r) => r.reason)).toEqual(['mention']);
  });

  it('코드 밖의 @handle 은 여전히 알림이 간다', async () => {
    const id = await post('@fizz 안녕');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('코드 블록 안의 집합 handle 은 확장되지 않는다', async () => {
    const id = await post('```\n@codeteam 이라고 쓰면 팀을 부른다\n```');
    expect(await inboxFor(teamMemberToken, id)).toEqual([]);
  });

  it('코드 밖의 집합 handle 은 확장된다 — 위 단언이 확장 자체가 죽은 것을 통과시키지 않는다', async () => {
    const id = await post('@codeteam 회의합니다');
    expect((await inboxFor(teamMemberToken, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('닫히지 않은 펜스 뒤의 @handle 은 코드가 아니므로 알림이 간다 — 화면과 같은 판정이다', async () => {
    // `splitCode` 는 닫히지 않은 펜스를 평문으로 둔다(메시지가 통째로 사라지는 것을 막는다).
    // 화면이 칠하는 것을 서버가 알리지 않으면 그것이 바로 #298 이 없앤 거짓말의 반대 방향이다.
    const id = await post('```\n@fizz 닫는 펜스가 없다');
    expect((await inboxFor(fizzPat, id)).map((r) => r.reason)).toEqual(['mention']);
  });

  it('이력은 다시 쓰지 않는다 — 저장된 본문은 그대로다', async () => {
    const body = '```\n@fizz\n```';
    const id = await post(body);
    const read = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
    });
    expect(read.statusCode).toBe(200);
    const found = (read.json().messages as Array<{ id: string; body: string }>).find((m) => m.id === id);
    expect(found?.body).toBe(body);
  });
});
