// 스레드 상태 리액션(D안) — 서버가 사실을 모아 루트에 **하나만** 단다.
// 판정 규칙 자체는 shared/test/threadStatus.test.ts 가 지킨다. 여기서는 **사실을 제대로 모으는가**,
// **바뀔 때 이전 것이 떼어지는가**(덮어쓰기), **사람 리액션과 섞이지 않는가**, **목록·이벤트에 실리는가**.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AskMeta, FailureMeta } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages, postMessage } from '../src/services/messages.js';
import { refreshThreadStatus } from '../src/services/threadStatus.js';
import { onEvent, type WorkspaceEvent } from '../src/events.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminId: string;
let adminToken: string;
let botId: string;
let bot2Id: string;
let channelId: string;
const live = () => new Set([botId, bot2Id]);

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: botId } = await createAgent(app, adminToken, 'statusbot'));
  ({ accountId: bot2Id } = await createAgent(app, adminToken, 'statusbot2'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'thread-status' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

async function seed(authorId: string, body: string, opts: { meta?: object; root?: string | null; kind?: 'user' | 'progress' } = {}) {
  const posted = await postMessage(pool, {
    channelId, authorId, body, threadRootId: opts.root ?? null,
    meta: (opts.meta ?? {}) as Record<string, unknown>,
    ...(opts.kind ? { kind: opts.kind } : {}),
  } as Parameters<typeof postMessage>[1]);
  return (posted as { message: { id: string } }).message.id;
}
const ask = (to: AskMeta['ask']['to'], prompt = '어느 쪽?'): AskMeta => ({
  kind: 'ask', ask: { options: [{ id: 'a', label: '가' }, { id: 'b', label: '나' }], to, prompt },
});
const failure: FailureMeta = { kind: 'failure', failure: { retryable: true, what: 'MCP 인증 필요' } };
const rows = async (id: string) => (await pool.query(`select * from thread_status where root_id = $1`, [id])).rows;

describe('스레드 상태 리액션', () => {
  it('사람끼리의 스레드에는 달지 않는다', async () => {
    const id = await seed(adminId, '그냥 잡담');
    expect(await refreshThreadStatus(pool, id, live())).toBe('unchanged');
    expect(await rows(id)).toEqual([]);
  });

  it('💬 → 🙋 → ✅ — 루트에 언제나 한 행, 바뀌면 이전 것을 덮는다', async () => {
    const id = await seed(adminId, '부탁');
    await seed(botId, '시작', { root: id, kind: 'progress' });
    expect((await refreshThreadStatus(pool, id, live()) as { emoji: string }).emoji).toBe('💬');

    await seed(botId, '물음', { root: id, meta: ask({ kind: 'human' }) });
    const asked = await refreshThreadStatus(pool, id, live());
    expect(asked).toMatchObject({ status: 'my-turn', emoji: '🙋', accountId: botId, reason: '어느 쪽?' });
    expect(await rows(id)).toHaveLength(1);

    // 같은 상태로 다시 판정하면 쓰지 않는다(이벤트도 안 나간다).
    expect(await refreshThreadStatus(pool, id, live())).toBe('unchanged');

    await pool.query(`update message set meta = jsonb_set(meta, '{ask,answeredWith}', '"a"') where thread_root_id = $1 and meta->>'kind' = 'ask'`, [id]);
    await seed(botId, '끝났다', { root: id });
    expect(await refreshThreadStatus(pool, id, live())).toMatchObject({ status: 'done', emoji: '✅' });
    expect((await rows(id)).map((r) => r.emoji)).toEqual(['✅']);
  });

  it('🚨 안 풀린 실패 — 이유는 fail 의 what, 같은 에이전트가 다시 말하면 풀린다', async () => {
    const id = await seed(adminId, '부탁');
    await seed(botId, '못 했다', { root: id, meta: failure });
    expect(await refreshThreadStatus(pool, id, live())).toMatchObject({ status: 'stuck', emoji: '🚨', reason: 'MCP 인증 필요' });
    await seed(botId, '다시 해 봤다', { root: id });
    expect(await refreshThreadStatus(pool, id, live())).toMatchObject({ status: 'done' });
  });

  it('🚨 마지막 말이 진행인데 러너가 죽었다', async () => {
    const id = await seed(adminId, '부탁');
    await seed(botId, '도는 중', { root: id, kind: 'progress' });
    expect(await refreshThreadStatus(pool, id, new Set())).toMatchObject({ status: 'stuck', accountId: botId });
  });

  it('⏳ 동료 에이전트에게 간 미답 물음', async () => {
    const id = await seed(adminId, '부탁');
    await seed(botId, '확인해 줘', { root: id, meta: ask({ kind: 'account', accountId: bot2Id }) });
    expect(await refreshThreadStatus(pool, id, live())).toMatchObject({ status: 'waiting', emoji: '⏳', accountId: botId, reason: bot2Id });
  });

  it('👀 배달된 멘션에 아직 말이 없다 — 읽음 처리돼도 첫 말 전까지 유지', async () => {
    const id = await seed(adminId, '부탁');
    await pool.query(`insert into inbox (account_id, message_id, reason, read_at) values ($1, $2, 'mention', now())`, [botId, id]);
    expect(await refreshThreadStatus(pool, id, live())).toMatchObject({ status: 'received', emoji: '👀', accountId: botId });
  });

  it('사람 리액션과 따로 실린다 — 목록에 statusReaction, reactions 에는 사람 ✅ 만', async () => {
    const id = await seed(adminId, '부탁');
    await seed(botId, '답', { root: id });
    await refreshThreadStatus(pool, id, live());
    await pool.query(`insert into message_reaction (message_id, account_id, emoji) values ($1, $2, '✅')`, [id, adminId]);
    const row = (await listMessages(pool, channelId, { limit: 200 })).find((m) => m.id === id)!;
    expect(row.statusReaction).toMatchObject({ status: 'done', emoji: '✅', accountId: botId });
    expect(row.reactions).toEqual([{ emoji: '✅', accountIds: [adminId] }]);
  });

  it('REST 로 쓴 말이 버스를 지나 다시 판정되고 thread.status 이벤트가 나간다', async () => {
    const seen: WorkspaceEvent[] = [];
    const off = onEvent((e) => { if (e.type === 'thread.status') seen.push(e); });
    try {
      const id = await seed(adminId, '부탁');
      await seed(botId, '시작', { root: id, kind: 'progress' });
      // 버스를 태우려면 라우트를 지나야 한다(서비스 직접 호출은 이벤트를 안 낸다).
      const res = await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: '어떻게 돼 가?', threadRootId: id },
      });
      expect(res.statusCode).toBeLessThan(300);
      await expect.poll(() => seen.find((e) => e.type === 'thread.status' && e.rootId === id), { timeout: 3000 }).toBeTruthy();
    } finally { off(); }
  });
});
