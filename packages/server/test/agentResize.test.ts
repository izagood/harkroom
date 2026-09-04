// #335 — attach 한 터미널의 크기가 writer 패널을 따라간다. 서버 쪽 회귀선.
//
// `agentInput.test.ts`(#315)와 **같은 방식으로 실제 소켓을 태운다.** 이유도 같다: 크기의
// 게이트는 REST 의 attach 인가 → 티켓 → WS 핸드셰이크를 지나야 성립하고, 그 경로를 안
// 지나는 테스트는 **화면만 막고 서버가 뚫려 있어도 초록이다**(#315 에서 실측된 함정).
// 브라우저는 이 프레임을 직접 보낼 수 있으므로, 여기서 재는 것이 유일한 증거다.
//
// #335 는 처음에 "소유자의 폭이 정답"(attach 시점의 canInput)으로 착지했고, #346(writer
// 규칙 — 스펙 §5-2 결정 2)이 그 판정을 "지금 writer 의 폭이 정답"으로 옮겼다. 원 근거는
// 그대로다: **읽기 전용은 아무것도 바꾸지 않는다** — 주체가 소유자 고정이 아니라 마지막
// attach 로 움직일 뿐이다(스펙 §5: "resize 는 writer 를 따른다").
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView, AttachClientFrame, AttachServerFrame, RelayRunnerFrame, RelayServerFrame } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { createRelayHub, type RelaySocket } from '../src/ws/relay.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let ownerToken: string;
let ownerId: string;
let agentId: string;
let agentPat: string;
let baseUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

interface FakeRunner {
  socket: WebSocket;
  received: RelayServerFrame[];
  send(frame: RelayRunnerFrame): void;
  close(): Promise<void>;
}

