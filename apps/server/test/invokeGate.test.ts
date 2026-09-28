// 호출 게이트(스펙 2026-09-20 §6). 게이트 자리는 fan-out 한 곳이고, 막힌 부름은 조용히 사라지지
// 않고 `meta.mentionDenied` 로 그 메시지에 남는다 — 부른 사람이 "왜 아무도 안 왔나"를 묻지
// 않게. 팀·auto-mention 은 넣는 시점에 400 이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let adminId: string;
let owner: { token: string; accountId: string }; let stranger: { token: string; accountId: string };
let channelId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function agentWith(handle: string, ownerId: string, scope: string) {
  const made = await createAgent(app, adminToken, handle);
  const res = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${made.accountId}`, headers: auth(adminToken),
    payload: { ownerAccountId: ownerId, invokeScope: scope },
  });
  expect(res.statusCode).toBe(200);
  return made;
}
async function post(token: string, body: string, chan = channelId) {
  const res = await app.inject({ method: 'POST', url: `/channels/${chan}/messages`, headers: auth(token), payload: { body } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; meta: Record<string, unknown> };
}
async function inboxHas(pat: string, messageId: string): Promise<boolean> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(pat) });
  return (res.json().entries as { messageId: string }[]).some((e) => e.messageId === messageId);
}

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  owner = await createMember(app, adminToken, 'owner');
  stranger = await createMember(app, adminToken, 'stranger');
  const chan = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'gate', visibility: 'public' } });
  channelId = chan.json().id;
  // 셋 다 채널을 본다 — public 이라 멤버십 없이도 보이지만, channel 스코프 시험은 멤버십을 따로 건다.
});
afterAll(async () => { await app.close(); await stop(); });

describe('owner 스코프', () => {
  it('남이 부르면 inbox 에 안 들어가고 meta.mentionDenied 에 남는다; 소유자가 부르면 들어간다', async () => {
    const a = await agentWith('privy', owner.accountId, 'owner');
    const denied = await post(stranger.token, '@privy 해 줘');
    expect(await inboxHas(a.pat, denied.id)).toBe(false);
    expect(denied.meta.mentionDenied).toEqual(['privy']);
    const ok = await post(owner.token, '@privy 해 줘');
    expect(await inboxHas(a.pat, ok.id)).toBe(true);
    expect(ok.meta.mentionDenied).toBeUndefined();
  });
});

describe('list 스코프', () => {
  it('명단에 있는 사람만 부를 수 있다', async () => {
    const a = await agentWith('listed', owner.accountId, 'list');
    expect((await post(stranger.token, '@listed 해 줘')).meta.mentionDenied).toEqual(['listed']);
    await app.inject({ method: 'PUT', url: `/accounts/agents/${a.accountId}/invokers/${stranger.accountId}`, headers: auth(adminToken) });
    const ok = await post(stranger.token, '@listed 해 줘');
    expect(await inboxHas(a.pat, ok.id)).toBe(true);
    expect(ok.meta.mentionDenied).toBeUndefined();
  });
});

describe('channel 스코프', () => {
  it('그 채널의 멤버만 부를 수 있다', async () => {
    const a = await agentWith('local', owner.accountId, 'channel');
    // stranger 는 public 채널을 보지만 멤버는 아니다.
    expect((await post(stranger.token, '@local 해 줘')).meta.mentionDenied).toEqual(['local']);
    // public 채널의 멤버십은 구독이다 — 초대 라우트로 넣는다.
    const join = await app.inject({ method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken), payload: { accountId: stranger.accountId } });
    expect([200, 201, 204]).toContain(join.statusCode);
    const ok = await post(stranger.token, '@local 해 줘');
    expect(await inboxHas(a.pat, ok.id)).toBe(true);
  });
});

describe('community 스코프는 그대로다', () => {
  it('누구나 부른다 — 현행 동작', async () => {
    const a = await agentWith('open', owner.accountId, 'community');
    const ok = await post(stranger.token, '@open 해 줘');
    expect(await inboxHas(a.pat, ok.id)).toBe(true);
    expect(ok.meta.mentionDenied).toBeUndefined();
  });
});

describe('팀·auto-mention 은 넣는 시점에 거절한다', () => {
  it('팀원 추가 — invoke_scope != community 면 400 invoke_scope_restricted', async () => {
    const a = await agentWith('teamless', owner.accountId, 'owner');
    const team = await app.inject({ method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'gate-team', displayName: 'Gate' } });
    expect(team.statusCode).toBe(201);
    const res = await app.inject({ method: 'PUT', url: `/teams/${team.json().id}/members/${a.accountId}`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invoke_scope_restricted');
  });

  it('auto-mention — invoke_scope != community 면 400 invoke_scope_restricted', async () => {
    const a = await agentWith('noauto', owner.accountId, 'list');
    const res = await app.inject({ method: 'PUT', url: `/channels/${channelId}/auto-mentions/${a.accountId}`, headers: auth(adminToken), payload: { mode: 'always' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invoke_scope_restricted');
  });
});

describe('admin 도 스코프 밖이면 부르지 못한다', () => {
  it('owner 스코프는 admin 도 막는다 — 소유가 곧 자격이다', async () => {
    const a = await agentWith('strict', owner.accountId, 'owner');
    const res = await post(adminToken, '@strict 해 줘');
    expect(await inboxHas(a.pat, res.id)).toBe(false);
    expect(res.meta.mentionDenied).toEqual(['strict']);
    expect(adminId).toBeTruthy();
  });
});
