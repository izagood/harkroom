// 인박스 줄이 **네 가지를 말할 재료**(#488 C2 1/2).
//
// 문서의 진단: *"지금 네 줄이 글자 하나까지 똑같다 — `스레드 답글 #general` 넷.
// 누가 무엇을 원하는지, 언제인지, 어느 스레드인지 아무것도 없다."*
//
// 원인은 화면이 게을러서가 아니라 **재료가 없어서**다. `InboxEntry` 가 id 넷만 실었고,
// 말의 종류를 담은 `reason` 은 값이 셋뿐이라(`mention`·`thread_reply`·`dm`) 무엇을
// 그려도 줄이 갈리지 않는다.
//
// 문서는 이 화면을 *"말의 종류가 `meta` 에 들어간 다음 제 모습이 된다"* 고 적었다.
// **그 문턱은 이미 넘었다**(`AskMeta`·`FailureMeta`·`ReportMeta`) — 여기서 하는 일은
// 그 사실을 인박스까지 **나르는 것**이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AskMeta } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listInbox, postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: botId } = await createAgent(app, adminToken, 'inboxbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'inbox-mat' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

/** admin 을 부르는 말 하나. 인박스에 항목이 생긴다. */
async function callAdmin(body: string, meta: object = {}, threadRootId: string | null = null) {
  const posted = await postMessage(pool, {
    channelId, authorId: botId, body, threadRootId,
    meta: meta as Record<string, unknown>,
  });
  return (posted as { message: { id: string } }).message.id;
}

const ask = (): AskMeta => ({
  kind: 'ask',
  ask: {
    options: [{ id: 'a', label: '이대로' }, { id: 'b', label: '다시' }],
    to: { kind: 'account', accountId: '' },
  },
});

async function inboxOf(): Promise<Awaited<ReturnType<typeof listInbox>>> {
  return listInbox(pool, adminId, {});
}

describe('줄이 네 가지를 말할 재료', () => {
  it('누가 · 무엇을 · 언제 · 어디가 함께 온다', async () => {
    const id = await callAdmin(`@admin 이것 좀 봐 ${Date.now()}`);
    const row = (await inboxOf()).find((e) => e.messageId === id);
    expect(row).toBeDefined();

    // 누가 — 얼굴을 그릴 수 있어야 한다.
    expect(row!.authorId).toBe(botId);
    // 무엇을 — 본문 한 줄. 서버가 자르지 않는다(자르는 폭은 화면이 안다).
    expect(row!.body).toContain('이것 좀 봐');
    // 언제 — 인박스 항목이 아니라 그 **말이 오간** 시각이다.
    expect(Number.isNaN(Date.parse(row!.createdAt))).toBe(false);
    // 어디 — 채널 바로 밑이면 threadRootId 는 null 이다.
    expect(row!.threadRootId).toBeNull();
    expect(row!.channelId).toBe(channelId);
  });

  /**
   * **말의 종류는 `meta` 가 답한다.** `reason` 은 셋뿐이라 되물음·선택·보고·넘김을
   * 구별하지 못한다 — 그것이 네 줄을 같게 만든 원인이다.
   */
  it('말의 종류를 담은 meta 가 그대로 실린다', async () => {
    const id = await callAdmin(`@admin 골라 줘 ${Date.now()}`, ask());
    const row = (await inboxOf()).find((e) => e.messageId === id);
    expect((row!.meta as { kind?: string }).kind).toBe('ask');
  });

  /** 모르는 `meta` 는 평문으로 흐른다 — 이 저장소의 불변 규약이다. */
  it('모르는 meta 도 그대로 나른다 — 서버가 걸러 내지 않는다', async () => {
    const id = await callAdmin(`@admin 새 어휘 ${Date.now()}`, { kind: 'not-yet-known' });
    const row = (await inboxOf()).find((e) => e.messageId === id);
    expect((row!.meta as { kind?: string }).kind).toBe('not-yet-known');
  });

  it('스레드 안이면 그 뿌리를 말한다 — 어디로 갈지가 줄에 있어야 한다', async () => {
    const rootId = await callAdmin(`뿌리 ${Date.now()}`);
    const replyId = await callAdmin(`@admin 답글에서 부른다 ${Date.now()}`, {}, rootId);
    const row = (await inboxOf()).find((e) => e.messageId === replyId);
    expect(row!.threadRootId).toBe(rootId);
  });
});

describe('지워진 말은 인박스에도 없다', () => {
  /**
   * **본문을 싣기 시작했으므로 생긴 규칙이다.** 전에는 id 만 실어 지워진 말이 인박스에
   * 남아도 화면에 아무것도 안 보였다. 이제 본문이 실리므로 그대로 두면 **지운 글이
   * 인박스 줄에 그대로 보인다.**
   */
  it('지운 말은 목록에서 빠진다', async () => {
    const id = await callAdmin(`@admin 곧 지울 말 ${Date.now()}`);
    expect((await inboxOf()).some((e) => e.messageId === id)).toBe(true);

    await pool.query('update message set deleted_at = now() where id = $1', [id]);
    expect((await inboxOf()).some((e) => e.messageId === id)).toBe(false);
  });
});
