// 호출 게이트(스펙 2026-09-20 §6). 게이트 자리는 fan-out 한 곳이고, 막힌 부름은 조용히 사라지지
// 않고 `meta.mentionDenied` 로 그 메시지에 남는다 — 부른 사람이 "왜 아무도 안 왔나"를 묻지
// 않게. auto-mention 은 넣는 시점에 400 이다. 팀은 자기 범위 + 팀원 범위 두 겹이다(068).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let adminId: string;
let owner: { token: string; accountId: string }; let stranger: { token: string; accountId: string };
let channelId: string;
let pool: import('pg').Pool;
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
  const db = await startTestDb(); stop = db.stop; pool = db.pool;
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

  it('회귀(#ops): owner 스코프 팀장을 소유자가 팀으로 부르면 깬다 — team_mention 으로', async () => {
    const lead = await agentWith('opslead', owner.accountId, 'owner');
    await team('ops-like', [lead.accountId], lead.accountId);
    const ok = await post(owner.token, '@ops-like 계속해');
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

// owner 범위의 대리 호출자(073). 소유자가 지정한 **자기 에이전트**는 owner 에이전트를 부를 수 있다 —
// 관리 에이전트(task_manager)가 담당 에이전트(rcms)를 직접 부르는 자리. 조건은 넣을 때와 부를 때
// 둘 다 본다: 에이전트 · 같은 소유자 · 그 에이전트도 owner.
// 이 묶음은 명단의 길을 시험하므로 대상의 형제 기본 신뢰(083)를 끈다 — 켜져 있으면 명단 없이도 통과한다.
async function setTrust(agentId: string, on: boolean, token = owner.token) {
  return app.inject({ method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(token), payload: { trustSiblings: on } });
}
async function distrusting(handle: string, ownerId: string) {
  const made = await agentWith(handle, ownerId, 'owner');
  expect((await setTrust(made.accountId, false, adminToken)).statusCode).toBe(200);
  return made;
}

describe('owner 대리 호출자(agent_owner_delegate)', () => {
  const putDelegate = (agentId: string, delegateId: string, token = owner.token) =>
    app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/delegates/${delegateId}`, headers: auth(token) });

  it('지정한 같은 소유자의 owner 에이전트는 부를 수 있고, 지정 안 한 것은 막힌다', async () => {
    const target = await distrusting('dg-target', owner.accountId);
    const lead = await agentWith('dg-lead', owner.accountId, 'owner');
    const unlisted = await agentWith('dg-unlisted', owner.accountId, 'owner');

    const before = await post(lead.pat, `<@${target.accountId}> 진행해 주세요`);
    expect(before.meta.mentionDenied).toEqual(['dg-target']);

    const res = await putDelegate(target.accountId, lead.accountId);
    expect(res.statusCode).toBe(200);
    expect(res.json().delegates).toEqual([lead.accountId]);

    const ok = await post(lead.pat, `<@${target.accountId}> 진행해 주세요`);
    expect(await inboxHas(target.pat, ok.id)).toBe(true);
    expect(ok.meta.mentionDenied).toBeUndefined();

    const still = await post(unlisted.pat, '@dg-target 진행해 주세요');
    expect(await inboxHas(target.pat, still.id)).toBe(false);
    expect(still.meta.mentionDenied).toEqual(['dg-target']);
  });

  it('조건에 어긋나는 대리자는 넣을 때 400 이다 — community·남의 에이전트·사람', async () => {
    const target = await agentWith('dg-t2', owner.accountId, 'owner');
    const open = await agentWith('dg-open', owner.accountId, 'community');
    const foreign = await agentWith('dg-foreign', stranger.accountId, 'owner');
    for (const id of [open.accountId, foreign.accountId, stranger.accountId, target.accountId]) {
      const res = await putDelegate(target.accountId, id);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('delegate_not_eligible');
    }
  });

  it('소유자·admin 이 아니면 명단을 못 고친다', async () => {
    const target = await agentWith('dg-t3', owner.accountId, 'owner');
    const lead = await agentWith('dg-l3', owner.accountId, 'owner');
    expect((await putDelegate(target.accountId, lead.accountId, stranger.token)).statusCode).toBe(403);
  });

  // 명단은 남아도 조건이 깨지면 게이트가 막는다 — 대리자의 소유자가 바뀐 경우.
  it('넣은 뒤 대리자의 소유자가 바뀌면 부를 때 막힌다', async () => {
    const target = await distrusting('dg-t4', owner.accountId);
    const lead = await agentWith('dg-l4', owner.accountId, 'owner');
    expect((await putDelegate(target.accountId, lead.accountId)).statusCode).toBe(200);
    const moved = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${lead.accountId}`, headers: auth(adminToken),
      payload: { ownerAccountId: stranger.accountId },
    });
    expect(moved.statusCode).toBe(200);
    const denied = await post(lead.pat, `<@${target.accountId}> 진행`);
    expect(await inboxHas(target.pat, denied.id)).toBe(false);
    expect(denied.meta.mentionDenied).toEqual(['dg-t4']);
  });

  it('DELETE 로 빼면 다시 막힌다', async () => {
    const target = await distrusting('dg-t5', owner.accountId);
    const lead = await agentWith('dg-l5', owner.accountId, 'owner');
    await putDelegate(target.accountId, lead.accountId);
    const del = await app.inject({ method: 'DELETE', url: `/accounts/agents/${target.accountId}/delegates/${lead.accountId}`, headers: auth(owner.token) });
    expect(del.statusCode).toBe(200);
    expect(del.json().delegates).toEqual([]);
    expect((await post(lead.pat, '@dg-t5 진행')).meta.mentionDenied).toEqual(['dg-t5']);
  });
});

