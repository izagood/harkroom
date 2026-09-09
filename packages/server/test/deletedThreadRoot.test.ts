import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { onEvent } from '../src/events.js';

/**
 * 스레드를 시작한 말을 지웠을 때(2026-09-09 신고). 지금까지는 그 한 행만 사라졌고,
 * 답글은 살아 있는데 목록에 머리가 없어서 채널에서는 스레드가 통째로 없어진 것처럼
 * 보였다 — 안에 남은 히스토리로 들어갈 문이 사라졌다.
 *
 * 규칙은 하나다: **답글이 남아 있으면 자리표시자로 남고, 없으면 그냥 지워진다.**
 * 그 자리표시자에는 본문·첨부·리액션·meta 가 실리지 않는다 — 화면만 가리는 것으로는
 * API·에이전트 프롬프트에 그대로 남기 때문이다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let token: string;
let accountId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token, accountId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${token}` },
    payload: { name: 'deleted-root' },
  });
  channelId = ch.json().id as string;
});

afterAll(async () => { await app.close(); await stop(); });

const post = (body: string, extra: object = {}) =>
  app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${token}` }, payload: { body, ...extra },
  });

/**
 * 진행·대기는 REST 로 못 올린다(그 경로에 `kind` 가 없다) — 러너가 MCP 로 올리는 것들이다.
 * 여기서 재는 것은 **자리표시자가 서는지**이므로 서비스로 바로 넣는다.
 */
const postKind = (body: string, kind: 'progress' | 'wake', threadRootId: string) =>
  postMessage(pool, { channelId, authorId: accountId, body, threadRootId, kind, attachmentIds: [] });

const del = (messageId: string) =>
  app.inject({
    method: 'DELETE', url: `/channels/${channelId}/messages/${messageId}`,
    headers: { authorization: `Bearer ${token}` },
  });

