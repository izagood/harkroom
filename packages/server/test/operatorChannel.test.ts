// `/operator` 채널 — 스펙 2026-09-20 §4. 실제 소켓을 태운다(agentRelay.test 와 같은 이유:
// 인메모리 허브만 단위로 재면 인증·업그레이드·heartbeat 가 통째로 빠진다).
//
// 관측 가능한 계약으로 적는다: 붙어서 hello 하면 목록에 online 과 능력이 보이고, 끊기거나
// wedge 되면 offline 이 된다. ping 을 몇 번 보냈는지는 세지 않는다 — 그건 구현이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { OperatorToServerFrame } from '@harkroom/shared/operatorProtocol';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let opToken: string; let operatorId: string; let baseUrl: string;
/** `/ws` 와 같은 값이어야 한다(buildServer 의 wsHeartbeatMs) — 갈라 두면 수명이 갈린다. */
const HEARTBEAT_MS = 120;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool, wsHeartbeatMs: HEARTBEAT_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: opToken, operatorId } = await registerOperator(app, adminToken, '테스트기기'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${baseUrl}/operator`, { headers: auth(token) });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
  });
  return ws;
}
const hello = (): OperatorToServerFrame => ({
  type: 'hello', protocol: 1,
  capabilities: { agentIds: ['a1'], harnesses: { 'claude-code': { installed: true, loggedIn: true } } },
  runners: [], sessions: [],
});
const online = async (): Promise<boolean> =>
  (await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) })).json().operators[0].online === true;
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('/operator 채널', () => {
  it('사람 토큰으로는 401', async () => {
    await expect(connect(adminToken)).rejects.toThrow('http 401');
  });
  it('hello 뒤 목록에 online 과 능력이 보이고, 끊으면 offline 이 된다', async () => {
    const ws = await connect(opToken);
    ws.send(JSON.stringify(hello()));
    await waitFor(online);
    const caps = await app.inject({ method: 'GET', url: `/operators/${operatorId}/capabilities`, headers: auth(adminToken) });
    expect(caps.statusCode).toBe(200);
    expect(caps.json().agentIds).toEqual(['a1']);
    ws.close();
    await waitFor(async () => !(await online()));
    const gone = await app.inject({ method: 'GET', url: `/operators/${operatorId}/capabilities`, headers: auth(adminToken) });
    expect(gone.statusCode).toBe(404);
  });
  it('wedge 되면 heartbeat 가 끊고 offline 이 된다', async () => {
    const ws = await connect(opToken);
    ws.send(JSON.stringify(hello()));
    await waitFor(online);
    // 읽기를 멈춘다 → ping 이 도착해도 처리되지 않아 pong 이 나가지 않는다.
    (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await waitFor(async () => !(await online()), 5000);
  });
  it('폐기된 오퍼레이터는 붙을 수 없다', async () => {
    const { token, operatorId: doomed } = await registerOperator(app, adminToken, '폐기될기기');
    await app.inject({ method: 'DELETE', url: `/operators/${doomed}`, headers: auth(adminToken) });
    await expect(connect(token)).rejects.toThrow('http 401');
  });
});