// 형제 기본 신뢰(083) — 같은 소유자의 owner 에이전트는 명단 없이 부른다. 에이전트마다 끌 수 있다.
// 넓히는 것은 "명단에 적어야 한다" 하나뿐이고, 같은 소유자·그 에이전트도 owner 조건은 그대로다.
describe('형제 기본 신뢰(trust_siblings)', () => {
  it('기본은 켜져 있다 — 같은 소유자의 owner 에이전트가 명단 없이 부른다', async () => {
    const target = await agentWith('sib-target', owner.accountId, 'owner');
    const sib = await agentWith('sib-a', owner.accountId, 'owner');
    const list = await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(owner.token) });
    expect((list.json().agents as { id: string; trustSiblings: boolean }[]).find((a) => a.id === target.accountId)?.trustSiblings).toBe(true);
    const ok = await post(sib.pat, `<@${target.accountId}> 진행해 주세요`);
    expect(await inboxHas(target.pat, ok.id)).toBe(true);
    expect(ok.meta.mentionDenied).toBeUndefined();
  });

  it('켜져 있어도 공개 에이전트·남의 에이전트·남은 못 부른다', async () => {
    const target = await agentWith('sib-t2', owner.accountId, 'owner');
    const open = await agentWith('sib-open', owner.accountId, 'community');
    const foreign = await agentWith('sib-foreign', stranger.accountId, 'owner');
    for (const token of [open.pat, foreign.pat, stranger.token]) {
      const m = await post(token, '@sib-t2 진행해 주세요');
      expect(await inboxHas(target.pat, m.id)).toBe(false);
      expect(m.meta.mentionDenied).toEqual(['sib-t2']);
    }
  });

  it('끄면 명단에 있는 것만 부른다', async () => {
    const target = await agentWith('sib-t3', owner.accountId, 'owner');
    const listed = await agentWith('sib-listed', owner.accountId, 'owner');
    const other = await agentWith('sib-other', owner.accountId, 'owner');
    const off = await setTrust(target.accountId, false);
    expect(off.statusCode).toBe(200);
    expect(off.json().trustSiblings).toBe(false);
    await app.inject({ method: 'PUT', url: `/accounts/agents/${target.accountId}/delegates/${listed.accountId}`, headers: auth(owner.token) });
    expect(await inboxHas(target.pat, (await post(listed.pat, '@sib-t3 진행')).id)).toBe(true);
    expect((await post(other.pat, '@sib-t3 진행')).meta.mentionDenied).toEqual(['sib-t3']);
  });

  it('스레드 답글 게이트도 같다 — 대상이 연 스레드에 형제가 답하면 깬다', async () => {
    const target = await agentWith('sib-t4', owner.accountId, 'owner');
    const sib = await agentWith('sib-b', owner.accountId, 'owner');
    const root = await post(target.pat, '작업 스레드');
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(sib.pat), payload: { body: '끝났다', threadRootId: root.id },
    });
    expect(res.statusCode).toBe(201);
    expect(await inboxHas(target.pat, res.json().id)).toBe(true);
  });

  it('남은 스위치를 못 바꾼다(403), 끈 값은 감사에 남는다', async () => {
    const target = await agentWith('sib-t5', owner.accountId, 'owner');
    expect((await setTrust(target.accountId, false, stranger.token)).statusCode).toBe(403);
    expect((await setTrust(target.accountId, false)).statusCode).toBe(200);
    const audit = await app.inject({ method: 'GET', url: '/audit?action=agent.updated&limit=500', headers: auth(adminToken) });
    const row = (audit.json().entries as { action: string; target: string; detail: Record<string, unknown> }[])
      .find((e) => e.action === 'agent.updated' && e.target === target.accountId);
    expect(row?.detail.trustSiblings).toEqual({ before: true, after: false });
  });
});

