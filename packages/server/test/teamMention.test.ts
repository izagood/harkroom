import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * `@팀` 으로 에이전트 팀을 부른다(#172 의 나머지 절반).
 *
 * `036_agent_team.sql` 이 이 순간을 위해 이름을 예약해 뒀다: *"이름은 계정 handle·집합
 * handle 과 같은 네임스페이스를 쓴다. 나중에 `@팀` 멘션을 열 여지를 남기기 위한 예약이고,
 * 그래서 유일성도 멘션 해석과 같은 기준이어야 한다"*. 여기서 그 여지를 쓴다.
 *
 * 이 파일이 지키는 것 — **집합(#230)과 같은 규칙을 팀이 쓴다**:
 * 1. 팀을 멘션하면 팀원 전원의 inbox 에 들어간다.
 * 2. 채널을 볼 수 없는 팀원은 들어가지 않는다(`fanOutMention` 의 가시성 판정 하나).
 * 3. 부른 사람 자신은 빠진다.
 * 4. 본문은 손대지 않는다 — `@팀` 은 원문에 그대로 남는다.
 * 5. 비활성 팀원은 **부름이 닿지 않는다** — 채널에 넣을 때와 같은 판정을 멘션에서도 한다.
 * 6. 같은 팀을 두 번 적어도 알림은 한 번(`notified` 중복 제거).
 * 7. `memberCount` 가 팀 행을 주는 **모든 경로**에 실린다(#285 가 집합에 대해 정한 계약).
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;

/** 팀원 에이전트 셋. "팀원 전원" 이 뜻을 갖게 하려면 하나로는 안 된다. */
let a1Pat: string;
let a1Id: string;
let a2Pat: string;
let a2Id: string;
/**
 * 팀에는 들어 있지만 private 채널은 **볼 수 없는** 에이전트. 가시성 회귀선이 이 계정
 * 없이는 아무것도 지키지 않는다(`handleGroup.test.ts` 의 `blindmember` 와 같은 자리).
 */
let blindPat: string;
let blindId: string;
/**
 * 비활성 팀원. 팀에는 남고 부름은 닿지 않아야 한다.
 *
 * PAT 를 잡아 두지 않는다 — 비활성 계정의 PAT 는 401 이라(실측) inbox 를 라우트로 읽을
 * 수 없고, 그 확인은 표를 직접 본다(아래 3번).
 */
let offId: string;

let privateId: string;
let publicId: string;
let teamId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createChannel(name: string, visibility: 'public' | 'private'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name, visibility },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function post(token: string, channelId: string, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function inboxFor(pat: string, messageId: string): Promise<Array<{ reason: string }>> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(pat) });
  expect(res.statusCode).toBe(200);
  return (res.json().entries as Array<{ reason: string; messageId: string }>)
    .filter((e) => e.messageId === messageId)
    // 사유만 남긴다 — 그것이 이 파일이 재는 사실이고, 행 전체를 견주면 `id`·`createdAt`
    // 같은 무관한 값이 어긋날 때마다 이 테스트가 거짓 실패한다.
    .map((e) => ({ reason: e.reason }));
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  ({ pat: a1Pat, accountId: a1Id } = await createAgent(app, adminToken, 'tmagent1'));
  ({ pat: a2Pat, accountId: a2Id } = await createAgent(app, adminToken, 'tmagent2'));
  ({ pat: blindPat, accountId: blindId } = await createAgent(app, adminToken, 'tmblind'));
  ({ accountId: offId } = await createAgent(app, adminToken, 'tmoff'));

  // 비활성화는 팀원을 지우지 않는다(`036` 주석) — 먼저 팀에 넣고 나서 끈다.
  const team = await app.inject({
    method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'release' },
  });
  expect(team.statusCode).toBe(201);
  teamId = team.json().id as string;
  for (const accountId of [a1Id, a2Id, blindId, offId]) {
    const res = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${accountId}`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
  }
  const off = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${offId}`, headers: auth(adminToken),
    payload: { disabled: true },
  });
  expect(off.statusCode).toBe(200);

  privateId = await createChannel('teamchan', 'private');
  publicId = await createChannel('teampub', 'public');
  // `tmblind` 는 **일부러 넣지 않는다** — 팀에는 있고 채널은 못 보는 에이전트다.
  // `tmoff` 는 넣는다: 비활성이 걸러지는 것이 가시성 때문이 아니라는 것을 보이려면
  // 그 계정이 채널을 볼 수 있어야 한다.
  for (const accountId of [a1Id, a2Id, offId]) {
    const res = await app.inject({
      method: 'POST', url: `/channels/${privateId}/members`,
      headers: auth(adminToken), payload: { accountId },
    });
    expect(res.statusCode).toBe(200);
  }
});

afterAll(async () => { await app.close(); await stop(); });

