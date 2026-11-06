import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { cancelDelegationsFor, createDelegationDeadlineSweeper, DELEGATION_WAIT_MAX_SEC } from '../src/services/delegations.js';
import { delegationChainCapped } from '../src/services/messages.js';
import { scheduleWake } from '../src/services/agentWakes.js';
import { settleCanceledTurn } from '../src/services/turnCancel.js';
import { onEvent, type WorkspaceEvent } from '../src/events.js';

/**
 * 위임 왕복(050) — **팀장이 넘긴 일이 끝나면 팀장이 다시 깬다.**
 *
 * 이 파일이 지키는 것 여섯:
 *
 * 1. 넘기면 팀원이 `team_delegated` 로 불리고 의무가 생긴다
 * 2. **러너가 없는 팀원에는 의무를 만들지 않는다**(층 0) — 만들면 아무도 닫지 않는 의무가
 *    되어 팀장은 기한까지 아무 것도 모른다
 * 3. **미결이 0 이 될 때 한 번만** 깨운다 — 부분 취합을 하면 팀장 턴이 순차로 여러 번 돌아
 *    최종 답을 여러 번 쓴다
 * 4. `progress` 는 닫지 않고 `fail` 은 닫는다(결말은 `failed`) — 하네스 실패가 자동으로 풀리는 길
 * 5. **기한이 지나면 무응답으로 닫고 깨운다** — 아무 신호도 오지 않는 경우의 유일한 출구
 * 6. **라운드 상한**과 사람의 발화가 그것을 리셋하는 것
 *
 * presence 는 **MCP 로 붙은 것 자체가 신호**다(`/mcp` 요청마다 `mark`). 그래서 러너가 있는
 * 팀원은 클라이언트를 연결해 두고, 없는 팀원은 연결하지 않는다 — 실제 배선을 그대로 쓴다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let mcpUrl: string;

let leadPat: string;
let leadId: string;
let onePat: string;
let oneId: string;
let twoPat: string;
let twoId: string;
let offId: string;
let channelId: string;
let teamId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

/** 사람이 스레드를 연다. 위임은 스레드에만 걸리므로 모든 시험이 이것으로 시작한다. */
async function openThread(body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function inboxReasons(accountId: string, messageId: string): Promise<string[]> {
  const res = await pool.query(
    `select reason from inbox where account_id = $1 and message_id = $2 order by id`,
    [accountId, messageId],
  );
  return res.rows.map((r) => r.reason as string);
}

async function outcomes(delegationMessageId: string): Promise<Record<string, string | null>> {
  const res = await pool.query(
    `select a.handle, i.outcome from team_delegation d
       join team_delegation_item i on i.delegation_id = d.id
       join account a on a.id = i.delegate_account_id
      where d.message_id = $1`,
    [delegationMessageId],
  );
  return Object.fromEntries(res.rows.map((r) => [r.handle as string, r.outcome as string | null]));
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));

  ({ pat: leadPat, accountId: leadId } = await createAgent(app, adminToken, 'dlead'));
  ({ pat: onePat, accountId: oneId } = await createAgent(app, adminToken, 'done1'));
  ({ pat: twoPat, accountId: twoId } = await createAgent(app, adminToken, 'dtwo'));
  ({ accountId: offId } = await createAgent(app, adminToken, 'doff'));

  const team = await app.inject({
    method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'delegteam' },
  });
  teamId = team.json().id as string;
  for (const accountId of [leadId, oneId, twoId, offId]) {
    const added = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${accountId}`, headers: auth(adminToken),
    });
    expect(added.statusCode).toBe(200);
  }
  const lead = await app.inject({
    method: 'PUT', url: `/teams/${teamId}/lead`, headers: auth(adminToken), payload: { accountId: leadId },
  });
  expect(lead.statusCode).toBe(200);

  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'delegchan' },
  });
  channelId = ch.json().id as string;

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});

afterAll(async () => { await app.close(); await stop(); });

describe('050 위임 왕복', () => {
  it('1. 넘기면 팀원이 team_delegated 로 불리고 의무가 생긴다', async () => {
    const rootId = await openThread('@delegteam 나눠서 해라');
    const leadClient = await mcpClient(leadPat);
    // 팀원 둘의 러너가 붙어 있다 — MCP 로 붙은 것 자체가 presence 신호다.
    const oneClient = await mcpClient(onePat);
    const twoClient = await mcpClient(twoPat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '@done1 은 서버, @dtwo 는 화면', to: ['done1', 'dtwo'] },
    }));

    expect(res.delegated).toEqual(['done1', 'dtwo']);
    expect(res.unreachable).toEqual([]);
    expect(res.roundsLeft).toBe(2);
    const messageId = (res.message as { id: string }).id;

    expect(await inboxReasons(oneId, messageId)).toEqual(['team_delegated']);
    expect(await inboxReasons(twoId, messageId)).toEqual(['team_delegated']);
    // 팀장 자신은 자기 발화로 불리지 않는다.
    expect(await inboxReasons(leadId, messageId)).toEqual([]);
    expect(await outcomes(messageId)).toEqual({ done1: null, dtwo: null });

    await oneClient.close(); await twoClient.close(); await leadClient.close();
  });

  it('2. 러너가 없는 팀원에는 의무를 만들지 않는다 — 전원 불가면 메시지도 없다', async () => {
    const rootId = await openThread('@delegteam 두 번째');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    // `doff` 는 MCP 로 붙지 않았다 = 러너가 없다.
    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '둘에게 넘긴다', to: ['done1', 'doff'] },
    }));
    expect(res.delegated).toEqual(['done1']);
    expect(res.unreachable).toEqual(['doff']);
    const messageId = (res.message as { id: string }).id;
    // 도달 불가한 팀원에게는 부름도 의무도 없다 — 아무도 닫지 않는 의무를 만들지 않는다.
    expect(await inboxReasons(offId, messageId)).toEqual([]);
    expect(await outcomes(messageId)).toEqual({ done1: null });

    // 전원 도달 불가면 **메시지조차 만들지 않는다**: 위임 메시지만 남으면 사람은 넘어간 줄
    // 알고 기다리는데 기다릴 것이 없다.
    const none = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '꺼진 팀원에게', to: ['doff'] },
    }));
    expect(none.delegated).toEqual([]);
    expect(none.message).toBeNull();

    await oneClient.close(); await leadClient.close();
  });

  it('3. 받는 쪽은 호출 게이트를 지나야 하고, 자기에게는 넘길 수 없다', async () => {
    const rootId = await openThread('@delegteam 권한');
    const leadClient = await mcpClient(leadPat);

    // 없는 이름은 막힌 에이전트와 같은 말로 거절한다 — 거절 사유로 범위 설정을 읽어 낼 수 없게.
    const stranger = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '남에게 넘긴다', to: ['mcpstranger'] },
    }));
    expect((stranger.error as { code: string }).code).toBe('not_invokable');

    // 자기에게 넘기는 것은 뜻이 없다.
    const self = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '나에게', to: ['dlead'] },
    }));
    expect((self.error as { code: string }).code).toBe('self_delegation');

    await leadClient.close();
  });

  it('4. 미결이 0 이 될 때 한 번만 깨운다', async () => {
    const rootId = await openThread('@delegteam 두 명에게');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);
    const twoClient = await mcpClient(twoPat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '둘에게 넘긴다', to: ['done1', 'dtwo'] },
    }));
    const messageId = (res.message as { id: string }).id;

    // 첫 팀원이 답한다 — 아직 미결이 하나 남았으므로 팀장은 깨지 않는다.
    await oneClient.callTool({
      name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '서버 쪽 끝났다', checks: ['확인'] },
    });
    expect(await inboxReasons(leadId, messageId)).toEqual([]);

    // 둘째가 답하면 그때 한 번 깬다.
    await twoClient.callTool({
      name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '화면 쪽 끝났다', checks: ['확인'] },
    });
    expect(await inboxReasons(leadId, messageId)).toEqual(['delegation_done']);
    expect(await outcomes(messageId)).toEqual({ done1: 'done', dtwo: 'done' });

    // 결말 목록이 인박스 항목에 실린다 — 팀장이 다음에 무엇을 할지 정하는 재료다.
    const inbox = text(await leadClient.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    const entry = (inbox.entries as Array<{ messageId: string; reason: string; delegation?: unknown }>)
      .find((e) => e.messageId === messageId && e.reason === 'delegation_done');
    expect(entry?.delegation).toMatchObject({
      timedOut: false,
      items: [{ handle: 'done1', outcome: 'done' }, { handle: 'dtwo', outcome: 'done' }],
    });

    await oneClient.close(); await twoClient.close(); await leadClient.close();
  });

  it('5. progress 는 닫지 않고 fail 은 닫는다 — 결말은 failed 다', async () => {
    const rootId = await openThread('@delegteam 실패 경로');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '하나에게 넘긴다', to: ['done1'] },
    }));
    const messageId = (res.message as { id: string }).id;

    // 진행 한 줄은 답이 아니다(#687 의 `countsAsReply`) — 닫히면 팀장이 결과 없이 깨어난다.
    await oneClient.callTool({
      name: 'message.progress', arguments: { channelId, threadRootId: rootId, body: '이제 본다' },
    });
    expect(await outcomes(messageId)).toEqual({ done1: null });
    expect(await inboxReasons(leadId, messageId)).toEqual([]);

    // 실패는 결과다. 러너는 3회 소진·한도·세션 충돌에서 이미 이 발화를 올리므로 하네스
    // 실패는 이 경로로 자동으로 풀린다.
    await oneClient.callTool({
      name: 'message.fail',
      arguments: { channelId, threadRootId: rootId, body: '못 했다', retryable: false },
    });
    expect(await outcomes(messageId)).toEqual({ done1: 'failed' });
    expect(await inboxReasons(leadId, messageId)).toEqual(['delegation_done']);

    await oneClient.close(); await leadClient.close();
  });

  it('6. 기한이 지나면 무응답으로 닫고 팀장을 깨운다', async () => {
    const rootId = await openThread('@delegteam 기한');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '기한을 짧게', to: ['done1'], deadlineSec: 60 },
    }));
    const messageId = (res.message as { id: string }).id;

    // 시간을 기다리지 않고 기한을 과거로 옮긴다 — 이 시험이 재는 것은 시계가 아니라 **판정**이다.
    await pool.query(
      `update team_delegation set deadline_at = now() - interval '1 second' where message_id = $1`,
      [messageId],
    );
    await createDelegationDeadlineSweeper(pool).sweep();

    expect(await outcomes(messageId)).toEqual({ done1: 'timeout' });
    expect(await inboxReasons(leadId, messageId)).toEqual(['delegation_done']);

    const inbox = text(await leadClient.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    const entry = (inbox.entries as Array<{ messageId: string; delegation?: { timedOut: boolean } }>)
      .find((e) => e.messageId === messageId);
    expect(entry?.delegation?.timedOut).toBe(true);

    // 늦게 온 답으로는 다시 깨우지 않는다 — 이미 사람에게 넘어간 일을 되살리면 둘이 같은
    // 일을 잡는다. 의무가 이미 닫혔으므로 이 답은 아무 것도 열지 않는다.
    await oneClient.callTool({
      name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '늦었지만 했다', checks: ['확인'] },
    });
    expect(await inboxReasons(leadId, messageId)).toEqual(['delegation_done']);

    await oneClient.close(); await leadClient.close();
  });

  it('8. 넘겨받은 팀원의 항목에 팀장과 기한이 실린다', async () => {
    const rootId = await openThread('@delegteam 맥락');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '서버를 봐라', to: ['done1'], deadlineSec: 600 },
    }));
    const messageId = (res.message as { id: string }).id;

    // 러너는 이것으로 *"최종 답은 팀장이 쓴다"* 블록을 만든다 — 팀장이 누구인지 모르면
    // 그 문장을 쓸 수 없고, 기한을 모르면 자기 답이 언제 무응답으로 닫히는지 모른다.
    const inbox = text(await oneClient.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    const entry = (inbox.entries as Array<{ messageId: string; reason: string; delegatedBy?: unknown }>)
      .find((e) => e.messageId === messageId);
    expect(entry?.reason).toBe('team_delegated');
    expect(entry?.delegatedBy).toMatchObject({ leadHandle: 'dlead', teamName: 'delegteam' });
    expect(typeof (entry?.delegatedBy as { deadlineAt: string }).deadlineAt).toBe('string');

    await oneClient.close(); await leadClient.close();
  });

  it('9. 의무가 닫히면 메시지 meta 의 open 이 줄고, 채널 목록이 그 마디를 싣는다', async () => {
    const rootId = await openThread('@delegteam 사슬');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);
    const twoClient = await mcpClient(twoPat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '둘에게', to: ['done1', 'dtwo'] },
    }));
    const messageId = (res.message as { id: string }).id;

    const openIds = async (): Promise<string[]> => {
      const r = await pool.query(`select meta->'delegation'->'open' as open from message where id = $1`, [messageId]);
      return (r.rows[0]!.open ?? []) as string[];
    };

    // **화면은 표를 못 읽는다** — 대기 사슬과 채널 목록 집계는 둘 다 메시지 meta 를 본다.
    expect((await openIds()).sort()).toEqual([oneId, twoId].sort());

    /**
     * 채널 목록의 `openAskLinks` 에 위임 마디가 실린다. 물음과 **같은 목록**인 것이 요점이다 —
     * 사슬을 잇는 `walk()` 는 마디의 출처를 묻지 않으므로, 목록을 갈라 두면 화면이 그 둘을
     * 합치는 코드를 또 써야 하고 그것이 스레드 안의 사슬과 갈라진다.
     */
    const list = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
    });
    const root = (list.json().messages as Array<{ id: string; openAskLinks?: Array<{ waiter: string; blockedBy: string }> }>)
      .find((m) => m.id === rootId);
    const blocked = (root?.openAskLinks ?? []).filter((l) => l.waiter === leadId).map((l) => l.blockedBy);
    expect(blocked.sort()).toEqual([oneId, twoId].sort());

    // 하나가 답하면 그 하나만 빠진다.
    await oneClient.callTool({
      name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝났다', checks: ['확인'] },
    });
    expect(await openIds()).toEqual([twoId]);

    // 전부 닫히면 빈 배열이다 — 사슬에서도 사라진다.
    await twoClient.callTool({
      name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '나도 끝났다', checks: ['확인'] },
    });
    expect(await openIds()).toEqual([]);

    await oneClient.close(); await twoClient.close(); await leadClient.close();
  });

  /**
   * 중단이 의무를 닫는다(051). **깨울지가 방향에 따라 정반대**라 두 갈래를 함께 잰다.
   *
   * 이것이 없으면 중단된 턴의 의무는 기한이 지나야 `timeout` 으로 닫히고, 팀장은 10분 뒤에
   * "무응답"을 받아 **사람이 일부러 멈춘 일을 다시 하려 든다.**
   */
  it('10. 팀원을 중단하면 취소로 닫히고 팀장이 깨어난다', async () => {
    const rootId = await openThread('@delegteam 중단');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '하나에게', to: ['done1'] },
    }));
    const messageId = (res.message as { id: string }).id;

    const client = await pool.connect();
    try {
      await client.query('begin');
      const woke = await cancelDelegationsFor(client, { threadRootId: rootId, accountId: oneId });
      await client.query('commit');
      // 사람은 그 팀원의 일을 멈춘 것이고 팀 전체를 멈춘 것이 아니다 — 팀장이 다음을 정한다.
      expect(woke).toEqual([leadId]);
    } finally { client.release(); }

    expect(await outcomes(messageId)).toEqual({ done1: 'canceled' });
    expect(await inboxReasons(leadId, messageId)).toEqual(['delegation_done']);

    // 결말이 `취소` 로 온다 — 프롬프트가 "다시 시작하지 마라"를 말하는 근거다.
    const inbox = text(await leadClient.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    const entry = (inbox.entries as Array<{ messageId: string; delegation?: { items: Array<{ outcome: string }> } }>)
      .find((e) => e.messageId === messageId);
    expect(entry?.delegation?.items[0]!.outcome).toBe('canceled');

    await oneClient.close(); await leadClient.close();
  });

  it('11. 팀장을 중단하면 의무가 닫히고 팀장은 깨지 않는다', async () => {
    const rootId = await openThread('@delegteam 팀장 중단');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);
    const twoClient = await mcpClient(twoPat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '둘에게', to: ['done1', 'dtwo'] },
    }));
    const messageId = (res.message as { id: string }).id;

    const client = await pool.connect();
    try {
      await client.query('begin');
      const woke = await cancelDelegationsFor(client, { threadRootId: rootId, accountId: leadId });
      await client.query('commit');
      // **깨우지 않는다** — 깨우면 사람이 멈춘 그 턴이 곧바로 되살아나고 중단의 뜻이 사라진다.
      expect(woke).toEqual([]);
    } finally { client.release(); }

    expect(await outcomes(messageId)).toEqual({ done1: 'canceled', dtwo: 'canceled' });
    expect(await inboxReasons(leadId, messageId)).toEqual([]);

    // 사슬에서도 사라진다(meta 의 open 이 비었다) — 멈춘 일이 "기다리는 중"으로 남지 않는다.
    const open = await pool.query(`select meta->'delegation'->'open' as open from message where id = $1`, [messageId]);
    expect(open.rows[0]!.open).toEqual([]);

    // 기한 스위퍼도 이 위임을 다시 건드리지 않는다 — `notified_at` 이 찍혀 있다.
    await pool.query(`update team_delegation set deadline_at = now() - interval '1 second' where message_id = $1`, [messageId]);
    await createDelegationDeadlineSweeper(pool).sweep();
    expect(await inboxReasons(leadId, messageId)).toEqual([]);

    await oneClient.close(); await twoClient.close(); await leadClient.close();
  });

  /**
   * **기한은 "끝내라"가 아니라 "이만큼 조용하면 죽은 것"이다**(2026-09-12).
   *
   * 한 턴의 예산은 30분인데 기한 기본값은 10분이라, 고치기 전에는 10분 넘는 일이
   * **구조적으로** 거짓 무응답이 됐다 — 팀장이 깨어나 같은 일을 다시 시키고, 뒤늦게 온
   * 진짜 보고는 이미 닫힌 의무를 열지 못했다.
   */
  it('12. 진행 한 줄이 기한을 뒤로 민다 — 일하는 중은 무응답이 아니다', async () => {
    const rootId = await openThread('@delegteam 오래 걸리는 일');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '오래 걸린다', to: ['done1'] },
    }));
    const messageId = (res.message as { id: string }).id;

    // 기한이 지났다(시간을 기다리지 않고 과거로 옮긴다).
    await pool.query(
      `update team_delegation set deadline_at = now() - interval '1 second' where message_id = $1`,
      [messageId],
    );

    // 그런데 팀원이 **살아 있다는 신호**를 보낸다. 진행은 의무를 닫지 않지만(시험 5)
    // 이제 기한은 민다.
    await oneClient.callTool({
      name: 'message.progress', arguments: { channelId, threadRootId: rootId, body: '아직 보는 중' },
    });

    await createDelegationDeadlineSweeper(pool).sweep();
    // 닫히지 않았다 — 팀장도 안 깨어난다.
    expect(await outcomes(messageId)).toEqual({ done1: null });
    expect(await inboxReasons(leadId, messageId)).toEqual([]);

    await oneClient.close(); await leadClient.close();
  });

  it('13. 그 스레드에서 턴이 돌고 있으면 기한이 지나도 닫지 않는다', async () => {
    const rootId = await openThread('@delegteam 도는 턴');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    const res = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '긴 작업', to: ['done1'] },
    }));
    const messageId = (res.message as { id: string }).id;
    await pool.query(
      `update team_delegation set deadline_at = now() - interval '1 second' where message_id = $1`,
      [messageId],
    );

    /**
     * 진행 발화보다 **강한 신호**다: 진행은 모델이 올려 줘야 하지만 이것은 러너가 그
     * 스레드에 붙어 있다는 사실 자체다. 허브의 목록을 흉내 내어 그 판정만 잰다.
     */
    const running = [{ agentAccountId: oneId, threadRootId: rootId }];
    await createDelegationDeadlineSweeper(pool, { runningTurns: () => running }).sweep();
    expect(await outcomes(messageId)).toEqual({ done1: null });

    // **건너뛰는 것이 아니라 민다.** 건너뛰면 이 행이 매 스윕(15초)마다 다시 잡힌다.
    const due = await pool.query(
      `select deadline_at > now() as pushed from team_delegation where message_id = $1`, [messageId],
    );
    expect(due.rows[0]!.pushed).toBe(true);

    // **다른 스레드**에서 도는 턴은 이 기다림과 무관하다 — 기한이 다시 지나면 닫힌다.
    await pool.query(
      `update team_delegation set deadline_at = now() - interval '1 second' where message_id = $1`,
      [messageId],
    );
    const elsewhere = [{ agentAccountId: oneId, threadRootId: 'other-thread' }];
    await createDelegationDeadlineSweeper(pool, { runningTurns: () => elsewhere }).sweep();
    expect(await outcomes(messageId)).toEqual({ done1: 'timeout' });

    await oneClient.close(); await leadClient.close();
  });

  it('7. 라운드 상한에 걸리고, 사람이 말하면 리셋된다', async () => {
    const rootId = await openThread('@delegteam 라운드');
    const leadClient = await mcpClient(leadPat);
    const oneClient = await mcpClient(onePat);

    for (let i = 0; i < 3; i++) {
      const ok = text(await leadClient.callTool({
        name: 'message.delegate',
        arguments: { channelId, threadRootId: rootId, body: `${i + 1}번째`, to: ['done1'] },
      }));
      expect(ok.delegated).toEqual(['done1']);
    }

    // 넷째부터는 사람이 봐야 하는 상태다. `MENTION_CHAIN_LIMIT` 은 이 왕복을 못 막으므로
    // (돌아오는 길이 멘션이 아니라 깨움이다) 이 상한이 유일한 장치다.
    const refused = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '4번째', to: ['done1'] },
    }));
    expect((refused.error as { code: string }).code).toBe('round_limit');

    // 사람이 한마디 하면 리셋된다 — 상한이 스레드를 영구히 잠그지 않는다(043 과 같은 규칙).
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
      payload: { body: '계속해라', threadRootId: rootId },
    });
    const again = text(await leadClient.callTool({
      name: 'message.delegate',
      arguments: { channelId, threadRootId: rootId, body: '리셋 뒤', to: ['done1'] },
    }));
    expect(again.delegated).toEqual(['done1']);

    await oneClient.close(); await leadClient.close();
  });
});

/**
 * 위임을 팀 밖으로 열고 끝 보고만 의무를 닫는다(162, 소유자 결정 2026-11-06).
 * 넘긴 쪽을 깨우는 다른 길(실패·기한·중단)은 팀 없는 위임에서도 그대로여야 한다.
 */
describe('팀 밖 위임 · 끝 보고만 닫음', () => {
  /** `done1` 은 팀장이 아니다 — `dtwo` 에게 넘기면 팀 없는 위임이 된다. */
  async function handOff(body: string): Promise<{ rootId: string; messageId: string; one: Client; two: Client }> {
    const rootId = await openThread(body);
    const one = await mcpClient(onePat);
    const two = await mcpClient(twoPat);
    const res = text(await one.callTool({ name: 'message.delegate', arguments: { channelId, threadRootId: rootId, body: '맡긴다', to: ['dtwo'] } }));
    expect(res.delegated).toEqual(['dtwo']);
    return { rootId, messageId: (res.message as { id: string }).id, one, two };
  }
  const expire = (messageId: string) => pool.query(`update team_delegation set deadline_at = now() - interval '1 second' where message_id = $1`, [messageId]);
  const deadlineOf = async (messageId: string) => new Date((await pool.query(`select deadline_at from team_delegation where message_id = $1`, [messageId])).rows[0]!.deadline_at as string);

  it('팀장이 아닌 에이전트도 넘긴다 — 팀 칸은 비고, 담당의 항목에 넘긴 쪽이 실린다', async () => {
    const { messageId, one, two } = await handOff('팀 없이');
    expect((await pool.query(`select team_id from team_delegation where message_id = $1`, [messageId])).rows[0]!.team_id).toBeNull();
    expect(await inboxReasons(twoId, messageId)).toEqual(['team_delegated']);
    const inbox = text(await two.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    const entry = (inbox.entries as Array<{ messageId: string; delegatedBy?: { leadHandle: string; teamName: string | null } }>).find((e) => e.messageId === messageId);
    expect(entry?.delegatedBy).toMatchObject({ leadHandle: 'done1', teamName: null });
    await one.close(); await two.close();
  });

  it('호출 범위에 막힌 상대에게는 넘기지 못하고 글도 남지 않는다', async () => {
    const { accountId: closedId } = await createAgent(app, adminToken, 'dclosed');
    const updated = await pool.query(`update agent_config set invoke_scope = 'list' where account_id = $1`, [closedId]);
    expect(updated.rowCount).toBe(1);
    const closed = await mcpClient(onePat);
    const rootId = await openThread('막힌 상대');
    const res = text(await closed.callTool({ name: 'message.delegate', arguments: { channelId, threadRootId: rootId, body: '넘긴다', to: ['dclosed'] } }));
    expect(res.error).toMatchObject({ code: 'not_invokable', handles: ['dclosed'] });
    const rows = await pool.query(`select 1 from team_delegation where thread_root_id = $1`, [rootId]);
    expect(rows.rowCount).toBe(0);
    const posted = await pool.query(`select 1 from message where thread_root_id = $1`, [rootId]);
    expect(posted.rowCount).toBe(0);
    await closed.close();
  });

  it('보통 답글은 닫지 않고 기한만 민다 — 끝 보고가 닫고 넘긴 쪽을 한 번 깨운다', async () => {
    const { rootId, messageId, one, two } = await handOff('보고만 닫는다');
    await expire(messageId);
    await two.callTool({ name: 'message.post', arguments: { channelId, threadRootId: rootId, body: '시작한다' } });
    expect(await outcomes(messageId)).toEqual({ dtwo: null });
    expect(await inboxReasons(oneId, messageId)).toEqual([]);
    expect((await deadlineOf(messageId)).getTime()).toBeGreaterThan(Date.now());

    await two.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝', checks: ['확인'] } });
    expect(await outcomes(messageId)).toEqual({ dtwo: 'done' });
    expect(await inboxReasons(oneId, messageId)).toEqual(['delegation_done']);
    await two.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '또 끝', checks: ['확인'] } });
    expect(await inboxReasons(oneId, messageId)).toEqual(['delegation_done']);
    await one.close(); await two.close();
  });

  it('실패(침묵 종료가 러너를 거쳐 오는 길)는 실패로 닫고 넘긴 쪽을 깨운다', async () => {
    const { rootId, messageId, one, two } = await handOff('실패');
    await two.callTool({ name: 'message.fail', arguments: { channelId, threadRootId: rootId, body: '넘겨받은 일에 답을 남기지 못하고 끝났습니다', retryable: true } });
    expect(await outcomes(messageId)).toEqual({ dtwo: 'failed' });
    expect(await inboxReasons(oneId, messageId)).toEqual(['delegation_done']);
    await one.close(); await two.close();
  });

  it('기한 스위퍼는 신호가 없으면 무응답으로 닫고 넘긴 쪽을 깨운다', async () => {
    const { messageId, one, two } = await handOff('기한');
    await expire(messageId);
    await createDelegationDeadlineSweeper(pool).sweep();
    expect(await outcomes(messageId)).toEqual({ dtwo: 'timeout' });
    expect(await inboxReasons(oneId, messageId)).toEqual(['delegation_done']);
    await one.close(); await two.close();
  });

  it('사람이 담당을 중단하면 취소로 닫고 넘긴 쪽을 깨운다', async () => {
    const { rootId, messageId, one, two } = await handOff('중단');
    const client = await pool.connect();
    try {
      await client.query('begin');
      expect(await cancelDelegationsFor(client, { threadRootId: rootId, accountId: twoId })).toEqual([oneId]);
      await client.query('commit');
    } finally { client.release(); }
    expect(await outcomes(messageId)).toEqual({ dtwo: 'canceled' });
    expect(await inboxReasons(oneId, messageId)).toEqual(['delegation_done']);
    await one.close(); await two.close();
  });

  it('담당의 예약이 남아 있으면 기한이 지나도 닫지 않고 그 시각 뒤로 민다', async () => {
    const { rootId, messageId, one, two } = await handOff('예약');
    const wake = await scheduleWake(pool, { accountId: twoId, channelId, threadRootId: rootId, notBeforeSec: 3000, reason: 'CI 확인' });
    await expire(messageId);
    await createDelegationDeadlineSweeper(pool).sweep();
    expect(await outcomes(messageId)).toEqual({ dtwo: null });
    expect((await deadlineOf(messageId)).getTime()).toBeGreaterThan(new Date(wake.wake!.wakeAt).getTime());
    await one.close(); await two.close();
  });

  it('담당의 물음이 열려 있으면 닫지 않고, 답이 나면 다시 기한으로 닫는다', async () => {
    const { rootId, messageId, one, two } = await handOff('물음');
    const asked = text(await two.callTool({
      name: 'message.ask',
      arguments: { channelId, threadRootId: rootId, body: '어느 쪽?', prompt: '어느 쪽?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    }));
    expect(asked.error).toBeUndefined();
    await expire(messageId);
    await createDelegationDeadlineSweeper(pool).sweep();
    expect(await outcomes(messageId)).toEqual({ dtwo: null });

    await pool.query(`update message set meta = jsonb_set(meta, '{ask,answeredWith}', '"a"') where id = $1`, [(asked.message as { id: string }).id]);
    await expire(messageId);
    await createDelegationDeadlineSweeper(pool).sweep();
    expect(await outcomes(messageId)).toEqual({ dtwo: 'timeout' });
    await one.close(); await two.close();
  });

  it('기다림에도 끝이 있다 — 상한이 지나면 예약이 남아도 기한으로 닫는다', async () => {
    const { rootId, messageId, one, two } = await handOff('상한');
    await scheduleWake(pool, { accountId: twoId, channelId, threadRootId: rootId, notBeforeSec: 3000, reason: '또 확인' });
    await pool.query(
      `update team_delegation set created_at = now() - ($2::int * interval '1 second'), deadline_at = now() - interval '1 second' where message_id = $1`,
      [messageId, DELEGATION_WAIT_MAX_SEC + 60],
    );
    await createDelegationDeadlineSweeper(pool).sweep();
    expect(await outcomes(messageId)).toEqual({ dtwo: 'timeout' });
    expect(await inboxReasons(oneId, messageId)).toEqual(['delegation_done']);
    await one.close(); await two.close();
  });

  it('연쇄 상한에 닿은 글이면 팀 밖 위임을 막는다', async () => {
    const { messageId, one, two } = await handOff('연쇄');
    const client = await pool.connect();
    try {
      expect(await delegationChainCapped(client, messageId)).toBe(false);
      await client.query(`update message set mention_depth = 1000 where id = $1`, [messageId]);
      expect(await delegationChainCapped(client, messageId)).toBe(true);
      await client.query(`update message set mention_depth = 0, chain_started_at = now() - interval '30 days' where id = $1`, [messageId]);
      expect(await delegationChainCapped(client, messageId)).toBe(true);
    } finally { client.release(); }
    await one.close(); await two.close();
  });

  describe('결말이 예약을 접는다(2026-11-06)', () => {
    const isOpen = async (wakeId: string) => (await pool.query(
      `select fired_at is null and canceled_at is null as open from agent_wake where id = $1`, [wakeId],
    )).rows[0]!.open as boolean;
    const delegationIdOf = async (messageId: string) => (await pool.query(`select id from team_delegation where message_id = $1`, [messageId])).rows[0]!.id as string;
    const leadWake = async (threadRootId: string, reason: string, extra: { delegationId?: string; reportTo?: { channelId: string; threadRootId: string }; watch?: boolean } = {}) => {
      const r = await scheduleWake(pool, { accountId: oneId, channelId, threadRootId, notBeforeSec: 3000, reason, ...extra });
      expect(r.refusal).toBeUndefined();
      return r.wake!.id;
    };

    it('이 위임을 적은 예약과 이 스레드로 보고하는 예약을 접고, 다른 일의 예약은 남긴다 — 깨어난 턴이 접힌 줄을 받는다', async () => {
      const { rootId, messageId, one, two } = await handOff('접기');
      const delegationId = await delegationIdOf(messageId);
      const otherThread = await openThread('다른 스레드');
      const elsewhere = await openThread('또 다른 스레드');
      const tagged = await leadWake(otherThread, '이 위임 확인', { delegationId });
      const reporting = await leadWake(otherThread, '이 스레드로 보고', { reportTo: { channelId, threadRootId: rootId }, watch: true });
      const anchored = await leadWake(rootId, '이 스레드에 건 예약');
      const unrelated = await leadWake(elsewhere, '다른 일');

      await two.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝', checks: ['확인'] } });

      expect(await isOpen(tagged)).toBe(false);
      expect(await isOpen(reporting)).toBe(false);
      expect(await isOpen(anchored)).toBe(false);
      expect(await isOpen(unrelated)).toBe(true);

      const inbox = text(await one.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
      const entry = (inbox.entries as Array<{ messageId: string; reason: string; canceledWakes?: Array<{ reason: string }> }>)
        .find((e) => e.messageId === messageId && e.reason === 'delegation_done');
      expect((entry?.canceledWakes ?? []).map((w) => w.reason).sort()).toEqual(['이 스레드로 보고', '이 스레드에 건 예약', '이 위임 확인'].sort());
      await one.close(); await two.close();
    });

    it('아직 안 끝난 위임을 적은 예약은 같은 스레드의 다른 위임 결말로 접히지 않는다', async () => {
      const { rootId, messageId, one, two } = await handOff('둘');
      const leadOnline = await mcpClient(leadPat);
      const again = text(await one.callTool({ name: 'message.delegate', arguments: { channelId, threadRootId: rootId, body: '또 맡긴다', to: ['dlead'] } }));
      expect(again.delegated).toEqual(['dlead']);
      const otherId = again.delegationId as string;
      const wake = await leadWake(rootId, '둘째 위임 확인', { delegationId: otherId });

      await two.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝', checks: ['확인'] } });
      expect(await outcomes(messageId)).toEqual({ dtwo: 'done' });
      expect(await isOpen(wake)).toBe(true);

      await leadOnline.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝', checks: ['확인'] } });
      expect(await isOpen(wake)).toBe(false);
      await leadOnline.close(); await one.close(); await two.close();
    });

    it('접은 줄에 canceledAt 을 적고 message.updated 로 알린다', async () => {
      const { rootId, messageId, one, two } = await handOff('시각 적기');
      const r = await scheduleWake(pool, { accountId: oneId, channelId, threadRootId: rootId, notBeforeSec: 3000, reason: '확인', delegationId: await delegationIdOf(messageId) });
      const seen: WorkspaceEvent[] = [];
      const off = onEvent((e) => seen.push(e));
      try {
        await two.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝', checks: ['확인'] } });
      } finally { off(); }
      const hit = seen.find((e) => e.type === 'message.updated' && e.message.id === r.wake!.messageId);
      expect(hit).toBeTruthy();
      const wake = (hit as Extract<WorkspaceEvent, { type: 'message.updated' }>).message.meta as { wake: { canceledAt?: string; firedAt?: string } };
      expect(typeof wake.wake.canceledAt).toBe('string');
      expect(wake.wake.firedAt).toBeUndefined();
      await one.close(); await two.close();
    });

    it('기한으로 접혀도 시각을 적고 알린다', async () => {
      const { rootId, messageId, one, two } = await handOff('기한 시각');
      const r = await scheduleWake(pool, { accountId: oneId, channelId, threadRootId: rootId, notBeforeSec: 3000, reason: '확인', delegationId: await delegationIdOf(messageId) });
      await expire(messageId);
      const seen: WorkspaceEvent[] = [];
      const off = onEvent((e) => seen.push(e));
      try { await createDelegationDeadlineSweeper(pool).sweep(); } finally { off(); }
      expect(await outcomes(messageId)).toEqual({ dtwo: 'timeout' });
      expect(seen.some((e) => e.type === 'message.updated' && e.message.id === r.wake!.messageId)).toBe(true);
      await one.close(); await two.close();
    });

    it('사람이 담당을 멈춰 접혀도 시각을 적고 알린다', async () => {
      const { rootId, messageId, one, two } = await handOff('중단 시각');
      const r = await scheduleWake(pool, { accountId: oneId, channelId, threadRootId: rootId, notBeforeSec: 3000, reason: '확인', delegationId: await delegationIdOf(messageId) });
      const seen: WorkspaceEvent[] = [];
      const off = onEvent((e) => seen.push(e));
      try { await settleCanceledTurn(pool, { threadRootId: rootId, agentAccountId: twoId }); } finally { off(); }
      expect(seen.some((e) => e.type === 'message.updated' && e.message.id === r.wake!.messageId)).toBe(true);
      await one.close(); await two.close();
    });

    it('실패로 끝나도 접는다', async () => {
      const { rootId, messageId, one, two } = await handOff('실패 접기');
      const wake = await leadWake(rootId, '확인', { delegationId: await delegationIdOf(messageId) });
      await two.callTool({ name: 'message.fail', arguments: { channelId, threadRootId: rootId, body: '못 했다', retryable: true } });
      expect(await isOpen(wake)).toBe(false);
      await one.close(); await two.close();
    });

    it('기한으로 닫혀도 접는다', async () => {
      const { rootId, messageId, one, two } = await handOff('기한 접기');
      const wake = await leadWake(rootId, '확인', { delegationId: await delegationIdOf(messageId) });
      await expire(messageId);
      await createDelegationDeadlineSweeper(pool).sweep();
      expect(await outcomes(messageId)).toEqual({ dtwo: 'timeout' });
      expect(await isOpen(wake)).toBe(false);
      await one.close(); await two.close();
    });

    it('사람이 담당을 중단해도 접는다', async () => {
      const { rootId, messageId, one, two } = await handOff('중단 접기');
      const wake = await leadWake(rootId, '확인', { delegationId: await delegationIdOf(messageId) });
      const client = await pool.connect();
      try {
        await client.query('begin');
        await cancelDelegationsFor(client, { threadRootId: rootId, accountId: twoId });
        await client.query('commit');
      } finally { client.release(); }
      expect(await isOpen(wake)).toBe(false);
      await one.close(); await two.close();
    });

    it('남의 위임이나 이미 끝난 위임은 예약에 적지 못한다', async () => {
      const { rootId, messageId, one, two } = await handOff('남의 위임');
      const delegationId = await delegationIdOf(messageId);
      const mine = await scheduleWake(pool, { accountId: twoId, channelId, threadRootId: rootId, notBeforeSec: 300, reason: '남의 것', delegationId });
      expect(mine.refusal?.code).toBe('bad_delegation');
      await two.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝', checks: ['확인'] } });
      const done = await scheduleWake(pool, { accountId: oneId, channelId, threadRootId: rootId, notBeforeSec: 300, reason: '끝난 것', delegationId });
      expect(done.refusal?.code).toBe('bad_delegation');
      await one.close(); await two.close();
    });

    // 위임 결말이 접는 것은 넘긴 쪽 예약뿐이다. 담당의 예약은 담당 자신의 끝 보고가 접는다(`foldWakesOnReport`) — 까닭 글이 없고 사유가 담당에게 돌아온다.
    it('위임 결말은 담당의 예약을 접지 않는다 — 담당의 끝 보고가 접고 사유를 돌려준다', async () => {
      const { rootId, one, two } = await handOff('담당 예약');
      const r = await scheduleWake(pool, { accountId: twoId, channelId, threadRootId: rootId, notBeforeSec: 3000, reason: '담당의 확인' });
      const res = text(await two.callTool({ name: 'message.report', arguments: { channelId, threadRootId: rootId, body: '끝', checks: ['확인'] } }));
      expect(res.foldedWakes).toEqual([expect.objectContaining({ reason: '담당의 확인' })]);
      const row = await pool.query<{ canceled_by_message_id: string | null }>('select canceled_by_message_id from agent_wake where id = $1', [r.wake!.id]);
      expect(row.rows[0]!.canceled_by_message_id).toBeNull();
      await one.close(); await two.close();
    });
  });
});
