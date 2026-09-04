// #141 Phase 2 — 진행 중인 에이전트 터미널 릴레이(스펙 §5). 서버 쪽 회귀선.
//
// 실제 소켓을 태운다(`app.listen` + `ws` 클라이언트). 인메모리 허브만 단위로 검증하면
// 이 기능의 절반 — PAT 헤더 인증, 티켓 소모, 업그레이드 거절 — 이 통째로 빠진다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView, AttachServerFrame, RelayRunnerFrame, RelayServerFrame } from '@murmur/shared';
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
 * PTY 출력을 흉내낸 바이트열. **일부러 두 가지를 섞었다**:
 * - ANSI 이스케이프(`\x1b[31m` …): 문자열로 왕복하면 살아남지만, 어떤 정규화든 걸리면 깨진다.
 * - **잘린 UTF-8**(`\xed\x95` — '한'(U+D55C)의 3바이트 중 앞 2바이트): 서버가 어디서든
 *   `toString('utf8')` 을 한 번만 해도 U+FFFD(`ef bf bd`)로 치환돼 **되돌릴 수 없다.**
 *   청크 경계에서 문자가 잘리는 것은 터미널 중계의 정상 상태이므로(pty.ts 의 RingBuffer
 *   주석) 이 바이트열이 그대로 도착하는 것이 계약이다.
 */
const RAW_BYTES = Buffer.concat([
  Buffer.from('\x1b[31mERR\x1b[0m \x1b]0;title\x07', 'binary'),
  Buffer.from([0x00, 0x07, 0xff, 0xfe]),
  Buffer.from([0xed, 0x95]),
]);

const REPLAY_BYTES = Buffer.from('\x1b[2J이전 화면', 'utf8');

interface FakeRunner {
  socket: WebSocket;
  /** 서버가 보낸 프레임들(주로 replay.request). */
  received: RelayServerFrame[];
  send(frame: RelayRunnerFrame): void;
  close(): Promise<void>;
}

/** 러너처럼 PAT 헤더로 `/agent-relay` 에 붙는다. */
async function connectRunner(pat: string): Promise<FakeRunner> {
  const socket = new WebSocket(`ws://${baseUrl}/agent-relay`, { headers: auth(pat) });
  const received: RelayServerFrame[] = [];
  socket.on('message', (d) => received.push(JSON.parse(String(d)) as RelayServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
    socket.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
  });
  return {
    socket, received,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => new Promise<void>((resolve) => { socket.on('close', () => resolve()); socket.close(); }),
  };
}

/** 업그레이드가 거절되면 HTTP 상태 코드를, 성공하면 0 을 준다. */
async function relayHandshakeStatus(headers: Record<string, string>): Promise<number> {
  const socket = new WebSocket(`ws://${baseUrl}/agent-relay`, { headers });
  return new Promise<number>((resolve) => {
    socket.on('open', () => { socket.close(); resolve(0); });
    socket.on('unexpected-response', (_req, res) => { socket.terminate(); resolve(res.statusCode ?? -1); });
    socket.on('error', () => resolve(-1));
  });
}

function session(overrides: Partial<AgentSessionView> = {}): AgentSessionView {
  return {
    sessionId: 'sess-1',
    agentAccountId: agentId,
    channelId: 'chan-1',
    threadRootId: 'root-1',
    harness: 'claude-code',
    startedAt: '2026-09-04T00:00:00.000Z',
    // 기본은 인터랙티브 턴(#369) — 이 파일은 릴레이 프레임 왕복을 보고, writer 판정은
    // agentInput 쪽이 잰다. overrides 로 멘션 턴(false)도 만들 수 있다.
    acceptsInput: true,
    ...overrides,
  };
}

interface Viewer {
  socket: WebSocket;
  frames: AttachServerFrame[];
  close(): void;
}

