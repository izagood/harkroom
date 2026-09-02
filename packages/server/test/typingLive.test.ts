import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { WsServerEvent } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let channelId: string;
let dmId: string;
let peerToken: string;
let peerId: string;
let base: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool, typingTtlMs: 5000 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'typing' },
  });
  channelId = ch.json().id;
  ({ accountId: peerId, pat: peerToken } = await createAgent(app, adminToken, 'peer'));
  const dm = await app.inject({
    method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
    payload: { accountIds: [peerId] },
  });
  dmId = dm.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const ticketFor = async (token: string) => {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  return res.json().ticket as string;
};

interface Collector {
  events: WsServerEvent[];
  ready: Promise<void>;
  send(payload: unknown): void;
  close(): void;
}

/** 소켓을 열고 presence.snapshot 을 받은 뒤를 '준비됨'으로 본다 — open 만으로는 구독이 아직 없다. */
async function connect(token: string): Promise<Collector> {
  const ticket = await ticketFor(token);
  const ws = new WebSocket(`ws://${base}/ws?ticket=${encodeURIComponent(ticket)}`);
  const events: WsServerEvent[] = [];
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const e = JSON.parse(String(raw)) as WsServerEvent;
      events.push(e);
      if (e.type === 'presence.snapshot') resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  await ready;
  return {
    events,
    ready,
    send: (payload) => ws.send(JSON.stringify(payload)),
    close: () => ws.close(),
  };
}

const typingEvents = (c: Collector) =>
  c.events.filter((e): e is Extract<WsServerEvent, { type: 'typing.changed' }> => e.type === 'typing.changed');

const waitFor = async (check: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
};

describe('telling others you are typing', () => {
  it('tells the other people in the channel', async () => {
    const me = await connect(adminToken);
    const other = await connect(peerToken);

    me.send({ type: 'typing', channelId });

    await waitFor(() => typingEvents(other).length > 0);
    expect(typingEvents(other)[0]).toMatchObject({ channelId, accountIds: [adminId] });
    me.close(); other.close();
  });

  // 자기 자신에게 '입력 중'을 보여 주면 화면이 자기 그림자를 그린다.
  it('does not tell me about my own typing', async () => {
    const me = await connect(adminToken);
    const other = await connect(peerToken);

    me.send({ type: 'typing', channelId });

    await waitFor(() => typingEvents(other).length > 0);
    // 이벤트는 모두에게 가지만, 목록에서 나는 빠져 있어야 한다 — 그래야 클라이언트가 걸러낼
    // 필요가 없고, 거르는 곳이 두 군데로 갈라지지 않는다.
    expect(typingEvents(me).every((e) => !e.accountIds.includes(adminId))).toBe(true);
    me.close(); other.close();
  });

  it('says nobody is typing once they stop', async () => {
    const me = await connect(adminToken);
    const other = await connect(peerToken);
    me.send({ type: 'typing', channelId });
    await waitFor(() => typingEvents(other).length > 0);

    me.send({ type: 'typing.stop', channelId });

    await waitFor(() => typingEvents(other).some((e) => e.accountIds.length === 0));
    me.close(); other.close();
  });

  // 소켓이 닫히면 stop 이 오지 않는다 — 그래도 '입력 중'이 남으면 안 된다.
  it('clears typing when the socket closes', async () => {
    const me = await connect(adminToken);
    const other = await connect(peerToken);
    me.send({ type: 'typing', channelId });
    await waitFor(() => typingEvents(other).length > 0);

    me.close();

    await waitFor(() => typingEvents(other).some((e) => e.accountIds.length === 0));
    other.close();
  });

  // DM 의 입력 상태가 멤버 밖으로 나가면 "누가 누구와 대화 중"이라는 사실이 새어 나간다.
  it('keeps dm typing inside the dm', async () => {
    const me = await connect(adminToken);
    const { pat: outsiderPat } = await createAgent(app, adminToken, `outsider${Date.now()}`);
    const outsider = await connect(outsiderPat);

    me.send({ type: 'typing', channelId: dmId });

    await new Promise((r) => setTimeout(r, 300));
    expect(typingEvents(outsider)).toHaveLength(0);
    me.close(); outsider.close();
  });

  it('ignores a typing signal for a channel the sender cannot see', async () => {
    const { pat: strangerPat } = await createAgent(app, adminToken, `stranger${Date.now()}`);
    const stranger = await connect(strangerPat);
    const member = await connect(adminToken);

    stranger.send({ type: 'typing', channelId: dmId });

    await new Promise((r) => setTimeout(r, 300));
    expect(typingEvents(member)).toHaveLength(0);
    stranger.close(); member.close();
  });

  // 모르는 타입이 else 분기로 흘러 'stop' 처럼 해석되면, 클라이언트가 보낸 아무 메시지가
  // 입력 상태를 지운다. 죽지 않는 것만으로는 부족하고, 상태를 건드리지 않아야 한다.
  it('leaves typing state alone for a message it does not understand', async () => {
    const me = await connect(adminToken);
    const other = await connect(peerToken);
    me.send({ type: 'typing', channelId });
    await waitFor(() => typingEvents(other).some((e) => e.accountIds.includes(adminId)));
    const before = typingEvents(other).length;

    me.send({ type: 'nonsense', channelId });

    await new Promise((r) => setTimeout(r, 300));
    const after = typingEvents(other);
    expect(after.length).toBe(before);
    expect(after[after.length - 1]!.accountIds).toContain(adminId);
    me.close(); other.close();
  });

  // 소켓으로 아무 것이나 보낼 수 있으므로, 모르는 메시지에 서버가 죽으면 안 된다.
  it('survives a message it does not understand', async () => {
    const me = await connect(adminToken);
    const other = await connect(peerToken);

    me.send({ type: 'nonsense', whatever: 1 });
    me.send('not even json');
    me.send({ type: 'typing' });

    me.send({ type: 'typing', channelId });
    await waitFor(() => typingEvents(other).length > 0);
    me.close(); other.close();
  });
});
