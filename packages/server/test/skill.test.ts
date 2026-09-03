import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { onEvent } from '../src/events.js';
import type { WorkspaceEvent } from '../src/events.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let agentPat: string;
let agentAccountId: string;
let channelId: string;
let mcpUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: agentPat, accountId: agentAccountId } = await createAgent(app, adminToken, 'forge'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'skill-ch' },
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

describe('workspace skill', () => {
  // 테스트 1: 에이전트가 skill.propose 로 제안하면 미승인 행이 생기고 채널에 알림이 남는다.
  it('에이전트가 제안하면 미승인 행이 생기고 채널에 알림이 남는다', async () => {
    const events: WorkspaceEvent[] = [];
    const off = onEvent((e) => events.push(e));
    try {
      const client = await mcpClient(agentPat);
      await client.callTool({
        name: 'skill.propose',
        arguments: { slug: 'test-skill', body: '# 테스트 스킬', channelId },
      });
      await client.close();

      // DB에 미승인 행이 생겼는지 확인
      const skill = await pool.query('select * from workspace_skill where slug = $1', ['test-skill']);
      expect(skill.rowCount).toBe(1);
      expect(skill.rows[0].approved_at).toBeNull();

      // 채널에 알림이 남았는지 확인
      const notification = events.find((e) => e.type === 'skill.proposed');
      expect(notification).toBeDefined();
      expect((notification as { channelId: string }).channelId).toBe(channelId);
    } finally { off(); }
  });

  // 테스트 2: 에이전트 PAT 로 approve 는 403, admin 은 200
  it('에이전트 PAT 로 approve 는 403, admin 은 200', async () => {
    // 에이전트로 approve 시도 (403)
    const agentRes = await app.inject({
      method: 'POST', url: '/skills/test-skill/approve',
      headers: { authorization: `Bearer ${agentPat}` },
    });
    expect(agentRes.statusCode).toBe(403);

    // admin으로 approve 시도 (200)
    const adminRes = await app.inject({
      method: 'POST', url: '/skills/test-skill/approve',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminRes.statusCode).toBe(200);
  });

  // 테스트 3: 미승인 스킬은 GET /skills?approved=true 에 없다
  it('미승인 스킬은 approved=true 에 없다', async () => {
    // 다른 스킬 제안 (미승인)
    await pool.query(
      `insert into workspace_skill (slug, body, proposed_by) values ($1, $2, $3)`,
      ['pending-skill', '# 대기중', agentAccountId],
    );

    const res = await app.inject({
      method: 'GET', url: '/skills?approved=true',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const skills = res.json() as { slug: string }[];
    expect(skills.find((s) => s.slug === 'pending-skill')).toBeUndefined();
    expect(skills.find((s) => s.slug === 'test-skill')).toBeDefined();
  });

  // 테스트 4: 같은 slug 재제안은 기존 행을 덮되 승인 상태를 잃는다
  it('같은 slug 재제안은 승인 상태를 잃는다', async () => {
    // 이미 승인된 스킬을 다시 제안
    const client = await mcpClient(agentPat);
    await client.callTool({
      name: 'skill.propose',
      arguments: { slug: 'test-skill', body: '# 수정된 스킬', channelId },
    });
    await client.close();

    // 승인 상태가 없어졌는지 확인
    const skill = await pool.query('select approved_at from workspace_skill where slug = $1', ['test-skill']);
    expect(skill.rows[0].approved_at).toBeNull();
  });

  // 테스트 5: slug 규칙 위반은 400
  it('slug 규칙 위반은 400', async () => {
    const client = await mcpClient(agentPat);
    const res = await client.callTool({
      name: 'skill.propose',
      arguments: { slug: 'invalid slug!', body: '# 잘못된', channelId },
    });
    await client.close();

    const result = JSON.parse(((res.content as { text: string }[])[0] as { text: string }).text) as { error: { code: string } };
    expect(result.error.code).toBe('invalid_slug');
  });

  // 테스트 7: 비활성·삭제된 스킬의 파일과 링크가 사라진다 (REST로 테스트)
  it('비활성화된 스킬을 approved=true 에서 조회할 수 없다', async () => {
    // 스킬을 제안하고 승인 (고유 slug 사용)
    const skillSlug = `disable-test-${Date.now()}`;
    await pool.query(
      `insert into workspace_skill (slug, body, proposed_by, approved_by, approved_at)
       values ($1, $2, $3, $4, now())`,
      [skillSlug, '# 테스트', agentAccountId, agentAccountId],
    );

    // 비활성화
    const delRes = await app.inject({
      method: 'DELETE', url: `/skills/${skillSlug}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    if (delRes.statusCode !== 200) {
      console.log('Delete failed:', delRes.statusCode, delRes.body);
    }
    expect(delRes.statusCode).toBe(200);

    // approved=true 에서는 사라짐
    const res = await app.inject({
      method: 'GET', url: '/skills?approved=true',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const skills = res.json() as { slug: string }[];
    expect(skills.find((s) => s.slug === skillSlug)).toBeUndefined();
  });
});

describe('skill propose via MCP', () => {
  // 추가 테스트: skill.propose의 입력 유효성 검사
  it('slug 길이 제한 검사', async () => {
    const client = await mcpClient(agentPat);
    // 40자 초과 slug
    const res = await client.callTool({
      name: 'skill.propose',
      arguments: { slug: 'a'.repeat(41), body: '# 너무 긴 스킬', channelId },
    });
    await client.close();

    const text = ((res.content as { text: string }[])[0] as { text: string }).text;
    // MCP 에러는 JSON 또는 에러 메시지
    const hasError = text.includes('invalid_slug') || text.includes('error');
    expect(hasError).toBe(true);
  });
});