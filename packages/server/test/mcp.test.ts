import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { onEvent } from '../src/events.js';
import { readAskMeta, readFailureMeta, readReportMeta } from '@murmur/shared';
import { recordAskAnswer } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminAccountId: string;
let botPat: string;
let channelId: string;
let mcpUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminAccountId } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'mcpbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'mcp-ch', repo: 'mcp-repo' },
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

const text = (r: Awaited<ReturnType<Client['callTool']>>): unknown =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

describe('mcp surface', () => {
  it('rejects human session token', async () => {
    await expect(mcpClient(adminToken)).rejects.toThrow();
  });

  // MCP 도구만으로는 inbox 를 소비할 방법이 없어서, MCP 로만 붙은 에이전트는 같은 멘션에
  // 영원히 반복 응답했다. 루프가 성립하려면 읽음 처리가 같은 표면에 있어야 한다.
  it('marks its own inbox entries read', async () => {
    const client = await mcpClient(botPat);
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@mcpbot 읽음 처리 확인' },
    });
    const before = text(await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } })) as
      { entries: { id: number }[] };
    expect(before.entries.length).toBeGreaterThan(0);

    const marked = text(await client.callTool({
      name: 'inbox.read', arguments: { ids: before.entries.map((e) => e.id) },
    })) as { read: number };
    const after = text(await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } })) as
      { entries: { id: number }[] };

    expect(marked.read).toBe(before.entries.length);
    expect(after.entries).toHaveLength(0);
  });

  // entry id 를 그대로 믿고 지우면 남의 inbox 를 소비할 수 있다.
  it('refuses to consume an inbox entry that belongs to someone else', async () => {
    const other = await createAgent(app, adminToken, 'otherbot');
    const otherClient = await mcpClient(other.pat);
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@otherbot 이건 네 것이다' },
    });
    const theirs = text(await otherClient.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } })) as
      { entries: { id: number }[] };
    expect(theirs.entries.length).toBeGreaterThan(0);

    const client = await mcpClient(botPat);
    const attempt = text(await client.callTool({
      name: 'inbox.read', arguments: { ids: theirs.entries.map((e) => e.id) },
    })) as { read: number };
    const stillTheirs = text(await otherClient.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } })) as
      { entries: { id: number }[] };

    expect(attempt.read).toBe(0);
    expect(stillTheirs.entries.length).toBe(theirs.entries.length);
  });

  it('lists tools, posts and reads messages', async () => {
    const client = await mcpClient(botPat);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'account.me', 'channel.doc', 'channel.list', 'inbox.poll', 'inbox.read',
      'memory.get', 'memory.list', 'memory.set',
      'message.ask', 'message.fail', 'message.post', 'message.progress', 'message.react', 'message.read', 'message.report', 'message.search', 'message.unreact',
      'skill.propose', 'workspace.guide',
    ]);

    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: 'hello from mcp' },
    })) as { message: { id: string } };
    const read = text(await client.callTool({
      name: 'message.read', arguments: { channelId },
    })) as { messages: { body: string }[] };
    expect(read.messages.some((m) => m.body === 'hello from mcp')).toBe(true);
    expect(posted.message.id).toBeTruthy();
    await client.close();
  });

  /**
   * Task 8 Step 2 — 발화 도구는 누구를 불렀는지 함께 준다.
   *
   * REST 는 같은 사실을 **헤더**로 싣는데(`NOTIFIED_HEADER`) 여기는 형제 키다. 모양이 다른
   * 이유는 응답의 모양이 다르기 때문이다: REST 의 POST 응답 본문은 `MessageRow` 그 자체라
   * 형제 키가 그 타입을 오염시키지만, MCP 는 이미 `{ message }` 봉투라 곁에 키를 더해도
   * `MessageRow` 는 그대로다. 그 '그대로'를 아래 마지막 단언이 지킨다.
   */
  it('발화 도구가 notified 를 함께 준다 — message 는 오염되지 않는다', async () => {
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: '<@' + adminAccountId + '> 좀 봐 줘' },
    })) as { message: Record<string, unknown>; notified: string[] };
    expect(posted.notified).toEqual([adminAccountId]);
    // 봉투에만 실린다 — 메시지 자체는 한 글자도 넓어지지 않는다.
    expect(posted.message).not.toHaveProperty('notified');
    await client.close();
  });

  // 에이전트 런타임은 murmur 밖에 있어서 서버가 재시도를 강제할 수 없다. 그래서 "재시작은
  // 정상 이벤트이니 백오프로 다시 걸어라"는 계약을 guide가 문서로 들고 있어야 한다.
  it('states the inbox.poll retry contract in workspace.guide', async () => {
    const client = await mcpClient(botPat);
    const { guide } = text(await client.callTool({ name: 'workspace.guide', arguments: {} })) as { guide: string };
    expect(guide).toMatch(/빈 결과/);
    expect(guide).toMatch(/재시도/);
    expect(guide).toMatch(/재시작|업데이트/);
    await client.close();
  });

  it('inbox.poll returns mention created after the call (long-poll)', async () => {
    const client = await mcpClient(botPat);
    const pending = client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 10_000 } });
    await new Promise((r) => setTimeout(r, 300));
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@mcpbot wake up' },
    });
    const result = text(await pending) as { entries: { reason: string }[] };
    expect(result.entries.some((e) => e.reason === 'mention')).toBe(true);
    await client.close();
  });

  it('adds and removes reactions via MCP', async () => {
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: 'reaction test' },
    })) as { message: { id: string } };
    const msgId = posted.message.id;

    const added = text(await client.callTool({
      name: 'message.react', arguments: { channelId, messageId: msgId, emoji: '👀' },
    })) as { emoji: string };
    expect(added.emoji).toBe('👀');

    const msgs = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const target = msgs.json().messages.find((m: { id: string }) => m.id === msgId);
    expect(target.reactions).toContainEqual(expect.objectContaining({ emoji: '👀', accountIds: expect.any(Array) }));

    const removed = text(await client.callTool({
      name: 'message.unreact', arguments: { channelId, messageId: msgId, emoji: '👀' },
    })) as { ok: boolean };
    expect(removed.ok).toBe(true);

    const afterRemove = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const afterTarget = afterRemove.json().messages.find((m: { id: string }) => m.id === msgId);
    expect(afterTarget.reactions).not.toContainEqual(expect.objectContaining({ emoji: '👀' }));
    await client.close();
  });

  it('rejects non-emoji in message.react', async () => {
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: 'emoji test' },
    })) as { message: { id: string } };

    const invalid = text(await client.callTool({
      name: 'message.react', arguments: { channelId, messageId: posted.message.id, emoji: ':)' },
    })) as { error?: { code: string } };
    expect(invalid.error?.code).toBe('bad_request');

    const invalid2 = text(await client.callTool({
      name: 'message.react', arguments: { channelId, messageId: posted.message.id, emoji: 'react' },
    })) as { error?: { code: string } };
    expect(invalid2.error?.code).toBe('bad_request');
    await client.close();
  });

  it('rejects reaction on invisible DM channel', async () => {
    const { accountId: otherId } = await createAgent(app, adminToken, 'dmpair');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [otherId] },
    });
    const dmChannelId = dm.json().id;
    const dmMsg = await app.inject({
      method: 'POST', url: `/channels/${dmChannelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'dm msg' },
    });

    const client = await mcpClient(botPat);
    const attempt = text(await client.callTool({
      name: 'message.react', arguments: { channelId: dmChannelId, messageId: dmMsg.json().id, emoji: '👀' },
    })) as { error?: { code: string } };
    expect(attempt.error?.code).toBe('forbidden');
    await client.close();
  });

  it('same actor adding same emoji twice counts as one (REST contract)', async () => {
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: 'double react test' },
    })) as { message: { id: string } };
    const msgId = posted.message.id;

    await client.callTool({ name: 'message.react', arguments: { channelId, messageId: msgId, emoji: '💬' } });
    await client.callTool({ name: 'message.react', arguments: { channelId, messageId: msgId, emoji: '💬' } });

    const msgs = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const target = msgs.json().messages.find((m: { id: string }) => m.id === msgId);
    const reactionCount = target.reactions.filter((r: { emoji: string }) => r.emoji === '💬').length;
    expect(reactionCount).toBe(1);
    await client.close();
  });

  it('rejects when actor exceeds MAX_REACTIONS_PER_ACTOR', async () => {
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: 'limit test' },
    })) as { message: { id: string } };
    const msgId = posted.message.id;

    const emojis = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','☺','😚','😙'];
    for (const emoji of emojis) {
      await client.callTool({ name: 'message.react', arguments: { channelId, messageId: msgId, emoji } });
    }

    const oneMore = text(await client.callTool({
      name: 'message.react', arguments: { channelId, messageId: msgId, emoji: '🤔' },
    })) as { error?: { code: string } };
    expect(oneMore.error?.code).toBe('too_many_reactions');
    await client.close();
  });
});

// REST 라우트는 리액션에 대해 WS 이벤트를 낸다 — MCP 도구가 그걸 빠뜨리면 리액션은 DB 에만
// 남고 붙어 있는 데스크탑은 다시 조회할 때까지 못 본다. 에이전트가 👀 를 다는 목적이
// "사람이 지금 본다"인데 그 목적이 사라진다(#99). 두 표면이 같은 규칙을 갖는다는 계약이다.
describe('MCP 리액션이 실시간 이벤트를 낸다', () => {
  it('message.react / message.unreact 가 reaction 이벤트를 낸다', async () => {
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: '리액션 이벤트 대상' },
    })) as { message: { id: string } };
    const messageId = posted.message.id;

    const seen: { type: string; messageId?: string; emoji?: string }[] = [];
    const stop = onEvent((e) => seen.push(e as { type: string; messageId?: string; emoji?: string }));
    try {
      await client.callTool({ name: 'message.react', arguments: { channelId, messageId, emoji: '👀' } });
      await client.callTool({ name: 'message.unreact', arguments: { channelId, messageId, emoji: '👀' } });
    } finally {
      stop();
      await client.close();
    }

    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reaction.added', messageId, emoji: '👀' }),
      expect.objectContaining({ type: 'reaction.removed', messageId, emoji: '👀' }),
    ]));
  });
});

/*
 * `#381` 회귀선(투영이 꺼진 것을 `work.link` 가 말하되 거절하지 않는다)을 걷어냈다.
 * 지키던 도구가 사라졌으므로 지킬 성질도 없다 — 단언을 뒤집은 것이 아니라 대상이 없다.
 *
 * `work.link` 검증선 셋과 감사 ② 의 채널 불일치 거절선이 함께 사라졌다. 그것들은 모두
 * "intent 를 어느 스레드에 묶는가"를 지켰다: 남의 채널 뿌리로는 못 묶는다, 없는 뿌리로는
 * 못 묶는다, 투영이 꺼져 있어도 매핑 행은 남는다. 묶을 대상이 없어졌다.
 *
 * `#381` 이 세운 **진짜 성질**은 도구와 함께 사라지지 않았다: "투영이 꺼진 것을 사람에게
 * 말한다." 그 자리는 화면 배너(`PROJECTION_UNCONFIGURED_NOTICE`)로 남아 있고
 * `desktop/test/sidebar.test.tsx` 가 지킨다 — repo 를 채널에 붙이는 사람에게 그 상태를
 * 말하는 자리다. 에이전트에게 말해 줄 이유가 사라진 것은 에이전트가 부를 도구가
 * 없어졌기 때문이고, 그 사실은 MCP 가 "그런 도구 없음"으로 정직하게 답한다.
 *
 * 도구 목록 단언(`lists tools, posts and reads messages`)이 `work.link` 의 부재를
 * 지킨다 — 껍데기로 되살아나면 그 단언이 빨개진다.
 */

/**
 * 선택 요청(`message.ask`) — 이 계획의 단일 최우선 항목이다. 발행·답·중복 거절과,
 * **모르는 meta 는 평문으로 흘린다**는 불변식을 고정한다.
 */
describe('message.ask — 선택 요청의 계약', () => {
  it('선택지를 발행하고 수신자를 meta 에 싣는다', async () => {
    const client = await mcpClient(botPat);
    try {
      const posted = text(await client.callTool({
        name: 'message.ask',
        arguments: {
          channelId, body: '008 이 이미 배포됐는지 내가 모른다',
          options: [
            { id: 'new', label: '새 마이그레이션 009', hint: '되돌리기 쉽다' },
            { id: 'edit', label: '008 을 고친다' },
          ],
        },
      })) as { message: { id: string; meta: Record<string, unknown> } };

      const ask = readAskMeta(posted.message.meta);
      expect(ask).not.toBeNull();
      expect(ask!.options.map((o) => o.id)).toEqual(['new', 'edit']);
      // to 를 비우면 '사람 아무나'다 — 옵셔널이 아니라 기본값이 있는 것이다.
      expect(ask!.to).toEqual({ kind: 'human' });
      expect(ask!.answeredWith).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('to 로 handle 을 주면 그 계정으로 풀고, 없는 handle 은 거절한다', async () => {
    const client = await mcpClient(botPat);
    try {
      const { accountId: forgeId } = await createAgent(app, adminToken, 'askforge');
      const posted = text(await client.callTool({
        name: 'message.ask',
        arguments: {
          channelId, body: '스키마는 네가 정해라', to: '@askforge',
          options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        },
      })) as { message: { meta: Record<string, unknown> } };
      expect(readAskMeta(posted.message.meta)!.to).toEqual({ kind: 'account', accountId: forgeId });

      // 아무도 답할 수 없는 물음을 저장하는 것은 조용한 실패다.
      const bad = text(await client.callTool({
        name: 'message.ask',
        arguments: {
          channelId, body: '없는 대상', to: '@nobody-here',
          options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        },
      })) as { error?: { code: string } };
      expect(bad.error?.code).toBe('unknown_handle');
    } finally {
      await client.close();
    }
  });

  it('옵션 수와 중복 id 를 발행 시점에 거절한다', async () => {
    const client = await mcpClient(botPat);
    try {
      // 하나면 선택이 아니다 — zod 스키마가 막는다. SDK 는 던지지 않고 `isError` 결과를
      // 돌려주므로(실측) 그 형태로 고정한다.
      const tooFew = await client.callTool({
        name: 'message.ask',
        arguments: { channelId, body: '하나', options: [{ id: 'a', label: 'A' }] },
      });
      expect(tooFew.isError).toBe(true);
      expect(JSON.stringify(tooFew.content)).toContain('at least 2');

      const dup = text(await client.callTool({
        name: 'message.ask',
        arguments: {
          channelId, body: '겹친 id',
          options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }],
        },
      })) as { error?: { code: string } };
      expect(dup.error?.code).toBe('duplicate_option');
    } finally {
      await client.close();
    }
  });

  it('답을 기록하고, 두 번째 답은 거절한다 (먼저 온 것이 이긴다)', async () => {
    const client = await mcpClient(botPat);
    try {
      const posted = text(await client.callTool({
        name: 'message.ask',
        arguments: {
          channelId, body: '골라 줘',
          options: [{ id: 'new', label: '새 마이그레이션' }, { id: 'edit', label: '008 수정' }],
        },
      })) as { message: { id: string } };

      const answered = await recordAskAnswer(pool, {
        messageId: posted.message.id, actorId: adminAccountId, optionId: 'new',
      });
      expect(typeof answered).not.toBe('string');
      const ask = readAskMeta((answered as { meta: Record<string, unknown> }).meta)!;
      expect(ask.answeredWith).toBe('new');
      expect(ask.answeredBy).toBe(adminAccountId);
      expect(ask.answeredAt).toBeTruthy();

      // 두 번째 답은 경합에서 진 것이다 — 원본을 덮어쓰지 않는다.
      expect(await recordAskAnswer(pool, {
        messageId: posted.message.id, actorId: adminAccountId, optionId: 'edit',
      })).toBe('already_answered');

      // 없는 옵션으로 답할 수는 없다.
      const other = text(await client.callTool({
        name: 'message.ask',
        arguments: { channelId, body: '다른 것', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
      })) as { message: { id: string } };
      expect(await recordAskAnswer(pool, {
        messageId: other.message.id, actorId: adminAccountId, optionId: 'zzz',
      })).toBe('unknown_option');
    } finally {
      await client.close();
    }
  });

  it('수신자가 정해진 물음은 그 계정만 답한다', async () => {
    const client = await mcpClient(botPat);
    try {
      const { accountId: otherId } = await createAgent(app, adminToken, 'askother');
      const posted = text(await client.callTool({
        name: 'message.ask',
        arguments: {
          channelId, body: '네가 골라라', to: '@askother',
          options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        },
      })) as { message: { id: string } };

      // 남에게 간 물음을 가로채면 `to` 를 실은 뜻이 사라진다.
      expect(await recordAskAnswer(pool, {
        messageId: posted.message.id, actorId: adminAccountId, optionId: 'a',
      })).toBe('forbidden');

      const ok = await recordAskAnswer(pool, {
        messageId: posted.message.id, actorId: otherId, optionId: 'a',
      });
      expect(typeof ok).not.toBe('string');
    } finally {
      await client.close();
    }
  });

  /**
   * **회귀선: 모르는 meta 는 평문으로 흘린다.** 구/신 버전 조합(러너 × 서버 × 데스크탑)의
   * 안전은 이 성질에 달려 있다 — 형식을 못 알아보면 상자를 그리지 않고 본문만 보여 준다.
   */
  it('형식이 깨진 ask meta 는 못 알아본 것으로 취급한다', async () => {
    expect(readAskMeta(undefined)).toBeNull();
    expect(readAskMeta({})).toBeNull();
    expect(readAskMeta({ kind: 'ask' })).toBeNull();
    // 옵션이 하나면 선택이 아니다 — 읽는 쪽에서도 경계를 지킨다.
    expect(readAskMeta({ kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }], to: { kind: 'human' } } })).toBeNull();
    // 수신자를 못 읽으면 그리지 않는다: '사람 아무나'로 넘기면 남의 물음이 내 화면에서 강조된다.
    expect(readAskMeta({ kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } })).toBeNull();
    expect(readAskMeta({
      kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'nope' } },
    })).toBeNull();
    // 알아보는 최소 형태.
    expect(readAskMeta({
      kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'human' } },
    })).not.toBeNull();
  });
});

