// Task 6 Step 2 · Task 8 Step 2 — 서버가 스레드 상태의 **재료**를 실어 준다.
//
// 이 파일이 지키는 것은 판정이 아니라 **사실**이다. 판정(5단)은 화면의 순수 함수
// `threadState()` 가 하고 그 테스트는 데스크탑에 있다 — 여기서 상태 이름을 검사하면 같은
// 판정이 두 벌이 되고, 이 작업이 피하려던 바로 그 중복이 테스트에까지 번진다.
//
// **왜 이 재료가 필요한가:** 답글은 스레드를 열 때만 로드되므로(`controller.openThread`)
// 채널 목록에는 루트만 있다. 그 상태로 판정을 걸면 **열어 보지 않은 스레드가 전부
// '끝남'으로 보인다.** 아래 테스트들은 그 거짓말이 다시 생기지 않게 못을 박는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER, type AskMeta, type FailureMeta } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages, postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botPat: string;
let botId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: botPat, accountId: botId } = await createAgent(app, adminToken, 'statebot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'thread-state' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const post = (token: string, body: string, extra: object = {}) =>
  app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token),
    payload: { body, ...extra },
  });

/** 루트를 하나 세운다. 반환은 그 id. */
async function root(body = 'root'): Promise<string> {
  return (await post(adminToken, body)).json().id as string;
}

/**
 * `meta` 를 실은 메시지를 심는다. 도구(MCP)를 거치지 않고 서비스로 직접 넣어 이 파일이
 * MCP 계약에 묶이지 않게 한다 — `askAnswer.test.ts` 의 선례다.
 */
async function seed(
  authorId: string, body: string, meta: object, threadRootId: string | null = null,
): Promise<string> {
  const posted = await postMessage(pool, {
    channelId, authorId, body, threadRootId,
    meta: meta as Record<string, unknown>,
  });
  return (posted as { message: { id: string } }).message.id;
}

const ask = (to: AskMeta['ask']['to'], answeredWith?: string): AskMeta => ({
  kind: 'ask',
  ask: {
    options: [{ id: 'a', label: '가' }, { id: 'b', label: '나' }],
    to, ...(answeredWith ? { answeredWith } : {}),
  },
});

const failure: FailureMeta = { kind: 'failure', failure: { retryable: true } };

