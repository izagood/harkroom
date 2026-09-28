// #140 워크스페이스 스킬 — 서버 쪽 보증.
//
// 가장 중요한 회귀선은 **승인 게이트**다: 에이전트가 스스로 승인할 수 있으면 한 에이전트가
// 잘못 배운 문장이 모두의 시스템 프롬프트가 된다. 그래서 여기서는 (i) 에이전트 PAT 로
// approve 가 403 인지, (ii) MCP 표면에 쓰기 도구가 아예 없는지를 **둘 다** 고정한다 —
// 403 만 고정하면 나중에 MCP 도구를 하나 더 만들어 게이트를 우회할 수 있다.
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

/** MCP `skill.propose` 를 한 번 부르고 도구가 돌려준 JSON 을 준다. */
async function propose(
  token: string, args: { slug: string; body: string; channelId?: string },
): Promise<Record<string, unknown>> {
  const client = await mcpClient(token);
  try {
    const res = await client.callTool({
      name: 'skill.propose',
      arguments: { channelId, ...args },
    });
    return JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

async function channelBodies(): Promise<string[]> {
  const res = await app.inject({
    method: 'GET', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  return (res.json().messages as { body: string }[]).map((m) => m.body);
}

describe('workspace skill', () => {
  // 요구 1. **이벤트가 아니라 채널에 남은 메시지를 본다.** 이벤트만 단언하면 알림을 실제로
  // 올리는 경로(proposeSkill → postMessage)를 지워도 초록이다 — 승인 게이트의 값은 사람이
  // 제안을 본다는 것 하나에 있으므로, 그 경로가 회귀선 안에 있어야 한다.
  it('에이전트가 제안하면 미승인 행이 생기고 채널에 알림이 남는다', async () => {
    const result = await propose(agentPat, { slug: 'test-skill', body: '# 테스트 스킬' });
    expect(result.ok).toBeDefined();

    const skill = await pool.query('select * from workspace_skill where slug = $1', ['test-skill']);
    expect(skill.rowCount).toBe(1);
    expect(skill.rows[0].approved_at).toBeNull();
    expect(skill.rows[0].proposed_by).toBe(agentAccountId);

    expect((await channelBodies()).some((b) => b.includes('test-skill'))).toBe(true);
  });

  // #311 요구 5 — 알림에서 승인 화면으로 가는 진입점의 **표시**.
  //
  // 화면은 이 값으로 버튼을 그린다(`MessageItem` 의 `meta.skillSlug`). 본문 글자를
  // 정규식으로 더듬게 두면 알림 문구를 한 글자 다듬는 순간 진입점이 조용히 사라진다.
  it('제안 알림에 어느 스킬인지가 meta 로 남는다', async () => {
    const rows = await pool.query(
      `select body, meta from message where channel_id = $1 and kind = 'system' order by seq desc`,
      [channelId],
    );
    const notice = rows.rows.find((r) => String(r.body).includes('test-skill'));
    expect(notice).toBeDefined();
    expect(notice.meta.skillSlug).toBe('test-skill');
  });

  // 요구 2 — **이 파일의 핵심 회귀선.** `requireAdmin` 을 빼면 여기가 빨개진다.
  it('에이전트 PAT 로 approve 는 403, admin 은 200', async () => {
    const agentRes = await app.inject({
      method: 'POST', url: '/skills/test-skill/approve',
      headers: { authorization: `Bearer ${agentPat}` },
    });
    expect(agentRes.statusCode).toBe(403);
    // 거절이 실제로 승인 도장을 남기지 않았는지도 본다 — 403 만 보고 넘어가면
    // "거절 응답 + 부수효과" 조합을 놓친다.
    const after = await pool.query('select approved_at from workspace_skill where slug = $1', ['test-skill']);
    expect(after.rows[0].approved_at).toBeNull();

    const adminRes = await app.inject({
      method: 'POST', url: '/skills/test-skill/approve',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminRes.statusCode).toBe(200);
  });

  // 비활성(=거부)도 admin 전용이다. approve 만 막고 delete 를 열어 두면 에이전트가
  // 남의 스킬을 끌 수 있다.
  it('에이전트 PAT 로 비활성도 403', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/skills/test-skill',
      headers: { authorization: `Bearer ${agentPat}` },
    });
    expect(res.statusCode).toBe(403);
    const row = await pool.query('select disabled_at from workspace_skill where slug = $1', ['test-skill']);
    expect(row.rows[0].disabled_at).toBeNull();
  });

  // 요구 3.
  it('미승인 스킬은 state=approved 에 없다', async () => {
    await pool.query(
      `insert into workspace_skill (slug, body, proposed_by) values ($1, $2, $3)`,
      ['pending-skill', '# 대기중', agentAccountId],
    );

    const res = await app.inject({
      method: 'GET', url: '/skills?state=approved',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const skills = res.json() as { slug: string }[];
    expect(skills.find((s) => s.slug === 'pending-skill')).toBeUndefined();
    expect(skills.find((s) => s.slug === 'test-skill')).toBeDefined();
  });

  // 요구 4. 본문이 바뀌었는데 승인 도장이 남아 있으면, 사람이 읽어 본 적 없는 문장이
  // 승인된 것으로 통한다 — 스킬은 프롬프트 인젝션 표면이다.
  it('같은 slug 재제안은 본문을 덮고 승인 상태를 잃는다', async () => {
    const before = await pool.query('select approved_at from workspace_skill where slug = $1', ['test-skill']);
    expect(before.rows[0].approved_at).not.toBeNull(); // 앞 테스트가 승인해 둔 상태

    await propose(agentPat, { slug: 'test-skill', body: '# 수정된 스킬' });

    const after = await pool.query(
      'select body, approved_at, approved_by from workspace_skill where slug = $1', ['test-skill']);
    expect(after.rows[0].body).toBe('# 수정된 스킬');
    expect(after.rows[0].approved_at).toBeNull();
    expect(after.rows[0].approved_by).toBeNull();

    // 그리고 승인 목록에서도 실제로 빠진다.
    const listed = await app.inject({
      method: 'GET', url: '/skills?state=approved',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((listed.json() as { slug: string }[]).find((s) => s.slug === 'test-skill')).toBeUndefined();
  });

  // 요구 5.
  it('slug 규칙 위반은 거절된다', async () => {
    expect(await propose(agentPat, { slug: 'invalid slug!', body: '# 잘못된' }))
      .toMatchObject({ error: { code: 'invalid_slug' } });
    expect(await propose(agentPat, { slug: 'a', body: '# 너무 짧다' }))
      .toMatchObject({ error: { code: 'invalid_slug' } });
    expect(await propose(agentPat, { slug: 'Has-Upper', body: '# 대문자' }))
      .toMatchObject({ error: { code: 'invalid_slug' } });

    // 거절된 제안은 행을 만들지 않는다.
    const rows = await pool.query(`select count(*)::int as n from workspace_skill where slug ilike '%upper%'`);
    expect(rows.rows[0].n).toBe(0);
  });

  it('REST 도 slug 규칙을 지킨다 — 없는 slug 승인은 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/skills/no-such-skill/approve',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // 요구 7 의 서버 쪽 절반(파일·링크는 러너 테스트가 본다):
  // 러너가 읽는 목록에서 사라져야 러너가 지운다.
  it('비활성화된 스킬은 state=approved 에서 사라진다', async () => {
    const slug = 'disable-test';
    await pool.query(
      `insert into workspace_skill (slug, body, proposed_by, approved_by, approved_at)
       values ($1, $2, $3, $4, now())`,
      [slug, '# 테스트', agentAccountId, agentAccountId],
    );

    const delRes = await app.inject({
      method: 'DELETE', url: `/skills/${slug}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET', url: '/skills?state=approved',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((res.json() as { slug: string }[]).find((s) => s.slug === slug)).toBeUndefined();

    // 두 번 비활성은 409 — 404 로 답하면 slug 오타와 구분되지 않는다.
    const again = await app.inject({
      method: 'DELETE', url: `/skills/${slug}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(again.statusCode).toBe(409);
  });

  // 승인된 스킬 본문은 곧 모두의 시스템 프롬프트다 — 인증 없이 읽히면 프롬프트 표면이 샌다.
  it('스킬 조회는 인증을 요구한다', async () => {
    expect((await app.inject({ method: 'GET', url: '/skills' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/skills?state=approved' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/skills/test-skill' })).statusCode).toBe(401);
    // 에이전트 PAT 는 읽을 수 있다 — 러너가 턴마다 이 경로로 동기화한다.
    expect((await app.inject({
      method: 'GET', url: '/skills?state=approved', headers: { authorization: `Bearer ${agentPat}` },
    })).statusCode).toBe(200);
  });

  // 에이전트는 자기가 못 보는 채널에 알림을 심을 수 없다 — 그렇지 않으면 제안 알림이
  // private 채널을 들여다보는(그리고 글을 남기는) 경로가 된다.
  it('보이지 않는 채널로는 제안할 수 없다', async () => {
    const priv = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'secret-ch', visibility: 'private' },
    });
    const result = await propose(agentPat, {
      slug: 'sneaky', body: '# 몰래', channelId: priv.json().id,
    });
    expect(result).toMatchObject({ error: { code: 'forbidden' } });
    const rows = await pool.query(`select count(*)::int as n from workspace_skill where slug = 'sneaky'`);
    expect(rows.rows[0].n).toBe(0);
  });

  // #325 — `?state=pending|approved|disabled`.
  //
  // 이 절이 지키는 것은 **이름과 동작이 같다**는 것 하나다. #325 를 낳은 사고가 바로
  // `approved=false` 가 "미승인만"이 아니라 전부를 돌려준 것이었다. 그래서 각 상태는
  // "자기 것이 있다"만이 아니라 **"남의 것이 섞이지 않는다"**까지 단언한다 — 앞의 절반만
  // 보면 필터를 통째로 지워도 초록이다.

  /** 세 상태를 한 벌씩 심어 둔다 — 테스트 순서에 기대지 않기 위해서다. */
  async function seedTriplet(tag: string): Promise<void> {
    await pool.query(
      `insert into workspace_skill (slug, body, proposed_by) values ($1, $2, $3)`,
      [`${tag}-pending`, '# 대기', agentAccountId],
    );
    await pool.query(
      `insert into workspace_skill (slug, body, proposed_by, approved_by, approved_at)
       values ($1, $2, $3, $3, now())`,
      [`${tag}-approved`, '# 승인', agentAccountId],
    );
    await pool.query(
      `insert into workspace_skill (slug, body, proposed_by, disabled_at) values ($1, $2, $3, now())`,
      [`${tag}-disabled`, '# 비활성', agentAccountId],
    );
  }

  const slugsOf = async (url: string): Promise<string[]> => {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { slug: string }[]).map((s) => s.slug);
  };

  it('state=pending 는 미승인만 반환한다 — 승인·비활성이 섞이지 않는다', async () => {
    await seedTriplet('p');
    const slugs = await slugsOf('/skills?state=pending');

    expect(slugs).toContain('p-pending');
    expect(slugs).not.toContain('p-approved');
    expect(slugs).not.toContain('p-disabled');
  });

  it('state=approved 는 승인만 반환한다 — 미승인·비활성이 섞이지 않는다', async () => {
    await seedTriplet('a');
    const slugs = await slugsOf('/skills?state=approved');

    expect(slugs).toContain('a-approved');
    expect(slugs).not.toContain('a-pending');
    expect(slugs).not.toContain('a-disabled');
  });

  it('state=disabled 는 비활성만 반환한다 — 미승인·승인이 섞이지 않는다', async () => {
    await seedTriplet('d');
    const slugs = await slugsOf('/skills?state=disabled');

    expect(slugs).toContain('d-disabled');
    expect(slugs).not.toContain('d-pending');
    expect(slugs).not.toContain('d-approved');
  });

  it('파라미터가 없으면 세 상태를 전부 반환한다', async () => {
    // 기본값이 "전부"인 것은 #311 화면이 한 번 불러 세 묶음으로 가르기 때문이다.
    // 기본을 approved 로 좁히면 그 화면에서 대기·비활성 묶음이 통째로 빈다.
    await seedTriplet('all');
    const slugs = await slugsOf('/skills');

    expect(slugs).toContain('all-pending');
    expect(slugs).toContain('all-approved');
    expect(slugs).toContain('all-disabled');
  });

  it('잘못된 state 값은 400 을 반환한다', async () => {
    const res = await app.inject({
      method: 'GET', url: '/skills?state=invalid',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  // #325 는 하위 호환 별칭을 두지 않기로 했다. 그 결정은 **옛 이름이 400 이어야** 지켜진다.
  // zod 가 모르는 키를 말없이 버리면 `?approved=true` 는 "필터 없음"이 되어 미승인 스킬까지
  // 200 으로 돌아간다 — 이름을 믿은 호출자가 받는 것이 정확히 #325 가 신고한 그 사고이고,
  // 조용하기까지 해서 더 나쁘다. 무시가 아니라 거절인지를 여기서 고정한다.
  it('옛 이름 approved= 는 무시가 아니라 400 이다 — 별칭을 두지 않았다', async () => {
    for (const url of ['/skills?approved=true', '/skills?approved=false']) {
      const res = await app.inject({
        method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('MCP 표면에 스킬 쓰기 도구가 없다', () => {
  // 게이트를 우회하는 가장 쉬운 길은 MCP 도구를 하나 더 만드는 것이다. 이름을 리터럴로
  // 확인한다 — 에이전트에게 열린 스킬 도구는 `skill.propose` 하나뿐이어야 한다.
  it('에이전트가 부를 수 있는 스킬 도구는 skill.propose 하나뿐이다', async () => {
    const client = await mcpClient(agentPat);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.filter((n) => n.startsWith('skill.'))).toEqual(['skill.propose']);
      for (const forbidden of ['skill.approve', 'skill.disable', 'skill.delete', 'skill.reject']) {
        expect(names).not.toContain(forbidden);
      }
    } finally {
      await client.close();
    }
  });

  // 없는 도구를 부르면 실패한다 — "도구 목록에는 없지만 부르면 동작한다"를 막는다.
  it('없는 이름으로 부르면 승인되지 않는다', async () => {
    const client = await mcpClient(agentPat);
    try {
      const res = await client.callTool({ name: 'skill.approve', arguments: { slug: 'test-skill' } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('not found');
      // 그리고 아무 것도 승인되지 않았다.
      const row = await pool.query('select approved_at from workspace_skill where slug = $1', ['test-skill']);
      expect(row.rows[0].approved_at).toBeNull();
    } finally {
      await client.close();
    }
  });
});
