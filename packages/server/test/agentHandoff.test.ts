// #384 — 멘션 턴에서 인터랙티브 턴으로 이어받기. 서버 쪽 회귀선.
//
// 실제 소켓을 태우는 이유는 `agentInteractiveOpen.test.ts` 와 같다: 이 기능의 성립 조건이
// REST → 허브 → 러너 → 응답 프레임의 **경로**이고, 그 이음새가 여기서만 드러난다.
//
// 이 파일이 지키는 것:
//   ① 이어받기 요청이 `handoff: true` 로 러너에 닿고, 러너의 `interactive.reserved` 가
//      `waiting: true` 로 사람에게 돌아온다(감사도 '열었다'가 아니라 '예약했다'로 남는다).
//   ② 그 능력이 없는 러너에는 **보내지 않고** 즉시 거절한다 — 눌렀는데 아무 일이 없거나
//      원인 없는 타임아웃이 되면 안 된다.
//   ③ **#369 의 회귀선이 그대로 초록이다**: 예약을 했어도 진행 중인 멘션 턴은 여전히
//      관찰 전용이다(`acceptsInput: false` → writer 없음, 이유는 'observe-only').
//   ④ 이어받기로 뜬 인터랙티브 세션은 `acceptsInput: true` 하나로 writer 가 열린다 —
//      #369 의 판정을 그대로 타고, 새 판정을 만들지 않았다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView, AttachServerFrame, RelayRunnerFrame, RelayServerFrame, RunnerCap } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

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

/** 러너 응답 한도를 짧게 — 거절 경로가 테스트를 10초 세우면 안 된다. */
const OPEN_TIMEOUT_MS = 400;

interface FakeRunner {
  socket: WebSocket;
  received: RelayServerFrame[];
  send(frame: RelayRunnerFrame): void;
  close(): Promise<void>;
}

async function connectRunner(caps: readonly RunnerCap[]): Promise<FakeRunner> {
  const socket = new WebSocket(`ws://${baseUrl}/agent-relay`, { headers: auth(agentPat) });
  const received: RelayServerFrame[] = [];
  socket.on('message', (d) => received.push(JSON.parse(String(d)) as RelayServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.send(JSON.stringify({ type: 'announce', sessions: [], caps }));
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

/**
 * 세션 하나. `acceptsInput` 은 **모드에서 유도하지 않는다** — 러너가 그 턴의 계획
 * (stdinFile)에서 읽어 싣는 사실이고(#369), 이 파일이 그 값의 두 갈래를 그대로 태운다:
 * 멘션 턴은 프롬프트를 파일로 받아 false, 이어받기로 뜬 인터랙티브 턴은 true.
 */
function session(sessionId: string, mode: 'mention' | 'interactive', acceptsInput: boolean): AgentSessionView {
  return {
    sessionId, agentAccountId: agentId, channelId: 'chan-1', threadRootId: 'root-1',
    harness: 'claude-code', startedAt: '2026-09-04T00:00:00.000Z', mode, acceptsInput,
  };
}

/** 이어받기 요청. `handoff: true` 가 [터미널 열기] 와 이 요청을 가르는 유일한 값이다. */
const handoffReq = (token: string) => app.inject({
  method: 'POST', url: '/agent-sessions/interactive', headers: auth(token),
  payload: { agentAccountId: agentId, channelId: 'chan-1', threadRootId: 'root-1', handoff: true },
});

/** 뷰어 소켓 하나를 열고 받은 프레임을 모은다 — writer 통지를 읽으려고 둔다. */
async function attachViewer(ticket: string): Promise<{ frames: AttachServerFrame[]; close: () => void }> {
  const socket = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${ticket}`);
  const frames: AttachServerFrame[] = [];
  socket.on('message', (d) => frames.push(JSON.parse(String(d)) as AttachServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return { frames, close: () => socket.close() };
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool: pool as Pool, interactiveOpenTimeoutMs: OPEN_TIMEOUT_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
  const created = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'owner', loginId: 'owner', displayName: 'owner', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'owner', password: 'pw123456' },
  });
  ownerId = created.json().id as string;
  ownerToken = login.json().token as string;

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

describe('#384-1 예약 — 진행 중인 멘션 턴은 계속 돌고, 기다린다는 사실이 응답에 실린다', () => {
  it('handoff:true 가 러너에 닿고 interactive.reserved 가 waiting:true 로 돌아온다', async () => {
    const runner = await connectRunner(['input', 'interactive', 'handoff']);
    runner.send({ type: 'session.started', session: session('sess-mention', 'mention', false) });
    runner.socket.on('message', (d) => {
      const frame = JSON.parse(String(d)) as RelayServerFrame;
      if (frame.type !== 'interactive.open') return;
      // 러너의 답: 예약했다. **새 세션을 만들지 않았다** — 사람은 도는 멘션 턴을 계속 본다.
      runner.send({ type: 'interactive.reserved', requestId: frame.requestId, sessionId: 'sess-mention' });
    });

    const res = await handoffReq(ownerToken);
    expect(res.statusCode).toBe(200);
    // 이 값이 화면의 "턴이 끝나면 엽니다"가 된다. 없으면 사람은 눌렀는데 아무 일이 없다.
    expect(res.json().waiting).toBe(true);
    expect((res.json().session as AgentSessionView).sessionId).toBe('sess-mention');
    expect(res.json().ticket).toMatch(/^murt_/);

    // 요청에 이어받기라는 사실이 실려 있다 — 러너가 이 값으로 예약과 즉시 열기를 가른다.
    const open = runner.received.find((f) => f.type === 'interactive.open');
    expect(open).toMatchObject({ channelId: 'chan-1', threadRootId: 'root-1', openedByHandle: 'owner', handoff: true });

    // 감사는 '열었다'가 아니라 '예약했다'다 — 이 시각에는 아직 아무 PTY 도 없다.
    const audit = await pool.query(
      `select actor_id as "actorId", target, detail from audit_log where action = 'agent.interactive.handoffReserved'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      actorId: ownerId, target: agentId,
      detail: { sessionId: 'sess-mention', channelId: 'chan-1', threadRootId: 'root-1' },
    });

    await runner.close();
  });

  it('handoff 능력이 없는 러너에는 요청을 보내지 않고 즉시 거절한다 — 문구가 이어받기를 가리킨다', async () => {
    const runner = await connectRunner(['input', 'interactive']);

    const res = await handoffReq(ownerToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('runner_outdated');
    // "인터랙티브 열기를 지원하지 않는다"로 뭉치면, 방금 되던 [터미널 열기]와 모순돼 보인다.
    expect(res.json().error.message).toContain('이어받기');
    // 구 러너는 이 프레임을 버린다 — 보내고 기다리면 원인 없는 504 가 사람에게 간다.
    expect(runner.received.some((f) => f.type === 'interactive.open')).toBe(false);

    await runner.close();
  });

  it('handoff 가 boolean 이 아니면 400 이다 — 문자열 false 가 참으로 읽히는 길을 열지 않는다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/agent-sessions/interactive', headers: auth(ownerToken),
      payload: { agentAccountId: agentId, channelId: 'chan-1', threadRootId: 'root-1', handoff: 'false' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });
});