/**
 * 실패(`message.fail`) — 여덟 가지 말 중 유일하게 **에이전트가 먼저 사람을 부르는** 말이다.
 * 수신자를 싣지 않는 것이 이 어휘의 요점이므로, 그 사실을 계약으로 고정한다.
 */
describe('message.fail — 실패의 계약', () => {
  it('실패를 싣고 retryable 을 기록한다', async () => {
    const client = await mcpClient(botPat);
    try {
      const posted = text(await client.callTool({
        name: 'message.fail',
        arguments: {
          channelId, body: '마이그레이션을 끝내지 못했다',
          what: '008 적용', reason: '스테이징 DB 에 붙지 못했다', retryable: true,
        },
      })) as { message: { meta: Record<string, unknown> } };

      const failure = readFailureMeta(posted.message.meta);
      expect(failure).not.toBeNull();
      expect(failure!.retryable).toBe(true);
      expect(failure!.what).toBe('008 적용');
      expect(failure!.reason).toBe('스테이징 DB 에 붙지 못했다');
      // **수신자 필드가 없다** — 실패의 수신자는 언제나 사람이므로 실을 것이 없다.
      expect((failure as unknown as { to?: unknown }).to).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('retryable 을 빠뜨리면 거절한다 — 서버가 기본값을 정하지 않는다', async () => {
    const client = await mcpClient(botPat);
    try {
      // true 로 치면 소용없는 실패에 버튼이 생기고, false 로 치면 고칠 수 있는 실패의
      // 경로가 사라진다. 둘 다 거짓 신호이므로 보내는 쪽이 반드시 정해야 한다.
      const res = await client.callTool({
        name: 'message.fail', arguments: { channelId, body: '실패했다' },
      });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('what·reason 없이도 성립한다 — 러너가 죽으면 이유를 남길 자가 없다', async () => {
    const client = await mcpClient(botPat);
    try {
      const posted = text(await client.callTool({
        name: 'message.fail', arguments: { channelId, body: '러너가 죽었다', retryable: false },
      })) as { message: { meta: Record<string, unknown> } };
      const failure = readFailureMeta(posted.message.meta)!;
      expect(failure.retryable).toBe(false);
      expect(failure.what).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('형식이 깨진 failure meta 는 못 알아본 것으로 취급한다', () => {
    expect(readFailureMeta(undefined)).toBeNull();
    expect(readFailureMeta({ kind: 'failure' })).toBeNull();
    // retryable 이 boolean 이 아니면 기본값을 정해 주지 않고 못 알아본 것으로 친다.
    expect(readFailureMeta({ kind: 'failure', failure: {} })).toBeNull();
    expect(readFailureMeta({ kind: 'failure', failure: { retryable: 'yes' } })).toBeNull();
    expect(readFailureMeta({ kind: 'failure', failure: { retryable: true } })).not.toBeNull();
  });
});

/**
 * 완료 보고(`message.report`) — 읽히는 말(규칙 03). `checks` 만 필수인 것이 이 계약의
 * 요점이다: 무엇을 확인했는지 없는 보고는 보고가 아니다.
 */
describe('message.report — 완료 보고의 계약', () => {
  it('확인·파일·남은 것·다음 제안을 싣는다', async () => {
    const client = await mcpClient(botPat);
    try {
      const posted = text(await client.callTool({
        name: 'message.report',
        arguments: {
          channelId, body: 'ws 쪽을 끝냈다',
          checks: ['연속 미응답만 끊는다', '회귀 테스트로 고정'],
          files: ['ws/heartbeat.test.ts'],
          remaining: ['lint 를 다시 부를지'],
          durationMs: 400000,
          next: [{ id: 'lint', label: 'lint 를 다시 불러 줘' }],
        },
      })) as { message: { meta: Record<string, unknown> } };

      const report = readReportMeta(posted.message.meta);
      expect(report).not.toBeNull();
      expect(report!.checks).toHaveLength(2);
      expect(report!.files).toEqual(['ws/heartbeat.test.ts']);
      expect(report!.next).toEqual([{ id: 'lint', label: 'lint 를 다시 불러 줘' }]);
    } finally {
      await client.close();
    }
  });

  it('checks 없이는 발행되지 않는다 — 확인 없는 보고는 보고가 아니다', async () => {
    const client = await mcpClient(botPat);
    try {
      const res = await client.callTool({
        name: 'message.report', arguments: { channelId, body: '끝났다' },
      });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('빈 묶음은 meta 에 싣지 않는다 — 없는 것은 자리를 차지하지 않는다', async () => {
    const client = await mcpClient(botPat);
    try {
      const posted = text(await client.callTool({
        name: 'message.report',
        arguments: { channelId, body: '끝', checks: ['하나'], files: [], next: [] },
      })) as { message: { meta: Record<string, unknown> } };
      const report = readReportMeta(posted.message.meta)!;
      expect(report.files).toBeUndefined();
      expect(report.next).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('형식이 깨진 report meta 는 못 알아본 것으로 취급한다', () => {
    expect(readReportMeta(undefined)).toBeNull();
    expect(readReportMeta({ kind: 'report' })).toBeNull();
    // checks 가 비면 조용히 사라진다 — 빈 상자는 거짓 신호다.
    expect(readReportMeta({ kind: 'report', report: { checks: [] } })).toBeNull();
    expect(readReportMeta({ kind: 'report', report: { files: ['a.ts'] } })).toBeNull();
    expect(readReportMeta({ kind: 'report', report: { checks: ['하나'] } })).not.toBeNull();
  });
});
