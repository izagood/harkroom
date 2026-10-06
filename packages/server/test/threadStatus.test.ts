// 스레드 상태 리액션(D안) — 서버가 사실을 모아 루트에 **하나만** 단다.
// 판정 규칙 자체는 shared/test/threadStatus.test.ts 가 지킨다. 여기서는 **사실을 제대로 모으는가**,
// **바뀔 때 이전 것이 떼어지는가**(덮어쓰기), **사람 리액션과 섞이지 않는가**, **목록·이벤트에 실리는가**.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AskMeta, FailureMeta } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { listMessages, postMessage } from '../src/services/messages.js';
import { refreshThreadStatus, startThreadStatusWatcher } from '../src/services/threadStatus.js';
import { listSavedMessages } from '../src/services/savedMessages.js';
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

  it('account_gate 실패는 🙋 로 읽고, 목록 행에 차례 주인을 싣고, 에이전트가 다시 말하면 풀린다', async () => {
    const id = await seed(adminId, '부탁');
    const gate: FailureMeta = {
      kind: 'failure',
      failure: { retryable: false, what: '계정 설정 확인 대기', code: 'account_gate', awaitingAccountId: adminId, account: 'work/acct-1' },
    };
    await seed(botId, '관문', { root: id, meta: gate });
    expect(await refreshThreadStatus(pool, id, live()))
      .toMatchObject({ status: 'my-turn', emoji: '🙋', accountId: botId, reason: '계정 설정 확인 대기' });
    const rowOf = async () => (await listMessages(pool, channelId, { limit: 200 })).find((m) => m.id === id)!;
    expect((await rowOf()).openGateAccountIds).toEqual([adminId]);

    // 같은 에이전트가 다시 말하면 실패가 풀린다 — 내 차례에서도 빠진다.
    await seed(botId, '이어서 했다', { root: id });
    expect(await refreshThreadStatus(pool, id, live())).toMatchObject({ status: 'done' });
    expect((await rowOf()).openGateAccountIds).toEqual([]);
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

  it('저장 목록 — private 채널에서 빠진 뒤에는 상태 이유도 본문도 안 실린다(#1030 F1·N2), 행은 남는다', async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const { token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'statusleaver');
    const priv = (await app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'status-private', visibility: 'private' } })).json().id as string;
    const add = await app.inject({ method: 'POST', url: `/channels/${priv}/members`, headers: auth, payload: { accountId: memberId } });
    expect(add.statusCode).toBeLessThan(300);
    const posted = await postMessage(pool, { channelId: priv, authorId: adminId, body: '비밀 부탁', threadRootId: null, meta: {} } as Parameters<typeof postMessage>[1]);
    const id = (posted as { message: { id: string } }).message.id;
    const save = await app.inject({ method: 'PUT', url: `/saved/${id}`, headers: { authorization: `Bearer ${memberToken}` } });
    expect(save.statusCode).toBeLessThan(300);

    // 멤버일 때는 실린다 — 시험의 이빨: 아래 null 이 '원래 안 실려서'가 아님을 보인다.
    await postMessage(pool, { channelId: priv, authorId: botId, body: '물음', threadRootId: id, meta: ask({ kind: 'human' }, '비밀 물음') as unknown as Record<string, unknown> } as Parameters<typeof postMessage>[1]);
    await refreshThreadStatus(pool, id, live());
    const before = await listSavedMessages(pool, memberId, 'open');
    expect(before.find((r) => r.messageId === id)?.message?.statusReaction?.reason).toBe('비밀 물음');

    const del = await app.inject({ method: 'DELETE', url: `/channels/${priv}/members/${memberId}`, headers: auth });
    expect(del.statusCode).toBeLessThan(300);
    await postMessage(pool, { channelId: priv, authorId: botId, body: '실패', threadRootId: id, meta: failure as unknown as Record<string, unknown> } as Parameters<typeof postMessage>[1]);
    await refreshThreadStatus(pool, id, live());

    const after = (await listSavedMessages(pool, memberId, 'open')).find((r) => r.messageId === id);
    expect(after).toBeDefined();          // 행은 남는다 — 사람이 지울 길
    expect(after!.message).toBeNull();     // 본문(N2)과 statusReaction(F1) 둘 다 없다
    expect(after!.deleted).toBe(false);
    const res = await app.inject({ method: 'GET', url: '/saved?state=open', headers: { authorization: `Bearer ${memberToken}` } });
    expect(JSON.stringify(res.json())).not.toContain('비밀');
    expect(JSON.stringify(res.json())).not.toContain('MCP 인증 필요');
  });

  it('같은 루트의 판정은 겹쳐 돌지 않는다(#1030 N1) — 몰려온 요청이 끝나면 마지막 사실로 맞는다', async () => {
    const presence = { online: () => [botId, bot2Id] } as unknown as Parameters<typeof startThreadStatusWatcher>[1];
    let concurrent = 0; let peak = 0;
    const realQuery = pool.query.bind(pool);
    const spy = { ...pool, query: async (...a: unknown[]) => {
      const sql = String(a[0]);
      if (!sql.includes('human_ask')) return (realQuery as (...x: unknown[]) => unknown)(...a);
      concurrent++; peak = Math.max(peak, concurrent);
      try { await new Promise((r) => setTimeout(r, 30)); return await (realQuery as (...x: unknown[]) => unknown)(...a); } finally { concurrent--; }
    } } as unknown as Pool;
    const w = startThreadStatusWatcher(spy, presence, { debounceMs: 0 });
    try {
      const id = await seed(adminId, '부탁');
      await seed(botId, '시작', { root: id, kind: 'progress' });
      const row = { id, threadRootId: null } as unknown as import('@harkroom/shared').MessageRow;
      const { emitEvent } = await import('../src/events.js');
      for (let i = 0; i < 5; i++) {
        emitEvent({ type: 'message.updated', message: row, audience: 'all' });
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 10));
      await w.flush();
      expect(peak).toBe(1);
      expect((await rows(id)).map((r) => r.emoji)).toEqual(['💬']);
    } finally { w.stop(); }
  });
});
