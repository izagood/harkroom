import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { createAgentWakeSweeper } from '../src/services/agentWakes.js';

/**
 * 깨움(wake) — 에이전트가 **자기를 나중에 깨우는** 예약.
 *
 * 왜 필요한가: 러너의 턴은 `claude -p` 한 번이고, 모델이 말을 멈추면 프로세스가 죽는다.
 * 그와 함께 백그라운드로 띄운 대기(CI 폴링 등)도 죽는다 — 2026-09-07 15:08 의 실패가
 * 그것이었다. 세션은 이미 디스크에 살아남아 `-r` 로 재개되므로(turn.ts), 빠진 것은
 * **깨우는 시계**뿐이다.
 *
 * 왜 `scheduled_message`(#222) 를 쓰지 않는가: 그것은 "이 본문을 나중에 **보낸다**"이고,
 * 깨움은 "이미 보인 이 줄을 근거로 나중에 나를 **부른다**"다. 예약 발송은 발송 전까지
 * 아무에게도 보이지 않아야 하는데(그 테이블의 존재 이유), 깨움은 반대로 **지금 당장
 * 보여야** 한다 — 사람이 "죽었나 기다리나"를 알 수 있는 유일한 근거이기 때문이다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let botPat: string;
let botAccountId: string;
let channelId: string;
let mcpUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat, accountId: botAccountId } = await createAgent(app, adminToken, 'wakebot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'wake-ch', repo: 'wake-repo' },
  });
  channelId = ch.json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>): any =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

/** 사람이 스레드를 하나 세운다 — 깨움은 언제나 어떤 스레드의 후속이다. */
async function newThread(): Promise<string> {
  const root = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { body: '@wakebot PR 올리고 CI 통과하면 머지해' },
  });
  return root.json().id as string;
}

/** 예약 시각을 과거로 당긴다 — sweep 을 시험하려면 이 길뿐이다(라우트는 과거를 막는다). */
async function pullWakeIntoPast(messageId: string): Promise<void> {
  await pool.query(`update agent_wake set wake_at = now() - interval '1 second' where message_id = $1`, [messageId]);
}

async function inboxReasons(accountId: string): Promise<string[]> {
  const res = await pool.query(
    `select reason from inbox where account_id = $1 order by id`, [accountId],
  );
  return res.rows.map((r) => r.reason as string);
}