/** attach 인가를 받고 뷰어 소켓을 연다. */
async function attach(token: string, sessionId: string): Promise<Viewer> {
  const res = await app.inject({
    method: 'POST', url: `/agent-sessions/${sessionId}/attach`, headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  const ticket = res.json().ticket as string;
  const socket = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${ticket}`);
  const frames: AttachServerFrame[] = [];
  socket.on('message', (d) => frames.push(JSON.parse(String(d)) as AttachServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return { socket, frames, close: () => socket.close() };
}

/**
 * announce 가 서버에 반영될 때까지 기다린다. **`setTimeout` 으로 갈음하지 않는다** —
 * 소켓 프레임 처리와 REST 요청은 서로 다른 경로라, 고정 지연으로 맞추면 느린 머신에서
 * 이 테스트가 자기 이유 없이 빨개진다.
 */
async function waitForSession(token: string, sessionId: string): Promise<void> {
  await waitForAsync(async () => {
    const res = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(token) });
    return (res.json().sessions as AgentSessionView[]).some((s) => s.sessionId === sessionId);
  });
}

/** 비동기 술어용. `waitFor` 와 합치지 않는다 — 한 함수로 뭉치면 await 를 빼먹어도 초록이다. */
const waitForAsync = async (pred: () => Promise<boolean>, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** 뷰어가 받은 output 프레임의 base64 를 바이트로 되돌린다. */
const outputBytes = (v: Viewer): Buffer[] =>
  v.frames.filter((f) => f.type === 'output').map((f) => Buffer.from(f.data, 'base64'));

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

describe('#141-1 러너 소켓의 인증', () => {
  it('에이전트 PAT 로는 붙는다', async () => {
    expect(await relayHandshakeStatus(auth(agentPat))).toBe(0);
  });

  it('자격증명이 없으면 401 이다', async () => {
    expect(await relayHandshakeStatus({})).toBe(401);
  });

  it('사람 계정의 세션 토큰이면 401 이다', async () => {
    // 인증은 통과하지만 kind 가 'human' 이다. 이 소켓은 세션을 announce 하는 자리이므로,
    // 아무 멤버나 "나는 에이전트 X 의 러너다"라고 주장할 수 있으면 목록이 위조된다.
    expect(await relayHandshakeStatus(auth(ownerToken))).toBe(401);
  });

  it('admin 이어도 사람 계정이면 401 이다', async () => {
    // isAdmin 이 러너 자격을 주지 않는다 — 러너는 계정 종류의 문제다.
    expect(await relayHandshakeStatus(auth(adminToken))).toBe(401);
  });
});

describe('#141-2 서버는 바이트를 변형하지 않는다', () => {
  it('ANSI 이스케이프와 잘린 UTF-8 을 포함한 바이트열이 그대로 도착한다', async () => {
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'raw-1' })] });
    await waitForSession(ownerToken, 'raw-1');

    const viewer = await attach(ownerToken, 'raw-1');
    // 재생 요청이 러너에 닿은 뒤에 재생으로 답한다 — 순서 보장은 테스트 3 이 본다.
    await waitFor(() => runner.received.some((f) => f.type === 'replay.request'));
    runner.send({ type: 'replay', sessionId: 'raw-1', data: '' });
    runner.send({ type: 'output', sessionId: 'raw-1', data: RAW_BYTES.toString('base64') });

    await waitFor(() => outputBytes(viewer).length >= 2);
    const live = outputBytes(viewer)[1]!;
    // 바이트 단위로 같아야 한다. 문자열로 비교하면 U+FFFD 치환이 양쪽에서 같이 일어나
    // 초록이 된다 — 이 테스트가 지키려는 것을 정확히 못 본다.
    expect(live.equals(RAW_BYTES)).toBe(true);
    // 치환이 일어났는지 직접도 확인한다: U+FFFD 의 UTF-8 은 `ef bf bd` 다.
    expect(live.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);

    viewer.close();
    await runner.close();
  });
});

describe('#141-3 attach 는 재생이 먼저다', () => {
  it('ring buffer 재생이 먼저 오고 그다음 실시간 바이트가 온다', async () => {
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'ord-1' })] });

    const viewer = await attach(ownerToken, 'ord-1');
    await waitFor(() => runner.received.some((f) => f.type === 'replay.request'));

    // **재생보다 라이브를 먼저 보낸다.** 서버가 뷰어별로 큐를 두지 않으면 이 순서가 그대로
    // 화면에 가고, xterm 이 최신 바이트를 먼저 그린 뒤 과거 화면으로 덮어쓴다.
    runner.send({ type: 'output', sessionId: 'ord-1', data: RAW_BYTES.toString('base64') });
    runner.send({ type: 'replay', sessionId: 'ord-1', data: REPLAY_BYTES.toString('base64') });

    await waitFor(() => outputBytes(viewer).length >= 2);
    const [first, second] = outputBytes(viewer);
    expect(first!.equals(REPLAY_BYTES)).toBe(true);
    expect(second!.equals(RAW_BYTES)).toBe(true);
    // 상태는 바이트보다 먼저 간다 — 화면이 "붙었다"를 그릴 근거다.
    expect(viewer.frames[0]).toEqual({ type: 'status', state: 'running' });

    viewer.close();
    await runner.close();
  });
});

describe('#141-4 attach 는 소유자·admin 만', () => {
  it('소유자도 admin 도 아니면 403 이다', async () => {
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'own-1' })] });
    await waitForSession(ownerToken, 'own-1');

    const res = await app.inject({
      method: 'POST', url: '/agent-sessions/own-1/attach', headers: auth(strangerToken),
    });
    expect(res.statusCode).toBe(403);

    // 소유자와 admin 은 통과한다 — 403 이 "아무도 못 붙는다"로 새는 것을 막는다.
    for (const token of [ownerToken, adminToken]) {
      const ok = await app.inject({
        method: 'POST', url: '/agent-sessions/own-1/attach', headers: auth(token),
      });
      expect(ok.statusCode).toBe(200);
    }
    await runner.close();
  });

  it('소유하지 않은 사람의 세션 목록은 비어 있다 — 403 이 아니라 부재다', async () => {
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'list-1' })] });
    // 소유자에게 보인다는 것을 먼저 확인한다 — 안 하면 아래의 빈 목록이 "아직 안 왔다"로도
    // 초록이 되어, 이 테스트가 소유자 필터를 전혀 지키지 않는다.
    await waitForSession(ownerToken, 'list-1');

    const theirs = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(strangerToken) });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().sessions).toEqual([]);

    await runner.close();
  });

  it('티켓은 발급받은 그 세션에만 쓴다', async () => {
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'tick-1' }), session({ sessionId: 'tick-2' })] });
    await waitForSession(ownerToken, 'tick-2');

    const res = await app.inject({
      method: 'POST', url: '/agent-sessions/tick-1/attach', headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const ticket = res.json().ticket as string;

    // 쿼리로 다른 세션을 요구해도 서버는 티켓에 박힌 세션만 본다 — 애초에 세션 id 를
    // 쿼리에서 읽지 않는다. 도착하는 것은 tick-1 의 바이트다.
    const socket = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${ticket}&session=tick-2`);
    const frames: AttachServerFrame[] = [];
    socket.on('message', (d) => frames.push(JSON.parse(String(d)) as AttachServerFrame));
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    await waitFor(() => runner.received.some((f) => f.type === 'replay.request' && f.sessionId === 'tick-1'));

    runner.send({ type: 'replay', sessionId: 'tick-1', data: '' });
    runner.send({ type: 'output', sessionId: 'tick-2', data: RAW_BYTES.toString('base64') });
    runner.send({ type: 'output', sessionId: 'tick-1', data: REPLAY_BYTES.toString('base64') });
    await waitFor(() => frames.filter((f) => f.type === 'output').length >= 2);
    const got = frames.filter((f) => f.type === 'output').map((f) => Buffer.from(f.data, 'base64'));
    expect(got.some((b) => b.equals(RAW_BYTES))).toBe(false);
    expect(got.some((b) => b.equals(REPLAY_BYTES))).toBe(true);

    socket.close();
    await runner.close();
  });

  it('한 번 쓴 티켓은 다시 쓰지 못한다', async () => {
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'once-1' })] });
    await waitForSession(ownerToken, 'once-1');
    const res = await app.inject({
      method: 'POST', url: '/agent-sessions/once-1/attach', headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const ticket = res.json().ticket as string;

    const first = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${ticket}`);
    await new Promise<void>((resolve) => first.on('open', () => resolve()));
    const second = new WebSocket(`ws://${baseUrl}/agent-attach?ticket=${ticket}`);
    const code = await new Promise<number>((resolve) => second.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);

    first.close();
    await runner.close();
  });
});

