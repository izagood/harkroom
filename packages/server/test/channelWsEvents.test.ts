import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { onEvent } from '../src/events.js';

/**
 * 채널 목록 변경 WS 이벤트(#284).
 *
 * 두 계정을 쓴다: `admin`(부트스트랩한 admin)과 `bystander`(에이전트 계정, admin 아님).
 * 이 구분이 이 파일의 핵심이다 — admin 은 자기가 멤버가 아닌 private 채널도 **목록에서는**
 * 본다(`listChannels` 의 admin 예외). 그래서 public→private 전환에서 채널을 잃는 사람은
 * admin 이 아닌 비멤버뿐이고, 수신자 계산이 그 예외를 모르면 admin 의 화면에서 방금
 * 자기가 비공개로 바꾼 채널이 "삭제됐다"며 사라진다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let bystanderPat: string;
let bystanderId: string;
let baseUrl: string;
let pool: Pool;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: bystanderId, pat: bystanderPat } = await createAgent(app, adminToken, 'bystander'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function ticketFor(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  return res.json().ticket as string;
}

interface Sink { events: any[]; ready: Promise<void>; close(): void }

function collectWithTicket(ticket: string): Sink {
  const events: any[] = [];
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as { type?: string }).type === 'presence.snapshot') resolve();
    });
  });
  return { events, ready, close: () => ws.close() };
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * "오지 않았다" 를 단언하기 전에 기다리는 시간.
 *
 * 고정 대기는 원래 약하다 — 이벤트가 늦게 오면 통과해 버린다. 그래서 이 파일의 부재
 * 단언은 **같은 라운드트립에서 다른 소켓이 이미 받았음**을 먼저 확인한 뒤에만 쓴다.
 * 그러면 "아직 안 왔다" 와 "오지 않는다" 가 구분된다.
 */
const settle = () => new Promise((r) => setTimeout(r, 300));

const has = (s: Sink, type: string, pred: (e: any) => boolean = () => true) =>
  s.events.some((e) => e.type === type && pred(e));

async function createChannel(name: string, visibility: 'public' | 'private'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name, visibility },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const patchChannel = (id: string, payload: Record<string, unknown>) => app.inject({
  method: 'PATCH', url: `/channels/${id}`,
  headers: { authorization: `Bearer ${adminToken}` }, payload,
});

const listChannelIds = async (token: string): Promise<string[]> => {
  const res = await app.inject({ method: 'GET', url: '/channels', headers: { authorization: `Bearer ${token}` } });
  return (res.json() as { channels: { id: string }[] }).channels.map((c) => c.id);
};

