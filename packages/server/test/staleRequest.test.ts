import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { createStaleRequestSweeper } from '../src/services/staleRequests.js';

/**
 * **아무도 집지 않은 요청을 서버가 스레드에 말한다**(049).
 *
 * 이 파일이 지키는 것은 문구가 아니라 **판정**이다:
 *
 * 1. 러너가 오프라인이고 요청이 미읽음으로 남으면 그 스레드에 실패 하나가 남는다
 * 2. **러너가 온라인이면 아무 말도 하지 않는다** — 읽음은 턴이 끝날 때 찍히므로 도는 긴
 *    턴(최대 30분)도 그동안 미읽음이다. 미읽음만 보고 판정하면 일하는 에이전트를 죽은
 *    것으로 단정한다. 이 축이 이 기능에서 가장 위험한 자리다
 * 3. 기동 유예 안에는 조용하다 — presence 는 인메모리라 재시작 직후엔 전원이 오프라인이고,
 *    유예가 없으면 **배포마다** 모든 스레드에 거짓 통지가 남는다
 * 4. 두 번 돌려도 줄은 하나다
 * 5. 사람이 부른 것만 말한다(`wake` 는 에이전트가 자기에게 건 후속이다)
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let agentId: string;
let agentHandle: string;
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 오프라인 presence — 아무도 폴하고 있지 않다. */
const offline = { online: () => [] as string[] };

async function post(body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 그 스레드에 남은 실패 메시지들. 저자와 meta 까지 본다 — 그것이 이 기능의 산출물이다. */
async function failuresIn(threadRootId: string): Promise<Array<{ authorId: string; body: string; meta: Record<string, unknown> }>> {
  const res = await pool.query(
    `select author_id as "authorId", body, meta from message
      where coalesce(thread_root_id, id) = $1 and id <> $1
        and meta->>'kind' = 'failure'
      order by seq`,
    [threadRootId],
  );
  return res.rows;
}

const sweeper = (over: Parameters<typeof createStaleRequestSweeper>[1] | null = null) =>
  createStaleRequestSweeper(pool, {
    presence: offline, staleAfterMs: 0, startupGraceMs: 0, ...(over ?? {}),
  });

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const agent = await createAgent(app, adminToken, 'stalebot');
  agentId = agent.accountId;
  agentHandle = 'stalebot';

  const channel = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name: 'stalechan', visibility: 'public' },
  });
  expect(channel.statusCode).toBe(201);
  channelId = channel.json().id as string;
});

afterAll(async () => { await app.close(); await stop(); });

describe('049 아무도 집지 않은 요청', () => {
  it('1. 러너가 오프라인이면 그 스레드에 실패 하나가 남는다', async () => {
    const messageId = await post(`@${agentHandle} 이거 해줘`);

    await sweeper().sweep();

    const failures = await failuresIn(messageId);
    expect(failures).toHaveLength(1);
    // **저자는 그 에이전트다** — 실패를 저자로 묶어 그리는 화면과 러너가 스스로 남기는
    // 실패(`message.fail`)와 같은 모양이어야 한다.
    expect(failures[0]!.authorId).toBe(agentId);
    // 러너를 다시 띄우면 이 요청부터 다시 집으므로 retryable 이다.
    expect((failures[0]!.meta as { failure: { retryable: boolean } }).failure.retryable).toBe(true);
    // 저자가 지금 말할 수단이 없다는 사실을 사유가 적는다.
    expect(JSON.stringify(failures[0]!.meta)).toContain('서버가 관측했다');
  });

  it('2. 러너가 온라인이면 아무 말도 하지 않는다 — 도는 긴 턴을 죽은 것으로 보면 안 된다', async () => {
    const messageId = await post(`@${agentHandle} 지금 일하는 중이다`);

    // 폴하고 있는 러너다. 읽음이 아직 안 찍힌 것은 **턴이 끝나지 않았기 때문**이고,
    // 그 사실을 presence 하나가 가른다.
    await sweeper({ presence: { online: () => [agentId] }, staleAfterMs: 0, startupGraceMs: 0 }).sweep();

    expect(await failuresIn(messageId)).toHaveLength(0);
    // 표시도 찍히지 않는다 — 찍혔으면 러너가 죽은 뒤에도 영영 말하지 못한다.
    const marked = await pool.query(
      `select 1 from inbox where account_id = $1 and message_id = $2 and stale_notified_at is not null`,
      [agentId, messageId],
    );
    expect(marked.rowCount).toBe(0);
  });

  it('3. 기동 유예 안에는 조용하다', async () => {
    const messageId = await post(`@${agentHandle} 방금 서버가 떴다`);

    // 기본 유예(60초) 안이다. presence 가 인메모리라 기동 직후엔 살아 있는 러너도
    // 오프라인으로 보인다 — 이 유예가 없으면 배포마다 거짓 통지가 쏟아진다.
    await createStaleRequestSweeper(pool, { presence: offline, staleAfterMs: 0 }).sweep();
    expect(await failuresIn(messageId)).toHaveLength(0);

    // 유예를 지나면 말한다.
    await sweeper().sweep();
    expect(await failuresIn(messageId)).toHaveLength(1);
  });

  it('4. 두 번 돌려도 줄은 하나다', async () => {
    const messageId = await post(`@${agentHandle} 두 번 돌린다`);

    const s = sweeper();
    await s.sweep();
    await s.sweep();

    expect(await failuresIn(messageId)).toHaveLength(1);
  });

  it('5. 같은 스레드에 요청이 둘이면 줄은 하나, 표시는 둘 다', async () => {
    const rootId = await post(`@${agentHandle} 첫 부름`);
    const reply = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
      payload: { body: `@${agentHandle} 또 부른다`, threadRootId: rootId },
    });
    expect(reply.statusCode).toBe(201);

    await sweeper().sweep();

    // 사람이 읽을 문장은 하나다.
    expect(await failuresIn(rootId)).toHaveLength(1);
    // 그러나 **표시는 요청마다** 찍힌다 — 스레드에 표시하면 다음 요청이 조용히 삼켜진다.
    const marked = await pool.query(
      `select count(*)::int as n from inbox i join message m on m.id = i.message_id
        where i.account_id = $1 and coalesce(m.thread_root_id, m.id) = $2
          and i.stale_notified_at is not null`,
      [agentId, rootId],
    );
    expect(marked.rows[0]!.n).toBe(2);
  });

  it('6. `wake` 는 말하지 않는다 — 사람이 부른 것이 아니다', async () => {
    const messageId = await post('사람이 부르지 않은 말');
    // 에이전트가 자기에게 건 후속과 같은 모양의 항목을 직접 만든다. 스레드에는 이미
    // 대기 줄이 서 있으므로 이 스위퍼가 할 말이 없다.
    await pool.query(
      `insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake')`,
      [agentId, messageId],
    );

    await sweeper().sweep();

    expect(await failuresIn(messageId)).toHaveLength(0);
  });
});