async function connectRunner(pat: string): Promise<FakeRunner> {
  const socket = new WebSocket(`ws://${baseUrl}/agent-relay`, { headers: auth(pat) });
  const received: RelayServerFrame[] = [];
  socket.on('message', (d) => received.push(JSON.parse(String(d)) as RelayServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return {
    socket, received,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => new Promise<void>((resolve) => { socket.on('close', () => resolve()); socket.close(); }),
  };
}

function session(sessionId: string): AgentSessionView {
  return {
    sessionId, agentAccountId: agentId, channelId: 'chan-1', threadRootId: 'root-1',
    harness: 'claude-code', startedAt: '2026-09-04T00:00:00.000Z',
  };
}

interface Viewer {
  socket: WebSocket;
  /** 마지막으로 받은 writer 통지(#346). 아직 없으면 null. */
  writer(): boolean | null;
  /** **뷰어 소켓에 직접 쓴다** — 화면의 가드를 지나지 않는 경로다(파일 머리 주석). */
  resize(cols: number, rows: number): void;
  type(bytes: Buffer): void;
  close(): void;
}

async function attach(token: string, sessionId: string): Promise<Viewer> {
  const res = await app.inject({
    method: 'POST', url: `/agent-sessions/${sessionId}/attach`, headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  const socket = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${res.json().ticket as string}`);
  const received: AttachServerFrame[] = [];
  socket.on('message', (d) => received.push(JSON.parse(String(d)) as AttachServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return {
    socket,
    writer: () => {
      const frames = received.filter((f) => f.type === 'writer');
      return frames.length ? (frames.at(-1) as { writer: boolean }).writer : null;
    },
    resize: (cols, rows) => socket.send(JSON.stringify({ type: 'resize', cols, rows } satisfies AttachClientFrame)),
    type: (bytes) => socket.send(JSON.stringify({ type: 'input', data: bytes.toString('base64') } satisfies AttachClientFrame)),
    close: () => socket.close(),
  };
}

const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const waitForAsync = async (pred: () => Promise<boolean>, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function waitForSession(sessionId: string): Promise<void> {
  await waitForAsync(async () => {
    const res = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(ownerToken) });
    return (res.json().sessions as AgentSessionView[]).some((s) => s.sessionId === sessionId);
  });
}

/** 러너가 받은 resize 프레임들. */
const resizes = (r: FakeRunner): { cols: number; rows: number }[] =>
  r.received.filter((f) => f.type === 'resize').map((f) => ({ cols: f.cols, rows: f.rows }));

/** 러너가 받은 input 프레임들의 바이트. */
const inputBytes = (r: FakeRunner): Buffer[] =>
  r.received.filter((f) => f.type === 'input').map((f) => Buffer.from(f.data, 'base64'));

/** 이 세션에 대한 감사 행 전부. **action 을 좁히지 않는다** — resize 가 어떤 이름으로든
 *  행을 만들면 여기 걸려야 한다. */
async function auditRows(sessionId: string): Promise<{ action: string; detail: Record<string, unknown> }[]> {
  const res = await pool.query(
    `select action, detail from audit_log where detail->>'sessionId' = $1 order by id`,
    [sessionId],
  );
  return res.rows as { action: string; detail: Record<string, unknown> }[];
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool: pool as Pool });
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

describe('#335-1 writer 가 패널 크기를 바꾸면 러너에 그 크기가 간다', () => {
  it('뷰어 소켓의 resize 가 그 세션의 러너에게 숫자 그대로 도착한다', async () => {
    const sessionId = 'sess-resize-owner';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    await waitFor(() => viewer.writer() === true);
    viewer.resize(100, 30);
    await waitFor(() => resizes(runner).length > 0);

    expect(resizes(runner)).toEqual([{ cols: 100, rows: 30 }]);
    // 어느 PTY 인지는 이 필드 하나로 정해진다 — 러너가 세션을 여럿 들고 있을 수 있다.
    expect(runner.received.filter((f) => f.type === 'resize')[0]!.sessionId).toBe(sessionId);

    viewer.close();
    await runner.close();
  });

  it('말이 안 되는 크기는 러너까지 가지 않는다 — 이 숫자는 ioctl 로 내려간다', async () => {
    const sessionId = 'sess-resize-bad';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    await waitFor(() => viewer.writer() === true);
    viewer.resize(0, 30);
    viewer.resize(-5, 30);
    viewer.resize(80.5, 24);
    viewer.resize(100_000, 24);

    // **정상값을 뒤에 보내 순서를 확인한다.** 고정 지연으로 "안 왔다"를 단언하면 느린
    // 머신에서 이 테스트가 자기 이유 없이 초록이 된다(#315 의 같은 규율).
    viewer.resize(90, 25);
    await waitFor(() => resizes(runner).length > 0);
    expect(resizes(runner)).toEqual([{ cols: 90, rows: 25 }]);

    viewer.close();
    await runner.close();
  });
});

describe('#335-2 writer 가 아닌 창이 크기를 바꿔도 PTY 크기는 안 바뀐다 — 서버가 버린다', () => {
  it('강등된 창의 resize 는 러너에 닿지 않고, writer 의 것만 닿는다', async () => {
    const sessionId = 'sess-resize-nonwriter';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const first = await attach(adminToken, sessionId);
    await waitFor(() => first.writer() === true);
    // 두 번째 attach 가 차례를 가져간다(#346 — 마지막 attach 가 writer).
    const second = await attach(ownerToken, sessionId);
    await waitFor(() => second.writer() === true && first.writer() === false);

    // **화면의 가드를 지나지 않고 소켓에 직접 쓴다.** 이것이 브라우저가 실제로 할 수
    // 있는 일이고, 화면만 막은 구현은 여기서 뚫린다.
    first.resize(40, 10);
    second.resize(120, 40);
    await waitFor(() => resizes(runner).length > 0);

    // 강등된 창의 40x10 은 하나도 없다 — **읽기 전용은 아무것도 바꾸지 않는다**(#335 의
    // 원 결정이 writer 규칙 위에서 그대로 산다: 스펙 §5 "resize 는 writer 를 따른다").
    expect(resizes(runner)).toEqual([{ cols: 120, rows: 40 }]);

    first.close();
    second.close();
    await runner.close();
  });
});

describe('#335-4 뷰어가 아닌 곳에서 온 크기는 존재하지 않는다 — 떠난 창의 늦은 프레임 포함', () => {
  it('resize 는 attach 한 writer 의 핸들로만 들어오고, close 뒤의 프레임은 버려진다', () => {
    // 허브를 직접 세운다 — 이 사실은 소켓 너머가 아니라 **허브의 수명 관리**에 산다.
    const hub = createRelayHub();
    const sent: string[] = [];
    const runnerSocket: RelaySocket = { send: (d) => sent.push(d), close: () => {} };
    hub.addRunner('agent-1', runnerSocket);
    hub.onRunnerMessage('agent-1', JSON.stringify({
      type: 'announce',
      caps: ['input', 'interactive'],
      sessions: [{
        sessionId: 's1', agentAccountId: 'agent-1', channelId: 'c1', threadRootId: null,
        harness: 'claude-code', startedAt: '2026-09-04T00:00:00.000Z',
      }],
    }));

    const viewer = hub.addViewer('s1', { send: () => {}, close: () => {} });
    expect(viewer.handleMessage(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))).toBe(true);
    expect(sent.filter((d) => d.includes('"resize"'))).toHaveLength(1);

    // 떠난 뒤의 늦은 프레임은 버려진다. 마지막 뷰어가 떠난 뒤 도착한 크기가 PTY 를
    // 뒤흔들면, 그 뒤에 붙는 사람이 남의 창 크기를 물려받는다.
    viewer.close();
    expect(viewer.handleMessage(JSON.stringify({ type: 'resize', cols: 60, rows: 20 }))).toBe(false);
    expect(sent.filter((d) => d.includes('"resize"'))).toHaveLength(1);
  });
});

describe('#335-5 resize 는 감사에 아무것도 남기지 않는다', () => {
  it('드래그처럼 수십 번 보내도 detach 합산(inputBytes)에 크기는 한 바이트도 안 섞인다', async () => {
    const sessionId = 'sess-resize-audit';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    await waitFor(() => viewer.writer() === true);
    // 사람이 패널 경계를 드래그하는 것과 같은 모양 — 한 픽셀에 프레임 하나다.
    for (let cols = 60; cols < 90; cols += 1) viewer.resize(cols, 24);
    await waitFor(() => resizes(runner).length === 30);

    // **입력을 하나 섞는다.** 이것이 없으면 감사 경로가 통째로 고장 나 있어도 이 테스트가
    // 초록이다 — "0"은 "안 센다"의 증거이면서 "아무것도 안 된다"의 증상이기도 하다.
    viewer.type(Buffer.from('x', 'utf8'));
    await waitFor(() => inputBytes(runner).length === 1);

    viewer.close();
    await waitForAsync(async () => (await auditRows(sessionId)).some((r) => r.action === 'agent.detached'));

    const rows = await auditRows(sessionId);
    // 남아야 하는 것: attach 한 줄과 detach 한 줄. resize 는 어떤 이름으로도 없다(#346 —
    // agent.input 행 자체가 detach 합산으로 대체됐다).
    expect(rows.map((r) => r.action)).toEqual(['agent.attached', 'agent.detached']);
    // 합산은 친 1바이트뿐이다 — 크기 조절 30번이 여기 섞이면 감사가 "개입 규모"를
    // 거짓말한다(창 크기 조절은 개입이 아니라 보기다).
    expect(rows[1]!.detail.inputBytes).toBe(1);

    await runner.close();
  });
});

describe('#335-6 #315 의 입력 경로가 그대로 동작한다', () => {
  it('resize 를 사이사이 섞어도 친 바이트가 순서대로 전부 도착한다', async () => {
    const sessionId = 'sess-resize-input';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    await waitFor(() => viewer.writer() === true);
    // 프레임 종류가 늘었으므로, 판별을 고치다 입력을 흘리는 회귀가 실제로 가능하다.
    viewer.type(Buffer.from('ye', 'utf8'));
    viewer.resize(100, 30);
    viewer.type(Buffer.from('s\r', 'utf8'));
    await waitFor(() => inputBytes(runner).length === 2);

    expect(Buffer.concat(inputBytes(runner)).toString('utf8')).toBe('yes\r');
    expect(resizes(runner)).toEqual([{ cols: 100, rows: 30 }]);

    viewer.close();
    await runner.close();
  });
});
