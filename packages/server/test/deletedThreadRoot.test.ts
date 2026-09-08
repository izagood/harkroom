import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

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
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token } = await bootstrapAdmin(app));
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
