// #315 — attach 한 터미널에 사람이 타이핑한다. 서버 쪽 회귀선.
//
// `agentRelay.test.ts`(#141, 읽기 절반)와 **같은 방식으로 실제 소켓을 태운다.** 인메모리
// 허브만 단위로 검증하면 이 기능의 게이트가 통째로 빠진다: 쓰기 인가는 REST 의 attach
// 인가 → 티켓 → WS 핸드셰이크를 지나야 성립하고, 그 경로를 안 지나는 테스트는 화면만
// 막고 서버가 뚫려 있어도 초록이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView, AttachClientFrame, RelayRunnerFrame, RelayServerFrame } from '@murmur/shared';
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

/**
 * 사람이 치는 것을 흉내낸 바이트열. **글자만이 아니다**: Ctrl-C(0x03), 위 화살표
 * (`\x1b[A`), 붙여 넣은 한글이 섞여 있다. 문자열로 왕복하면 이 중 일부가 왜곡되고,
 * latin1 로 왕복하면 한글이 깨진다 — 바이트 그대로 도착하는 것이 계약이다.
 */
const TYPED = Buffer.concat([
  Buffer.from([0x03]),
  Buffer.from('\x1b[A', 'binary'),
  Buffer.from('yes 비밀번호1234\r', 'utf8'),
]);

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
  /** 서버가 알려 준 쓰기 권한. attach 응답에서 온 값 그대로다. */
  canInput: boolean;
  type(bytes: Buffer): void;
  close(): void;
}

