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
import type { AgentSessionView, AttachClientFrame, AttachServerFrame, RelayRunnerFrame, RelayServerFrame } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
/** admin 이 **직접 소유한** 에이전트. `POST /accounts/agents` 가 만드는 기본 상태다. */
let adminOwnedAgentId: string;
let adminOwnedAgentPat: string;
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
  /** 서버가 이 뷰어에 보낸 프레임 전부 — `writer` 통지가 여기 실린다(스펙 §5-2 결정 2). */
  received: AttachServerFrame[];
  /** 마지막으로 받은 writer 통지. 아직 없으면 null — 구 서버 흉내가 아니라 순서 검증용. */
  writer(): boolean | null;
  type(bytes: Buffer): void;
  close(): void;
}

/** attach 인가를 받고 뷰어 소켓을 연다. */
async function attach(token: string, sessionId: string): Promise<Viewer> {
  const res = await app.inject({
    method: 'POST', url: `/agent-sessions/${sessionId}/attach`, headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  // 쓰기 차례는 응답이 아니라 소켓의 `writer` 프레임이 알린다 — 응답에 있으면 attach
  // 시점의 판정이 얼어붙어 승격·강등을 담지 못한다(#346).
  expect(res.json().canInput).toBeUndefined();
  const socket = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${res.json().ticket as string}`);
  const received: AttachServerFrame[] = [];
  socket.on('message', (d) => received.push(JSON.parse(String(d)) as AttachServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return {
    socket,
    received,
    writer: () => {
      const frames = received.filter((f) => f.type === 'writer');
      return frames.length ? (frames.at(-1) as { writer: boolean }).writer : null;
    },
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

/** 이 세션에 대한 `agent.detached` 감사 행 전부 — 개입 사실은 이 행의 inputBytes 로 남는다(#346). */
async function detachedAuditRows(sessionId: string): Promise<{ actorId: string | null; at: string; detail: Record<string, unknown> }[]> {
  const res = await pool.query(
    `select actor_id as "actorId", at, detail from audit_log
      where action = 'agent.detached' and detail->>'sessionId' = $1 order by id`,
    [sessionId],
  );
  return res.rows as { actorId: string | null; at: string; detail: Record<string, unknown> }[];
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool: pool as Pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

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

  // 소유자를 옮기지 **않은** 에이전트. `POST /accounts/agents` 는 admin 전용이고 만든
  // 사람을 그대로 owner_account_id 에 넣으므로(services/agents.ts::createAgentAccount),
  // 이것이 새로 만든 에이전트의 **기본 상태**다 — 소유자가 곧 admin 인 상태.
  ({ accountId: adminOwnedAgentId, pat: adminOwnedAgentPat } = await createAgent(app, adminToken, 'selfowned'));

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('#315-1 writer 뷰어가 친 바이트가 러너 PTY 로 간다', () => {
  it('혼자 붙은 뷰어는 writer 통지를 받고, 그 input 이 러너에게 바이트 그대로 도착한다', async () => {
    const sessionId = 'sess-input-1';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    // 마지막(이자 유일한) attach 가 writer 다 — 서버가 먼저 통지한다(스펙 §5-2 결정 2).
    await waitFor(() => viewer.writer() === true);
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

describe('#315-4 writer 가 아닌 뷰어는 소켓에 직접 써도 러너에 닿지 않는다', () => {
  it('두 번째 attach 가 첫 번째를 강등시키고, 강등된 창의 input 은 버려진다', async () => {
    const sessionId = 'sess-input-nonwriter';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const first = await attach(ownerToken, sessionId);
    await waitFor(() => first.writer() === true);

    // 두 번째 창이 붙으면 차례가 넘어간다 — 첫 창은 강등 통지를 받는다.
    const second = await attach(adminToken, sessionId);
    await waitFor(() => second.writer() === true);
    await waitFor(() => first.writer() === false);

    // **강등된 창이 소켓에 직접 쓴다.** 화면이 아니라 서버가 막아야 하는 자리다.
    first.type(TYPED);

    // writer 의 입력을 뒤에 보내 순서를 확인한다 — "아직 안 왔다"와 "영영 안 온다"를
    // 고정 지연으로 가르면 느린 머신에서 이 테스트가 자기 이유 없이 초록이 된다.
    second.type(Buffer.from('writer\r', 'utf8'));
    await waitFor(() => inputBytes(runner).length > 0);

    expect(inputBytes(runner)).toHaveLength(1);
    expect(inputBytes(runner)[0]!.toString('utf8')).toBe('writer\r');

    first.close();
    second.close();
    await runner.close();
  });

  it('writer 가 떠나면 가장 최근에 붙은 남은 뷰어가 승계한다', async () => {
    const sessionId = 'sess-input-succession';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    // 각 승격·강등을 **기다린 뒤** 다음으로 간다 — 안 기다리면 second 의 attach 시점
    // writer:true 가 남아 있어, 아래의 "승계했다" 대기가 낡은 프레임으로 즉시 통과하고
    // 그 사이 서버 쪽 차례는 아직 third 라 입력이 버려진다(실측한 경합).
    const first = await attach(ownerToken, sessionId);
    await waitFor(() => first.writer() === true);
    const second = await attach(adminToken, sessionId);
    await waitFor(() => second.writer() === true && first.writer() === false);
    const third = await attach(ownerToken, sessionId);
    await waitFor(() => third.writer() === true && second.writer() === false);

    // writer(셋째)가 떠난다 — 남은 것 중 가장 최근(둘째)이 승계해야 한다. 첫째가
    // 받으면 "마지막 attach 가 writer" 가 이탈 경로에서 뒤집힌 것이다.
    third.close();
    await waitFor(() => second.writer() === true);
    expect(first.writer()).toBe(false);

    // 승계한 창의 입력이 실제로 흐른다 — 통지만 오고 게이트가 안 열리면 반쪽이다.
    second.type(Buffer.from('heir\r', 'utf8'));
    await waitFor(() => inputBytes(runner).length > 0);
    expect(inputBytes(runner)[0]!.toString('utf8')).toBe('heir\r');

    first.close();
    second.close();
    await runner.close();
  });
});

describe('#315-6 소유자도 admin 도 아니면 읽기도 못 한다 (#141 게이트 유지)', () => {
  it('제3자는 attach 인가에서 403 이고 티켓 자체를 못 받는다', async () => {
    const sessionId = 'sess-input-stranger';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
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

describe('#315-7 감사에 누가·언제·몇 바이트만 남고 내용은 남지 않는다', () => {
  it('detach 행 전체를 문자열로 만들어도 타이핑한 값이 그 안에 없다', async () => {
    const sessionId = 'sess-input-audit';
    const secret = 'sk-live-0123456789abcdef';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    viewer.type(Buffer.from(secret, 'utf8'));
    // 러너에 닿은 것을 확인한 뒤 detach 한다 — 개입 사실은 detach 행에만 남는다(#346).
    await waitFor(() => inputBytes(runner).length === 1);
    viewer.close();
    await waitForAsync(async () => (await detachedAuditRows(sessionId)).length > 0);

    const rows = await detachedAuditRows(sessionId);
    // 남아야 하는 사실: 누가(actorId), 언제(at), 어느 턴에(sessionId), 몇 바이트(inputBytes).
    expect(rows[0]!.actorId).toBe(ownerId);
    expect(Date.parse(rows[0]!.at)).not.toBeNaN();
    // 바이트 **수**가 실제 전송량과 일치한다 — 디코드 없이 base64 길이 산술로 센 값이다.
    expect(rows[0]!.detail).toEqual({ sessionId, inputBytes: Buffer.byteLength(secret, 'utf8') });

    // **행 전체를 문자열로 만들어 검사한다.** "detail 에 그 키가 없다"로 단언하면 필드
    // 이름이 바뀌는 순간 아무것도 안 지키는 테스트가 된다. 원문과 base64 둘 다 본다 —
    // 이 파이프의 값은 base64 로 오가므로, 그대로 복사한 결함은 원문 검색에 안 걸린다.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(Buffer.from(secret, 'utf8').toString('base64'));

    await runner.close();
  });
});

describe('#315-8 연타가 감사 행을 폭증시키지 않는다', () => {
  it('한 attach 소켓의 입력 전부가 detach 행 하나의 합산으로 남는다', async () => {
    const sessionId = 'sess-input-burst';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    // 사람이 한 줄을 치는 것과 같은 모양 — 키 하나에 프레임 하나다. 멀티바이트를 섞는다:
    // 합산이 base64 길이 산술로 정확하려면 한글(3바이트)도 제대로 세어야 한다.
    const typed = 'yes, 좋다\r';
    for (const ch of typed) viewer.type(Buffer.from(ch, 'utf8'));
    const frameCount = [...typed].length;
    await waitFor(() => inputBytes(runner).length === frameCount);

    // **바이트는 하나도 안 묶였다.** 합산되는 것은 감사뿐이고, PTY 에는 전부 가야 한다 —
    // 여기서 바이트가 줄면 사람이 친 것이 사라진 것이다.
    expect(inputBytes(runner)).toHaveLength(frameCount);

    viewer.close();
    await waitForAsync(async () => (await detachedAuditRows(sessionId)).length > 0);

    // 행은 **하나**다 — 키 입력마다(또는 시간 창마다) 행을 만들면 행 타임스탬프가 곧
    // 키 입력의 리듬이라 그 자체가 부채널이다(스펙 §5-2 결정 3).
    const rows = await detachedAuditRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail.inputBytes).toBe(Buffer.byteLength(typed, 'utf8'));

    await runner.close();
  });

  it('아무것도 안 친 뷰어의 detach 행은 inputBytes 0 이다 — 관찰과 개입이 구분된다', async () => {
    const sessionId = 'sess-input-zero';
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session(sessionId)], caps: ['input', 'interactive'] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    viewer.close();
    await waitForAsync(async () => (await detachedAuditRows(sessionId)).length > 0);

    // 0 이 명시적으로 남아야 감사 조회가 "붙어서 보기만 했다"와 "붙어서 쳤다"를 가른다.
    expect((await detachedAuditRows(sessionId))[0]!.detail.inputBytes).toBe(0);

    await runner.close();
  });
});

describe('#315-9 소유자가 admin 이어도 자기 에이전트에는 칠 수 있다', () => {
  it('admin 이면서 그 에이전트의 소유자인 사람도 writer 통지를 받고 바이트가 러너에 도착한다', async () => {
    // **이 조합이 기본값이다.** 에이전트를 만들 수 있는 것은 admin 뿐이고
    // (`POST /accounts/agents` 는 `requireAdmin`), 만든 사람이 그대로 소유자가 된다.
    // 그래서 "소유자가 admin 이기도 하다"는 예외가 아니라 새 에이전트의 **출발 상태**다.
    //
    // writer 규칙(#346)으로 오면서 "admin 은 읽기 전용" 판정 자체가 사라졌으므로 이
    // 회귀선의 뜻은 좁아졌다: attach 인가를 통과한 사람이 혼자 붙어 있으면 — 그가
    // admin 이든 소유자든 — 차례가 그에게 온다. 이 조합이 죽으면 갓 만든 에이전트의
    // 터미널에 칠 수 있는 사람이 한 명도 없다(#338 이 잡은 사고의 재발 방지선).
    const sessionId = 'sess-input-adminowner';
    const runner = await connectRunner(adminOwnedAgentPat);
    runner.send({
      type: 'announce',
      sessions: [{ ...session(sessionId), agentAccountId: adminOwnedAgentId }],
      caps: ['input', 'interactive'],
    });
    await waitForAsync(async () => {
      const res = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(adminToken) });
      return (res.json().sessions as AgentSessionView[]).some((s) => s.sessionId === sessionId);
    });

    const viewer = await attach(adminToken, sessionId);
    await waitFor(() => viewer.writer() === true);

    viewer.type(TYPED);
    await waitFor(() => inputBytes(runner).length === 1);
    expect(inputBytes(runner)[0]!.equals(TYPED)).toBe(true);

    viewer.close();
    await runner.close();
  });
});

describe('#346 caps 없는 구 러너에는 입력이 조용히 사라지지 않는다', () => {
  it('caps 를 선언하지 않은 러너의 세션에서는 writer:false 만 오고, 그래도 친 input 은 포워딩되지 않는다', async () => {
    const sessionId = 'sess-input-nocaps';
    const runner = await connectRunner(agentPat);
    // 구 러너 흉내 — caps 필드 자체가 없다. 이 러너는 input 프레임을 받아도 버린다.
    runner.send({ type: 'announce', sessions: [session(sessionId)] });
    await waitForSession(sessionId);

    const viewer = await attach(ownerToken, sessionId);
    // 차례를 주는 대신 읽기 전용임을 바로 알린다 — 차례를 주면 사람은 쳤다고 믿는데
    // 러너가 조용히 버린다: "안 되는 것"이 고장처럼 보이는 정확히 그 모양이다.
    await waitFor(() => viewer.writer() === false);

    // 화면 가드를 우회해 소켓에 직접 쓴다 — 서버가 포워딩하지 않아야 한다.
    viewer.type(TYPED);
    // "영영 안 온다"를 확인하려고 반대 방향 신호를 세울 수 없으므로(구 러너는 아무
    // 능력도 없다) 여기서만 예외적으로 짧은 고정 대기를 쓴다.
    await new Promise((r) => setTimeout(r, 300));
    expect(inputBytes(runner)).toEqual([]);

    // 개입이 없었으므로 detach 감사의 합산도 0 이어야 한다 — 포워딩 안 된 바이트를
    // 세면 감사가 "개입했다"고 거짓말한다.
    viewer.close();
    await waitForAsync(async () => (await detachedAuditRows(sessionId)).length > 0);
    expect((await detachedAuditRows(sessionId))[0]!.detail.inputBytes).toBe(0);

    await runner.close();
  });
});
