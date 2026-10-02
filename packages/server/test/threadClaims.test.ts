// (에이전트, 스레드) 턴 임대(마이그레이션 095). 앱 업데이트 때 옛 러너와 새 러너가 겹쳐도 같은 스레드에는
// 턴이 하나만 뜨게 하는 서버 쪽 판정이다. 여기서 재는 것:
//  - 남이 살아 있는 임대를 쥐면 409 이고 아무것도 바뀌지 않는다
//  - 같은 holder 의 재호출은 하트비트다(expires_at 을 민다)
//  - 하트비트가 끊겨 만료되면 다른 러너가 넘겨받고, 늦게 온 옛 holder 의 하트비트는 409 다
//  - 옛 러너가 놓으면(종료) 곧바로 넘겨받는다. 옛 holder 의 놓기는 남의 임대를 지우지 않는다
//  - 동시에 잡으면 하나만 이긴다
//  - 에이전트끼리·스레드끼리 섞이지 않는다, 사람 계정은 403
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let bot: { accountId: string; pat: string };
let other: { accountId: string; pat: string };
let humanToken: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  const { token: adminToken } = await bootstrapAdmin(app);
  bot = await createAgent(app, adminToken, 'claimbot');
  other = await createAgent(app, adminToken, 'otherbot');
  ({ token: humanToken } = await createMember(app, adminToken, 'claimhuman'));
});
afterAll(async () => { await app.close(); await stop(); });

const thread = () => ({ channelId: randomUUID(), threadRootId: randomUUID() });

const claim = (token: string, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/agent/thread-claims', headers: { authorization: `Bearer ${token}` }, payload: body,
});
const release = (token: string, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/agent/thread-claims/release', headers: { authorization: `Bearer ${token}` }, payload: body,
});
/** 하트비트가 끊긴 채 시간이 흐른 것을 흉내낸다 — 시계를 기다리는 대신 만료 시각을 과거로 민다. */
const expire = (agentId: string, t: { channelId: string; threadRootId: string }) => pool.query(
  `update agent_thread_claim set expires_at = now() - interval '1 second'
    where agent_id = $1 and channel_id = $2 and thread_root_id = $3`,
  [agentId, t.channelId, t.threadRootId],
);
const row = async (agentId: string, t: { channelId: string; threadRootId: string }) => (await pool.query<{ holder: string; claimed_at: Date; expires_at: Date }>(
  `select holder, claimed_at, expires_at from agent_thread_claim where agent_id = $1 and channel_id = $2 and thread_root_id = $3`,
  [agentId, t.channelId, t.threadRootId],
)).rows[0];

describe('스레드 임대 (095)', () => {
  it('비어 있으면 잡고, 남이 쥔 동안에는 409 이며 쥔 쪽은 그대로다', async () => {
    const t = thread();
    const a = await claim(bot.pat, { ...t, holder: 'runner-old' });
    expect(a.statusCode).toBe(200);
    expect(a.json().claimed).toBe(true);

    const b = await claim(bot.pat, { ...t, holder: 'runner-new' });
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe('thread_claimed');
    expect(b.json().expiresAt).toBe(a.json().expiresAt);
    expect((await row(bot.accountId, t))?.holder).toBe('runner-old');
  });

  it('같은 holder 의 재호출은 하트비트다 — 만료를 밀고 claimed_at 은 그대로 둔다', async () => {
    const t = thread();
    await claim(bot.pat, { ...t, holder: 'h1', ttlSec: 15 });
    const before = await row(bot.accountId, t);
    const again = await claim(bot.pat, { ...t, holder: 'h1', ttlSec: 120 });
    expect(again.statusCode).toBe(200);
    const after = await row(bot.accountId, t);
    expect(after!.expires_at.getTime()).toBeGreaterThan(before!.expires_at.getTime());
    expect(after!.claimed_at.getTime()).toBe(before!.claimed_at.getTime());
  });

  it('하트비트가 끊겨 만료되면 다른 러너가 넘겨받고, 늦게 온 옛 하트비트는 409 다', async () => {
    const t = thread();
    await claim(bot.pat, { ...t, holder: 'runner-old' });
    await expire(bot.accountId, t);

    const takeover = await claim(bot.pat, { ...t, holder: 'runner-new' });
    expect(takeover.statusCode).toBe(200);
    expect((await row(bot.accountId, t))?.holder).toBe('runner-new');

    // 옛 러너가 멈췄다 깨어나 하트비트를 보내도 되찾지 못한다 — 넘겨받은 쪽이 살아 있는 한.
    const late = await claim(bot.pat, { ...t, holder: 'runner-old' });
    expect(late.statusCode).toBe(409);
    expect((await row(bot.accountId, t))?.holder).toBe('runner-new');
  });

  it('옛 러너가 턴을 끝내고 놓으면 새 러너가 곧바로 넘겨받는다', async () => {
    const t = thread();
    await claim(bot.pat, { ...t, holder: 'runner-old' });
    expect((await claim(bot.pat, { ...t, holder: 'runner-new' })).statusCode).toBe(409);

    expect((await release(bot.pat, { ...t, holder: 'runner-old' })).statusCode).toBe(204);
    expect((await claim(bot.pat, { ...t, holder: 'runner-new' })).statusCode).toBe(200);
  });

  it('옛 holder 의 놓기는 넘겨받힌 남의 임대를 지우지 않는다', async () => {
    const t = thread();
    await claim(bot.pat, { ...t, holder: 'runner-old' });
    await expire(bot.accountId, t);
    await claim(bot.pat, { ...t, holder: 'runner-new' });

    expect((await release(bot.pat, { ...t, holder: 'runner-old' })).statusCode).toBe(204);
    expect((await row(bot.accountId, t))?.holder).toBe('runner-new');
  });

  it('동시에 잡으면 하나만 이긴다', async () => {
    const t = thread();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claim(bot.pat, { ...t, holder: `racer-${i}` })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(7);
  });

  it('에이전트끼리·스레드끼리 섞이지 않는다', async () => {
    const t = thread();
    await claim(bot.pat, { ...t, holder: 'same' });
    // 다른 에이전트는 같은 스레드를 따로 잡는다 — 임대는 (에이전트, 스레드) 단위다.
    expect((await claim(other.pat, { ...t, holder: 'x' })).statusCode).toBe(200);
    // 같은 에이전트의 다른 스레드도 따로다.
    expect((await claim(bot.pat, { ...thread(), holder: 'y' })).statusCode).toBe(200);
    // 다른 에이전트가 같은 holder 이름으로 놓아도 내 임대는 남는다.
    await release(other.pat, { ...t, holder: 'same' });
    expect((await row(bot.accountId, t))?.holder).toBe('same');
  });

  it('사람 계정은 403, 모양이 틀리면 400', async () => {
    expect((await claim(humanToken, { ...thread(), holder: 'h' })).statusCode).toBe(403);
    expect((await release(humanToken, { ...thread(), holder: 'h' })).statusCode).toBe(403);
    expect((await claim(bot.pat, { channelId: 'nope', threadRootId: randomUUID(), holder: 'h' })).statusCode).toBe(400);
    expect((await claim(bot.pat, { ...thread(), holder: '' })).statusCode).toBe(400);
    expect((await claim(bot.pat, { ...thread(), holder: 'h', ttlSec: 5 })).statusCode).toBe(400);
  });
});
