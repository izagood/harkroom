// 호출 게이트(스펙 2026-09-20 §6). 게이트 자리는 fan-out 한 곳이고, 막힌 부름은 조용히 사라지지
// 않고 `meta.mentionDenied` 로 그 메시지에 남는다 — 부른 사람이 "왜 아무도 안 왔나"를 묻지
// 않게. auto-mention 은 넣는 시점에 400 이다. 팀은 자기 범위 + 팀원 범위 두 겹이다(068).
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

// 본문이 처음부터 `<@id>` 인 부름(에이전트는 흔히 id 로 부른다). 예전에는 막힘 표시가
// `@handle` 글자로 찾은 계정에서만 만들어져서, 막힌 부름이 meta 에 남지 않고 조용히
// 사라졌다(#rcms: task_manager → rcms 세 번, notified 에도 meta 에도 없었다).
describe('raw <@id> 로 부른 막힌 호출', () => {
  it('meta.mentionDenied 에 handle 로 남는다', async () => {
    const a = await agentWith('rawprivy', owner.accountId, 'owner');
    const caller = await createAgent(app, adminToken, 'rawcaller');
    const denied = await post(caller.pat, `<@${a.accountId}> 진행해 주세요`);
    expect(await inboxHas(a.pat, denied.id)).toBe(false);
    expect(denied.meta.mentionDenied).toEqual(['rawprivy']);
  });

  // 에이전트 글의 한가운데 `<@id>` 는 지칭이다 — 계정 종류를 몰라 사람으로 보면 부름이 된다.
  it('에이전트 글 한가운데의 <@에이전트id> 는 부르지 않는다', async () => {
    const target = await createAgent(app, adminToken, 'rawref');
    const caller = await createAgent(app, adminToken, 'rawreffer');
    const msg = await post(caller.pat, `보고입니다. 구현은 <@${target.accountId}> 몫이다`);
    expect(await inboxHas(target.pat, msg.id)).toBe(false);
    expect(msg.meta.mentionDenied).toBeUndefined();
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

describe('auto-mention 은 넣는 시점에 거절한다', () => {
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

describe('팀 — 팀도 에이전트와 같은 범위 규칙을 탄다(068)', () => {
  const put = (url: string, payload?: unknown) => app.inject({ method: 'PUT', url, headers: auth(adminToken), ...(payload ? { payload } : {}) });
  async function team(name: string, members: string[], lead?: string) {
    const res = await app.inject({ method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    for (const m of members) expect((await put(`/teams/${id}/members/${m}`)).statusCode).toBe(200);
    if (lead) expect((await put(`/teams/${id}/lead`, { accountId: lead })).statusCode).toBe(200);
    return id;
  }

  it('owner 스코프 팀원도 팀에 넣을 수 있다 — 넣는 시점에 거르지 않는다', async () => {
    const a = await agentWith('joinable', owner.accountId, 'owner');
    await team('join-team', [a.accountId]);
  });

  it('회귀(#udc): owner 스코프 팀장을 소유자가 팀으로 부르면 깬다 — team_mention 으로', async () => {
    const lead = await agentWith('udclead', owner.accountId, 'owner');
    await team('udc-like', [lead.accountId], lead.accountId);
    const ok = await post(owner.token, '@udc-like 계속해');
    const inbox = (await app.inject({ method: 'GET', url: '/inbox', headers: auth(lead.pat) })).json().entries as { messageId: string; reason: string }[];
    expect(inbox.find((e) => e.messageId === ok.id)?.reason).toBe('team_mention');
    expect(ok.meta.mentionDenied).toBeUndefined();
  });

  it('남이 팀으로 부르면 owner 팀원은 안 깨고 mentionDenied 에 남는다 — 팀이 팀원을 넓히지 못한다', async () => {
    const privy = await agentWith('tprivy', owner.accountId, 'owner');
    const open = await agentWith('topen', owner.accountId, 'community');
    await team('mixed-team', [privy.accountId, open.accountId]);
    const res = await post(stranger.token, '@mixed-team 봐 줘');
    expect(await inboxHas(privy.pat, res.id)).toBe(false);
    expect(await inboxHas(open.pat, res.id)).toBe(true);
    expect(res.meta.mentionDenied).toEqual(['tprivy']);
  });

  it('막힌 팀장은 적고, 부를 수 있는 팀원 전원으로 떨어진다', async () => {
    const lead = await agentWith('blead', owner.accountId, 'owner');
    const other = await agentWith('bother', owner.accountId, 'community');
    await team('fallback-team', [lead.accountId, other.accountId], lead.accountId);
    const res = await post(stranger.token, '@fallback-team 봐 줘');
    expect(await inboxHas(lead.pat, res.id)).toBe(false);
    expect(await inboxHas(other.pat, res.id)).toBe(true);
    expect(res.meta.mentionDenied).toEqual(['blead']);
  });

  it('팀 자체의 owner 범위 — 남이 부르면 팀 이름이 mentionDenied 에 남고 아무도 안 깬다', async () => {
    const a = await agentWith('tmember', owner.accountId, 'community');
    const id = await team('owned-team', [a.accountId]);
    const set = await put(`/teams/${id}/scope`, { invokeScope: 'owner', ownerAccountId: owner.accountId });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ invokeScope: 'owner', ownerAccountId: owner.accountId });
    const denied = await post(stranger.token, '@owned-team 봐 줘');
    expect(await inboxHas(a.pat, denied.id)).toBe(false);
    expect(denied.meta.mentionDenied).toEqual(['owned-team']);
    const ok = await post(owner.token, '@owned-team 봐 줘');
    expect(await inboxHas(a.pat, ok.id)).toBe(true);
  });

  it('팀 list 범위 — 명단에 넣으면 부를 수 있다', async () => {
    const a = await agentWith('lmember', owner.accountId, 'community');
    const id = await team('listed-team', [a.accountId]);
    expect((await put(`/teams/${id}/scope`, { invokeScope: 'list' })).statusCode).toBe(200);
    expect((await post(stranger.token, '@listed-team 봐 줘')).meta.mentionDenied).toEqual(['listed-team']);
    const add = await put(`/teams/${id}/invokers/${stranger.accountId}`);
    expect(add.json().invokers).toEqual([stranger.accountId]);
    const ok = await post(stranger.token, '@listed-team 봐 줘');
    expect(await inboxHas(a.pat, ok.id)).toBe(true);
  });

  it('새 팀은 community 이고 소유자는 만든 사람이다', async () => {
    const id = await team('fresh-team', []);
    const got = (await app.inject({ method: 'GET', url: `/teams/${id}`, headers: auth(adminToken) })).json();
    expect(got.team).toMatchObject({ invokeScope: 'community', ownerAccountId: adminId });
    expect(got.invokers).toEqual([]);
  });

  it('owner 범위에 소유자가 없으면 400 owner_required', async () => {
    const id = await team('ownerless-team', []);
    const res = await put(`/teams/${id}/scope`, { invokeScope: 'owner', ownerAccountId: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('owner_required');
  });
});