/** attach 인가를 받고 뷰어 소켓을 연다. */
async function attach(token: string, sessionId: string): Promise<Viewer> {
  const res = await app.inject({
    method: 'POST', url: `/agent-sessions/${sessionId}/attach`, headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  const socket = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${res.json().ticket as string}`);
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return {
    socket,
    canInput: res.json().canInput as boolean,
    // **뷰어 소켓에 직접 쓴다.** 화면의 가드를 지나지 않는 경로다 — 서버가 막지 않으면
    // 여기서 뚫린다(화면만 비활성으로 두면 못 잡는 그 구멍).
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

/** announce 가 반영될 때까지 기다린다. 고정 지연으로 갈음하지 않는다. */
async function waitForSession(sessionId: string): Promise<void> {
  await waitForAsync(async () => {
    const res = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(ownerToken) });
    return (res.json().sessions as AgentSessionView[]).some((s) => s.sessionId === sessionId);
  });
}

/** 러너가 받은 input 프레임들의 바이트. */
const inputBytes = (r: FakeRunner): Buffer[] =>
  r.received.filter((f) => f.type === 'input').map((f) => Buffer.from(f.data, 'base64'));

/** 이 세션에 대한 `agent.input` 감사 행 전부. */
async function inputAuditRows(sessionId: string): Promise<{ actorId: string | null; at: string; detail: unknown }[]> {
  const res = await pool.query(
    `select actor_id as "actorId", at, detail from audit_log
      where action = 'agent.input' and detail->>'sessionId' = $1 order by id`,
    [sessionId],
  );
  return res.rows as { actorId: string | null; at: string; detail: unknown }[];
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  // 감사 묶임 간격을 짧게 준다 — 기본 60초로는 "묶인다"는 확인만 되고 "간격이 지나면
  // 다시 남는다"는 확인이 테스트를 1분 멈춘다.
  app = await buildServer({ pool: pool as Pool, inputAuditWindowMs: 300 });
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

describe('#315-1 소유자가 친 바이트가 러너 PTY 로 간다', () => {
  it('뷰어 소켓의 input 이 그 세션의 러너에게 바이트 그대로 도착한다', async () => {
    const sessionId = 'sess-input-1';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    expect(viewer.canInput).toBe(true);
    viewer.type(TYPED);
    await waitFor(() => inputBytes(runner).length > 0);

    // 바이트 비교다. 문자열 비교로 갈음하면 Ctrl-C(0x03)나 잘린 시퀀스가 같아 보인다.
    expect(inputBytes(runner)).toHaveLength(1);
    expect(inputBytes(runner)[0]!.equals(TYPED)).toBe(true);
    // 프레임의 세션 id 도 확인한다 — 러너가 세션을 여럿 들고 있을 때 어느 PTY 인지는
    // 이 필드 하나로 정해진다.
    expect(runner.received.filter((f) => f.type === 'input')[0]!.sessionId).toBe(sessionId);

    viewer.close();
    await runner.close();
  });
});

describe('#315-4 admin 은 볼 수 있지만 칠 수 없다', () => {
  it('admin 의 input 은 거절되고 러너에 바이트가 가지 않는다', async () => {
    const sessionId = 'sess-input-admin';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)] });
    await waitForSession(sessionId);

    const adminViewer = await attach(adminToken, sessionId);
    // 서버가 먼저 말한다 — 화면은 이 값을 받아 입력을 안 연다.
    expect(adminViewer.canInput).toBe(false);
    adminViewer.type(TYPED);

    // **소유자의 입력을 뒤에 보내 순서를 확인한다.** "아직 안 왔다"와 "영영 안 온다"를
    // 고정 지연으로 가르면 느린 머신에서 이 테스트가 자기 이유 없이 초록이 된다.
    const ownerViewer = await attach(ownerToken, sessionId);
    ownerViewer.type(Buffer.from('owner\r', 'utf8'));
    await waitFor(() => inputBytes(runner).length > 0);

    expect(inputBytes(runner)).toHaveLength(1);
    expect(inputBytes(runner)[0]!.toString('utf8')).toBe('owner\r');

    adminViewer.close();
    ownerViewer.close();
    await runner.close();
  });
});

describe('#315-6 소유자도 admin 도 아니면 읽기도 못 한다 (#141 게이트 유지)', () => {
  it('제3자는 attach 인가에서 403 이고 티켓 자체를 못 받는다', async () => {
    const sessionId = 'sess-input-stranger';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)] });
    await waitForSession(sessionId);

    const res = await app.inject({
      method: 'POST', url: `/agent-sessions/${sessionId}/attach`, headers: auth(strangerToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().ticket).toBeUndefined();

    // 입력을 열었다고 읽기 게이트가 느슨해지지 않았음을 같은 자리에서 확인한다 —
    // 이 사실이 #141 의 것이라고 저쪽 파일에만 두면, 여기서 게이트를 우회하는 변경이
    // 들어와도 이 파일만 보는 사람에게는 아무 신호가 없다.
    await runner.close();
  });
});

describe('#315-7 감사에 누가 언제만 남고 내용은 남지 않는다', () => {
  it('감사 행 전체를 문자열로 만들어도 타이핑한 값이 그 안에 없다', async () => {
    const sessionId = 'sess-input-audit';
    const secret = 'sk-live-0123456789abcdef';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    viewer.type(Buffer.from(secret, 'utf8'));
    await waitForAsync(async () => (await inputAuditRows(sessionId)).length > 0);

    const rows = await inputAuditRows(sessionId);
    // 남아야 하는 사실: 누가(actorId), 언제(at), 어느 턴에(sessionId).
    expect(rows[0]!.actorId).toBe(ownerId);
    expect(Date.parse(rows[0]!.at)).not.toBeNaN();
    expect(rows[0]!.detail).toEqual({ sessionId });

    // **행 전체를 문자열로 만들어 검사한다.** "detail 에 그 키가 없다"로 단언하면 필드
    // 이름이 바뀌는 순간 아무것도 안 지키는 테스트가 된다. 원문과 base64 둘 다 본다 —
    // 이 파이프의 값은 base64 로 오가므로, 그대로 복사한 결함은 원문 검색에 안 걸린다.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(Buffer.from(secret, 'utf8').toString('base64'));

    viewer.close();
    await runner.close();
  });
});

describe('#315-8 연타가 감사 행을 폭증시키지 않는다', () => {
  it('한 attach 세션의 연속 입력은 한 행으로 묶이고, 간격이 지나면 다시 한 행이 남는다', async () => {
    const sessionId = 'sess-input-burst';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    // 사람이 한 줄을 치는 것과 같은 모양 — 키 하나에 프레임 하나다.
    for (const ch of 'yes, do it\r') viewer.type(Buffer.from(ch, 'utf8'));
    await waitFor(() => inputBytes(runner).length === 11);
    await waitForAsync(async () => (await inputAuditRows(sessionId)).length > 0);

    // **바이트는 하나도 안 묶였다.** 묶이는 것은 감사뿐이고, PTY 에는 전부 가야 한다 —
    // 여기서 바이트가 줄면 사람이 친 것이 사라진 것이다.
    expect(inputBytes(runner)).toHaveLength(11);
    expect(await inputAuditRows(sessionId)).toHaveLength(1);

    // 간격(테스트에서 300ms)이 지나면 다음 개입은 다시 남는다 — 묶임이 "첫 번째만 남기고
    // 영원히 침묵한다"가 되면 두 시간 뒤의 개입이 감사에서 사라진다.
    await new Promise((r) => setTimeout(r, 350));
    viewer.type(Buffer.from('x', 'utf8'));
    await waitForAsync(async () => (await inputAuditRows(sessionId)).length === 2);
    expect(await inputAuditRows(sessionId)).toHaveLength(2);

    viewer.close();
    await runner.close();
  });
});