describe('#384-2 writer 판정은 #369 그대로다 — 멘션 턴은 관찰 전용, 이어받기 턴은 입력 가능', () => {
  it('예약을 했어도 진행 중인 멘션 턴에 붙으면 여전히 관찰 전용이다(#369 회귀선)', async () => {
    const runner = await connectRunner(['input', 'interactive', 'handoff']);
    runner.send({ type: 'session.started', session: session('sess-m2', 'mention', false) });
    runner.socket.on('message', (d) => {
      const frame = JSON.parse(String(d)) as RelayServerFrame;
      if (frame.type === 'interactive.open') {
        runner.send({ type: 'interactive.reserved', requestId: frame.requestId, sessionId: 'sess-m2' });
      }
    });

    const res = await handoffReq(ownerToken);
    expect(res.json().waiting).toBe(true);

    // 그 티켓으로 붙는다 — 기다리는 동안 보는 화면이 이것이다.
    const viewer = await attachViewer(res.json().ticket as string);
    await waitFor(() => viewer.frames.some((f) => f.type === 'writer'));
    const writer = viewer.frames.find((f) => f.type === 'writer');
    // **입력은 열리지 않는다.** 프롬프트가 파일이라는 사실은 예약과 무관하게 그대로다 —
    // 여기가 초록이 아니면 #369 가 방금 고친 거짓말이 되돌아온다.
    expect(writer).toMatchObject({ writer: false, resize: true, reason: 'observe-only' });

    viewer.close();
    await runner.close();
  });

  it('이어받기로 뜬 인터랙티브 세션은 acceptsInput:true 하나로 writer 가 열린다', async () => {
    const runner = await connectRunner(['input', 'interactive', 'handoff']);
    // 멘션 턴이 끝난 뒤 러너가 예약대로 띄운 세션 — `stdinFile: null` 이라 acceptsInput 이 true 다.
    runner.send({ type: 'session.started', session: session('sess-handoff', 'interactive', true) });
    runner.socket.on('message', (d) => {
      const frame = JSON.parse(String(d)) as RelayServerFrame;
      if (frame.type === 'interactive.open') {
        runner.send({ type: 'interactive.opened', requestId: frame.requestId, sessionId: 'sess-handoff', created: false });
      }
    });

    // 화면은 턴이 끝나면 같은 요청을 한 번 더 보낸다 — 그때 이 세션의 티켓을 받는다.
    const res = await handoffReq(ownerToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().waiting).toBe(false);
    expect((res.json().session as AgentSessionView).sessionId).toBe('sess-handoff');

    const viewer = await attachViewer(res.json().ticket as string);
    await waitFor(() => viewer.frames.some((f) => f.type === 'writer'));
    expect(viewer.frames.find((f) => f.type === 'writer')).toMatchObject({
      writer: true, resize: true, reason: null,
    });

    viewer.close();
    await runner.close();
  });
});
