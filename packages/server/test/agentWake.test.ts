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

  /**
   * 실측(2026-09-10 09:01): 스레드에 `06:01 PM 에 다시 봅니다` 가 서 있는 동안 사람이
   * "CI 실패했어 수정해" 를 썼고, 그 발화는 예약에 아무 일도 하지 않았다. 사람이 본 것은
   * 아무 일도 일어나지 않는 대기 줄이다 — *"내가 이야기 하면 바로 일어나서 작업해야하는데
   * 그냥 계속 기다리고 있어"*.
   */
  describe('사람이 말하면 기다림은 그 자리에서 끝난다', () => {
    async function wakeRow(messageId: string): Promise<{ fired: boolean; canceled: boolean }> {
      const res = await pool.query(
        `select fired_at, canceled_at from agent_wake where message_id = $1`, [messageId],
      );
      return { fired: res.rows[0].fired_at !== null, canceled: res.rows[0].canceled_at !== null };
    }

    async function schedule(threadRootId: string, reason: string): Promise<string> {
      const client = await mcpClient(botPat);
      const res = text(await client.callTool({
        name: 'turn.wake', arguments: { channelId, threadRootId, notBeforeSec: 3600, reason },
      }));
      await client.close();
      return res.wake.messageId as string;
    }

    it('부르지 않고 말해도 깨어난다 — 그 스레드에서 기다리던 에이전트만', async () => {
      const threadRootId = await newThread();
      const wakeMessageId = await schedule(threadRootId, '한 시간 뒤 CI');

      // 사람의 답글. `@wakebot` 을 **적지 않았다** — 그래도 기다림은 끝난다.
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: '아니 그거 지금 실패했어', threadRootId },
      });

      expect(await wakeRow(wakeMessageId)).toEqual({ fired: true, canceled: false });
      const entries = await pool.query(
        `select id from inbox where account_id = $1 and message_id = $2 and reason = 'wake'`,
        [botAccountId, wakeMessageId],
      );
      expect(entries.rowCount).toBe(1);

      // 당겨서 깨운 예약을 sweep 이 또 깨우지 않는다 — 항목은 여전히 하나다.
      await createAgentWakeSweeper(pool).sweep();
      const after = await pool.query(
        `select id from inbox where account_id = $1 and message_id = $2`,
        [botAccountId, wakeMessageId],
      );
      expect(after.rowCount).toBe(1);
    });

    it('부름이 함께 오면 예약은 접힌다 — 같은 스레드에 턴이 두 번 열리지 않는다', async () => {
      const threadRootId = await newThread();
      const wakeMessageId = await schedule(threadRootId, '한 시간 뒤 CI');

      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: '@wakebot 지금 실패했어 수정해', threadRootId },
      });

      // 접었다 — 부름이 이미 그 턴을 띄우므로, 깨움까지 넣으면 끝난 일에 두 번째 턴이 뒤늦게 열린다.
      expect(await wakeRow(wakeMessageId)).toEqual({ fired: false, canceled: true });
      const wakeEntries = await pool.query(
        `select id from inbox where account_id = $1 and message_id = $2`,
        [botAccountId, wakeMessageId],
      );
      expect(wakeEntries.rowCount).toBe(0);
      // 접힌 예약은 sweep 도 건너뛴다.
      await createAgentWakeSweeper(pool).sweep();
      const stillNone = await pool.query(
        `select id from inbox where account_id = $1 and message_id = $2`,
        [botAccountId, wakeMessageId],
      );
      expect(stillNone.rowCount).toBe(0);
    });

    it('에이전트의 발화는 남의 예약을 깨우지 않는다 — 서로 깨우는 고리를 만들지 않는다', async () => {
      const { pat: peerPat } = await createAgent(app, adminToken, `peer${Date.now()}`);
      const threadRootId = await newThread();
      const wakeMessageId = await schedule(threadRootId, '한 시간 뒤 CI');

      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${peerPat}` },
        payload: { body: '내가 보던 것은 이쪽이다', threadRootId },
      });

      expect(await wakeRow(wakeMessageId)).toEqual({ fired: false, canceled: false });
    });

    it('다른 스레드의 발화는 이 예약을 건드리지 않는다', async () => {
      const threadRootId = await newThread();
      const wakeMessageId = await schedule(threadRootId, '한 시간 뒤 CI');
      const otherThread = await newThread();

      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: '여긴 다른 얘기다', threadRootId: otherThread },
      });

      expect(await wakeRow(wakeMessageId)).toEqual({ fired: false, canceled: false });
    });
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

/**
 * **`GET /agent-wakes`** — 관제 화면이 *"죽었나 기다리나"* 를 한 자리에서 말하게 하는 문.
 *
 * 이 문이 없던 동안 화면은 `도는 턴 0개` 만 말할 수 있었고, 그 0 에는 두 뜻이 섞여 있었다:
 * 아무 일도 없는 것과 **기다리는 중인 것**. 예약은 스레드마다 흩어진 wake 메시지로만
 * 보였으므로 스레드를 다 열어 보지 않으면 알 수 없었다.
 */
describe('GET /agent-wakes — 아직 오지 않은 깨움', () => {
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const listWakes = async (token: string) => {
    const res = await app.inject({ method: 'GET', url: '/agent-wakes', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return res.json().wakes as {
      id: string; agentAccountId: string; channelId: string; threadRootId: string;
      messageId: string; wakeAt: string; reason: string | null;
    }[];
  };

  const schedule = async (threadRootId: string, reason: string, notBeforeSec = 300) => {
    const client = await mcpClient(botPat);
    const res = text(await client.callTool({
      name: 'turn.wake', arguments: { channelId, threadRootId, notBeforeSec, reason },
    }));
    await client.close();
    expect(res.error).toBeUndefined();
    return res.wake as { id: string; messageId: string; wakeAt: string };
  };

  it('예약한 것이 앵커·사유·시각과 함께 목록에 뜬다', async () => {
    const threadRootId = await newThread();
    const wake = await schedule(threadRootId, '깨움 목록 시험');

    const mine = (await listWakes(adminToken)).find((w) => w.id === wake.id);
    expect(mine).toBeTruthy();
    expect(mine!.agentAccountId).toBe(botAccountId);
    // 앵커는 **wake 메시지에서 되찾는다**(040 의 규칙) — 시계 테이블에 또 저장하지 않는다.
    expect(mine!.threadRootId).toBe(threadRootId);
    expect(mine!.reason).toBe('깨움 목록 시험');
    expect(mine!.channelId).toBe(channelId);
    expect(new Date(mine!.wakeAt).toISOString()).toBe(mine!.wakeAt);
  });

  it('이미 깨운 것은 주지 않는다 — 이 문이 답하는 물음은 "앞으로 올 것"이다', async () => {
    const threadRootId = await newThread();
    const wake = await schedule(threadRootId, '곧 깬다');
    await pullWakeIntoPast(wake.messageId);
    await createAgentWakeSweeper(pool).sweep();

    expect((await listWakes(adminToken)).map((w) => w.id)).not.toContain(wake.id);
  });

  it('취소된 것도 주지 않는다', async () => {
    const threadRootId = await newThread();
    const wake = await schedule(threadRootId, '취소될 것');
    await pool.query(`update agent_wake set canceled_at = now() where id = $1`, [wake.id]);

    expect((await listWakes(adminToken)).map((w) => w.id)).not.toContain(wake.id);
  });

  /**
   * 시계는 메시지가 지워져도 살아 있어 **깨움은 그대로 온다.** 그래서 줄을 감추지 않고
   * 사유만 비운다 — 감추면 화면이 "기다리는 것이 없다"고 거짓말한다.
   */
  it('wake 메시지가 지워지면 줄은 남고 사유만 비워진다', async () => {
    const threadRootId = await newThread();
    const wake = await schedule(threadRootId, '지워질 사유');
    await pool.query(`update message set deleted_at = now() where id = $1`, [wake.messageId]);

    const row = (await listWakes(adminToken)).find((w) => w.id === wake.id);
    expect(row).toBeTruthy();
    expect(row!.reason).toBeNull();
  });

  /**
   * 권한은 `/agent-sessions` 와 **같은 판정**이고, 소유하지 않은 사람에게 403 이 아니라
   * **빈 목록**인 이유도 같다: 이 라우트는 특정 에이전트를 묻지 않으므로 거절할 대상이 없다.
   */
  it('소유하지 않은 사람에게는 빈 목록이다 — 거절이 아니다', async () => {
    const threadRootId = await newThread();
    await schedule(threadRootId, '남의 에이전트 예약');

    const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        handle: 'stranger', loginId: 'stranger', displayName: 'stranger',
        password: 'pw123456', inviteToken: inv.json().token as string,
      },
    });
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'stranger', password: 'pw123456' },
    });

    expect(await listWakes(login.json().token as string)).toEqual([]);
  });
});
