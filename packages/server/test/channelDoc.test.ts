import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * #188 회귀선(서버). 채널에 붙는 문서가 지켜야 하는 것들이다.
 *
 * 여기 묶인 약속 중 **조용한 손실**과 관련된 것이 핵심이다: 볼 수 없는 채널의 본문이 새지
 * 않는다는 것, 낙관적 동시성이 어긋난 저장을 실제로 **막는다**는 것(상태 코드만 409 이고
 * 저장은 되는 모양이 최악이다), 감사 로그에 본문이 복사되지 않는다는 것, 그리고 에이전트에게
 * 열린 것이 읽기뿐이라는 것.
 */

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let memberToken: string;
let memberId: string;
let outsiderToken: string;
let botPat: string;
let mcpUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function registerHuman(handle: string): Promise<{ token: string; id: string }> {
  const invite = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
  const created = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle, loginId: handle, displayName: handle, password: 'pw123456',
      inviteToken: invite.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: handle, password: 'pw123456' },
  });
  return { token: login.json().token as string, id: created.json().id as string };
}

async function makeChannel(name: string, visibility: 'public' | 'private'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name, visibility },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const getDoc = (channelId: string, token: string) =>
  app.inject({ method: 'GET', url: `/channels/${channelId}/doc`, headers: auth(token) });

const putDoc = (
  channelId: string, token: string, body: string, expectedUpdatedAt: number | null,
) => app.inject({
  method: 'PUT', url: `/channels/${channelId}/doc`, headers: auth(token),
  payload: { body, expectedUpdatedAt },
});

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ token: memberToken, id: memberId } = await registerHuman('docmember'));
  ({ token: outsiderToken } = await registerHuman('docoutsider'));
  ({ pat: botPat } = await createAgent(app, adminToken, 'docbot'));
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

const toolText = (r: Awaited<ReturnType<Client['callTool']>>): unknown =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

