import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

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
let bystanderPat: string;
let bystanderId: string;
let baseUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
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
  return (res.json() as { id: string }[]).map((c) => c.id);
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