/** 채널 목록에서 그 루트 한 줄을 집는다 — **화면이 실제로 보는 경로**다. */
async function rootRow(id: string) {
  const rows = await listMessages(pool, channelId, { limit: 200 });
  const found = rows.find((m) => m.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe('스레드 상태 재료 — 채널 목록이 루트만 봐도 상태를 알 수 있다', () => {
  it('아무 일도 없는 스레드는 재료가 전부 비어 있다', async () => {
    const id = await root('조용한 루트');
    const r = await rootRow(id);
    expect(r.openAskHumanCount).toBe(0);
    expect(r.openAskAccountIds).toEqual([]);
    expect(r.failureCount).toBe(0);
    // 마지막 말은 루트 자신이다 — 답글이 없어도 `lastKind` 는 null 이 아니다.
    expect(r.lastKind).toBe('user');
    expect(r.lastAuthorId).toBe(adminId);
  });

  /**
   * **이 파일의 핵심 케이스다.** 답글이 하나도 없는 루트의 미답 물음 — 채널 목록에 있는 것이
   * 루트뿐이므로, 루트를 세지 않으면 이 스레드는 '끝남'으로 보인다. 계획서가 경계한
   * 그 거짓말이 정확히 여기서 생긴다.
   */
  it('루트 자신의 미답 물음이 세어진다 — 답글이 없어도', async () => {
    const id = await seed(botId, '골라 줘', ask({ kind: 'human' }));
    const r = await rootRow(id);
    expect(r.openAskHumanCount).toBe(1);
    expect(r.openAskAccountIds).toEqual([]);
  });

  it('특정 계정에게 간 미답 물음은 그 수신자를 싣는다', async () => {
    const id = await seed(botId, '네가 골라', ask({ kind: 'account', accountId: adminId }));
    const r = await rootRow(id);
    // '사람 아무나'와 **같은 통에 담지 않는다** — 화면이 "내 차례"를 가르는 분기가 다르다.
    expect(r.openAskHumanCount).toBe(0);
    expect(r.openAskAccountIds).toEqual([adminId]);
  });

  it('답글에 있는 물음도 루트의 재료에 올라온다', async () => {
    const id = await root();
    await seed(botId, '중간에 묻는다', ask({ kind: 'account', accountId: adminId }), id);
    const r = await rootRow(id);
    expect(r.openAskAccountIds).toEqual([adminId]);
  });

  it('답한 물음은 세지 않는다 — 답한 물음은 더 이상 아무도 막지 않는다', async () => {
    const id = await seed(botId, '이미 골랐다', ask({ kind: 'human' }, 'a'));
    const r = await rootRow(id);
    expect(r.openAskHumanCount).toBe(0);
  });

  it('ask-answer 로 답하면 그 즉시 미답에서 빠진다', async () => {
    const id = await seed(botId, '곧 답할 물음', ask({ kind: 'human' }));
    expect((await rootRow(id)).openAskHumanCount).toBe(1);
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'a' },
    });
    expect(res.statusCode).toBe(200);
    expect((await rootRow(id)).openAskHumanCount).toBe(0);
  });

  it('수신자가 여럿이면 중복 없이 모인다', async () => {
    const id = await root();
    await seed(botId, 'admin 에게', ask({ kind: 'account', accountId: adminId }), id);
    await seed(botId, 'admin 에게 또', ask({ kind: 'account', accountId: adminId }), id);
    await seed(adminId, 'bot 에게', ask({ kind: 'account', accountId: botId }), id);
    const r = await rootRow(id);
    expect(r.openAskAccountIds).toHaveLength(2);
    expect(new Set(r.openAskAccountIds)).toEqual(new Set([adminId, botId]));
  });

  it('실패가 세어진다 — 루트에 있든 답글에 있든', async () => {
    const rootWithFailure = await seed(botId, '루트가 실패', failure);
    expect((await rootRow(rootWithFailure)).failureCount).toBe(1);

    const id = await root();
    await seed(botId, '답글이 실패', failure, id);
    expect((await rootRow(id)).failureCount).toBe(1);
  });

  it('마지막 말이 진행이면 그 종류와 저자를 싣는다', async () => {
    const id = await root();
    await post(botPat, '먼저 한 마디', { threadRootId: id });
    await postMessage(pool, {
      channelId, authorId: botId, body: '도는 중', threadRootId: id, kind: 'progress',
    });
    const r = await rootRow(id);
    // 화면은 이 둘에 자기가 아는 생존을 곱해 '도는 중'과 '막힘'을 가른다.
    expect(r.lastKind).toBe('progress');
    expect(r.lastAuthorId).toBe(botId);
  });

  it('진행 뒤에 사람이 말하면 마지막 말이 바뀐다', async () => {
    const id = await root();
    await postMessage(pool, {
      channelId, authorId: botId, body: '도는 중', threadRootId: id, kind: 'progress',
    });
    expect((await rootRow(id)).lastKind).toBe('progress');
    await post(adminToken, '사람이 끼어든다', { threadRootId: id });
    const r = await rootRow(id);
    expect(r.lastKind).toBe('user');
    expect(r.lastAuthorId).toBe(adminId);
  });

  it('지워진 답글은 재료에서 빠진다', async () => {
    const id = await root();
    const askId = await seed(botId, '곧 지울 물음', ask({ kind: 'human' }), id);
    expect((await rootRow(id)).openAskHumanCount).toBe(1);
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${askId}`, headers: auth(adminToken),
    });
    expect((await rootRow(id)).openAskHumanCount).toBe(0);
  });

  /**
   * `replyCount` 와 **같은 규약**이다: 재료는 루트에만 붙는다. 답글에도 붙이면 화면이
   * 한 스레드를 여러 번 세게 되고, 답글 하나가 스레드 전체인 척한다.
   */
  it('답글 행의 재료는 null 이다', async () => {
    const id = await root();
    await seed(botId, '답글', ask({ kind: 'human' }), id);
    const rows = await listMessages(pool, channelId, { threadRootId: id });
    const reply = rows.find((m) => m.threadRootId === id)!;
    expect(reply.openAskHumanCount).toBeNull();
    expect(reply.openAskAccountIds).toBeNull();
    expect(reply.failureCount).toBeNull();
    expect(reply.lastKind).toBeNull();
    expect(reply.lastAuthorId).toBeNull();
  });

  /**
   * 페이지 밖의 답글도 세어야 한다 — 서버가 권위인 이유가 이것이다. 클라이언트는 최근 몇
   * 개만 들고 있으므로, 오래된 물음을 세지 못하면 긴 스레드일수록 상태가 거짓이 된다.
   */
  it('페이지 밖의 오래된 물음도 세어진다 (서버가 권위)', async () => {
    const id = await root();
    await seed(botId, '아주 오래된 물음', ask({ kind: 'human' }), id);
    for (let i = 0; i < 30; i += 1) {
      await post(botPat, `잡담 ${i}`, { threadRootId: id });
    }
    // 채널 목록에는 그 물음이 **한 줄도 실려 있지 않다**(답글이므로). 그런데도 루트의 재료는
    // 그것을 안다 — 이 스레드가 '끝남'이 아님을 화면이 열어 보지 않고 알 수 있는 이유다.
    const r = await rootRow(id);
    expect(r.replyCount).toBe(31);
    expect(r.openAskHumanCount).toBe(1);
  });

  /**
   * 메시지 하나를 내주는 경로(`COLS`)에서는 재료가 null 이다 — 그 자리는 스레드를 요약하는
   * 자리가 아니다. 키 자체는 있어야 화면이 '모른다(null)'와 '키 없음'을 헷갈리지 않는다.
   */
  it('메시지 하나를 내주는 경로에서는 재료가 null 이다', async () => {
    const id = await seed(botId, '링크로 열릴 물음', ask({ kind: 'human' }));
    const res = await app.inject({ method: 'GET', url: `/messages/${id}`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('openAskHumanCount');
    expect(body.openAskHumanCount).toBeNull();
    expect(body.lastKind).toBeNull();
  });
});

/**
 * Task 8 Step 2 — 누구를 불렀는지 부른 사람에게 돌려준다.
 *
 * **헤더인 이유**를 이 테스트가 함께 지킨다: 본문은 `MessageRow` **그 자체**로 남아야 한다.
 * 데스크탑이 이 응답을 그대로 스토어에 넣기 때문에(`controller.ts::send`), 본문에 형제 키가
 * 생기면 WebSocket 으로 오는 같은 메시지와 모양이 갈린다.
 */
describe('POST 응답의 notified — 누구를 불렀는가', () => {
  it('아무도 안 불렀으면 수는 0 이고 명단 헤더는 없다', async () => {
    const res = await post(adminToken, '혼잣말');
    expect(res.statusCode).toBe(201);
    expect(res.headers[NOTIFIED_COUNT_HEADER]).toBe('0');
    // 빈 헤더를 싣지 않는다 — 빈 문자열을 나누면 `['']` 가 되어 없는 사람이 하나 생긴다.
    expect(res.headers[NOTIFIED_HEADER]).toBeUndefined();
  });

  it('멘션한 사람이 명단에 실린다', async () => {
    const res = await post(adminToken, '@statebot 좀 봐 줘');
    expect(res.statusCode).toBe(201);
    expect(res.headers[NOTIFIED_COUNT_HEADER]).toBe('1');
    expect(String(res.headers[NOTIFIED_HEADER]).split(',')).toEqual([botId]);
  });

  it('@channel 은 볼 수 있는 사람 전부를 싣는다 — 부른 사람 자신은 빼고', async () => {
    const res = await post(adminToken, '@channel 모두 보세요');
    expect(res.statusCode).toBe(201);
    const ids = String(res.headers[NOTIFIED_HEADER]).split(',');
    expect(ids).toContain(botId);
    expect(ids).not.toContain(adminId);
    expect(res.headers[NOTIFIED_COUNT_HEADER]).toBe(String(ids.length));
  });

  /**
   * **본문은 한 글자도 넓어지지 않는다.** 이것이 헤더를 고른 이유 그 자체이므로 테스트로
   * 못을 박는다 — 누군가 편해 보인다고 본문에 `notified` 를 얹으면 여기서 걸린다.
   */
  it('본문은 MessageRow 그대로다 — notified 가 새지 않는다', async () => {
    const res = await post(adminToken, '@statebot 본문 오염 검사');
    expect(res.json()).not.toHaveProperty('notified');
  });

  /**
   * 재생(idempotency)은 **헤더 자체가 없다.** `postMessage` 가 재생 경로에서 빈 배열을 주는데
   * 그것은 "이 요청이 새로 부른 사람이 없다"이지 "아무도 안 불렸다"가 아니다 — 첫 요청이 이미
   * 불렀다. 헤더 없음('모른다')과 `0`('없다')을 구분해 두어야 화면이 아는 척하지 않는다.
   */
  it('재생이면 헤더를 아예 싣지 않는다 — 0 과 모름은 다르다', async () => {
    const key = `notified-replay-${Date.now()}`;
    const first = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { ...auth(adminToken), 'idempotency-key': key },
      payload: { body: '@statebot 재시도할 부름' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers[NOTIFIED_COUNT_HEADER]).toBe('1');

    const again = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { ...auth(adminToken), 'idempotency-key': key },
      payload: { body: '@statebot 재시도할 부름' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.headers[NOTIFIED_COUNT_HEADER]).toBeUndefined();
    expect(again.headers[NOTIFIED_HEADER]).toBeUndefined();
  });
});