describe('#188 채널 문서', () => {
  it('1. 저장하면 같은 채널에서 다시 읽힌다', async () => {
    const channelId = await makeChannel('doc-roundtrip', 'public');

    // 아직 아무도 쓰지 않았다 — 404 가 아니라 빈 문서고, "누가 언제"는 비어 있다.
    const empty = await getDoc(channelId, memberToken);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ channelId, body: '', updatedBy: null, updatedAt: null });

    const saved = await putDoc(channelId, memberToken, '이 채널의 전제', null);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().body).toBe('이 채널의 전제');
    expect(saved.json().updatedBy).toBe(memberId);

    const read = await getDoc(channelId, memberToken);
    expect(read.json().body).toBe('이 채널의 전제');
    expect(read.json().updatedBy).toBe(memberId);
    expect(read.json().updatedAt).toBe(saved.json().updatedAt);
  });

  it('2. 채널당 하나 — 두 번 저장하면 덮어쓰기지 두 행이 아니다', async () => {
    const channelId = await makeChannel('doc-single', 'public');

    const first = await putDoc(channelId, memberToken, '첫 판', null);
    expect(first.statusCode).toBe(200);
    const second = await putDoc(
      channelId, memberToken, '둘째 판', new Date(first.json().updatedAt as string).getTime(),
    );
    expect(second.statusCode).toBe(200);

    // 행 수를 직접 센다. 응답만 보면 "두 행 중 최신 하나를 읽는" 구현도 초록이다.
    const rows = await pool.query('select body from channel_doc where channel_id = $1', [channelId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.body).toBe('둘째 판');
  });

  it('3. 볼 수 없는 채널의 문서는 읽기·쓰기 모두 403 이고 본문이 새지 않는다', async () => {
    const channelId = await makeChannel('doc-private', 'private');
    await putDoc(channelId, adminToken, '비밀 전제', null);

    const read = await getDoc(channelId, outsiderToken);
    expect(read.statusCode).toBe(403);
    // 상태 코드만 보면 "403 인데 본문도 실려 있다"를 놓친다. 응답 전체에서 본문 문자열을
    // 찾는다 — 거절 응답에 본문을 실어 보내는 것이 이 기능의 가장 조용한 누출이다.
    expect(read.body).not.toContain('비밀 전제');

    const write = await putDoc(channelId, outsiderToken, '덮어쓰기 시도', null);
    expect(write.statusCode).toBe(403);
    expect(write.body).not.toContain('비밀 전제');

    // 거절이 실제로 저장을 막았는가.
    const rows = await pool.query('select body from channel_doc where channel_id = $1', [channelId]);
    expect(rows.rows[0]!.body).toBe('비밀 전제');
  });

  it('4. private 채널의 멤버는 편집할 수 있고 비멤버는 403 이다', async () => {
    const channelId = await makeChannel('doc-membership', 'private');
    const invited = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken),
      payload: { accountId: memberId },
    });
    expect(invited.statusCode).toBe(200);

    const byMember = await putDoc(channelId, memberToken, '멤버가 쓴 것', null);
    expect(byMember.statusCode).toBe(200);

    const byOutsider = await putDoc(channelId, outsiderToken, '비멤버가 쓴 것', null);
    expect(byOutsider.statusCode).toBe(403);
    const rows = await pool.query('select body from channel_doc where channel_id = $1', [channelId]);
    expect(rows.rows[0]!.body).toBe('멤버가 쓴 것');
  });

  it('5. expectedUpdatedAt 이 낡았으면 409 이고 저장되지 않는다 — 현재 본문이 응답에 있다', async () => {
    const channelId = await makeChannel('doc-stale', 'public');
    const base = await putDoc(channelId, memberToken, 'A 가 읽은 판', null);
    const staleExpectation = new Date(base.json().updatedAt as string).getTime();

    // B 가 먼저 고친다.
    const byB = await putDoc(channelId, adminToken, 'B 가 고친 판', staleExpectation);
    expect(byB.statusCode).toBe(200);

    // A 는 자기가 읽은 판의 시각을 들고 저장한다.
    const byA = await putDoc(channelId, memberToken, 'A 가 저장하려던 판', staleExpectation);
    expect(byA.statusCode).toBe(409);
    expect(byA.json().error.code).toBe('doc_stale');
    // 현재 본문이 함께 와야 사람이 두 판을 보고 정할 수 있다.
    expect(byA.json().doc.body).toBe('B 가 고친 판');

    // **저장되지 않았다.** 409 를 주면서 쓰기까지 하는 것이 이 기능의 최악의 모양이다.
    const rows = await pool.query('select body from channel_doc where channel_id = $1', [channelId]);
    expect(rows.rows[0]!.body).toBe('B 가 고친 판');
  });

  it('5b. expectedUpdatedAt 을 빼먹어도 이미 있는 문서를 덮어쓰지 못한다', async () => {
    // 옵셔널을 "검사 생략"으로 읽으면 필드를 빼기만 해도 낙관적 동시성이 꺼진다.
    // 부재·null 은 "아직 문서가 없다고 믿는다"이므로, 이미 있으면 stale 이다.
    const channelId = await makeChannel('doc-noexpect', 'public');
    await putDoc(channelId, memberToken, '먼저 쓴 것', null);

    const blind = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/doc`, headers: auth(outsiderToken),
      payload: { body: '기대값 없이 덮어쓰기' },
    });
    expect(blind.statusCode).toBe(409);
    const rows = await pool.query('select body from channel_doc where channel_id = $1', [channelId]);
    expect(rows.rows[0]!.body).toBe('먼저 쓴 것');
  });

  it('6. 에이전트 PAT 로 MCP 읽기는 되고 쓰기 도구는 없다', async () => {
    const channelId = await makeChannel('doc-mcp', 'public');
    await putDoc(channelId, adminToken, '에이전트가 읽을 전제', null);

    const client = await mcpClient(botPat);
    const read = toolText(await client.callTool({
      name: 'channel.doc', arguments: { channelId },
    })) as { body: string };
    expect(read.body).toBe('에이전트가 읽을 전제');

    // 쓰기 도구가 **없다.** 이름을 리터럴로 나열해 주입한다 — "doc 이 들어간 도구가 하나뿐"
    // 같은 느슨한 단언은 `channel.doc.set` 이 생겨도 통과할 수 있다.
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('channel.doc');
    for (const forbidden of [
      'channel.doc.set', 'channel.doc.update', 'channel.doc.write', 'channel.doc.edit',
      'channel.doc.put', 'channel.doc.append', 'channel.doc.delete', 'channel.doc.clear',
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // 그리고 그 이름으로 부르면 서버가 거절한다(도구 목록에만 없는 것이 아니다).
    // MCP SDK 는 없는 도구를 예외가 아니라 `isError` 로 답한다.
    const attempted = await client.callTool({
      name: 'channel.doc.set', arguments: { channelId, body: '에이전트가 쓴 것' },
    });
    expect(attempted.isError).toBe(true);
    const after = await pool.query('select body from channel_doc where channel_id = $1', [channelId]);
    expect(after.rows[0]!.body).toBe('에이전트가 읽을 전제');
    await client.close();
  });

  it('6b. 볼 수 없는 채널은 MCP 로도 본문이 새지 않는다', async () => {
    const channelId = await makeChannel('doc-mcp-private', 'private');
    await putDoc(channelId, adminToken, 'MCP 로도 새면 안 되는 것', null);

    const client = await mcpClient(botPat);
    const res = toolText(await client.callTool({ name: 'channel.doc', arguments: { channelId } }));
    expect(JSON.stringify(res)).not.toContain('MCP 로도 새면 안 되는 것');
    expect(res).toMatchObject({ error: { code: 'forbidden' } });
    await client.close();
  });

  it('7. 감사 detail 에 본문이 없다', async () => {
    const channelId = await makeChannel('doc-audit', 'public');
    const secret = '감사에 복사되면 안 되는 문서 본문';
    await putDoc(channelId, memberToken, secret, null);

    const audit = await pool.query(
      `select actor_id, detail from audit_log
        where target = $1 and action = 'channel.doc.updated' order by id desc limit 1`,
      [channelId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.actor_id).toBe(memberId);
    // detail 전체를 문자열로 훑는다 — 어느 키에 실렸든 잡는다.
    expect(JSON.stringify(audit.rows[0]!.detail)).not.toContain(secret);
    // 길이는 남는다: "얼마나 큰 변경이었나"는 본문 없이도 답할 수 있는 질문이다.
    expect(audit.rows[0]!.detail).toMatchObject({ bodyLength: secret.length });
  });

  it('보관된 채널의 문서는 읽기 전용이다', async () => {
    const channelId = await makeChannel('doc-archived', 'public');
    await putDoc(channelId, adminToken, '보관 전에 쓴 것', null);
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: auth(adminToken),
      payload: { archived: true },
    });

    const read = await getDoc(channelId, memberToken);
    expect(read.statusCode).toBe(200);
    const write = await putDoc(channelId, memberToken, '보관 뒤에 쓰기', null);
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('channel_archived');
  });

  it('없는 채널은 404 다 — 외래키 위반으로 500 이 되지 않는다', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await getDoc(ghost, adminToken)).statusCode).toBe(404);
    expect((await putDoc(ghost, adminToken, 'x', null)).statusCode).toBe(404);
  });

  it('인증 없이는 읽기·쓰기 모두 401 이다', async () => {
    const channelId = await makeChannel('doc-anon', 'public');
    await putDoc(channelId, adminToken, '익명에게 보이면 안 되는 것', null);

    const read = await app.inject({ method: 'GET', url: `/channels/${channelId}/doc` });
    expect(read.statusCode).toBe(401);
    expect(read.body).not.toContain('익명에게 보이면 안 되는 것');
    const write = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/doc`, payload: { body: 'x' },
    });
    expect(write.statusCode).toBe(401);
  });

  it('문서가 있는 채널도 삭제된다 — 문서 행이 삭제를 막지 않는다', async () => {
    // `channel_doc.channel_id` 는 cascade 가 아니다. `deleteChannel`(#155)이 이 테이블을
    // 모르면 **문서가 하나라도 있는 채널만** 삭제가 FK 위반으로 터진다 — 스키마 목록
    // 단언(`channelDelete.test.ts`)과 별개로 실제 경로도 한 번 지나가 본다.
    const channelId = await makeChannel('doc-deletable', 'public');
    await putDoc(channelId, adminToken, '삭제될 채널의 문서', null);
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: auth(adminToken),
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: auth(adminToken),
    });
    expect(deleted.statusCode).toBe(204);
    const rows = await pool.query('select 1 from channel_doc where channel_id = $1', [channelId]);
    expect(rows.rowCount).toBe(0);
  });

  it('admin 도 예외가 아니다 — 볼 수 없는 채널이면 못 쓴다', async () => {
    // admin 은 private 채널을 만들면 첫 멤버가 되므로, 남이 만든 private 채널로 확인한다.
    const channelId = await makeChannel('doc-admin-created', 'private');
    // 만든 admin 을 멤버에서 빼면 admin 도 비멤버다.
    await pool.query('delete from channel_member where channel_id = $1 and account_id = $2',
      [channelId, adminId]);
    const write = await putDoc(channelId, adminToken, 'admin 이 쓴 것', null);
    expect(write.statusCode).toBe(403);
  });
});
