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
      handle: 'plainuser', loginId: 'plainuser', displayName: 'Plain User', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'plainuser', password: 'pw123456' },
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

// 메모리 고도화 M5: 사람이 기억을 고치고, 이전 판을 보고 되돌린다.
describe('에이전트 기억 편집 REST (M5)', () => {
  const url = (slug: string) => `/accounts/agents/${agentId}/memory/${encodeURIComponent(slug)}`;

  it('PUT 이 본문·요약·종류를 고치고, 이전 판이 남는다', async () => {
    await setMemory(pool, agentId, 'mem/edit-me', 'v1');
    const put = await app.inject({
      method: 'PUT', url: url('mem/edit-me'), headers: admin(),
      payload: { value: 'v2', description: '사람이 고침', kind: 'procedure' },
    });
    expect(put.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: `/accounts/agents/${agentId}/memory`, headers: admin() }))
      .json() as { memories: { slug: string; value: string; description: string | null; kind: string }[] };
    expect(list.memories.find((m) => m.slug === 'mem/edit-me')).toMatchObject({ value: 'v2', description: '사람이 고침', kind: 'procedure' });
    const revs = await app.inject({ method: 'GET', url: `${url('mem/edit-me')}/revisions`, headers: admin() });
    expect((revs.json() as { revisions: { value: string }[] }).revisions.map((r) => r.value)).toEqual(['v1']);
  });

  // 사람이 연 판 뒤에 에이전트가 고쳤으면 덮지 않는다.
  it('ifUpdatedAt 이 어긋나면 409 와 지금 판을 준다', async () => {
    await setMemory(pool, agentId, 'mem/raced', 'a');
    const stale = new Date(Date.now() - 60_000).toISOString();
    const res = await app.inject({
      method: 'PUT', url: url('mem/raced'), headers: admin(), payload: { value: 'b', ifUpdatedAt: stale },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string; updatedAt: string } }).error.code).toBe('conflict');
  });

  it('core 한도·slug 문법을 에이전트와 같이 지킨다', async () => {
    const long = await app.inject({ method: 'PUT', url: url('core'), headers: admin(), payload: { value: 'x'.repeat(3001) } });
    expect(long.statusCode).toBe(422);
    const bad = await app.inject({ method: 'PUT', url: url('Bad.Slug'), headers: admin(), payload: { value: 'x' } });
    expect(bad.statusCode).toBe(422);
  });

  it('소유자·관리자가 아니면 고칠 수도, 이전 판을 볼 수도 없다', async () => {
    const plain = { authorization: `Bearer ${plainToken}` };
    const put = await app.inject({ method: 'PUT', url: url('mem/x'), headers: plain, payload: { value: 'x' } });
    const revs = await app.inject({ method: 'GET', url: `${url('mem/x')}/revisions`, headers: plain });
    expect(put.statusCode).toBe(403);
    expect(revs.statusCode).toBe(403);
  });
});
