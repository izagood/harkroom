// #337 — 사람이 스스로 인터랙티브 터미널을 연다(스펙 §5-2 결정 4). 서버 쪽 회귀선.
//
// `agentRelay.test.ts`·`agentInput.test.ts` 와 같은 방식으로 실제 소켓을 태운다 — 이
// 기능의 성립 조건이 REST 인가 → 허브 requestId 상관 → 러너 응답 → 티켓 발급의 **경로**
// 이고, 허브만 단위로 보면 그 경로의 이음새(같은 소켓의 session.started 가 opened 보다
// 먼저 처리된다, 티켓이 attach 와 같은 저장소에서 나온다)가 검증되지 않는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView, RelayRunnerFrame, RelayServerFrame, RunnerCap } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let ownerToken: string;
let ownerId: string;
let strangerToken: string;
let agentId: string;
let agentPat: string;
let baseUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** interactive.open 타임아웃을 짧게 잡는다 — 504 경로 확인이 테스트를 10초 세우면 안 된다. */
const OPEN_TIMEOUT_MS = 400;

interface FakeRunner {
  socket: WebSocket;
  received: RelayServerFrame[];
  send(frame: RelayRunnerFrame): void;
  close(): Promise<void>;
}

async function connectRunner(pat: string, caps: readonly RunnerCap[] | null): Promise<FakeRunner> {
  const socket = new WebSocket(`ws://${baseUrl}/agent-relay`, { headers: auth(pat) });
  const received: RelayServerFrame[] = [];
  socket.on('message', (d) => received.push(JSON.parse(String(d)) as RelayServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  // caps: null 은 구 러너 흉내 — announce 에 필드 자체가 없다.
  socket.send(JSON.stringify(caps
    ? { type: 'announce', sessions: [], caps }
    : { type: 'announce', sessions: [] }));
  return {
    socket, received,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => new Promise<void>((resolve) => { socket.on('close', () => resolve()); socket.close(); }),
  };
}

const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function session(sessionId: string, mode: 'mention' | 'interactive'): AgentSessionView {
  return {
    sessionId, agentAccountId: agentId, channelId: 'chan-1', threadRootId: 'root-1',
    harness: 'claude-code', startedAt: '2026-09-04T00:00:00.000Z', mode,
  };
}

/**
 * 프로토콜을 지키는 가짜 러너: interactive.open 이 오면 **session.started 를 먼저** 보내고
 * interactive.opened 로 답한다 — 실제 러너(interactiveTurn.ts)와 같은 순서다.
 */
function answerOpens(runner: FakeRunner, opts: { sessionId: string; created: boolean }): void {
  runner.socket.on('message', (d) => {
    const frame = JSON.parse(String(d)) as RelayServerFrame;
    if (frame.type !== 'interactive.open') return;
    if (opts.created) {
      runner.send({ type: 'session.started', session: session(opts.sessionId, 'interactive') });
    }
    runner.send({ type: 'interactive.opened', requestId: frame.requestId, sessionId: opts.sessionId, created: opts.created });
  });
}

const openReq = (token: string) => app.inject({
  method: 'POST', url: '/agent-sessions/interactive', headers: auth(token),
  payload: { agentAccountId: agentId, channelId: 'chan-1', threadRootId: 'root-1' },
});

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool: pool as Pool, interactiveOpenTimeoutMs: OPEN_TIMEOUT_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const register = async (handle: string) => {
    const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
    const created = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { handle, loginId: handle, displayName: handle, password: 'pw123456', inviteToken: inv.json().token as string },
    });
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: handle, password: 'pw123456' },
    });
    return { id: created.json().id as string, token: login.json().token as string };
  };

  const owner = await register('owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  strangerToken = (await register('stranger')).token;

  ({ accountId: agentId, pat: agentPat } = await createAgent(app, adminToken, 'forge'));
  const patched = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(adminToken),
    payload: { ownerAccountId: ownerId },
  });
  expect(patched.statusCode).toBe(200);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('#337-1 열기 성공 — opened 응답이 티켓·세션으로 돌아온다', () => {
  it('러너가 세션을 만들어 답하면 200 에 ticket 과 session 이 실리고 감사가 남는다', async () => {
    const runner = await connectRunner(agentPat, ['input', 'interactive']);
    answerOpens(runner, { sessionId: 'sess-new', created: true });

    const res = await openReq(ownerToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket).toMatch(/^murt_/);
    expect((res.json().session as AgentSessionView).sessionId).toBe('sess-new');
    expect((res.json().session as AgentSessionView).mode).toBe('interactive');

    // 러너가 받은 요청에 누가 열었는지가 실려 있다 — 조종 중 유예 통지의 재료다.
    const open = runner.received.find((f) => f.type === 'interactive.open');
    expect(open).toMatchObject({ channelId: 'chan-1', threadRootId: 'root-1', openedByHandle: 'owner' });

    // 티켓이 attach 와 같은 저장소에서 나온다 — 그 티켓으로 뷰어 소켓이 실제로 열린다.
    const viewer = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${res.json().ticket as string}`);
    await new Promise<void>((resolve, reject) => { viewer.on('open', () => resolve()); viewer.on('error', reject); });
    viewer.close();

    // 셸을 여는 것은 관찰보다 강한 행위다 — attach 와 별개 액션으로 남는다(§5-2 결정 4).
    await waitFor(() => true);
    const audit = await pool.query(
      `select actor_id as "actorId", target, detail from audit_log where action = 'agent.interactive.opened'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      actorId: ownerId,
      target: agentId,
      detail: { sessionId: 'sess-new', channelId: 'chan-1', threadRootId: 'root-1', created: true },
    });

    await runner.close();
  });

  it('이미 돌던 턴이면 created:false 로 그 세션에 합류한다', async () => {
    const runner = await connectRunner(agentPat, ['input', 'interactive']);
    // 멘션 턴이 이미 announce 돼 있다 — 러너의 3분기 ① 이 이 세션 id 를 돌려준다.
    runner.send({ type: 'session.started', session: session('sess-mention', 'mention') });
    answerOpens(runner, { sessionId: 'sess-mention', created: false });

    const res = await openReq(ownerToken);
    expect(res.statusCode).toBe(200);
    expect((res.json().session as AgentSessionView).sessionId).toBe('sess-mention');
    // 세션 자체는 멘션 턴의 것이다 — created:false 는 "새 PTY 를 띄우지 않았다"는 뜻이고,
    // 감사의 created 가 그것을 남긴다.
    const audit = await pool.query(
      `select detail from audit_log where action = 'agent.interactive.opened' and detail->>'sessionId' = 'sess-mention'`,
    );
    expect(audit.rows[0]!.detail).toMatchObject({ created: false });

    await runner.close();
  });
});