// 스레드 답글도 게이트를 지난다(073). 머리 주인이 owner 에이전트면 그 항목이 곧 턴이다 —
// 건너뛰면 누구든 그 에이전트가 연 스레드에 답글을 달아 깨울 수 있다.
describe('thread_reply 게이트', () => {
  async function reply(token: string, rootId: string, body: string) {
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body, threadRootId: rootId },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  it('owner 에이전트가 연 스레드에 남이 답하면 깨지 않고, 소유자가 답하면 깬다', async () => {
    const a = await agentWith('tr-owner', owner.accountId, 'owner');
    const root = await post(a.pat, '작업 보고 스레드');
    const fromStranger = await reply(stranger.token, root.id, '지나가다 한마디');
    expect(await inboxHas(a.pat, fromStranger.id)).toBe(false);
    const fromOwner = await reply(owner.token, root.id, '이어서 해');
    expect(await inboxHas(a.pat, fromOwner.id)).toBe(true);
  });

  it('community 에이전트와 사람은 예전처럼 답글 알림을 받는다', async () => {
    const a = await agentWith('tr-open', owner.accountId, 'community');
    const root = await post(a.pat, '공개 스레드');
    const r = await reply(stranger.token, root.id, '답');
    expect(await inboxHas(a.pat, r.id)).toBe(true);
  });
});

