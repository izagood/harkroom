// 러너 프레임이 흐르는 소켓의 하트비트 회귀선. 단계 3 뒤로 그 소켓은 `/agent-relay` 가 아니라
// **오퍼레이터 채널**(`/operator`)이다 — 러너 세션의 수명이 그 소켓의 수명을 따른다.
//
// **왜 이 파일이 생겼나**(2026-09-20 실측): 원격 서버(Cloudflare 프록시 뒤)로 옮긴 뒤,
// 릴레이가 경로 중간에서 끊겨도 **양쪽 모두 그 사실을 모르는** 상태가 생겼다. 러너는
// 붙어 있다고 믿어 재접속하지 않고, 서버는 죽은 소켓을 레지스트리에 들고 있다가
// `interactive.open` 을 그리로 던진다 — 사람 화면에는 10초 뒤 원인 없는 504 가 뜬다.
//
// `/ws` 는 30초 ping 으로 정확히 그 상태를 걷어낸다(`heartbeatLive.test.ts`). 이 소켓만
// ping 이 없었다 — 같은 경로에서 **더 민감한 쪽**(PTY 바이트가 흐르는 소켓)이 더
// 느슨했던 셈이고, 그것은 `socketLifetime.ts` 가 세운 원칙과 정면으로 어긋난다.
//
// 계약을 **관측 가능한 사실**로 적는다: 답하지 않는 러너의 세션은 `/agent-sessions`
// 에서 사라진다. 소켓이 끊기면 `addRunner` 가 돌려준 detach 가 실행돼 레지스트리를
// 비우기 때문이다 — ping 이 몇 번 나갔는지를 세지 않는 이유가 이것이다(그건 구현이다).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { operatorRunnerFactory } from './helpers/operatorRunner.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let agentId: string;
let baseUrl: string;
let runners: ReturnType<typeof operatorRunnerFactory>;

/** `/ws` 와 **같은 값**을 쓴다(buildServer 의 `wsHeartbeatMs`). 갈라 두면 두 소켓의
 *  수명이 갈라지고, 그것이 이 결함의 모양이었다. */
const HEARTBEAT_MS = 120;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool, wsHeartbeatMs: HEARTBEAT_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: agentId } = await createAgent(app, adminToken, 'wedgedrunner'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  runners = operatorRunnerFactory(app, () => baseUrl, adminToken);
});
afterAll(async () => { await app.close(); await stop(); });

function session(sessionId: string): AgentSessionView {
  return {
    sessionId,
    agentAccountId: agentId,
    channelId: 'chan-1',
    threadRootId: 'root-1',
    harness: 'claude-code',
    startedAt: '2026-09-20T00:00:00.000Z',
    acceptsInput: true,
  };
}

async function listed(sessionId: string): Promise<boolean> {
  const res = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(adminToken) });
  return (res.json().sessions as AgentSessionView[]).some((s) => s.sessionId === sessionId);
}

/** 비동기 술어용. 고정 지연으로 갈음하지 않는다 — 느린 머신에서 자기 이유 없이 빨개진다. */
const waitForAsync = async (pred: () => Promise<boolean>, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('러너 릴레이는 하트비트를 받는다', () => {
  // 정상 러너를 끊으면 안 된다. ping 을 보내기만 하고 답을 안 보는 구현도 이 테스트는
  // 통과하지만, 아래 테스트와 **짝으로** 두면 그 구현이 걸린다.
  it('keeps a responsive runner across several heartbeat periods', async () => {
    const runner = await runners.connect(agentId);
    runner.send({ type: 'announce', sessions: [session('alive-1')] });
    await waitForAsync(() => listed('alive-1'));

    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 5));

    // ws 클라이언트는 ping 에 자동으로 pong 한다 — 정상 연결은 살아 있어야 한다.
    expect(runner.socket.readyState).toBe(WebSocket.OPEN);
    expect(await listed('alive-1')).toBe(true);

    runner.socket.close();
  });

  // 죽은 TCP 연결은 close 를 주지 않는다. 그래서 pong 부재가 **유일한** 신호다 —
  // 이것이 없으면 서버는 그 러너를 영원히 살아 있다고 믿는다.
  it('drops a wedged runner and forgets its sessions', async () => {
    const runner = await runners.connect(agentId);
    runner.send({ type: 'announce', sessions: [session('wedged-1')] });
    await waitForAsync(() => listed('wedged-1'));

    runner.wedge();

    await waitForAsync(async () => !(await listed('wedged-1')), 5000);
  });
});
