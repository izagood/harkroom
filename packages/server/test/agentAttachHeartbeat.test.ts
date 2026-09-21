/**
 * 뷰어(`/agent-attach`) 소켓도 하트비트를 받는다 — 실측(2026-09-21, 원격지에서 터미널 열기).
 *
 * 이 소켓은 `/ws`·`/operator` 와 달리 ping 을 받지 않았다. 사람이 입력을 기다리는 동안 PTY 바이트가
 * 없으면 Cloudflare 가 ~100초 뒤 소켓을 조용히 걷어가고, 서버는 close 를 보고 뷰어 0 을 러너에
 * 알리며, 러너는 60초 유예 뒤 하네스를 회수했다(143). 원격 패널은 "러너 연결 끊김"이 됐다 —
 * 2026-09-20 의 릴레이 결함과 같은 부류다. 여기서 재는 것은 둘이다: 붙어 있는 뷰어는 주기마다
 * ping 을 받는다(프록시가 유휴로 안 본다), pong 이 없는 뷰어는 끊고 러너에 뷰어 0 이 간다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { operatorRunnerFactory } from './helpers/operatorRunner.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let agentId: string; let baseUrl: string;
let runners: ReturnType<typeof operatorRunnerFactory>;
const HEARTBEAT_MS = 120;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool, wsHeartbeatMs: HEARTBEAT_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: agentId } = await createAgent(app, adminToken, 'viewed'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  runners = operatorRunnerFactory(app, () => baseUrl, adminToken);
});
afterAll(async () => { await app.close(); await stop(); });

const session = (sessionId: string): AgentSessionView => ({
  sessionId, agentAccountId: agentId, channelId: 'chan-1', threadRootId: 'root-1',
  harness: 'claude-code', startedAt: '2026-09-21T00:00:00.000Z', acceptsInput: true,
});
const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
};
async function attachViewer(sessionId: string, opts: { autoPong?: boolean } = {}): Promise<WebSocket> {
  const res = await app.inject({ method: 'POST', url: `/agent-sessions/${sessionId}/attach`, headers: auth(adminToken) });
  expect(res.statusCode).toBe(200);
  const ws = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${res.json().ticket as string}`, { autoPong: opts.autoPong ?? true });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  return ws;
}
async function announce(sessionId: string) {
  const runner = await runners.connect(agentId);
  runner.send({ type: 'session.started', session: session(sessionId) });
  await waitFor(() => runner.received.length >= 0);
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(adminToken) });
    if ((res.json().sessions as AgentSessionView[]).some((s) => s.sessionId === sessionId)) break;
    if (Date.now() - start > 4000) throw new Error('세션이 안 올랐다');
    await new Promise((r) => setTimeout(r, 20));
  }
  return runner;
}

describe('뷰어 소켓 하트비트', () => {
  it('붙어 있는 뷰어는 주기마다 서버 ping 을 받고, 여러 주기가 지나도 살아 있다', async () => {
    const runner = await announce('view-1');
    const viewer = await attachViewer('view-1');
    let pings = 0; viewer.on('ping', () => { pings += 1; });
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 5));
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    viewer.close(); await runner.close();
  });

  it('pong 이 없는 뷰어는 끊기고 러너는 viewer.count 0 을 받는다 — 케이블 뽑힌 화면이 영원히 붙어 있지 않는다', async () => {
    const runner = await announce('view-2');
    const viewer = await attachViewer('view-2', { autoPong: false });
    const counts = () => runner.received
      .filter((f) => f.type === 'viewer.count' && f.sessionId === 'view-2')
      .map((f) => (f as { count: number }).count);
    await waitFor(() => counts().includes(1));
    await waitFor(() => viewer.readyState === WebSocket.CLOSED, HEARTBEAT_MS * 20);
    await waitFor(() => counts().at(-1) === 0);
    await runner.close();
  });
});
