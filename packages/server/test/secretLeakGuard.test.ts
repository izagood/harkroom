import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { createSecretKeyring } from '../src/services/secretKeyring.js';
import { collectStrings, needlesFor } from '../src/services/secretLeakGuard.js';

// 비밀 보관소 PR 2b — 본문 거절(D5). 스레드 bc98df3a.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
// 실제 토큰 형식의 리터럴을 저장소에 두지 않는다(보안 검토 L1).
const VALUE = `ghp_${'b'.repeat(36)}`;
// 줄 단위 검사용 여러 줄 값. 높은 엔트로피 리터럴은 gitleaks 가 키로 읽는다 — 반복 글자로 조립한다.
const PEM_LINE = 'Q'.repeat(40);
const PEM = ['-----BEGIN TEST KEY-----', PEM_LINE, 'R'.repeat(40), '-----END TEST KEY-----'].join('\n');
const PW = `pw-${'h'.repeat(14)}`;

describe('바늘 (D5)', () => {
  it('평문·URL 인코딩·base64 세 모양을 만들고 8자 미만은 버린다', () => {
    const n = needlesFor(Buffer.from('p@ss word!x'));
    expect(n).toContain('p@ss word!x');
    expect(n).toContain(encodeURIComponent('p@ss word!x'));
    expect(n).toContain(Buffer.from('p@ss word!x').toString('base64'));
    expect(needlesFor(Buffer.from('short'))).toEqual([]);
  });
  it('여러 줄 파일 비밀은 긴 줄 하나만 옮겨 적어도 걸린다', () => {
    expect(needlesFor(Buffer.from(PEM))).toContain(PEM_LINE);
  });
  it('문자열은 키까지 모은다', () => {
    expect(collectStrings({ a: ['x', { [VALUE]: 1 }] })).toEqual(['a', 'x', VALUE]);
  });
});