describe('채널 목록 변경 WS 이벤트 (#284)', () => {
  const collect = async (token: string) => collectWithTicket(await ticketFor(token));

  it('1. public 채널을 만들면 다른 계정의 소켓도 channel.created 를 받는다', async () => {
    const admin = await collect(adminToken);
    const bystander = await collect(bystanderPat);
    await admin.ready; await bystander.ready;

    const channelId = await createChannel('created-public', 'public');

    await waitFor(() =>
      has(admin, 'channel.created', (e) => e.channel.id === channelId) &&
      has(bystander, 'channel.created', (e) => e.channel.id === channelId));

    // 페이로드는 ChannelView 전체다 — 목록을 그리려면 이름과 공개 범위가 있어야 한다.
    const seen = bystander.events.find((e) => e.type === 'channel.created' && e.channel.id === channelId);
    expect(seen.channel.name).toBe('created-public');
    expect(seen.channel.visibility).toBe('public');
    expect(seen.audience).toBe('all');

    admin.close(); bystander.close();
  });

  it('2. private 채널 생성 이벤트는 admin 도 멤버도 아닌 계정에 가지 않는다', async () => {
    const admin = await collect(adminToken);
    const bystander = await collect(bystanderPat);
    await admin.ready; await bystander.ready;

    const channelId = await createChannel('created-private', 'private');

    // 만든 사람(admin, 그리고 첫 멤버)은 받는다. 이것을 먼저 확인해야 아래 부재 단언이
    // "아직 안 왔다" 가 아니라 "오지 않는다" 를 뜻한다.
    await waitFor(() => has(admin, 'channel.created', (e) => e.channel.id === channelId));
    await settle();
    expect(has(bystander, 'channel.created', (e) => e.channel.id === channelId)).toBe(false);

    admin.close(); bystander.close();
  });

  it('3. 삭제하면 그 채널을 볼 수 있던 계정 전원이 channel.deleted 를 받는다', async () => {
    const channelId = await createChannel('to-delete', 'public');
    const admin = await collect(adminToken);
    const bystander = await collect(bystanderPat);
    await admin.ready; await bystander.ready;

    // 삭제는 보관된 채널만 가능하다.
    expect((await patchChannel(channelId, { archived: true })).statusCode).toBe(200);
    const del = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);

    await waitFor(() =>
      has(admin, 'channel.deleted', (e) => e.channelId === channelId) &&
      has(bystander, 'channel.deleted', (e) => e.channelId === channelId));

    admin.close(); bystander.close();
  });

  it('4. public→private: 비멤버는 channel.deleted 를 받고 admin 은 받지 않는다', async () => {
    const channelId = await createChannel('to-private', 'public');
    const admin = await collect(adminToken);
    const bystander = await collect(bystanderPat);
    await admin.ready; await bystander.ready;

    expect((await patchChannel(channelId, { visibility: 'private' })).statusCode).toBe(200);

    // 비멤버·비admin 에게는 채널이 사라진 것이므로 삭제로 보인다.
    await waitFor(() => has(bystander, 'channel.deleted', (e) => e.channelId === channelId));
    // admin 은 멤버가 아니지만 목록에서는 계속 본다 — 그러니 삭제가 아니라 갱신이다.
    await waitFor(() => has(admin, 'channel.updated',
      (e) => e.channel.id === channelId && e.channel.visibility === 'private'));
    // 여기가 수신자 필터의 핵심 단언이다. `audience: 'all'` 로 보내면 admin 도 삭제를
    // 받아, 보고 있던 채널이 비워지고 "삭제됐다" 안내가 뜬다.
    await settle();
    expect(has(admin, 'channel.deleted', (e) => e.channelId === channelId)).toBe(false);
    // 반대 방향도 같이 잠근다: 채널을 잃은 사람에게 갱신을 보내면 목록에 되살아난다.
    expect(has(bystander, 'channel.updated', (e) => e.channel.id === channelId)).toBe(false);

    admin.close(); bystander.close();
  });

  it('4b. public→private: 멤버는 channel.updated 만 받는다', async () => {
    const channelId = await createChannel('to-private-member', 'public');
    const add = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: bystanderId },
    });
    expect(add.statusCode).toBe(200);

    const bystander = await collect(bystanderPat);
    await bystander.ready;

    expect((await patchChannel(channelId, { visibility: 'private' })).statusCode).toBe(200);

    await waitFor(() => has(bystander, 'channel.updated',
      (e) => e.channel.id === channelId && e.channel.visibility === 'private'));
    await settle();
    expect(has(bystander, 'channel.deleted', (e) => e.channelId === channelId)).toBe(false);

    bystander.close();
  });

  it('4c. private→public: 그때까지 못 보던 계정도 channel.updated 로 채널을 얻는다', async () => {
    const channelId = await createChannel('to-public-again', 'private');
    const bystander = await collect(bystanderPat);
    await bystander.ready;

    expect((await patchChannel(channelId, { visibility: 'public' })).statusCode).toBe(200);

    // 반대 전환은 "새로 생긴 것" 과 구분할 수 없지만, 이벤트 이름은 updated 로 고정돼
    // 있다(#284). 그래서 데스크탑이 updated 를 upsert 로 다뤄야 목록에 나타난다.
    await waitFor(() => has(bystander, 'channel.updated',
      (e) => e.channel.id === channelId && e.channel.visibility === 'public'));
    expect(await listChannelIds(bystanderPat)).toContain(channelId);

    bystander.close();
  });

  it('5. 담기·상태 변경·해제의 saved.changed 는 본인 소켓에만 간다', async () => {
    const channelId = await createChannel('saved-events', 'public');
    const msgRes = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'saved target' },
    });
    const messageId = msgRes.json().id as string;

    const admin = await collect(adminToken);
    const bystander = await collect(bystanderPat);
    await admin.ready; await bystander.ready;

    await app.inject({ method: 'PUT', url: `/saved/${messageId}`, headers: { authorization: `Bearer ${adminToken}` } });
    await waitFor(() => has(admin, 'saved.changed', (e) => e.messageId === messageId && e.state === 'open'));

    // 담기는 개인의 사실이다 — 남의 소켓에 가면 그 사람의 "Saved N" 이 틀린다.
    await settle();
    expect(has(bystander, 'saved.changed')).toBe(false);

    await app.inject({
      method: 'PATCH', url: `/saved/${messageId}`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { state: 'done' },
    });
    await waitFor(() => has(admin, 'saved.changed', (e) => e.messageId === messageId && e.state === 'done'));

    await app.inject({ method: 'DELETE', url: `/saved/${messageId}`, headers: { authorization: `Bearer ${adminToken}` } });
    // 해제는 명시적 null 이다 — undefined 면 JSON 에서 키가 사라져 클라이언트가 "안 바뀜" 으로 읽는다.
    await waitFor(() => has(admin, 'saved.changed', (e) => e.messageId === messageId && e.state === null));
    const unsaved = admin.events.filter((e) => e.type === 'saved.changed').at(-1);
    expect(Object.prototype.hasOwnProperty.call(unsaved, 'state')).toBe(true);
    expect(unsaved.state).toBeNull();

    await settle();
    expect(has(bystander, 'saved.changed')).toBe(false);

    admin.close(); bystander.close();
  });

  /**
   * 7. 발행은 커밋 뒤다.
   *
   * "커밋 뒤" 를 직접 관찰하는 방법은 이벤트를 받은 **그 순간** 조회해 보는 것이다:
   * 커밋 전에 발행하면 수신자가 아직 옛 상태를 읽는다. 실패해서 아무것도 커밋되지 않은
   * 요청에서는 이벤트가 아예 없어야 한다 — 롤백된 트랜잭션의 이벤트가 그것이다.
   */
  it('7. 생성 이벤트를 받은 순간 조회하면 그 채널이 이미 목록에 있다', async () => {
    const bystander = await collect(bystanderPat);
    await bystander.ready;

    const seenAt: Promise<string[]> = new Promise((resolve) => {
      const timer = setInterval(() => {
        const e = bystander.events.find((x) => x.type === 'channel.created' && x.channel.name === 'commit-order');
        if (e) { clearInterval(timer); resolve(listChannelIds(bystanderPat)); }
      }, 5);
    });
    const channelId = await createChannel('commit-order', 'public');
    expect(await seenAt).toContain(channelId);

    bystander.close();
  });

  it('7b. 삭제 이벤트를 받은 순간 조회하면 그 채널이 이미 목록에 없다', async () => {
    const channelId = await createChannel('commit-order-delete', 'public');
    const bystander = await collect(bystanderPat);
    await bystander.ready;
    await patchChannel(channelId, { archived: true });

    const seenAt: Promise<string[]> = new Promise((resolve) => {
      const timer = setInterval(() => {
        if (has(bystander, 'channel.deleted', (e) => e.channelId === channelId)) {
          clearInterval(timer); resolve(listChannelIds(bystanderPat));
        }
      }, 5);
    });
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(await seenAt).not.toContain(channelId);

    bystander.close();
  });

  it('7c. 실패한 삭제(보관되지 않음, 409)에서는 channel.deleted 가 나가지 않는다', async () => {
    const channelId = await createChannel('never-deleted', 'public');
    const admin = await collect(adminToken);
    const bystander = await collect(bystanderPat);
    await admin.ready; await bystander.ready;

    const del = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(409);

    // 같은 소켓이 이벤트를 받을 수 있음을 증명해 두고(부재 단언의 대조군), 그 다음에
    // 삭제 이벤트가 없다는 것을 단언한다.
    await patchChannel(channelId, { topic: 'still here' });
    await waitFor(() => has(bystander, 'channel.updated', (e) => e.channel.id === channelId));
    expect(has(bystander, 'channel.deleted', (e) => e.channelId === channelId)).toBe(false);
    expect(has(admin, 'channel.deleted', (e) => e.channelId === channelId)).toBe(false);
    expect(await listChannelIds(bystanderPat)).toContain(channelId);

    admin.close(); bystander.close();
  });
});

