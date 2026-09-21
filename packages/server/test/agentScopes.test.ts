// 호출·자격증명 스코프(스펙 2026-09-20 §6). `owner_account_id` 하나가 겸하던 셋을 가른다:
// 누가 깨울 수 있나(`invokeScope`)와 무슨 자격증명을 쥐나(`credentialScope`). 불변식은
// 양방향이다 — personal ⟺ owner — 그리고 넓히기는 일방통행으로 막는다(그 에이전트의 메모리·
// 세션에 개인 데이터가 이미 눕는다). 여기서 재는 것은 서버가 그 둘을 PATCH 에서 거절하는가다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let memberToken: string; let memberId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'caller'));
});
afterAll(async () => { await app.close(); await stop(); });

const create = async (handle: string, extra: object = {}) => {
  const res = await app.inject({ method: 'POST', url: '/accounts/agents', headers: auth(adminToken), payload: { handle, displayName: handle, ...extra } });
  return res;
};
const patch = (id: string, payload: object, token = adminToken) =>
  app.inject({ method: 'PATCH', url: `/accounts/agents/${id}`, headers: auth(token), payload });

describe('스코프 기본값', () => {
  it('새 에이전트는 community / none 이다 — 현행 동작 그대로', async () => {
    const res = await create('plain');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ invokeScope: 'community', credentialScope: 'none', invokers: [] });
  });
});

describe('불변식 — personal ⟺ owner', () => {
  it('personal 인데 owner 가 아니면 400 scope_invariant (만들 때도, 고칠 때도)', async () => {
    const bad = await create('bad', { credentialScope: 'personal' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('scope_invariant');
    const ok = await create('ok');
    const res = await patch(ok.json().id, { credentialScope: 'personal' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('scope_invariant');
  });

  it('owner + personal 은 통과한다', async () => {
    const res = await create('mine', { invokeScope: 'owner', credentialScope: 'personal' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ invokeScope: 'owner', credentialScope: 'personal' });
  });

  it('owner 인데 personal 이 아닌 것은 허용된다 — 불변식은 personal 쪽이 owner 를 요구하는 방향이 강하다', async () => {
    // personal ⟹ owner 는 반드시. owner ⟹ personal 은 "개인 MCP 를 붙일 수 있다"는 자격이지 의무가 아니다.
    const res = await create('quiet', { invokeScope: 'owner', credentialScope: 'none' });
    expect(res.statusCode).toBe(201);
  });

  it('personal 인 채로 invokeScope 만 넓히려 하면 400 — 불변식이 먼저 깨진다', async () => {
    const created = await create('p2', { invokeScope: 'owner', credentialScope: 'personal' });
    const res = await patch(created.json().id, { invokeScope: 'community' });
    expect(res.statusCode).toBe(400);
  });
});

describe('넓히기는 일방통행', () => {
  it('owner → 무엇이든 넓히는 PATCH 는 400 scope_widening', async () => {
    const created = await create('narrow', { invokeScope: 'owner' });
    for (const to of ['list', 'channel', 'community'] as const) {
      const res = await patch(created.json().id, { invokeScope: to });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('scope_widening');
    }
  });

  it('좁히기는 자유다 — community → channel → list → owner', async () => {
    const created = await create('wide');
    const id = created.json().id as string;
    for (const to of ['channel', 'list', 'owner'] as const) {
      const res = await patch(id, { invokeScope: to });
      expect(res.statusCode).toBe(200);
      expect(res.json().invokeScope).toBe(to);
    }
  });
});

describe('invokers 명단', () => {
  it('소유자·admin 이 넣고 빼며, 목록은 AgentView.invokers 로 보인다', async () => {
    const created = await create('listed', { invokeScope: 'list' });
    const id = created.json().id as string;
    const put = await app.inject({ method: 'PUT', url: `/accounts/agents/${id}/invokers/${memberId}`, headers: auth(adminToken) });
    expect(put.statusCode).toBe(200);
    expect(put.json().invokers).toEqual([memberId]);
    // 멱등 — 두 번 넣어도 하나다.
    const again = await app.inject({ method: 'PUT', url: `/accounts/agents/${id}/invokers/${memberId}`, headers: auth(adminToken) });
    expect(again.json().invokers).toEqual([memberId]);
    const del = await app.inject({ method: 'DELETE', url: `/accounts/agents/${id}/invokers/${memberId}`, headers: auth(adminToken) });
    expect(del.statusCode).toBe(200);
    expect(del.json().invokers).toEqual([]);
  });

  it('남의 에이전트 명단은 못 건드린다 — 403', async () => {
    const created = await create('theirs', { invokeScope: 'list' });
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${created.json().id}/invokers/${memberId}`, headers: auth(memberToken) });
    expect(res.statusCode).toBe(403);
  });
});
