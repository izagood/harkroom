import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { onEvent } from '../src/events.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let botPat: string;
let channelId: string;
let mcpUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
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
      'message.post', 'message.progress', 'message.react', 'message.read', 'message.search', 'message.unreact',
      'work.link', 'workspace.guide',
    ]);

    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: 'hello from mcp' },
    })) as { message: { id: string } };
    const read = text(await client.callTool({
      name: 'message.read', arguments: { channelId },
    })) as { messages: { body: string }[] };
    expect(read.messages.some((m) => m.body === 'hello from mcp')).toBe(true);

    const linked = text(await client.callTool({
      name: 'work.link',
      arguments: { repo: 'mcp-repo', intentOid: 'i-77', threadRootMessageId: posted.message.id },
    }));
    expect(linked).toEqual({ ok: true });
    await client.close();
  });

  it('work.link rejects a thread root that belongs to a different channel (감사 ②)', async () => {
    const otherCh = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'other-ch' },
    });
    const otherChannelId = otherCh.json().id;
    const otherMsg = await app.inject({
      method: 'POST', url: `/channels/${otherChannelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'root in a channel not bound to mcp-repo' },
    });

    const client = await mcpClient(botPat);
    const mismatched = text(await client.callTool({
      name: 'work.link',
      arguments: { repo: 'mcp-repo', intentOid: 'i-wrong-channel', threadRootMessageId: otherMsg.json().id },
    })) as { error?: { code: string } };
    expect(mismatched.error?.code).toBe('invalid_thread');

    const missing = text(await client.callTool({
      name: 'work.link',
      arguments: { repo: 'mcp-repo', intentOid: 'i-missing-root', threadRootMessageId: '00000000-0000-0000-0000-000000000000' },
    })) as { error?: { code: string } };
    expect(missing.error?.code).toBe('invalid_thread');

    const wt = await pool.query(
      `select 1 from work_thread where repo = 'mcp-repo' and intent_oid in ('i-wrong-channel', 'i-missing-root')`,
    );
    expect(wt.rowCount).toBe(0);
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