/**
 * 채널 멤버십 변경 WS 이벤트(#300).
 *
 * #284 의 channelListAudience 함수를 재사용한다 — 메시지 층의 audienceFor 가 아니다.
 * 수신자는 목록에서 채널을 볼 수 있는 사람이고, 추가된 사람/제거된 사람은 각각
 * channel.created/channel.deleted 를 받는다(#284 의 public→private 전환 논리).
 */
describe('채널 멤버십 변경 WS 이벤트 (#300)', () => {
  const collect = async (token: string) => collectWithTicket(await ticketFor(token));

  it('1. 초대되면 그 사람은 channel.created 를 받는다(목록에 새로 나타난다)', async () => {
    // bystander 를 초대할 private 채널을 만든다.
    const channelId = await createChannel('member-add-test', 'private');
    const bystander = await collect(bystanderPat);
    await bystander.ready;

    // admin 은 만들 때 첫 멤버가 되므로 channel.created 를 받았을 것이다.
    // bystander 가 초대되어 channel.created 를 받는지를 본다.
    const add = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: bystanderId },
    });
    expect(add.statusCode).toBe(200);

    await waitFor(() => has(bystander, 'channel.created', (e) => e.channel.id === channelId));
    // channel.created 페이로드는 `ChannelRow` **전부**여야 한다. 몇 개만 보면 컬럼 목록을
    // 베껴 쓴 자리에서 필드가 빠져도 초록으로 남는다 — 실측으로 `createdAt` 이 빠져 있었고,
    // 그 행을 받은 화면에서는 채널 디렉터리의 "생성순" 정렬이 비교할 값을 잃었다.
    const seen = bystander.events.find((e) => e.type === 'channel.created' && e.channel.id === channelId);
    expect(seen.channel.name).toBe('member-add-test');
    expect(seen.channel.visibility).toBe('private');
    expect(Object.keys(seen.channel).sort())
      .toEqual(['archivedAt', 'createdAt', 'id', 'kind', 'name', 'repo', 'topic', 'visibility']);

    bystander.close();
  });

  it('2. 추방되면 그 사람에게 channel.deleted 가 간다', async () => {
    // bystander 를 초대하고, 그 다음 추방한다.
    const channelId = await createChannel('member-remove-test', 'private');
    const add = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: bystanderId },
    });
    expect(add.statusCode).toBe(200);

    const bystander = await collect(bystanderPat);
    await bystander.ready;

    const rem = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/members/${bystanderId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rem.statusCode).toBe(200);

    await waitFor(() => has(bystander, 'channel.deleted', (e) => e.channelId === channelId));

    bystander.close();
  });

  it('3. 남은 멤버는 channel.member_removed 를 받고 목록은 유지된다', async () => {
    // bystander 를 초대하고, 다른 계정을 하나 더 만든 뒤 bystander 를 추방한다.
    const channelId = await createChannel('member-remove-others', 'private');
    const add1 = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: bystanderId },
    });
    expect(add1.statusCode).toBe(200);

    // admin (이미 멤버) 이 channel.member_removed 를 받는지를 본다.
    const admin = await collect(adminToken);
    await admin.ready;

    const rem = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/members/${bystanderId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rem.statusCode).toBe(200);

    await waitFor(() => has(admin, 'channel.member_removed', (e) => e.channelId === channelId && e.accountId === bystanderId));
    // 채널이 목록에서 사라지지 않았음을 확인한다.
    expect(await listChannelIds(adminToken)).toContain(channelId);

    admin.close();
  });

  it('4. private 채널 멤버십 변경: 남은 멤버는 channel.member_removed 를 받는다, 제거된 사람은 channel.deleted 를 받는다', async () => {
    // 세 계정을 쓴다: admin(만든 사람), bystander(비멤버), member(멤버 → 제거됨)
    const channelId = await createChannel('private-member-events', 'private');
    // member 계정을 만들고 채널에 초대한다.
    const { accountId: memberId, pat: memberPat } = await createAgent(app, adminToken, 'member');
    const add = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: memberId },
    });
    expect(add.statusCode).toBe(200);

    // bystander(비멤버), member(멤버 → 제거될 사람), admin(만든 사람, 첫 멤버) 소켓을 연다.
    const bystander = await collect(bystanderPat);
    const member = await collect(memberPat);
    const admin = await collect(adminToken);
    await bystander.ready; await member.ready; await admin.ready;

    // member 를 추방한다.
    const rem = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/members/${memberId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rem.statusCode).toBe(200);

    // 남은 멤버(admin) 는 channel.member_removed 를 받아야 한다.
    await waitFor(() => has(admin, 'channel.member_removed', (e) => e.channelId === channelId && e.accountId === memberId));
    // 제거된 사람(member) 은 channel.deleted 를 받아야 한다(목록에서 사라진 것이기 때문).
    await waitFor(() => has(member, 'channel.deleted', (e) => e.channelId === channelId));
    // 비멤버(bystander) 는 아무것도 받지 않아야 한다.
    await settle();
    expect(has(bystander, 'channel.member_added')).toBe(false);
    expect(has(bystander, 'channel.member_removed')).toBe(false);
    expect(has(bystander, 'channel.created')).toBe(false);
    expect(has(bystander, 'channel.deleted')).toBe(false);

    bystander.close(); member.close(); admin.close();
  });

  /**
   * 6. 발행은 **커밋 뒤**다.
   *
   * WS 로 받은 뒤 HTTP 로 조회하는 방식은 이 보증을 지키지 못한다 — 조회가 왕복하는 사이에
   * 삽입이 끝나 버려서, 삽입 **전에** 발행하도록 되돌려도 초록으로 남는다(실측). 그래서
   * 발행 순간을 **버스에서** 잡는다: `emitEvent` 는 동기라, 구독자가 그 자리에서 띄운 질의는
   * 라우트가 아직 삽입 문장을 보내기도 전에 서버에 도착한다. 그 질의가 "이미 멤버다" 를
   * 보면 발행이 커밋 뒤였다는 뜻이다.
   */
  it('6. 발행 순간에 이미 커밋돼 있다 — 발행을 삽입 앞으로 옮기면 빨개진다', async () => {
    const channelId = await createChannel('member-commit-test', 'private');
    const { accountId: joinerId } = await createAgent(app, adminToken, 'commit-joiner');

    let atEmit: Promise<boolean> | null = null;
    const off = onEvent((e) => {
      if (e.type === 'channel.member_added' && e.channelId === channelId && e.accountId === joinerId) {
        atEmit = pool
          .query(`select 1 from channel_member where channel_id = $1 and account_id = $2`, [channelId, joinerId])
          .then((r) => (r.rowCount ?? 0) > 0);
      }
    });
    try {
      const add = await app.inject({
        method: 'POST', url: `/channels/${channelId}/members`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: joinerId },
      });
      expect(add.statusCode).toBe(200);
      expect(atEmit).not.toBeNull();
      expect(await atEmit!).toBe(true);
    } finally {
      off();
    }
  });

  it('6b. 실패한 요청(없는 계정 404)에서는 멤버십 이벤트가 나가지 않는다', async () => {
    const channelId = await createChannel('member-no-event', 'private');
    const seen: string[] = [];
    const off = onEvent((e) => {
      if ((e.type === 'channel.member_added' || e.type === 'channel.member_removed') && e.channelId === channelId) {
        seen.push(e.type);
      }
    });
    try {
      const missing = '00000000-0000-4000-8000-000000000000';
      const add = await app.inject({
        method: 'POST', url: `/channels/${channelId}/members`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: missing },
      });
      expect(add.statusCode).toBe(404);

      // 멤버가 아닌 사람을 빼는 요청은 지워진 행이 없다 — 그것도 이벤트가 아니다.
      const { accountId: strangerId } = await createAgent(app, adminToken, 'member-stranger');
      const rem = await app.inject({
        method: 'DELETE', url: `/channels/${channelId}/members/${strangerId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(rem.statusCode).toBe(200);

      // 대조군: 같은 경로가 성공하면 이벤트는 실제로 나간다.
      const { accountId: realId } = await createAgent(app, adminToken, 'member-real');
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/members`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: realId },
      });
      expect(seen).toEqual(['channel.member_added']);
    } finally {
      off();
    }
  });
});

