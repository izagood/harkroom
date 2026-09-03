import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { WsServerEvent } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { onEvent, type WorkspaceEvent } from '../src/events.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let agentPat: string;
let agentId: string;
let base: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: agentId, pat: agentPat } = await createAgent(app, adminToken, 'status-agent'));
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const setStatus = (token: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: '/accounts/me/status', headers: auth(token), payload: payload as object });

const waitFor = async (check: () => boolean, ms = 4000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
};

interface Collector { events: WsServerEvent[]; close(): void }

async function connect(token: string): Promise<Collector> {
  const ticket = (await app.inject({ method: 'POST', url: '/ws-ticket', headers: auth(token) })).json().ticket as string;
  const ws = new WebSocket(`ws://${base}/ws?ticket=${encodeURIComponent(ticket)}`);
  const events: WsServerEvent[] = [];
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const e = JSON.parse(String(raw)) as WsServerEvent;
      events.push(e);
      if (e.type === 'presence.snapshot') resolve();
    });
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  await ready;
  return { events, close: () => ws.close() };
}

describe('사람이 정한 상태 (#186)', () => {
  it('PUT 으로 정한 상태가 /auth/me 와 /accounts 에 그대로 보인다', async () => {
    const res = await setStatus(adminToken, { status: 'dnd', statusText: '긴 턴 도는 중' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'dnd', statusText: '긴 턴 도는 중' });

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminToken) });
    expect(me.json()).toMatchObject({ status: 'dnd', statusText: '긴 턴 도는 중' });

    const dir = await app.inject({ method: 'GET', url: '/accounts', headers: auth(adminToken) });
    const mine = (dir.json().accounts as { id: string; status: string; statusText: string | null }[])
      .find((a) => a.id === adminId);
    expect(mine).toMatchObject({ status: 'dnd', statusText: '긴 턴 도는 중' });
  });

  it('상태를 바꾸면 status.changed 가 다른 연결에 도착한다', async () => {
    // 에이전트 소켓은 **다른 연결**이다. 자기 소켓에만 도달하면 그것은 브로드캐스트가 아니다.
    const other = await connect(agentPat);
    try {
      await setStatus(adminToken, { status: 'away', statusText: '회의' });
      await waitFor(() => other.events.some((e) => e.type === 'status.changed'));
      const got = other.events.filter((e): e is Extract<WsServerEvent, { type: 'status.changed' }> =>
        e.type === 'status.changed');
      expect(got).toContainEqual({
        type: 'status.changed', accountId: adminId, status: 'away', statusText: '회의',
      });
    } finally {
      other.close();
    }
  });

  it('상태를 바꿔도 presence.changed 는 발생하지 않는다', async () => {
    // 결정 1의 회귀선: 상태는 파생 presence 를 **덮지 않는다**. 상태 변경이 presence 를
    // 함께 내면 "연결이 끊긴 사람"과 "방해 금지인 사람"이 한 표시로 뭉친다.
    const seen: WorkspaceEvent[] = [];
    const off = onEvent((e) => seen.push(e));
    try {
      await setStatus(adminToken, { status: 'dnd' });
      await waitFor(() => seen.some((e) => e.type === 'status.changed'));
      // 이 계정으로 좁힌다 — 앞선 테스트가 닫은 소켓의 뒤늦은 presence 가 섞이면 무엇을
      // 단언하는 테스트인지 흐려진다. 여기서 묻는 것은 "상태를 바꾼 사람의 연결 표시가
      // 흔들렸는가"다.
      expect(seen.filter((e) => e.type === 'presence.changed' && e.accountId === adminId)).toEqual([]);
    } finally {
      off();
    }
  });

  it('연결이 끊겨 offline 이 돼도 status 는 그대로다', async () => {
    const seen: WorkspaceEvent[] = [];
    const off = onEvent((e) => seen.push(e));
    const me = await connect(adminToken);
    try {
      await setStatus(adminToken, { status: 'away', statusText: '자리 비움' });
      me.close();
      // presence 는 실제로 내려간다 — 그래야 "그래도 status 는 남는다"가 의미를 갖는다.
      await waitFor(() => seen.some((e) =>
        e.type === 'presence.changed' && e.accountId === adminId && !e.online));

      const after = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminToken) });
      expect(after.json()).toMatchObject({ status: 'away', statusText: '자리 비움' });
    } finally {
      off();
      me.close();
    }
  });

  it('에이전트의 상태 변경은 400 이고 실제로 바뀌지도 않는다', async () => {
    const res = await setStatus(agentPat, { status: 'dnd', statusText: '바쁨' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_account');

    // 응답 코드만 보면 "거절했다고 말하면서 실제로는 썼다"를 놓친다.
    const row = await pool.query(`select status, status_text from account where id = $1`, [agentId]);
    expect(row.rows[0]).toEqual({ status: 'available', status_text: null });
  });

  it('statusText: null 이 문구를 지우고, 81자는 거절한다', async () => {
    await setStatus(adminToken, { status: 'away', statusText: '점심' });

    // 키 부재는 '손대지 않음'이다 — 지우기와 구분돼야 한다.
    await setStatus(adminToken, { status: 'dnd' });
    const kept = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminToken) });
    expect(kept.json()).toMatchObject({ status: 'dnd', statusText: '점심' });

    const cleared = await setStatus(adminToken, { status: 'dnd', statusText: null });
    expect(cleared.json()).toEqual({ status: 'dnd', statusText: null });
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminToken) });
    expect(after.json().statusText).toBeNull();

    const tooLong = await setStatus(adminToken, { status: 'dnd', statusText: 'a'.repeat(81) });
    expect(tooLong.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminToken) })).json().statusText).toBeNull();
  });
});