describe('#141-5 PTY 바이트는 DB 에 남지 않는다', () => {
  it('message·audit 어디에도 바이트가 없다', async () => {
    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'db-1' })] });

    const viewer = await attach(ownerToken, 'db-1');
    await waitFor(() => runner.received.some((f) => f.type === 'replay.request' && f.sessionId === 'db-1'));
    runner.send({ type: 'replay', sessionId: 'db-1', data: REPLAY_BYTES.toString('base64') });
    runner.send({ type: 'output', sessionId: 'db-1', data: RAW_BYTES.toString('base64') });
    await waitFor(() => outputBytes(viewer).length >= 2);

    viewer.close();
    await runner.close();

    // detach 감사가 소켓 close 뒤에 들어간다 — 그 행까지 포함해서 본다.
    await waitForAsync(async () => {
      const rows = await pool.query(`select 1 from audit_log where action = 'agent.detached'`);
      return Boolean(rows.rowCount);
    });

    const b64 = RAW_BYTES.toString('base64');
    const replayB64 = REPLAY_BYTES.toString('base64');

    const audit = await pool.query<{ action: string; detail: Record<string, unknown> }>(
      `select action, detail from audit_log`,
    );
    expect(audit.rows.some((r) => r.action === 'agent.attached')).toBe(true);
    expect(audit.rows.some((r) => r.action === 'agent.detached')).toBe(true);

    /**
     * **허용된 키를 못박는다.** 되돌려 RED 를 하다 알게 된 것: 바이트열을 문자열로 찾는
     * 것만으로는 부족했다 — 실제로 detail 에 스크롤백을 심어 봤는데, 그 바이트가 테스트가
     * 아는 정확한 바이트열이 아니면(현실에서는 언제나 그렇다) 이 테스트가 조용히 초록이
     * 됐다. 새 키가 하나라도 늘면 빨개지는 쪽이 실제로 무언가를 지킨다.
     */
    const allowed: Record<string, string[]> = {
      'agent.attached': ['sessionId', 'channelId'],
      // inputBytes 는 **수**다 — 개입 사실의 합산(#346, 스펙 §5-2 결정 3)이지 바이트
      // 내용이 아니다. 내용이 안 새는 것은 아래 바이트열 검색이 계속 지킨다.
      'agent.detached': ['sessionId', 'inputBytes'],
    };
    for (const row of audit.rows) {
      const keys = allowed[row.action];
      if (keys) expect(Object.keys(row.detail).sort()).toEqual([...keys].sort());
      // 아는 바이트열이 어디에도 없다는 것도 함께 본다 — 키 검사만으로는 기존 키에
      // 바이트를 담는 경우(sessionId 에 출력을 이어 붙이는 등)를 못 잡는다.
      const text = JSON.stringify(row.detail);
      for (const needle of [b64, replayB64, 'ERR']) {
        expect(text.includes(needle)).toBe(false);
      }
    }

    // 메시지 테이블에도 없다 — 릴레이가 이벤트 버스·발화 경로를 타지 않는다는 뜻이다.
    const messages = await pool.query(`select count(*)::int as n from message`);
    expect(messages.rows[0]!.n).toBe(0);
  });
});

