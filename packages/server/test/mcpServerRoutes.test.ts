// MCP 레지스트리(스펙 2026-09-20 §6). 서버는 이름과 자격증명 종류만 안다 — 정의와 토큰은
// 오퍼레이터 머신에 있다. 여기서 재는 것은 그 목록의 관리 권한과, 에이전트의 mcpServers 가
// 그 부분집합이며 personal 이름이 credentialScope 불변식에 걸리는가다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let memberToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken } = await createMember(app, adminToken, 'plain'));
});
afterAll(async () => { await app.close(); await stop(); });

const put = (name: string, credentialKind: string, token = adminToken) =>
  app.inject({ method: 'PUT', url: `/mcp-servers/${name}`, headers: auth(token), payload: { credentialKind } });
const createAgentWith = async (handle: string, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/accounts/agents', headers: auth(adminToken), payload: { handle, displayName: handle, ...extra } });
const patch = (id: string, payload: object) =>
  app.inject({ method: 'PATCH', url: `/accounts/agents/${id}`, headers: auth(adminToken), payload });

describe('레지스트리', () => {
  it('agent.privileged 가 등록·갱신·삭제하고, 누구나(로그인) 목록을 본다', async () => {
    expect((await put('github', 'community')).statusCode).toBe(200);
    expect((await put('slack', 'personal')).statusCode).toBe(200);
    // 갱신 — 같은 이름에 다른 종류.
    expect((await put('github', 'community')).json().credentialKind).toBe('community');
    const list = await app.inject({ method: 'GET', url: '/mcp-servers', headers: auth(memberToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().servers.map((s: { name: string }) => s.name)).toEqual(['github', 'slack']);
    expect((await app.inject({ method: 'DELETE', url: '/mcp-servers/github', headers: auth(adminToken) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/mcp-servers/github', headers: auth(adminToken) })).statusCode).toBe(404);
  });

  it('member 는 등록하지 못한다 — 403', async () => {
    expect((await put('mine', 'community', memberToken)).statusCode).toBe(403);
  });

  it('이름은 [a-z0-9-]{1,32} 다', async () => {
    expect((await put('Bad_Name', 'community')).statusCode).toBe(400);
  });
});

describe('에이전트의 mcpServers', () => {
  it('레지스트리의 부분집합만 붙는다 — 모르는 이름은 400 unknown_mcp_server', async () => {
    await put('github', 'community');
    const agent = (await createAgentWith('gh')).json();
    const ok = await patch(agent.id, { mcpServers: ['github'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mcpServers).toEqual(['github']);
    const bad = await patch(agent.id, { mcpServers: ['github', 'nope'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('unknown_mcp_server');
  });

  it('personal 이름은 credentialScope=personal(따라서 owner) 인 에이전트에만 붙는다', async () => {
    await put('slack', 'personal');
    const shared = (await createAgentWith('shared')).json();
    const denied = await patch(shared.id, { mcpServers: ['slack'] });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe('scope_invariant');
    const mine = (await createAgentWith('mine', { invokeScope: 'owner', credentialScope: 'personal' })).json();
    const ok = await patch(mine.id, { mcpServers: ['slack'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mcpServers).toEqual(['slack']);
    // personal 이름을 단 채로 credentialScope 를 넓힐 수 없다.
    const widen = await patch(mine.id, { credentialScope: 'none' });
    expect(widen.statusCode).toBe(400);
  });

  it('레지스트리에서 지우면 에이전트에서도 빠진다', async () => {
    await put('tmp', 'community');
    const agent = (await createAgentWith('tmpuser')).json();
    await patch(agent.id, { mcpServers: ['tmp'] });
    await app.inject({ method: 'DELETE', url: '/mcp-servers/tmp', headers: auth(adminToken) });
    const res = await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(adminToken) });
    const row = (res.json().agents as { id: string; mcpServers: string[] }[]).find((a) => a.id === agent.id);
    expect(row?.mcpServers).toEqual([]);
  });
});
