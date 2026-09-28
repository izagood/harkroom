import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let base: string;

let agent1Pat: string;
let agent1Id: string;
let agent2Pat: string;
let agent2Id: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: agent1Id, pat: agent1Pat } = await createAgent(app, adminToken, 'agent-1'));
  ({ accountId: agent2Id, pat: agent2Pat } = await createAgent(app, adminToken, 'agent-2'));
});
afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }) as { content: { type: 'text'; text: string }[] };
  const text = result.content[0]?.text;
  if (!text) throw new Error('no content');
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'mcp_error', message: text } };
  }
}

describe('memory MCP tools', () => {
  it('set then get returns the value', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const setResult = await callTool(client, 'memory.set', { slug: 'core', value: 'hello world' });
      expect(setResult).toEqual({ ok: true });

      const getResult = await callTool(client, 'memory.get', { slug: 'core' });
      expect(getResult).toEqual({
        slug: 'core',
        value: 'hello world',
        updatedAt: expect.any(String),
      });
    } finally {
      await client.close();
    }
  });

  it('set(slug, null) deletes the memory', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'memory.set', { slug: 'mem/todelete', value: 'to be deleted' });
      const getBefore = await callTool(client, 'memory.get', { slug: 'mem/todelete' });
      expect(getBefore.value).toBe('to be deleted');

      const deleteResult = await callTool(client, 'memory.set', { slug: 'mem/todelete', value: null });
      expect(deleteResult).toEqual({ ok: true });

      const getAfter = await callTool(client, 'memory.get', { slug: 'mem/todelete' });
      expect(getAfter.error?.code).toBe('not_found');
    } finally {
      await client.close();
    }
  });

  // 삭제는 멱등이다. inbox 가 at-least-once 라 같은 지시가 두 번 처리될 수 있고,
  // 그때 재삭제가 에러로 오면 성공한 작업이 실패로 기록된다.
  it('deleting an absent memory succeeds (idempotent)', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const first = await callTool(client, 'memory.set', { slug: 'mem/never-existed', value: null });
      expect(first).toEqual({ ok: true });

      await callTool(client, 'memory.set', { slug: 'mem/twice', value: 'x' });
      await callTool(client, 'memory.set', { slug: 'mem/twice', value: null });
      const again = await callTool(client, 'memory.set', { slug: 'mem/twice', value: null });
      expect(again).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });

  it('list returns only slugs, not values', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'memory.set', { slug: 'mem/listtest1', value: 'secret data' });
      await callTool(client, 'memory.set', { slug: 'mem/listtest2', value: 'another secret' });

      const listResult = await callTool(client, 'memory.list', {});
      expect(listResult.slugs).toContain('mem/listtest1');
      expect(listResult.slugs).toContain('mem/listtest2');
      expect(listResult.slugs.length).toBeGreaterThanOrEqual(2);
      // rev 는 판본 해시다(러너 캐시용) — 값이 아니므로 "값을 주지 않는다"는 그대로다.
      expect(Object.keys(listResult).sort()).toEqual(['entries', 'rev', 'slugs']);
      expect(JSON.stringify(listResult)).not.toContain('secret data');
    } finally {
      await client.close();
    }
  });

  // 러너 메모리 캐시(2026-09-28): 러너는 rev 가 자기 사본과 같으면 core 를 다시 받지 않는다.
  // 그러니 **내용이 바뀌는 모든 쓰기가 rev 를 바꿔야 하고**, 안 바뀌면 rev 도 그대로여야 한다.
  it('list rev changes on add, update and delete, and is stable otherwise', async () => {
    const { pat } = await createAgent(app, adminToken, 'rev-agent');
    const client = await mcpClient(pat);
    const rev = async () => (await callTool(client, 'memory.list', {})).rev as string;
    try {
      expect(await rev()).toBe('empty');
      await callTool(client, 'memory.set', { slug: 'core', value: 'a' });
      const afterAdd = await rev();
      expect(afterAdd).not.toBe('empty');
      expect(await rev()).toBe(afterAdd);

      await callTool(client, 'memory.set', { slug: 'core', value: 'b' });
      const afterUpdate = await rev();
      expect(afterUpdate).not.toBe(afterAdd);

      await callTool(client, 'memory.set', { slug: 'mem/x', value: 'x' });
      const afterSecond = await rev();
      await callTool(client, 'memory.set', { slug: 'mem/x', value: null });
      const afterDelete = await rev();
      expect(afterDelete).not.toBe(afterSecond);
      expect(afterDelete).toBe(afterUpdate);
    } finally {
      await client.close();
    }
  });

  // 메모리 고도화 PR3: core 는 매 턴 실리므로 한도가 따로다. 거절은 "어떻게 하라"를 싣는다.
  it('rejects core over the core limit with a how-to, allows it exactly', async () => {
    const { pat } = await createAgent(app, adminToken, 'core-limit-agent');
    const client = await mcpClient(pat);
    try {
      const over = await callTool(client, 'memory.set', { slug: 'core', value: 'x'.repeat(3001) });
      expect(over.error?.code).toBe('core_too_long');
      expect(over.error?.message).toContain('mem/');
      expect(await callTool(client, 'memory.set', { slug: 'core', value: 'x'.repeat(3000) })).toEqual({ ok: true });
      // mem/* 는 여전히 8000 까지다.
      expect(await callTool(client, 'memory.set', { slug: 'mem/long', value: 'x'.repeat(8000) })).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });

  // description 은 세 상태다: 생략=유지, 문자열=바꿈, ''=지움. 생략이 지우면 본문만 고치는
  // 호출마다 요약이 사라진다.
  it('description: set, kept when omitted, cleared by empty string, listed in entries', async () => {
    const { pat } = await createAgent(app, adminToken, 'desc-agent');
    const client = await mcpClient(pat);
    const entry = async () => ((await callTool(client, 'memory.list', {})).entries as { slug: string; description: string | null; kind: string }[])
      .find((e) => e.slug === 'mem/d');
    try {
      await callTool(client, 'memory.set', { slug: 'mem/d', value: 'v1', description: '배포 절차' });
      expect(await entry()).toEqual({ slug: 'mem/d', description: '배포 절차', kind: 'topic' });
      await callTool(client, 'memory.set', { slug: 'mem/d', value: 'v2' });
      expect((await entry())?.description).toBe('배포 절차');
      expect((await callTool(client, 'memory.get', { slug: 'mem/d' })).description).toBe('배포 절차');
      await callTool(client, 'memory.set', { slug: 'mem/d', value: 'v3', description: '' });
      expect((await entry())?.description).toBeNull();
    } finally {
      await client.close();
    }
  });

  // 읽은 횟수가 정리의 근거다. 읽기는 판본(rev)을 바꾸지 않는다 — 바꾸면 러너 캐시가 매번 깨진다.
  it('memory.get counts reads without changing rev', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'read-agent');
    const client = await mcpClient(pat);
    try {
      await callTool(client, 'memory.set', { slug: 'mem/r', value: 'v' });
      const before = (await callTool(client, 'memory.list', {})).rev;
      await callTool(client, 'memory.get', { slug: 'mem/r' });
      await callTool(client, 'memory.get', { slug: 'mem/r' });
      const row = (await pool.query(
        `select read_count, last_read_at from agent_memory where account_id = $1 and slug = 'mem/r'`, [accountId],
      )).rows[0];
      expect(row.read_count).toBe(2);
      expect(row.last_read_at).not.toBeNull();
      expect((await callTool(client, 'memory.list', {})).rev).toBe(before);
    } finally {
      await client.close();
    }
  });

  // 덮어쓰기·삭제 전 본문을 이전 판으로 남긴다 — 정리 턴이 병합·삭제를 하려면 되돌릴 길이 먼저다.
  it('keeps the last 5 revisions on update and delete', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'rev-keep-agent');
    const client = await mcpClient(pat);
    const revs = async () => (await pool.query(
      `select value from agent_memory_revision where account_id = $1 and slug = 'mem/h' order by replaced_at desc, id desc`,
      [accountId],
    )).rows.map((r) => r.value as string);
    try {
      await callTool(client, 'memory.set', { slug: 'mem/h', value: 'v0' });
      expect(await revs()).toEqual([]);
      await callTool(client, 'memory.set', { slug: 'mem/h', value: 'v1' });
      expect(await revs()).toEqual(['v0']);
      for (let i = 2; i <= 7; i++) await callTool(client, 'memory.set', { slug: 'mem/h', value: `v${i}` });
      expect(await revs()).toEqual(['v6', 'v5', 'v4', 'v3', 'v2']);
      await callTool(client, 'memory.set', { slug: 'mem/h', value: null });
      expect((await revs())[0]).toBe('v7');
    } finally {
      await client.close();
    }
  });

  // 070: kind 는 생략=유지, 새 기억은 topic. list entries 에 실린다.
  it('kind defaults to topic, is kept when omitted, and is listed', async () => {
    const { pat } = await createAgent(app, adminToken, 'kind-agent');
    const client = await mcpClient(pat);
    const kindOf = async (slug: string) => ((await callTool(client, 'memory.list', {})).entries as { slug: string; kind: string }[])
      .find((e) => e.slug === slug)?.kind;
    try {
      await callTool(client, 'memory.set', { slug: 'mem/k', value: 'v' });
      expect(await kindOf('mem/k')).toBe('topic');
      await callTool(client, 'memory.set', { slug: 'mem/k', value: 'v', kind: 'procedure' });
      await callTool(client, 'memory.set', { slug: 'mem/k', value: 'v2' });
      expect(await kindOf('mem/k')).toBe('procedure');
      const bad = await callTool(client, 'memory.set', { slug: 'mem/k', value: 'v', kind: 'nope' });
      expect(bad.error).toBeDefined();
    } finally {
      await client.close();
    }
  });

  // 070: journal 은 최근 60개만 남고, 밀려난 것은 이전 판으로 간다. topic 은 건드리지 않는다.
  it('keeps only the newest 60 journal entries, moving the rest to revisions', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'journal-agent');
    const client = await mcpClient(pat);
    try {
      await callTool(client, 'memory.set', { slug: 'mem/keep', value: 'topic' });
      for (let i = 0; i < 62; i++) {
        await callTool(client, 'memory.set', { slug: `mem/j-${String(i).padStart(2, '0')}`, value: `j${i}`, kind: 'journal' });
      }
      const rows = (await pool.query(
        `select slug from agent_memory where account_id = $1 and kind = 'journal' order by slug`, [accountId],
      )).rows.map((r) => r.slug as string);
      expect(rows).toHaveLength(60);
      expect(rows).not.toContain('mem/j-00');
      expect(rows).not.toContain('mem/j-01');
      expect(rows).toContain('mem/j-61');
      const moved = (await pool.query(
        `select slug from agent_memory_revision where account_id = $1 and slug in ('mem/j-00', 'mem/j-01')`, [accountId],
      )).rowCount;
      expect(moved).toBe(2);
      expect((await callTool(client, 'memory.get', { slug: 'mem/keep' })).value).toBe('topic');
    } finally {
      await client.close();
    }
  });

  // 070: 이름·요약 3점, 본문 1점. core 는 빼고, 조사가 붙은 낱말도 걸린다.
  it('memory.search ranks slug/description over body, skips core, strips Korean particles', async () => {
    const { pat } = await createAgent(app, adminToken, 'search-agent');
    const client = await mcpClient(pat);
    try {
      await callTool(client, 'memory.set', { slug: 'core', value: '캐시 캐시 캐시' });
      await callTool(client, 'memory.set', { slug: 'mem/body-only', value: '여기에 캐시 이야기가 있다' });
      await callTool(client, 'memory.set', { slug: 'mem/runner-cache', value: '본문', description: '러너 캐시 설계' });
      await callTool(client, 'memory.set', { slug: 'mem/unrelated', value: 'xterm' });
      const res = await callTool(client, 'memory.search', { query: '캐시가 치명적이다' });
      const slugs = (res.hits as { slug: string }[]).map((h) => h.slug);
      expect(slugs).toEqual(['mem/runner-cache', 'mem/body-only']);
      expect(res.hits[0].value).toBeUndefined();
      const withValue = await callTool(client, 'memory.search', { query: '캐시', includeValue: true, limit: 1 });
      expect(withValue.hits).toHaveLength(1);
      expect(withValue.hits[0].value).toBe('본문');
    } finally {
      await client.close();
    }
  });

  it('different account cannot see other accounts memory', async () => {
    const client1 = await mcpClient(agent1Pat);
    const client2 = await mcpClient(agent2Pat);
    try {
      await client1.callTool({ name: 'memory.set', arguments: { slug: 'mem/agent1only', value: 'agent1 secret' } });
      await client2.callTool({ name: 'memory.set', arguments: { slug: 'mem/agent2only', value: 'agent2 secret' } });

      const r1 = await callTool(client1, 'memory.get', { slug: 'mem/agent1only' });
      expect(r1.value).toBe('agent1 secret');

      const r2 = await callTool(client2, 'memory.get', { slug: 'mem/agent2only' });
      expect(r2.value).toBe('agent2 secret');

      const notMyMemory = await callTool(client1, 'memory.get', { slug: 'mem/agent2only' });
      expect(notMyMemory.error?.code).toBe('not_found');

      const notMyMemory2 = await callTool(client2, 'memory.get', { slug: 'mem/agent1only' });
      expect(notMyMemory2.error?.code).toBe('not_found');

      // get 만 검사하면 list 의 스코프가 비어 있어도 통과한다 — 실제로 listMemory 에서
      // 계정 조건을 지웠을 때 이 테스트가 초록이었다(다른 테스트가 우연히 잡았을 뿐이다).
      const list1 = await callTool(client1, 'memory.list', {});
      expect(list1.slugs).toContain('mem/agent1only');
      expect(list1.slugs).not.toContain('mem/agent2only');

      const list2 = await callTool(client2, 'memory.list', {});
      expect(list2.slugs).toContain('mem/agent2only');
      expect(list2.slugs).not.toContain('mem/agent1only');
    } finally {
      await client1.close();
      await client2.close();
    }
  });

  it('rejects invalid slug formats', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const upper = await callTool(client, 'memory.set', { slug: 'CORE', value: 'test' });
      expect(upper.error?.code).toBe('invalid_slug');

      const noPrefix = await callTool(client, 'memory.set', { slug: 'random', value: 'test' });
      expect(noPrefix.error?.code).toBe('invalid_slug');
      // **거절은 문법을 함께 준다.** 문구가 `invalid slug format` 뿐이던 동안, 접두사를
      // 빼고 두어 번 시도한 에이전트가 "이 도구는 core 하나만 받는다"고 결론짓고 기억을
      // 다른 데(사라지는 곳)에 넣었다 — 그 결론을 막는 것이 이 문장이다.
      expect(noPrefix.error?.message).toContain('mem/');
      expect(noPrefix.error?.message).toContain('core');

      const longSlug = await callTool(client, 'memory.set', { slug: 'a'.repeat(256), value: 'test' });
      expect(longSlug.error?.code).toBe('invalid_slug');
    } finally {
      await client.close();
    }
  });

  it('allows core slug', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const result = await callTool(client, 'memory.set', { slug: 'core', value: 'valid' });
      expect(result).toEqual({ ok: true });

      const getResult = await callTool(client, 'memory.get', { slug: 'core' });
      expect(getResult.value).toBe('valid');
    } finally {
      await client.close();
    }
  });

  it('rejects value > 8000 chars, allows exactly 8000', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const tooLong = await callTool(client, 'memory.set', { slug: 'mem/toolong', value: 'a'.repeat(8001) });
      expect(tooLong.error?.code).toBe('mcp_error');

      const exact = await callTool(client, 'memory.set', { slug: 'mem/exact8000', value: 'a'.repeat(8000) });
      expect(exact).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });

  it('rejects 201st item, allows 200th', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const listBefore = await callTool(client, 'memory.list', {});
      const existingCount = listBefore.slugs?.length ?? 0;
      const needToAdd = 200 - existingCount;

      for (let i = 0; i < needToAdd; i++) {
        const result = await callTool(client, 'memory.set', { slug: `mem/testitem${i}`, value: 'x' });
        expect(result).toEqual({ ok: true });
      }

      const add201 = await callTool(client, 'memory.set', { slug: 'mem/testitem200', value: 'x' });
      expect(add201.error?.code).toBe('too_many');

      const removeOne = await callTool(client, 'memory.set', { slug: 'mem/testitem0', value: null });
      expect(removeOne).toEqual({ ok: true });

      const addAfterDelete = await callTool(client, 'memory.set', { slug: 'mem/testitem200', value: 'x' });
      expect(addAfterDelete).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });
});