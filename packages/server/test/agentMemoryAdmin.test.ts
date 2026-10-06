import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { setMemory, listMemory, AUDIT_HUMAN_LIST_CAP } from '../src/services/memory.js';
import type { Pool } from 'pg';
import { MAX_MEMORY_ITEMS_PER_ACCOUNT } from '@harkroom/shared';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let agentId: string;
let otherAgentId: string;
let plainToken: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
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

  it('사람 계정 id 나 없는 id 로는 기억 행을 만들지 않는다 — admin 이어도 404', async () => {
    // requireOwnerOrAdmin 은 이 둘에도 admin 을 통과시킨다. 라우트가 대상을 안 보면 사람 id 로 행이 생겼다.
    for (const id of [adminId, '00000000-0000-4000-8000-000000000000']) {
      const put = await app.inject({
        method: 'PUT', url: `/accounts/agents/${id}/memory/${encodeURIComponent('mem/stray')}`, headers: admin(), payload: { value: 'x' },
      });
      expect(put.statusCode).toBe(404);
      expect(await listMemory(pool, id)).toHaveLength(0);
    }
  });

  it('사람 계정 id 면 읽기·지우기·이전 판·확인도 admin 이어도 404 다', async () => {
    // 옛 판본이 남긴 사람 id 의 기억 행이 있다고 치고(서비스로 직접 만든다) REST 로는 보이지도 지워지지도 않아야 한다.
    await setMemory(pool, adminId, 'mem/stray-old', 'x', undefined, undefined, undefined, 'test');
    const slug = encodeURIComponent('mem/stray-old');
    const res = await Promise.all([
      app.inject({ method: 'GET', url: `/accounts/agents/${adminId}/memory`, headers: admin() }),
      app.inject({ method: 'GET', url: `/accounts/agents/${adminId}/memory/${slug}/revisions`, headers: admin() }),
      app.inject({ method: 'POST', url: `/accounts/agents/${adminId}/memory/${slug}/confirm`, headers: admin() }),
      app.inject({ method: 'DELETE', url: `/accounts/agents/${adminId}/memory/${slug}`, headers: admin() }),
    ]);
    for (const r of res) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
    expect(await listMemory(pool, adminId)).toHaveLength(1);
  });
});