describe('#337-2 실패가 상태 코드로 갈린다 — 화면이 그대로 사람에게 보여줄 문구다', () => {
  it('러너가 없으면 404 no_runner', async () => {
    const res = await openReq(ownerToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('no_runner');
  });

  it('caps 에 interactive 가 없는 구 러너는 즉시 409 — 타임아웃을 기다리지 않는다', async () => {
    const runner = await connectRunner(agentPat, null);
    const started = Date.now();
    const res = await openReq(ownerToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('runner_outdated');
    // "즉시"를 시간으로 단언한다 — 타임아웃(400ms)을 기다렸다면 이 게이트가 없는 것이다.
    expect(Date.now() - started).toBeLessThan(OPEN_TIMEOUT_MS);
    // 구 러너에는 프레임 자체가 가지 않는다 — 가면 조용히 버려질 뿐이다.
    expect(runner.received.filter((f) => f.type === 'interactive.open')).toEqual([]);
    await runner.close();
  });

  it('러너가 답하지 않으면 504 runner_timeout', async () => {
    const runner = await connectRunner(agentPat, ['input', 'interactive']);
    // 아무 응답도 하지 않는 러너 — spawn 이 걸려 있는 경우의 흉내다.
    const res = await openReq(ownerToken);
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('runner_timeout');
    await runner.close();
  });

  it('러너의 거절(interactive.error)은 그 문구 그대로 409 로 온다 — codex 거절이 이 경로다', async () => {
    const runner = await connectRunner(agentPat, ['input', 'interactive']);
    runner.socket.on('message', (d) => {
      const frame = JSON.parse(String(d)) as RelayServerFrame;
      if (frame.type !== 'interactive.open') return;
      runner.send({ type: 'interactive.error', requestId: frame.requestId, message: 'codex 인터랙티브 턴은 지원하지 않는다' });
    });
    const res = await openReq(ownerToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('interactive_rejected');
    expect(res.json().error.message).toBe('codex 인터랙티브 턴은 지원하지 않는다');
    await runner.close();
  });

  it('소유자도 admin 도 아니면 403 — attach 와 같은 술어다', async () => {
    const runner = await connectRunner(agentPat, ['input', 'interactive']);
    const res = await openReq(strangerToken);
    expect(res.statusCode).toBe(403);
    // 인가에서 거절된 요청은 러너에 닿지도 않는다.
    expect(runner.received.filter((f) => f.type === 'interactive.open')).toEqual([]);
    await runner.close();
  });

  it('필드가 빠지면 400 — 스레드를 특정하지 못하는 열기는 없다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/agent-sessions/interactive', headers: auth(ownerToken),
      payload: { agentAccountId: agentId, channelId: 'chan-1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('#337-3 viewer.count 가 러너에 흐른다 — 인터랙티브 고아 회수의 신호', () => {
  it('attach 가 count 를 올리고 detach 가 내린다', async () => {
    const runner = await connectRunner(agentPat, ['input', 'interactive']);
    runner.send({ type: 'session.started', session: session('sess-count', 'interactive') });
    await waitFor(() => runner.received.length >= 0);

    const attachRes = await app.inject({
      method: 'POST', url: '/agent-sessions/sess-count/attach', headers: auth(ownerToken),
    });
    expect(attachRes.statusCode).toBe(200);
    const viewer = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${attachRes.json().ticket as string}`);
    await new Promise<void>((resolve, reject) => { viewer.on('open', () => resolve()); viewer.on('error', reject); });

    const counts = () => runner.received
      .filter((f) => f.type === 'viewer.count' && f.sessionId === 'sess-count')
      .map((f) => (f as { count: number }).count);
    await waitFor(() => counts().includes(1));

    viewer.close();
    // 0 이 도착해야 러너의 유예 타이머가 시작된다 — 이 프레임이 빠지면 사람이 패널을
    // 닫아도 인터랙티브 PTY 가 영원히 산다.
    await waitFor(() => counts().at(-1) === 0);

    await runner.close();
  });
});
