import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * 나중에 볼 메시지(#219). 이 파일이 지키는 것은 넷이다.
 *
 * 1. **개인 전용** — 내 큐가 남에게 보이지 않는다. 라우트에 남의 계정을 가리키는 매개변수가
 *    아예 없으므로 유일한 통제선은 모든 쿼리의 `account_id = $1` 필터다. 그 하나가 빠지면
 *    workspace 의 모든 사람이 서로의 큐를 읽는다.
 * 2. **가시성** — 볼 수 없는 채널의 메시지는 담을 수 없다(403). 담긴 뒤에는 목록이 본문을
 *    실어 내주므로, 담기 시점의 이 검사가 곧 private 채널 본문의 유출 경로가 된다.
 * 3. **상태 둘** — `open`/`done` 이 서로 배타적이고, 두 번 담아도 행은 하나다.
 * 4. **삭제된 메시지의 자리** — 행은 남고 **본문은 새지 않는다**(핀의 같은 판단, #218).
 */

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let aPat: string;
let bPat: string;
let publicId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createChannel(token: string, name: string, visibility: 'public' | 'private'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(token), payload: { name, visibility },
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

const save = (token: string, messageId: string) =>
  app.inject({ method: 'PUT', url: `/saved/${messageId}`, headers: auth(token) });

const listSaved = (token: string, state: 'open' | 'done') =>
  app.inject({ method: 'GET', url: `/saved?state=${state}`, headers: auth(token) });

const summary = (token: string) =>
  app.inject({ method: 'GET', url: '/saved/summary', headers: auth(token) });

type Entry = {
  messageId: string; channelId: string; state: 'open' | 'done';
  createdAt: string; doneAt: string | null;
  deleted: boolean; message: { body: string } | null;
};

const entriesOf = (res: { json: () => { entries: Entry[] } }): Entry[] => res.json().entries;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const a = await createAgent(app, adminToken, 'saved-a');
  const b = await createAgent(app, adminToken, 'saved-b');
  aPat = a.pat;
  bPat = b.pat;
  publicId = await createChannel(adminToken, 'saved-public', 'public');
});
afterAll(async () => { await app.close(); await stop(); });

describe('나중에 볼 메시지 (#219)', () => {
  // 1. 개인 전용. 남의 목록에 새면 이 기능은 개인 큐가 아니다.
  it('1. 담으면 내 목록에 나오고 남의 목록에는 없다', async () => {
    const messageId = await post(adminToken, publicId, 'read this later');

    const saved = await save(aPat, messageId);
    expect(saved.statusCode).toBe(200);

    const mine = await listSaved(aPat, 'open');
    expect(mine.statusCode).toBe(200);
    expect(entriesOf(mine).map((e) => e.messageId)).toContain(messageId);

    const theirs = await listSaved(bPat, 'open');
    expect(theirs.statusCode).toBe(200);
    expect(entriesOf(theirs).map((e) => e.messageId)).not.toContain(messageId);
    // 요약(사이드바 배지·메뉴 문구)도 같은 경계를 지켜야 한다 — 개수만 새도 남의 큐 크기가 샌다.
    expect((await summary(bPat)).json().messageIds as string[]).not.toContain(messageId);
  });

  // 2. 가시성. 여기서 새면 private 채널의 본문이 목록을 통해 그대로 나간다.
  it('2. 볼 수 없는 채널의 메시지는 403 이고 행이 남지 않는다', async () => {
    const privateId = await createChannel(adminToken, 'saved-private', 'private');
    const secret = await post(adminToken, privateId, 'sekrit token 7c2f');

    const refused = await save(bPat, secret);
    expect(refused.statusCode).toBe(403);

    const after = await listSaved(bPat, 'open');
    expect(entriesOf(after).map((e) => e.messageId)).not.toContain(secret);
    // 본문이 어디로도 새지 않았는지 응답 전체로 확인한다.
    expect(after.body).not.toContain('sekrit token 7c2f');
    expect(refused.body).not.toContain('sekrit token 7c2f');
  });

  // 3. 상태 둘. `open` 과 `done` 이 배타적이어야 '할 것'이 줄어드는 것이 보인다.
  it('3. done 으로 바꾸면 open 목록에서 빠지고 done 목록에 있으며 done_at 이 찍힌다', async () => {
    const messageId = await post(adminToken, publicId, 'finish me');
    await save(aPat, messageId);

    const patched = await app.inject({
      method: 'PATCH', url: `/saved/${messageId}`, headers: auth(aPat), payload: { state: 'done' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().state).toBe('done');
    expect(patched.json().doneAt).not.toBeNull();

    expect(entriesOf(await listSaved(aPat, 'open')).map((e) => e.messageId)).not.toContain(messageId);
    const done = entriesOf(await listSaved(aPat, 'done')).find((e) => e.messageId === messageId);
    expect(done).toBeDefined();
    expect(done!.doneAt).not.toBeNull();
  });

  // 4. 삭제된 메시지. 담아 둔 사실은 내 기록이므로 자리는 남는다 — **본문은 남지 않는다**.
  it('4. 삭제된 메시지가 목록에 남지만 본문은 새지 않는다', async () => {
    const messageId = await post(adminToken, publicId, 'leaky secret 9f3a');
    await save(aPat, messageId);

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${publicId}/messages/${messageId}`, headers: auth(adminToken),
    });
    expect(deleted.statusCode).toBe(204);

    const list = await listSaved(aPat, 'open');
    const row = entriesOf(list).find((e) => e.messageId === messageId);
    expect(row).toBeDefined();
    expect(row!.deleted).toBe(true);
    // 옵셔널이 아니라 명시적 null 이다 — 키가 사라지면 '아직 안 받았다'와 구분되지 않는다.
    expect(row!.message).toBeNull();
    expect('message' in row!).toBe(true);
    expect(list.body).not.toContain('leaky secret 9f3a');
  });

  // 5. 두 번 담아도 행은 하나. `done` 이던 것은 `open` 으로 돌아온다.
  it('5. 두 번 담아도 행은 하나이고 done 이던 것이 open 으로 돌아온다', async () => {
    const messageId = await post(adminToken, publicId, 'save me twice');
    await save(aPat, messageId);
    await app.inject({
      method: 'PATCH', url: `/saved/${messageId}`, headers: auth(aPat), payload: { state: 'done' },
    });

    const again = await save(aPat, messageId);
    expect(again.statusCode).toBe(200);
    expect(again.json().state).toBe('open');
    expect(again.json().doneAt).toBeNull();

    const open = entriesOf(await listSaved(aPat, 'open')).filter((e) => e.messageId === messageId);
    expect(open).toHaveLength(1);
    expect(entriesOf(await listSaved(aPat, 'done')).map((e) => e.messageId)).not.toContain(messageId);
  });

  // 6. 요약이 사이드바 배지의 근거다. open 개수여야 한다 — done 까지 세면 다 처리한 뒤에도
  //    숫자가 남아 할 일이 있다고 거짓을 말한다.
  it('6. 요약의 openCount 는 open 개수이고 messageIds 는 done 까지 담는다', async () => {
    const c = await createAgent(app, adminToken, 'saved-c');
    const one = await post(adminToken, publicId, 'summary one');
    const two = await post(adminToken, publicId, 'summary two');
    await save(c.pat, one);
    await save(c.pat, two);
    await app.inject({
      method: 'PATCH', url: `/saved/${two}`, headers: auth(c.pat), payload: { state: 'done' },
    });

    const res = await summary(c.pat);
    expect(res.statusCode).toBe(200);
    expect(res.json().openCount).toBe(1);
    expect((res.json().messageIds as string[]).sort()).toEqual([one, two].sort());
  });

  // 7. 담기 해제. 지운 뒤에는 어느 탭에도 없다.
  it('7. 담기 해제하면 목록과 요약에서 함께 빠진다', async () => {
    const messageId = await post(adminToken, publicId, 'unsave me');
    await save(aPat, messageId);

    const removed = await app.inject({
      method: 'DELETE', url: `/saved/${messageId}`, headers: auth(aPat),
    });
    expect(removed.statusCode).toBe(204);

    expect(entriesOf(await listSaved(aPat, 'open')).map((e) => e.messageId)).not.toContain(messageId);
    expect((await summary(aPat)).json().messageIds as string[]).not.toContain(messageId);

    // 담기지 않은 것을 다시 지우면 404 다 — 조용히 204 로 답하면 '지웠다'와 '없었다'가 같아진다.
    const twice = await app.inject({ method: 'DELETE', url: `/saved/${messageId}`, headers: auth(aPat) });
    expect(twice.statusCode).toBe(404);
  });

  // 8. 없는 메시지와 볼 수 없는 메시지는 **다른 답**이다. 둘을 한 코드로 묶으면 403 결정이
  //    사라지고, 담기 실패의 이유를 화면이 말할 수 없다.
  it('8. 없는 메시지는 404, 볼 수 없는 메시지는 403 이다', async () => {
    const missing = await save(aPat, '00000000-0000-4000-8000-000000000000');
    expect(missing.statusCode).toBe(404);

    const privateId = await createChannel(adminToken, 'saved-private-2', 'private');
    const hidden = await post(adminToken, privateId, 'not for you');
    expect((await save(bPat, hidden)).statusCode).toBe(403);
  });

  // 9. public 채널은 **비멤버도 볼 수 있다**(`channelVisibleSql`). 담기가 멤버십을 따로
  //    요구하면 public 채널의 메시지를 아무도 담을 수 없게 된다.
  it('9. public 채널의 비멤버도 담을 수 있다', async () => {
    const d = await createAgent(app, adminToken, 'saved-d');
    const messageId = await post(adminToken, publicId, 'public and savable');

    const members = await app.inject({
      method: 'GET', url: `/channels/${publicId}/members`, headers: auth(adminToken),
    });
    const memberIds = (members.json().members as { accountId: string }[]).map((m) => m.accountId);
    expect(memberIds).not.toContain(d.accountId);

    expect((await save(d.pat, messageId)).statusCode).toBe(200);
  });

  /**
   * #155 의 채널 삭제는 `channel`·`message` 를 참조하는 테이블을 **명시적으로** 지운다
   * (cascade 를 스키마에 박지 않는 것이 그쪽의 결정이다). `saved_message` 가 그 목록에
   * 빠지면 담아 둔 행이 하나라도 있는 채널의 삭제가 FK 위반으로 터진다 — 그때는 이미
   * 운영 중이다. `channelDelete.test.ts` 의 스키마 열거 테스트가 이것을 잡아냈다.
   *
   * 메시지 삭제와 다른 결정인 이유: 메시지 삭제는 "삭제됨" 자리를 남기지만(결정 3),
   * 채널 삭제는 그 채널이 있었다는 사실 자체를 지운다.
   */
  it('10. 담아 둔 행이 있는 채널도 삭제된다 — 자리는 함께 사라진다', async () => {
    const doomedId = await createChannel(adminToken, 'saved-doomed', 'public');
    const messageId = await post(adminToken, doomedId, 'about to vanish');
    expect((await save(aPat, messageId)).statusCode).toBe(200);

    await app.inject({
      method: 'PATCH', url: `/channels/${doomedId}`, headers: auth(adminToken),
      payload: { archived: true },
    });
    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${doomedId}`, headers: auth(adminToken),
    });
    expect(deleted.statusCode).toBe(204);

    expect(entriesOf(await listSaved(aPat, 'open')).map((e) => e.messageId)).not.toContain(messageId);
    expect((await summary(aPat)).json().messageIds as string[]).not.toContain(messageId);
  });
});