describe('#141-6 러너 재접속 후에도 attach 가 이어진다', () => {
  it('재접속 러너의 announce 로 세션이 되살아나고 다시 붙을 수 있다', async () => {
    const first = await connectRunner(agentPat);
    first.send({ type: 'announce', sessions: [session({ sessionId: 'rc-1' })] });
    const before = await attach(ownerToken, 'rc-1');
    await waitFor(() => before.frames.length > 0);

    // 러너가 끊긴다(백오프 경로의 출발점). 뷰어는 '끝났다'가 아니라 '러너 연결 끊김'을
    // 받아야 한다 — 둘을 같게 말하면 사람이 기다릴지 포기할지 정할 수 없다.
    await first.close();
    await waitFor(() => before.frames.some((f) => f.type === 'status' && f.state === 'runner-offline'));
    // 러너가 없는 동안에는 attach 인가 자체가 404 다(세션이 없다).
    const gone = await app.inject({
      method: 'POST', url: '/agent-sessions/rc-1/attach', headers: auth(ownerToken),
    });
    expect(gone.statusCode).toBe(404);
    before.close();

    // 러너가 백오프 뒤 다시 붙어 같은 세션을 announce 한다.
    const second = await connectRunner(agentPat);
    second.send({ type: 'announce', sessions: [session({ sessionId: 'rc-1' })] });
    await waitForSession(ownerToken, 'rc-1');

    const after = await attach(ownerToken, 'rc-1');
    await waitFor(() => second.received.some((f) => f.type === 'replay.request' && f.sessionId === 'rc-1'));
    second.send({ type: 'replay', sessionId: 'rc-1', data: REPLAY_BYTES.toString('base64') });
    await waitFor(() => outputBytes(after).length >= 1);
    expect(outputBytes(after)[0]!.equals(REPLAY_BYTES)).toBe(true);

    after.close();
    await second.close();
  });
});