describe('#172 `@팀` 멘션', () => {
  it('1. 팀을 부르면 팀원 전원의 인박스에 들어간다', async () => {
    const messageId = await post(adminToken, publicId, '@release 배포 준비해라');

    expect(await inboxFor(a1Pat, messageId)).toEqual([{ reason: 'mention' }]);
    expect(await inboxFor(a2Pat, messageId)).toEqual([{ reason: 'mention' }]);
    // public 채널은 누구나 볼 수 있으므로 `tmblind` 도 여기서는 깬다 — 가시성이 아니라
    // 팀 명단이 대상을 정한다는 것을 이 줄이 말한다.
    expect(await inboxFor(blindPat, messageId)).toEqual([{ reason: 'mention' }]);
  });

  it('2. 가시성 없는 팀원은 안 들어간다', async () => {
    const messageId = await post(adminToken, privateId, '@release private 에서 부른다');

    expect(await inboxFor(a1Pat, messageId)).toEqual([{ reason: 'mention' }]);
    expect(await inboxFor(a2Pat, messageId)).toEqual([{ reason: 'mention' }]);
    // 팀원이지만 이 채널을 볼 수 없다 — `fanOutMention` 의 `channelVisibleSql` 하나가
    // 그 판정을 한다. 이 줄이 없으면 우회 경로가 조용히 들어와도 아무것도 안 깨진다.
    expect(await inboxFor(blindPat, messageId)).toEqual([]);
  });

  /**
   * 비활성 팀원은 팀에 **남고**(`036`: 명단은 운영자의 의도 기록이다) 부름은 닿지 않는다.
   *
   * inbox 를 라우트로 못 읽는다 — 비활성 계정의 PAT 는 401 이다(실측). 그래서 표를 직접
   * 본다: 이 테스트가 재는 사실은 "항목이 만들어졌나" 이고 그것은 표에 있다.
   */
  it('3. 비활성 팀원은 부름이 닿지 않는다 — 팀에는 남아 있다', async () => {
    const messageId = await post(adminToken, privateId, '@release 비활성 확인');

    // `tmoff` 는 팀원이고 **채널 멤버이기도 하다** — 그래도 안 깬다. 걸러진 사유가
    // 가시성이 아니라 비활성이라는 것을 이 조합이 증명한다(가시성 필터로는 이것을
    // 대신할 수 없다는 `messages.ts` 주석의 근거가 여기다).
    const inbox = await pool.query(
      `select 1 from inbox where account_id = $1 and message_id = $2`, [offId, messageId],
    );
    expect(inbox.rowCount).toBe(0);
    const member = await pool.query(
      `select 1 from channel_member where channel_id = $1 and account_id = $2`,
      [privateId, offId],
    );
    expect(member.rowCount).toBe(1);

    // 명단에서 지워지지도 않았다 — 다시 켜면 다시 넣을 필요가 없다.
    const still = await app.inject({
      method: 'GET', url: `/teams/${teamId}`, headers: auth(adminToken),
    });
    const members = still.json().members as Array<{ handle: string; disabled: boolean }>;
    expect(members.find((m) => m.handle === 'tmoff')).toEqual({
      accountId: offId, handle: 'tmoff', disabled: true,
    });
  });

  it('4. 부른 사람 자신은 빠지고, 본문은 손대지 않는다', async () => {
    const messageId = await post(a1Pat, publicId, '@release 내가 부른다');

    expect(await inboxFor(a1Pat, messageId)).toEqual([]);
    expect(await inboxFor(a2Pat, messageId)).toEqual([{ reason: 'mention' }]);

    const row = await pool.query(`select body from message where id = $1`, [messageId]);
    // 팀 이름은 계정이 아니므로 `normalizeMentions` 가 지나친다 — `@release` 가 원문에
    // 그대로 남아야 한다(`@channel`·집합과 같은 결정).
    expect(row.rows[0].body).toBe('@release 내가 부른다');
  });

  it('5. 같은 팀을 두 번 적어도 알림은 하나다', async () => {
    const messageId = await post(adminToken, publicId, '@release @release 두 번');
    expect(await inboxFor(a1Pat, messageId)).toEqual([{ reason: 'mention' }]);
  });

  it('6. 없는 이름은 아무 일도 하지 않는다', async () => {
    const messageId = await post(adminToken, publicId, '@nosuchteam 아무도 없다');
    expect(await inboxFor(a1Pat, messageId)).toEqual([]);
  });

  /**
   * 응답 헤더가 **깬 사람 수**를 말한다. 데스크탑이 이 수를 팀의 `memberCount` 와 견줘
   * "셋을 불러 둘만 깼다"를 그린다(`lib/notified.ts`) — 멘션만 열고 이 수를 안 주면
   * `#230` 이 막으려던 조용한 실패가 팀에서 되살아난다.
   */
  it('7. private 채널에서 팀을 부르면 깬 수가 명단보다 적다고 헤더가 말한다', async () => {
    const res = await app.inject({
      method: 'POST', url: `/channels/${privateId}/messages`,
      headers: auth(adminToken), payload: { body: '@release 헤더 확인' },
    });
    expect(res.statusCode).toBe(201);
    // 팀원 넷 중 둘만 깬다(blind 는 못 보고, off 는 비활성).
    expect(res.headers['x-murmur-notified-count']).toBe('2');
  });

  /**
   * `memberCount`(#285 가 집합에 대해 정한 계약)를 팀 행을 주는 **모든 경로**가 싣는다.
   *
   * 한 경로만 확인하면 안 되는 이유는 그 이슈의 주석이 이미 적어 뒀다: 한 곳이 수를
   * 빠뜨리면 그 화면만 `undefined명` 이 되고, 필수 필드라도 서버 응답은 런타임 값이라
   * 타입이 잡아 주지 않는다. **갓 만든 팀의 0 도 여기서 확인한다** — 그 자리를 손으로
   * 적으면 `COLS` 를 안 쓰는 경로가 하나 생긴다(`handleGroups.ts` 의 같은 주석).
   */
  it('8. 구성원 수가 팀 행을 주는 모든 경로에 실린다', async () => {
    const list = await app.inject({ method: 'GET', url: '/teams', headers: auth(a1Pat) });
    const found = (list.json().teams as Array<{ name: string; memberCount: number }>)
      .find((t) => t.name === 'release');
    expect(found?.memberCount).toBe(4);

    const one = await app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: auth(a1Pat) });
    expect(one.json().team.memberCount).toBe(4);

    const created = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'freshteam' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().memberCount).toBe(0);

    const renamed = await app.inject({
      method: 'PATCH', url: `/teams/${created.json().id}`, headers: auth(adminToken),
      payload: { name: 'freshteam2' },
    });
    expect(renamed.json().memberCount).toBe(0);
  });
});

