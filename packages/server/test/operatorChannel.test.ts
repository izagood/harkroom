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
import { onEvent } from '../src/events.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let opToken: string; let operatorId: string; let baseUrl: string;
/** `/ws` 와 같은 값이어야 한다(buildServer 의 wsHeartbeatMs) — 갈라 두면 수명이 갈린다. */
const HEARTBEAT_MS = 120;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool, wsHeartbeatMs: HEARTBEAT_MS });
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
  it('hello 의 버전을 적고 목록에 싣는다 — 끊겨도 남고, 버전 없는 hello 는 모름(null)으로 덮는다', async () => {
    const { token, operatorId: id } = await registerOperator(app, adminToken, '버전기기');
    const versionOf = async (): Promise<string | null | undefined> =>
      (await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) }))
        .json().operators.find((o: { id: string }) => o.id === id)?.version;
    expect(await versionOf()).toBeNull();

    const changed: string[] = [];
    const off = onEvent((e) => { if (e.type === 'operator.changed' && e.operatorId === id) changed.push(e.type); });
    try {
      const ws = await connect(token);
      ws.send(JSON.stringify({ ...hello(), version: '0.3.45' }));
      await waitFor(async () => (await versionOf()) === '0.3.45');
      // 접속 한 번 + 버전이 바뀐 한 번. 같은 값을 다시 hello 하면 더 내지 않는다.
      await waitFor(async () => changed.length >= 2);
      const before = changed.length;
      ws.send(JSON.stringify({ ...hello(), version: '0.3.45' }));
      await new Promise((r) => setTimeout(r, 100));
      expect(changed.length).toBe(before);
      ws.close();
      await waitFor(async () => {
        const op = (await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) }))
          .json().operators.find((o: { id: string }) => o.id === id);
        return op?.online === false;
      });
      // 오프라인이어도 마지막 버전은 남는다 — 러너가 꺼진 카드도 기준이 있어야 한다.
      expect(await versionOf()).toBe('0.3.45');
      const self = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(token) });
      expect(self.json().version).toBe('0.3.45');

      const old = await connect(token);
      old.send(JSON.stringify(hello()));
      await waitFor(async () => (await versionOf()) === null);
      old.close();
    } finally { off(); }
  });
  it('폐기된 오퍼레이터는 붙을 수 없다', async () => {
    const { token, operatorId: doomed } = await registerOperator(app, adminToken, '폐기될기기');
    await app.inject({ method: 'DELETE', url: `/operators/${doomed}`, headers: auth(adminToken) });
    await expect(connect(token)).rejects.toThrow('http 401');
  });
});

// 폐기는 인증을 다시 보지 않는 붙은 소켓까지 닿아야 한다 — 두면 죽은 토큰으로 계속 산다.
describe('폐기된 오퍼레이터의 소켓', () => {
  const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

  it('DELETE /operators/:id 는 붙은 소켓을 끊는다', async () => {
    const op = await registerOperator(app, adminToken, '지울기기');
    const ws = await connect(op.token);
    const done = closed(ws);
    const del = await app.inject({ method: 'DELETE', url: `/operators/${op.operatorId}`, headers: auth(adminToken) });
    expect(del.statusCode).toBe(204);
    expect(await done).toBe(4401);
  });

  it('다시 등록(replaces)은 옛 소켓을 끊는다', async () => {
    const op = await registerOperator(app, adminToken, '바꿀기기');
    const ws = await connect(op.token);
    const done = closed(ws);
    const code = (await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(adminToken) })).json().code as string;
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '바꿀기기', replaces: op.operatorId } });
    expect(res.json().replaced.operatorId).toBe(op.operatorId);
    expect(await done).toBe(4401);
  });
});

// commit 뒤의 실패(security #1025 권장): 옛 행이 이미 폐기·배정이 옮겨진 뒤라, 응답이 500 이면 새 토큰이
// 머신에 가지 않고 배정이 아무도 토큰을 모르는 행에 갇힌다. 이벤트 구독자가 던지는 것은 실제로
// `emitEvent` 를 뚫고 올라온다(EventEmitter 는 구독자 예외를 그대로 던진다).
describe('다시 등록 — commit 뒤 부수 효과가 던져도', () => {
  it('200 과 새 토큰을 돌려주고, 옛 소켓은 그래도 끊는다', async () => {
    const op = await registerOperator(app, adminToken, '던질기기');
    const ws = await connect(op.token);
    const done = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    // claim 이 내는 첫 이벤트(새 등록, audience = 소유자 목록)에서만 던진다. 소켓 close 핸들러의
    // `operator.changed`(audience 'all')는 요청 밖에서 돌아 던지면 처리되지 않은 예외가 된다.
    const off = onEvent((e) => { if (e.type === 'operator.changed' && Array.isArray(e.audience)) throw new Error('구독자 고장'); });
    try {
      const code = (await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(adminToken) })).json().code as string;
      const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '던질기기', replaces: op.operatorId } });
      expect(res.statusCode).toBe(200);
      expect(res.json().token).toMatch(/^hkop_/);
      expect(res.json().replaced.operatorId).toBe(op.operatorId);
    } finally { off(); }
    expect(await done).toBe(4401);
  });

  it('구독자가 던져도 옛 토큰 폐기(operator.revoked) 감사 행은 남는다', async () => {
    const op = await registerOperator(app, adminToken, '감사기기');
    const off = onEvent((e) => { if (e.type === 'operator.changed' && Array.isArray(e.audience)) throw new Error('구독자 고장'); });
    try {
      const code = (await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(adminToken) })).json().code as string;
      const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '감사기기', replaces: op.operatorId } });
      expect(res.statusCode).toBe(200);
      const { rows } = await pool.query<{ detail: { replacedBy: string } }>(
        `select detail from audit_log where action = 'operator.revoked' and target = $1`, [op.operatorId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail.replacedBy).toBe(res.json().operator.id);
    } finally { off(); }
  });
});