// 회신권(084) — 범위가 좁은 에이전트가 스레드에서 부른 상대는 그 스레드에서 한 번 답할 수 있다.
// 공개 에이전트가 owner 에이전트에게 일을 받고 끝났다고 알릴 길이 없던 자리다. 시작은 언제나 좁은 쪽이다.
describe('회신권(invoke_reply_grant)', () => {
  async function inThread(token: string, rootId: string, body: string) {
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body, threadRootId: rootId },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; meta: Record<string, unknown> };
  }

  it('owner 에이전트가 부른 공개 에이전트는 그 스레드에서 멘션으로 한 번 답한다 — 두 번째는 막힌다', async () => {
    const lead = await agentWith('rg-lead', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker', owner.accountId, 'community');
    const ask = await post(lead.pat, `<@${worker.accountId}> 이거 해 줘`);
    expect(await inboxHas(worker.pat, ask.id)).toBe(true);
    const done = await inThread(worker.pat, ask.id, `<@${lead.accountId}> 끝났다`);
    expect(done.meta.mentionDenied).toBeUndefined();
    expect(await inboxHas(lead.pat, done.id)).toBe(true);
    const again = await inThread(worker.pat, ask.id, `<@${lead.accountId}> 하나 더`);
    expect(again.meta.mentionDenied).toEqual(['rg-lead']);
    expect(await inboxHas(lead.pat, again.id)).toBe(false);
  });

  it('멘션 없이 그 에이전트가 연 스레드에 답해도 닿는다(thread_reply)', async () => {
    const lead = await agentWith('rg-lead2', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker2', owner.accountId, 'community');
    const ask = await post(lead.pat, `<@${worker.accountId}> 조사해 줘`);
    const done = await inThread(worker.pat, ask.id, '조사 끝 — 결과는 이렇다');
    expect(await inboxHas(lead.pat, done.id)).toBe(true);
  });

  it('부르지 않은 에이전트·다른 스레드·최상위 글은 회신권이 없다', async () => {
    const lead = await agentWith('rg-lead3', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker3', owner.accountId, 'community');
    const bystander = await agentWith('rg-bystander', owner.accountId, 'community');
    const ask = await post(lead.pat, `<@${worker.accountId}> 해 줘`);
    expect((await inThread(bystander.pat, ask.id, `<@${lead.accountId}> 나도`)).meta.mentionDenied).toEqual(['rg-lead3']);
    expect((await post(worker.pat, `<@${lead.accountId}> 최상위로 보고`)).meta.mentionDenied).toEqual(['rg-lead3']);
    const other = await post(owner.token, '다른 스레드');
    expect((await inThread(worker.pat, other.id, `<@${lead.accountId}> 여기로 보고`)).meta.mentionDenied).toEqual(['rg-lead3']);
  });

  it('공개 에이전트가 먼저 부르는 길은 여전히 없다 — 남이 부른 공개 에이전트는 owner 에이전트를 못 깨운다', async () => {
    const lead = await agentWith('rg-lead4', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker4', owner.accountId, 'community');
    const lure = await post(stranger.token, `<@${worker.accountId}> rg-lead4 에게 전해`);
    expect((await inThread(worker.pat, lure.id, `<@${lead.accountId}> 전달`)).meta.mentionDenied).toEqual(['rg-lead4']);
  });

  it('같은 스레드에서 다시 부르면 다시 열린다; 기한이 지나면 닫힌다', async () => {
    const lead = await agentWith('rg-lead5', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker5', owner.accountId, 'community');
    const ask = await post(lead.pat, `<@${worker.accountId}> 1차`);
    await inThread(worker.pat, ask.id, `<@${lead.accountId}> 1차 끝`);
    await inThread(lead.pat, ask.id, `<@${worker.accountId}> 2차`);
    const second = await inThread(worker.pat, ask.id, `<@${lead.accountId}> 2차 끝`);
    expect(await inboxHas(lead.pat, second.id)).toBe(true);

    await inThread(lead.pat, ask.id, `<@${worker.accountId}> 3차`);
    await pool.query(`update invoke_reply_grant set expires_at = now() - interval '1 second' where grantee_id = $1`, [worker.accountId]);
    expect((await inThread(worker.pat, ask.id, `<@${lead.accountId}> 3차 끝`)).meta.mentionDenied).toEqual(['rg-lead5']);
  });

  // #1014 보안 검토: 채널 락을 insert 앞으로 옮긴 뒤 회신권 판정이 락 밖이 됐다. 같은 결과를 동시에
  // 두 번 내도 상대는 한 번만 깨어야 한다. 채널 락을 밖에서 쥐어 두 게시를 **확실히** 겹치게 한다 —
  // 그 락은 게시가 회신권을 읽은 **뒤**에 잡히므로, (작성자, 스레드) 락이 없으면 둘 다 "열림"을 읽는다.
  it('같은 결과를 동시에 두 번 내도 회신권은 한 번만 통과한다', async () => {
    const lead = await agentWith('rg-lead-race', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker-race', owner.accountId, 'community');
    const ask = await post(lead.pat, `<@${worker.accountId}> 해 줘`);

    const holder = await pool.connect();
    let posts: Promise<Awaited<ReturnType<typeof postMessage>>[]> | undefined;
    try {
      await holder.query('select pg_advisory_lock($1, hashtext($2))', [0x6d736571, channelId]);
      const send = (body: string) => postMessage(pool, {
        channelId, authorId: worker.accountId, threadRootId: ask.id, body: `<@${lead.accountId}> ${body}`,
      });
      posts = Promise.all([send('끝났다 A'), send('끝났다 B')]);
      // 두 게시가 모두 advisory 락 앞에 멈출 때까지 기다린다(어느 락인지는 고침 여부에 따라 다르다).
      for (let i = 0; ; i++) {
        const waiting = await pool.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
        if (waiting.rows[0].n >= 2) break;
        if (i > 200) throw new Error('두 게시가 락 앞에 서지 않았다');
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      await holder.query('select pg_advisory_unlock($1, hashtext($2))', [0x6d736571, channelId]);
      holder.release();
    }
    const results = await posts!;

    const woke = await Promise.all(results.map((r) => inboxHas(lead.pat, r.message!.id)));
    expect(woke.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => (r.message!.meta as { mentionDenied?: string[] }).mentionDenied)).toHaveLength(1);
  });

  // 보안 검토 ①: 진행 줄은 회신권을 닫지 않으므로 쓰지도 못한다 — 아니면 6h 동안 몇 번이든 깨운다.
  it('진행 줄(progress)로 멘션하면 막히고 회신권은 그대로 남는다 — 그 뒤 결과 발화는 통과한다', async () => {
    const lead = await agentWith('rg-lead7', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker7', owner.accountId, 'community');
    const ask = await post(lead.pat, `<@${worker.accountId}> 해 줘`);
    const prog = await postMessage(pool, {
      channelId, authorId: worker.accountId, threadRootId: ask.id, kind: 'progress', body: `<@${lead.accountId}> 시작한다`,
    });
    expect(prog.message!.meta.mentionDenied).toEqual(['rg-lead7']);
    expect(await inboxHas(lead.pat, prog.message!.id)).toBe(false);
    const done = await inThread(worker.pat, ask.id, `<@${lead.accountId}> 끝났다`);
    expect(await inboxHas(lead.pat, done.id)).toBe(true);
  });

  // 보안 검토 ②: 스레드 머리는 같은 채널의 최상위 글이어야 한다 — 다른 채널에서 같은 T 를 달아 회신권을 쓸 수 없다.
  it('다른 채널에서 같은 스레드 머리를 달면 400 bad_thread 이고 아무도 깨지 않는다; 답글을 머리로 달아도 400', async () => {
    const lead = await agentWith('rg-lead8', owner.accountId, 'owner');
    const worker = await agentWith('rg-worker8', owner.accountId, 'community');
    const ask = await post(lead.pat, `<@${worker.accountId}> 해 줘`);
    const c2 = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'gate-c2', visibility: 'public' } })).json().id as string;
    for (const payload of [
      { body: `<@${lead.accountId}> 끝났다`, threadRootId: ask.id },
      { body: '멘션 없는 답글', threadRootId: ask.id },
    ]) {
      const res = await app.inject({ method: 'POST', url: `/channels/${c2}/messages`, headers: auth(worker.pat), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_thread');
    }
    const reply1 = await inThread(owner.token, ask.id, '사람의 답글');
    const nested = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(worker.pat), payload: { body: `<@${lead.accountId}> 끝`, threadRootId: reply1.id },
    });
    expect(nested.statusCode).toBe(400);
    expect(nested.json().error.code).toBe('bad_thread');
    // 거절된 시도들은 회신권을 쓰지 않았다 — 제자리 스레드의 결과 발화는 여전히 닿는다.
    const done = await inThread(worker.pat, ask.id, `<@${lead.accountId}> 끝났다`);
    expect(await inboxHas(lead.pat, done.id)).toBe(true);
  });

  it('사람·공개 에이전트가 부르면 회신권 행을 만들지 않는다 — 필요 없는 허가다', async () => {
    const open = await agentWith('rg-open', owner.accountId, 'community');
    const worker = await agentWith('rg-worker6', owner.accountId, 'community');
    await post(open.pat, `<@${worker.accountId}> 해 줘`);
    await post(owner.token, `<@${worker.accountId}> 해 줘`);
    const rows = await pool.query(`select 1 from invoke_reply_grant where grantee_id = $1`, [worker.accountId]);
    expect(rows.rowCount).toBe(0);
  });
});