/**
 * ## 세 네임스페이스가 배타인가 — 실측
 *
 * `036_agent_team.sql` 은 *"유일성도 멘션 해석과 같은 기준이어야 한다"* 고 적었지만, 그
 * 기준을 지키는 문장은 **팀 쪽에만** 있다: `createTeam` 은 계정·집합·팀 셋을 모두 확인하는
 * 반면 `createHandleGroup` 은 `account` 만 보고 `agent_team` 을 보지 않으며, 계정 생성
 * (`authRoutes.ts` 의 register · `services/agents.ts` 의 에이전트 생성)도 `handle_group`
 * 만 본다.
 *
 * 그래서 **배타가 아니다** — 아래 두 테스트가 그것을 고정한다. 이 파일이 그 구멍을 고치는
 * 것이 아니라(계정·집합 생성 경로의 사실이다) **겹쳐 있을 때의 답을 하나로 못 박는다.**
 * 그 순서가 `services/messages.ts` 의 그 루프에 주석으로 적혀 있다: 계정 → 집합 → 팀.
 */
describe('세 네임스페이스의 겹침과 해석 순서', () => {
  it('팀 이름과 같은 집합을 나중에 만들 수 있다 — 배타가 아니다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/handle-groups', headers: auth(adminToken),
      payload: { handle: 'release', displayName: '겹친 집합' },
    });
    // 팀 `release` 가 이미 있는데도 201 이다. `createHandleGroup` 이 `agent_team` 을
    // 보지 않기 때문이고, 이것이 아래 순서 테스트가 필요한 이유다.
    expect(res.statusCode).toBe(201);
  });

  it('겹치면 집합이 이긴다 — 사람의 부름이 에이전트의 부름에 밀리지 않는다', async () => {
    const human = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
    const created = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        handle: 'tmhuman', loginId: 'tmhuman', displayName: 'Tm Human',
        password: 'pw123456', inviteToken: human.json().token as string,
      },
    });
    expect(created.statusCode).toBe(201);
    const humanId = created.json().id as string;
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'tmhuman', password: 'pw123456' },
    });
    const humanToken = login.json().token as string;

    const group = await app.inject({
      method: 'GET', url: '/handle-groups', headers: auth(adminToken),
    });
    const groupId = (group.json().groups as Array<{ id: string; handle: string }>)
      .find((g) => g.handle === 'release')!.id;
    const added = await app.inject({
      method: 'POST', url: `/handle-groups/${groupId}/members`,
      headers: auth(adminToken), payload: { accountIds: [humanId] },
    });
    expect(added.statusCode).toBe(200);

    const messageId = await post(adminToken, publicId, '@release 겹친 이름을 부른다');

    // 집합의 사람이 깬다.
    expect(await inboxFor(humanToken, messageId)).toEqual([{ reason: 'mention' }]);
    // 같은 이름의 **팀은 펼쳐지지 않는다.** 둘 다 펼쳐지는 것이 가장 나쁘다 — `@release`
    // 가 사람 집합인지 에이전트 팀인지 부른 사람이 모르게 된다.
    expect(await inboxFor(a1Pat, messageId)).toEqual([]);
    expect(await inboxFor(a2Pat, messageId)).toEqual([]);
  });
});