const list = async (thread?: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/channels/${channelId}/messages${thread ? `?thread=${thread}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json().messages as { id: string; body: string; deletedAt: string | null; replyCount: number | null }[];
};

describe('지워진 스레드 머리', () => {
  it('답글이 남아 있으면 자리표시자로 남는다 — 본문 없이, 답글 수와 함께', async () => {
    const root = (await post('root that will be deleted')).json().id as string;
    await post('a reply that must survive', { threadRootId: root });

    const res = await del(root);
    // 204 가 아니라 200 이다: 자리가 남았으므로 부른 쪽이 덮을 행이 있다.
    expect(res.statusCode).toBe(200);
    expect(res.json().deletedAt).not.toBeNull();
    expect(res.json().body).toBe('');

    const channel = await list();
    const kept = channel.find((m) => m.id === root);
    expect(kept).toBeDefined();
    expect(kept!.body).toBe('');
    expect(kept!.deletedAt).not.toBeNull();
    // 답글 집계는 남는다 — 그것이 이 행에 남긴 유일한 컨트롤(스레드로 들어가는 문)의 재료다.
    expect(kept!.replyCount).toBe(1);

    // 스레드를 열면 히스토리가 그대로다.
    const thread = await list(root);
    expect(thread.map((m) => m.body)).toEqual(['', 'a reply that must survive']);
  });

  it('답글이 없으면 그냥 사라진다 — 자리표시자를 남기지 않는다', async () => {
    const lonely = (await post('nobody replied to this')).json().id as string;

    const res = await del(lonely);
    expect(res.statusCode).toBe(204);
    expect((await list()).some((m) => m.id === lonely)).toBe(false);
  });

  it('마지막 답글까지 지우면 자리표시자도 함께 사라진다', async () => {
    const root = (await post('root')).json().id as string;
    const reply = (await post('only reply', { threadRootId: root })).json().id as string;

    await del(root);
    expect((await list()).some((m) => m.id === root)).toBe(true);

    await del(reply);
    expect((await list()).some((m) => m.id === root)).toBe(false);
  });

  it('답글 자신은 자리표시자로 남지 않는다', async () => {
    const root = (await post('root stays alive')).json().id as string;
    const reply = (await post('a reply to delete', { threadRootId: root })).json().id as string;

    expect((await del(reply)).statusCode).toBe(204);
    expect((await list(root)).some((m) => m.id === reply)).toBe(false);
  });

  it('자리표시자에는 첨부·리액션·meta 가 실리지 않는다', async () => {
    const root = (await post('root with an unanswered ask', {
      meta: { kind: 'ask', ask: { to: { kind: 'human' }, options: [{ id: 'y', label: 'yes' }] } },
    })).json().id as string;
    await post('reply', { threadRootId: root });
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${root}/reactions`,
      headers: { authorization: `Bearer ${token}` }, payload: { emoji: '👍' },
    });

    await del(root);
    const kept = (await list()).find((m) => m.id === root) as unknown as {
      meta: Record<string, unknown>; reactions: unknown[]; attachments: unknown[];
    };
    // 지운 머리에 미답 물음이 남으면 그 스레드는 영원히 누군가를 기다리는 것으로 보인다.
    expect(kept.meta).toEqual({});
    expect(kept.reactions).toEqual([]);
    expect(kept.attachments).toEqual([]);
  });

  /**
   * 자리표시자가 **답글로 세지 않는 것 위에는 서지 않는다**(2026-09-09 후속 신고).
   *
   * 위의 규칙("답글이 남아 있으면 남는다")에서 '답글'이 살아 있는 자식 아무거나였다.
   * 그래서 접힌 진행 줄만 남은 머리가 `채팅이 삭제되었습니다` 로 계속 서 있었고, 눌러
   * 들어가면 말풍선이 하나도 없었다 — 신고자의 말: *"답글이 아니라 접혀진 작업 내역이야
   * … 이럴때는 채팅 자체가 삭제되는게 맞아."*
   *
   * 자리표시자의 존재 이유가 **살아 있는 답글로 들어갈 문**이었으므로, 들어갈 답글이
   * 없으면 문도 없다.
   */
  it('진행만 남은 머리는 자리표시자를 남기지 않는다 — 그냥 사라진다', async () => {
    const root = (await post('root whose only children are progress rows')).json().id as string;
    await postKind('보는 중', 'progress', root);
    await postKind('5분 뒤 다시', 'wake', root);

    // 204 다: 자리가 남지 않았으므로 부른 쪽이 덮을 행이 없다.
    expect((await del(root)).statusCode).toBe(204);
    expect((await list()).some((m) => m.id === root)).toBe(false);
  });

  it('진행이 섞여 있어도 답글이 하나라도 살아 있으면 남는다', async () => {
    const root = (await post('root with progress and a real reply')).json().id as string;
    await postKind('보는 중', 'progress', root);
    await post('a real reply', { threadRootId: root });

    expect((await del(root)).statusCode).toBe(200);
    const kept = (await list()).find((m) => m.id === root);
    expect(kept).toBeDefined();
    // 답글 수는 진행을 세지 않는다(#687) — 자리를 세운 것은 그 하나뿐이다.
    expect(kept!.replyCount).toBe(1);
  });

  it('마지막 답글을 지우면 진행이 남아 있어도 머리가 함께 사라진다', async () => {
    const root = (await post('root')).json().id as string;
    await postKind('보는 중', 'progress', root);
    const reply = (await post('only real reply', { threadRootId: root })).json().id as string;

    await del(root);
    expect((await list()).some((m) => m.id === root)).toBe(true);

    // 진행 두 줄이 남아 있지만 답글은 없다 — 문을 세울 이유가 사라진다.
    await del(reply);
    expect((await list()).some((m) => m.id === root)).toBe(false);
  });

  /**
   * 사라진 머리는 **결과가 다시 달리면 돌아온다.** 도는 턴은 지워진 스레드에도 계속
   * 발화할 수 있으므로(진행만 남긴 그 턴이다) 이 경로가 실제로 생긴다 — 돌아오지 않으면
   * 답은 도착했는데 채널에 머리가 없어 그 답이 어디에도 그려지지 않는다.
   */
  it('사라진 머리에 결과가 달리면 자리표시자가 돌아온다', async () => {
    const root = (await post('root that comes back')).json().id as string;
    await postKind('보는 중', 'progress', root);
    await del(root);
    expect((await list()).some((m) => m.id === root)).toBe(false);

    await post('the turn finally answered', { threadRootId: root });
    const back = (await list()).find((m) => m.id === root);
    expect(back).toBeDefined();
    expect(back!.deletedAt).not.toBeNull();
    expect(back!.body).toBe('');
    expect(back!.replyCount).toBe(1);
    // 스레드를 열면 그 사이의 작업 내역도 함께 보인다 — 진행 행을 지우지는 않았다.
    expect((await list(root)).map((m) => m.body)).toEqual(['', '보는 중', 'the turn finally answered']);
  });

  it('사라진 머리에 진행만 더 달려도 돌아오지 않는다', async () => {
    const root = (await post('root that stays gone')).json().id as string;
    await postKind('보는 중', 'progress', root);
    await del(root);

    await postKind('아직 보는 중', 'progress', root);
    expect((await list()).some((m) => m.id === root)).toBe(false);
  });

  /**
   * 돌아오는 것을 **이벤트로도** 알린다 — 다시 받아올 때까지 기다리면 그동안 답이 채널에
   * 없다. 두 가지가 규칙이다:
   *
   * ① `message.created` 가 아니라 `message.updated` 다. 이 머리는 이미 있던 행이 다시
   *    보이게 된 것이라, `created` 로 내면 몇 시간 전에 지운 말이 방금 온 말로 보인다.
   * ② **답 뒤에** 나간다. 먼저 내면 화면에 머리가 생기고, 뒤이어 오는 `message.created`
   *    가 답글 수를 하나 더 올린다(서버가 준 행에는 이 답이 이미 세어져 있다).
   */
  it('돌아온 머리는 답 뒤에 message.updated 로 나간다', async () => {
    const root = (await post('root announced back')).json().id as string;
    await postKind('보는 중', 'progress', root);
    await del(root);

    const seen: string[] = [];
    const off = onEvent((e) => {
      if (e.type === 'message.created' && e.message.threadRootId === root) seen.push('created:reply');
      if (e.type === 'message.updated' && e.message.id === root) seen.push(`updated:root:${e.message.replyCount}`);
    });
    try {
      await post('the answer', { threadRootId: root });
    } finally {
      off();
    }
    expect(seen).toEqual(['created:reply', 'updated:root:1']);
  });

  it('링크·검색에서는 여전히 없는 메시지다 — 자리표시자는 목록에만 있다', async () => {
    const root = (await post('findable-tombstone-word')).json().id as string;
    await post('reply keeps the root visible in lists', { threadRootId: root });
    await del(root);

    const byId = await app.inject({
      method: 'GET', url: `/messages/${root}`, headers: { authorization: `Bearer ${token}` },
    });
    expect(byId.statusCode).toBe(404);

    const search = await app.inject({
      method: 'GET', url: '/search?q=findable-tombstone-word',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.stringify(search.json())).not.toContain(root);
  });

  it('본문은 데이터베이스에도 남지 않는가 — 남는다(소프트 삭제 그대로), 다만 API 로는 안 나간다', async () => {
    const root = (await post('soft deleted body')).json().id as string;
    await post('reply', { threadRootId: root });
    await del(root);
    const row = await pool.query('select body, deleted_at from message where id = $1', [root]);
    // 소프트 삭제는 이 작업이 바꾸지 않았다는 사실을 적어 둔다 — 바뀐 것은 **목록 조건**과
    // **내주는 컬럼**이고, 행 자체는 예전처럼 deleted_at 만 찍힌다.
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(row.rows[0].body).toBe('soft deleted body');
  });
});