describe('turn.wake — 에이전트가 자기를 나중에 깨운다', () => {
  it('예약하면 그 자리에서 kind=wake 메시지가 스레드에 보인다 — 사람이 기다리는 중임을 안다', async () => {
    const threadRootId = await newThread();
    const client = await mcpClient(botPat);
    const res = text(await client.callTool({
      name: 'turn.wake',
      arguments: { channelId, threadRootId, notBeforeSec: 300, reason: 'CI 결과 확인' },
    }));
    await client.close();

    expect(res.error).toBeUndefined();
    const msg = await pool.query(
      `select body, kind, meta, author_id, thread_root_id from message where id = $1`,
      [res.wake.messageId],
    );
    expect(msg.rows[0].kind).toBe('wake');
    expect(msg.rows[0].body).toBe('CI 결과 확인');
    expect(msg.rows[0].author_id).toBe(botAccountId);
    // 앵커를 지킨다 — 이 값이 러너의 세션 키이고, 어긋나면 깨어난 턴이 새 세션으로 시작한다.
    expect(msg.rows[0].thread_root_id).toBe(threadRootId);
    // 시각은 **사실로** 싣고 문자열로 굽지 않는다 — 로컬 시간대로 읽는 것은 클라이언트 몫이다.
    expect(typeof msg.rows[0].meta.wake.wakeAt).toBe('string');
  });

  it('예약 시각 전에는 아무도 깨우지 않는다', async () => {
    const threadRootId = await newThread();
    const client = await mcpClient(botPat);
    text(await client.callTool({
      name: 'turn.wake',
      arguments: { channelId, threadRootId, notBeforeSec: 3600, reason: '한 시간 뒤' },
    }));
    await client.close();

    const before = (await inboxReasons(botAccountId)).filter((r) => r === 'wake').length;
    await createAgentWakeSweeper(pool).sweep();
    const after = (await inboxReasons(botAccountId)).filter((r) => r === 'wake').length;
    expect(after).toBe(before);
  });

  it('시각이 되면 작성자 **자신의** inbox 에 wake 항목이 생긴다 — 자기 멘션은 막혀 있으므로(messages.ts:441) 이 길이 필요하다', async () => {
    const threadRootId = await newThread();
    const client = await mcpClient(botPat);
    const res = text(await client.callTool({
      name: 'turn.wake',
      arguments: { channelId, threadRootId, notBeforeSec: 300, reason: 'CI 결과 확인' },
    }));
    await client.close();
    await pullWakeIntoPast(res.wake.messageId);

    await createAgentWakeSweeper(pool).sweep();

    const entries = await pool.query(
      `select reason, message_id from inbox where account_id = $1 and reason = 'wake'`,
      [botAccountId],
    );
    expect(entries.rows.map((r) => r.message_id)).toContain(res.wake.messageId);
  });

  it('두 번 깨우지 않는다 — sweep 이 여러 번 돌아도 항목은 하나다', async () => {
    const threadRootId = await newThread();
    const client = await mcpClient(botPat);
    const res = text(await client.callTool({
      name: 'turn.wake',
      arguments: { channelId, threadRootId, notBeforeSec: 300, reason: '한 번만' },
    }));
    await client.close();
    await pullWakeIntoPast(res.wake.messageId);

    const sweeper = createAgentWakeSweeper(pool);
    await sweeper.sweep();
    await sweeper.sweep();

    const entries = await pool.query(
      `select id from inbox where account_id = $1 and message_id = $2`,
      [botAccountId, res.wake.messageId],
    );
    expect(entries.rowCount).toBe(1);
  });

  it('60초보다 이른 예약은 거절한다 — 상한 없는 재예약은 자기를 깨우는 무한 루프다', async () => {
    const threadRootId = await newThread();
    const client = await mcpClient(botPat);
    // MCP SDK 는 인자 검증 실패를 예외가 아니라 `isError` 결과로 돌려준다 — 그래서
    // 이 거절은 도구 안의 정책 거절(`wake_limit`)과 모양이 다르다. 하한은 인자의 문제이고
    // 상한은 스레드 상태의 문제이므로, 두 거절이 갈라지는 것이 맞다.
    const res = await client.callTool({
      name: 'turn.wake',
      arguments: { channelId, threadRootId, notBeforeSec: 5, reason: '너무 이르다' },
    });
    await client.close();
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toContain('notBeforeSec');
    // 거절된 예약은 대기 줄도 남기지 않는다 — 보이는 줄과 걸린 시계는 언제나 짝이다.
    const wakes = await pool.query(
      `select count(*)::int as n from message where thread_root_id = $1 and kind = 'wake'`,
      [threadRootId],
    );
    expect(wakes.rows[0].n).toBe(0);
  });

  it('사람의 새 발화 없이 연속으로 걸 수 있는 깨움에는 상한이 있다', async () => {
    const threadRootId = await newThread();
    const client = await mcpClient(botPat);
    let refused: unknown = null;
    // 상한 + 여유. 상한에 걸리면 error 코드로 답하고 더 이상 예약하지 않는다.
    for (let i = 0; i < 25; i++) {
      const res = text(await client.callTool({
        name: 'turn.wake',
        arguments: { channelId, threadRootId, notBeforeSec: 60, reason: `${i}번째` },
      }));
      if (res.error) { refused = res.error; break; }
    }
    await client.close();
    expect(refused).toMatchObject({ code: 'wake_limit' });
  });
});