describe('#141-7 attach 는 턴의 권한을 바꾸지 않는다', () => {
  it('attach 전후로 mentionPermission 이 그대로다', async () => {
    // 스펙 §6: "멘션 턴에 attach 해도 그 턴의 모드는 바꿀 수 없다". 읽기만 하므로 자연히
    // 성립하지만, 그것이 **우연히** 성립하는 상태를 회귀선으로 고정한다 — 나중에 입력을
    // 열 때(별도 후속) 이 선이 빨개지는 것이 그 작업의 시작점이어야 한다.
    const before = await app.inject({
      method: 'GET', url: `/accounts/agents`, headers: auth(adminToken),
    });
    const defBefore = (before.json().agents as { id: string; mentionPermission: string }[])
      .find((a) => a.id === agentId)!;

    const runner = await connectRunner(agentPat);
    runner.send({ type: 'announce', sessions: [session({ sessionId: 'perm-1' })] });
    const viewer = await attach(ownerToken, 'perm-1');
    await waitFor(() => runner.received.some((f) => f.type === 'replay.request' && f.sessionId === 'perm-1'));
    runner.send({ type: 'replay', sessionId: 'perm-1', data: '' });
    await waitFor(() => outputBytes(viewer).length >= 1);
    viewer.close();
    await runner.close();

    const after = await app.inject({
      method: 'GET', url: `/accounts/agents`, headers: auth(adminToken),
    });
    const defAfter = (after.json().agents as { id: string; mentionPermission: string }[])
      .find((a) => a.id === agentId)!;
    expect(defAfter.mentionPermission).toBe(defBefore.mentionPermission);

    // 릴레이가 정의를 쓰는 표면 자체를 갖지 않는다는 것도 본다: attach 는 `agent_config`
    // 를 한 컬럼도 건드리지 않는다.
    const audit = await pool.query<{ action: string }>(
      `select action from audit_log where action = 'agent.updated' and target = $1`, [agentId],
    );
    // 셋업의 PATCH(소유자 지정) 하나뿐이어야 한다 — attach 가 하나를 더 만들면 안 된다.
    expect(audit.rowCount).toBe(1);
  });
});