/**
 * 5·7. 핸들 집합 변경과, 수신자 계산이 **어느 층의 함수**인지.
 *
 * 7 이 층을 구분하는 방법은 admin 예외다. `channelListAudience`(목록 층, #284)는 standard
 * 채널을 **멤버가 아닌 admin 에게도** 보이는 것으로 친다 — `listChannels` 의 admin 예외를
 * 같은 술어에서 가져오기 때문이다. 반면 메시지 층의 `audienceFor` 는 private 채널을 멤버로만
 * 좁힌다. 그래서 "멤버가 아닌 admin 이 private 채널의 멤버십 이벤트를 받는가" 가 두 함수를
 * 실제로 갈라 놓는다 — 호출을 목으로 세는 것과 달리 이 단언은 구현이 바뀌어도 **동작**을
 * 지킨다. `audienceFor` 로 바꾸면 이 절은 빨개진다.
 */
describe('멤버십·집합 이벤트의 수신자 층 (#300)', () => {
  const collect = async (token: string) => collectWithTicket(await ticketFor(token));

  it('5. handle_group.changed 가 로그인한 다른 계정에도 가고 구성원 수가 갱신된다', async () => {
    const bystander = await collect(bystanderPat);
    await bystander.ready;

    const created = await app.inject({
      method: 'POST', url: '/handle-groups', headers: { authorization: `Bearer ${adminToken}` },
      payload: { handle: 'ws-team', displayName: 'WS Team' },
    });
    expect(created.statusCode).toBe(201);
    const groupId = created.json().id as string;
    // 집합이 생긴 것 자체가 후보 목록의 변화다 — 구성원 변경만 알리면 새 집합은 아무의
    // 자동완성에도 나타나지 않는다.
    await waitFor(() => has(bystander, 'handle_group.changed', (e) => e.groupId === groupId));

    const before = bystander.events.filter((e) => e.type === 'handle_group.changed').length;
    const added = await app.inject({
      method: 'POST', url: `/handle-groups/${groupId}/members`,
      // 집합에는 사람만 들어간다(#230 결정 1) — 에이전트 계정은 400 이다. 그래서
      // 구성원은 admin(사람)이고, 듣는 쪽이 bystander(다른 계정)다.
      headers: { authorization: `Bearer ${adminToken}` }, payload: { accountIds: [adminId] },
    });
    expect(added.statusCode).toBe(200);
    await waitFor(() => bystander.events.filter((e) => e.type === 'handle_group.changed').length > before);

    // 이벤트를 받은 뒤 조회하면 구성원 수가 이미 올라 있다 — 화면이 이것으로 후보의 수를 고친다.
    const accounts = await app.inject({
      method: 'GET', url: '/accounts', headers: { authorization: `Bearer ${bystanderPat}` },
    });
    const group = (accounts.json() as { groups: { id: string; memberCount: number }[] })
      .groups.find((g) => g.id === groupId);
    expect(group?.memberCount).toBe(1);

    bystander.close();
  });

  it('7. 멤버가 아닌 admin 도 private 채널의 멤버십 이벤트를 받는다(목록 층 판정)', async () => {
    // 두 번째 admin 을 만든다. admin 은 부트스트랩으로만 생기므로 직접 승격시킨다 —
    // 이 테스트가 필요로 하는 것은 "멤버가 아닌 admin" 이라는 상태 하나뿐이다.
    const { accountId: adminTwoId, pat: adminTwoPat } = await createAgent(app, adminToken, 'admin-two');
    await pool.query(`update account set is_admin = true where id = $1`, [adminTwoId]);

    // admin-two 가 멤버가 아닌 private 채널.
    const channelId = await createChannel('layer-check', 'private');
    const { accountId: newcomerId } = await createAgent(app, adminToken, 'layer-newcomer');

    const adminTwo = await collect(adminTwoPat);
    await adminTwo.ready;

    const add = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: newcomerId },
    });
    expect(add.statusCode).toBe(200);

    // 목록 층(channelListAudience)이면 온다. 메시지 층(audienceFor)이면 오지 않는다.
    await waitFor(() => has(adminTwo, 'channel.member_added',
      (e) => e.channelId === channelId && e.accountId === newcomerId));

    const rem = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/members/${newcomerId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rem.statusCode).toBe(200);
    await waitFor(() => has(adminTwo, 'channel.member_removed',
      (e) => e.channelId === channelId && e.accountId === newcomerId));

    adminTwo.close();
  });
});