describe('사람용 정리 API (Memory 탭 재설계 PR 2)', () => {
  const owner = () => admin();

  it('목록에 recall 열(recallCount·lastRecalledAt)이 실린다', async () => {
    const { accountId: id } = await createAgent(app, adminToken, 'recallcolbot');
    await setMemory(pool, id, 'mem/recalled', '실린 것');
    await pool.query(
      `update agent_memory set recall_count = 3, last_recalled_at = now() where account_id = $1 and slug = 'mem/recalled'`, [id],
    );
    const res = await app.inject({ method: 'GET', url: `/accounts/agents/${id}/memory`, headers: owner() });
    const m = (res.json().memories as { slug: string; recallCount: number; lastRecalledAt: string | null }[])
      .find((e) => e.slug === 'mem/recalled')!;
    expect(m.recallCount).toBe(3);
    expect(m.lastRecalledAt).not.toBeNull();
  });

  // 결정 4: 칩 숫자가 정확해야 한다 — 에이전트(MCP)의 30 자르기를 사람 화면에 쓰지 않는다.
  it('GET …/memory/audit 는 30개에서 자르지 않는다', async () => {
    const { accountId: id } = await createAgent(app, adminToken, 'auditallbot');
    // 이름·본문이 서로 닮지 않게(닮으면 similar 짝이 n² 으로 늘어 아래 상한 시험이 된다).
    for (let i = 0; i < 40; i++) await setMemory(pool, id, `mem/topic${i}x`, `고유본문${i}`);
    const res = await app.inject({ method: 'GET', url: `/accounts/agents/${id}/memory/audit`, headers: owner() });
    expect(res.statusCode).toBe(200);
    const audit = res.json().audit as { undescribed: string[]; truncated: boolean; items: { active: number } };
    expect(audit.undescribed).toHaveLength(40);
    expect(audit.truncated).toBe(false);
    expect(audit.items.active).toBe(40);
  });

  // 짝 목록은 n² 이라 사람 화면에서도 끊는다 — 응답 크기의 상한(security).
  it('짝 목록은 상한에서 끊고 truncated 를 세운다', async () => {
    const { accountId: id } = await createAgent(app, adminToken, 'auditcapbot');
    // 이름이 같은 낱말뿐인 21개 → similar 짝 210 > 200
    for (let i = 0; i < 21; i++) await setMemory(pool, id, `mem/same-name-${i}`, `고유본문${i}`);
    const res = await app.inject({ method: 'GET', url: `/accounts/agents/${id}/memory/audit`, headers: owner() });
    const audit = res.json().audit as { similar: unknown[]; truncated: boolean; undescribed: string[] };
    expect(audit.similar).toHaveLength(AUDIT_HUMAN_LIST_CAP);
    expect(audit.truncated).toBe(true);
    expect(audit.undescribed).toHaveLength(21);
  });

  it('보관은 여러 개를 한 번에, slug 마다 결과를 준다 — core·없는 것·틀린 이름은 막고 나머지는 한다', async () => {
    const { accountId: id } = await createAgent(app, adminToken, 'archivebatchbot');
    await setMemory(pool, id, 'core', '코어');
    await setMemory(pool, id, 'mem/a', 'A');
    await setMemory(pool, id, 'mem/b', 'B');
    const res = await app.inject({
      method: 'POST', url: `/accounts/agents/${id}/memory/archive`, headers: owner(),
      payload: { slugs: ['mem/a', 'mem/b', 'mem/a', 'core', 'mem/missing', 'Bad Slug'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { slug: 'mem/a', result: 'ok' },
      { slug: 'mem/b', result: 'ok' },
      { slug: 'core', result: 'core_not_archivable' },
      { slug: 'mem/missing', result: 'not_found' },
      { slug: 'Bad Slug', result: 'invalid_slug' },
    ]);
    expect(await listMemory(pool, id)).toEqual(['core']);
    // 감사에는 성공한 slug 만, 본문은 없다.
    const audit = await pool.query(
      `select detail from audit_log where action = 'agent.memory.archived' and target = $1 order by id desc limit 1`, [id],
    );
    expect(audit.rows[0].detail).toEqual({ slugs: ['mem/a', 'mem/b'] });

    const back = await app.inject({
      method: 'POST', url: `/accounts/agents/${id}/memory/unarchive`, headers: owner(), payload: { slugs: ['mem/a'] },
    });
    expect(back.json().results).toEqual([{ slug: 'mem/a', result: 'ok' }]);
    expect(await listMemory(pool, id)).toEqual(['core', 'mem/a']);
  });

  it('되살리기는 살아 있는 것이 상한이면 too_many 다', async () => {
    const { accountId: id } = await createAgent(app, adminToken, 'unarchivefullbot');
    await setMemory(pool, id, 'mem/old', '옛것');
    await app.inject({
      method: 'POST', url: `/accounts/agents/${id}/memory/archive`, headers: owner(), payload: { slugs: ['mem/old'] },
    });
    await pool.query(
      `insert into agent_memory (account_id, slug, value)
       select $1, 'mem/fill-' || g, 'x' from generate_series(1, $2::int) g`,
      [id, MAX_MEMORY_ITEMS_PER_ACCOUNT],
    );
    const res = await app.inject({
      method: 'POST', url: `/accounts/agents/${id}/memory/unarchive`, headers: owner(), payload: { slugs: ['mem/old'] },
    });
    expect(res.json().results).toEqual([{ slug: 'mem/old', result: 'too_many' }]);
  });

  it('소유자·admin 이 아니면 audit·보관·되살리기 모두 403, 남의 기억은 그대로다', async () => {
    const { accountId: id } = await createAgent(app, adminToken, 'guardedbot');
    await setMemory(pool, id, 'mem/keep', '남는다');
    const plain = { authorization: `Bearer ${plainToken}` };
    const res = await Promise.all([
      app.inject({ method: 'GET', url: `/accounts/agents/${id}/memory/audit`, headers: plain }),
      app.inject({ method: 'POST', url: `/accounts/agents/${id}/memory/archive`, headers: plain, payload: { slugs: ['mem/keep'] } }),
      app.inject({ method: 'POST', url: `/accounts/agents/${id}/memory/unarchive`, headers: plain, payload: { slugs: ['mem/keep'] } }),
    ]);
    for (const r of res) expect(r.statusCode).toBe(403);
    expect(await listMemory(pool, id)).toEqual(['mem/keep']);
  });

  it('사람 계정 id 면 admin 이어도 404 다', async () => {
    const res = await Promise.all([
      app.inject({ method: 'GET', url: `/accounts/agents/${adminId}/memory/audit`, headers: admin() }),
      app.inject({ method: 'POST', url: `/accounts/agents/${adminId}/memory/archive`, headers: admin(), payload: { slugs: ['mem/stray-old'] } }),
      app.inject({ method: 'POST', url: `/accounts/agents/${adminId}/memory/unarchive`, headers: admin(), payload: { slugs: ['mem/stray-old'] } }),
    ]);
    for (const r of res) expect(r.statusCode).toBe(404);
  });

  it('slugs 는 1개 이상, 상한 이하여야 한다', async () => {
    const empty = await app.inject({
      method: 'POST', url: `/accounts/agents/${agentId}/memory/archive`, headers: admin(), payload: { slugs: [] },
    });
    expect(empty.statusCode).toBe(400);
    const tooMany = await app.inject({
      method: 'POST', url: `/accounts/agents/${agentId}/memory/archive`, headers: admin(),
      payload: { slugs: Array.from({ length: MAX_MEMORY_ITEMS_PER_ACCOUNT + 1 }, (_, i) => `mem/x-${i}`) },
    });
    expect(tooMany.statusCode).toBe(400);
  });
});
