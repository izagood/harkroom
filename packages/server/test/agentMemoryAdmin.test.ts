import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { setMemory, listMemory } from '../src/services/memory.js';
import type { Pool } from 'pg';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let agentId: string;
let otherAgentId: string;
let plainToken: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: agentId } = await createAgent(app, adminToken, 'memorybot'));
  ({ accountId: otherAgentId } = await createAgent(app, adminToken, 'othermemorybot'));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'plainuser', displayName: 'Plain User', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle: 'plainuser', password: 'pw123456' },
  });
  plainToken = login.json().token as string;
});
afterAll(async () => { await app.close(); await stop(); });

const admin = () => ({ authorization: `Bearer ${adminToken}` });

describe('에이전트 기억 관리 REST (#139 3단계)', () => {
  it('GET 이 slug 와 값을 함께 준다 — 목록만 주면 사람이 무엇을 지우는지 모른다', async () => {
    await setMemory(pool, agentId, 'core', '재빈은 러너를 담당한다');

    const res = await app.inject({ method: 'GET', url: `/accounts/agents/${agentId}/memory`, headers: admin() });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { memories: { slug: string; value: string; updatedAt: string }[] };
    const core = body.memories.find((m) => m.slug === 'core');
    expect(core?.value).toBe('재빈은 러너를 담당한다');
  });

  it('DELETE 가 그 항목만 지운다', async () => {
    await setMemory(pool, agentId, 'keep', '남는다');
    await setMemory(pool, agentId, 'drop', '사라진다');

    const res = await app.inject({
      method: 'DELETE', url: `/accounts/agents/${agentId}/memory/drop`, headers: admin(),
    });

    expect(res.statusCode).toBe(204);
    const slugs = await listMemory(pool, agentId);
    expect(slugs).toContain('keep');
    expect(slugs).not.toContain('drop');
  });

  // 계정 스코프가 빠지면 아무 admin 이 slug 이름만 알고 남의 에이전트 기억을 지운다.
  it('다른 에이전트의 같은 slug 는 건드리지 않는다', async () => {
    await setMemory(pool, agentId, 'shared-slug', '내 것');
    await setMemory(pool, otherAgentId, 'shared-slug', '남의 것');

    await app.inject({
      method: 'DELETE', url: `/accounts/agents/${agentId}/memory/shared-slug`, headers: admin(),
    });

    expect(await listMemory(pool, otherAgentId)).toContain('shared-slug');
  });

  it('admin 이 아닌 사람은 읽지도 지우지도 못한다', async () => {
    const headers = { authorization: `Bearer ${plainToken}` };
    await setMemory(pool, agentId, 'guarded', '값');

    const read = await app.inject({ method: 'GET', url: `/accounts/agents/${agentId}/memory`, headers });
    const del = await app.inject({
      method: 'DELETE', url: `/accounts/agents/${agentId}/memory/guarded`, headers,
    });

    expect(read.statusCode).toBe(403);
    expect(del.statusCode).toBe(403);
    // 403 을 주고도 지워 버리면 가드가 아니다.
    expect(await listMemory(pool, agentId)).toContain('guarded');
  });

  // 본문이 감사 로그에 복사되면 삭제가 삭제가 아니다 (docs/design.md).
  it('감사 기록에 기억 본문이 남지 않는다', async () => {
    await setMemory(pool, agentId, 'secret-slug', '민감한 본문이다');
    await app.inject({
      method: 'DELETE', url: `/accounts/agents/${agentId}/memory/secret-slug`, headers: admin(),
    });

    const rows = await pool.query(
      `select detail from audit_log where action = 'agent.memory.deleted' order by id desc limit 1`,
    );
    expect(JSON.stringify(rows.rows[0].detail)).toContain('secret-slug');
    expect(JSON.stringify(rows.rows[0].detail)).not.toContain('민감한 본문이다');
  });
});