describe('본문 거절 (D5)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let agent: { accountId: string; pat: string };
  let bystander: { accountId: string; pat: string };
  let channelId: string;
  let mcpUrl: string;
  const ring = createSecretKeyring(new Map([['k1', randomBytes(32)]]), 'k1');

  const mcp = async (token: string): Promise<Client> => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth(token) } }));
    return client;
  };
  const toolJson = (r: Awaited<ReturnType<Client['callTool']>>): { error?: { code: string; message: string } } =>
    JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
  const post = (token: string, body: string) =>
    app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body } });
  const blockedCount = async () =>
    (await pool.query(`select count(*)::int as n from secret_access_log where reason = 'leak_blocked'`)).rows[0].n as number;

  beforeAll(async () => {
    db = await startTestDb();
    pool = db.pool;
    app = await buildServer({ pool, secretKeyring: ring });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    agent = await createAgent(app, admin.token, 'worker');
    bystander = await createAgent(app, admin.token, 'bystander');
    channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'leak-test' } })).json().id as string;
    for (const id of [agent.accountId, bystander.accountId]) {
      await app.inject({ method: 'POST', url: `/channels/${channelId}/members`, headers: auth(admin.token), payload: { accountId: id } });
    }
    const mk = async (payload: Record<string, unknown>) =>
      (await app.inject({ method: 'POST', url: '/secrets', headers: auth(alice.token), payload })).json().secret.id as string;
    const gh = await mk({ name: 'gh', kind: 'text', value: VALUE });
    const key = await mk({ name: 'key', kind: 'file', filename: 'k.pem', valueBase64: Buffer.from(PEM).toString('base64') });
    const tiny = await mk({ name: 'tiny', kind: 'text', value: 'abc123' });
    for (const id of [gh, key, tiny]) {
      expect((await app.inject({ method: 'PUT', url: `/secrets/${id}/grants`, headers: auth(alice.token), payload: { agentId: agent.accountId, operator: 'any' } })).statusCode).toBe(200);
    }
    // 정지된 grant 의 비밀도 본다 — 값이 덜 비밀이 되지 않는다.
    await pool.query(`update secret_grant set suspended_at = now() where secret_id = $1`, [key]);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    mcpUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`;
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('MCP: 발화·기억·스킬 어디에 넣어도 거절 — 오류는 고정 문장이고 값을 되비추지 않는다', async () => {
    const c = await mcp(agent.pat);
    try {
      const before = await blockedCount();
      const r1 = toolJson(await c.callTool({ name: 'message.post', arguments: { channelId, body: `here: ${VALUE}` } }));
      expect(r1.error?.code).toBe('secret_in_body');
      expect(JSON.stringify(r1)).not.toContain(VALUE);
      expect(JSON.stringify(r1)).not.toContain('gh');
      const r2 = toolJson(await c.callTool({ name: 'memory.set', arguments: { slug: 'mem/x', value: Buffer.from(VALUE).toString('base64') } }));
      expect(r2.error?.code).toBe('secret_in_body');
      const r3 = toolJson(await c.callTool({ name: 'skill.propose', arguments: { slug: 'leak', body: `k=${encodeURIComponent(VALUE)}`, channelId } }));
      expect(r3.error?.code).toBe('secret_in_body');
      expect(await blockedCount()).toBe(before + 3);
      // 정지된 grant 의 파일 비밀 한 줄.
      const r4 = toolJson(await c.callTool({ name: 'message.post', arguments: { channelId, body: `line ${PEM_LINE}` } }));
      expect(r4.error?.code).toBe('secret_in_body');
      // 걸린 글은 저장되지 않았다.
      expect((await pool.query(`select 1 from message where body like '%ghp_%'`)).rowCount).toBe(0);
      expect((await pool.query(`select 1 from agent_memory where slug = 'mem/x'`)).rowCount).toBe(0);
    } finally {
      await c.close();
    }
  });

  it('MCP: 깨끗한 글은 지나가고, 8자 미만 비밀은 보지 않는다', async () => {
    const c = await mcp(agent.pat);
    try {
      const ok = toolJson(await c.callTool({ name: 'message.post', arguments: { channelId, body: 'all good abc123 here' } }));
      expect(ok.error).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  it('REST: 에이전트의 JSON 본문도 같은 관문을 지난다', async () => {
    const res = await post(agent.pat, `x ${VALUE} y`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('secret_in_body');
    expect(res.body).not.toContain(VALUE);
    const audit = await pool.query(`select detail::text from audit_log where action = 'secret.leak.blocked' order by id desc limit 1`);
    expect(audit.rows[0].detail).toContain('rest:POST');
    expect(audit.rows[0].detail).not.toContain(VALUE);
  });

  it('grant 가 없는 에이전트·사람의 글은 거절하지 않는다(사람에게는 desktop 경고)', async () => {
    expect((await post(bystander.pat, `x ${VALUE}`)).statusCode).not.toBe(400);
    expect((await post(alice.token, `x ${VALUE}`)).statusCode).toBe(201);
  });

  it('첨부: 에이전트가 올린 파일 바이트에 값이 있으면 거절하고 저장하지 않는다', async () => {
    const boundary = '----harkroomleak';
    const upload = (content: string) => app.inject({
      method: 'POST', url: '/uploads', headers: { ...auth(agent.pat), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="n.txt"\r\nContent-Type: text/plain\r\n\r\n`),
        Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    const bad = await upload(`token=${VALUE}\n`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('secret_in_body');
    expect((await upload('nothing to see')).statusCode).toBe(201);
    const rows = await pool.query(`select count(*)::int as n from attachment where uploader_id = $1`, [agent.accountId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('비밀 설명에 그 비밀의 값을 넣으면 거절(만들기·고치기·값 바꾸기)', async () => {
    const mk = await app.inject({ method: 'POST', url: '/secrets', headers: auth(alice.token), payload: { name: 'pw', kind: 'text', value: PW, description: `pw is ${PW}` } });
    expect(mk.json().error.code).toBe('secret_in_description');
    const id = (await app.inject({ method: 'POST', url: '/secrets', headers: auth(alice.token), payload: { name: 'pw', kind: 'text', value: PW, description: 'db password' } })).json().secret.id as string;
    expect((await app.inject({ method: 'PATCH', url: `/secrets/${id}`, headers: auth(alice.token), payload: { description: `it is ${PW}` } })).json().error.code).toBe('secret_in_description');
    expect((await app.inject({ method: 'PUT', url: `/secrets/${id}/value`, headers: auth(alice.token), payload: { value: 'db password' } })).json().error.code).toBe('secret_in_description');
  });
});
