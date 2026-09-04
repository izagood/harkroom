// #141 — 터미널 뷰어 소켓(`/agent-attach`)의 **수명**. `/ws` 와 같은 두 규칙을 지키는지 본다.
//
// 왜 별도 파일인가: 이 두 규칙은 서버를 다른 설정으로 띄워야 보인다(Origin 허용 목록,
// 짧은 재검증 주기). `agentRelay.test.ts` 의 앱에 그 설정을 얹으면 그 파일의 나머지
// 테스트가 전부 Origin·재검증을 지나게 되고, 무엇이 무엇을 지키는지 흐려진다.
//
// 왜 지켜야 하는가: attach 티켓은 처음부터 `credentialHash` 를 운반했지만 아무도 읽지
// 않았다. 그래서 로그인 세션이 만료되거나 PAT 가 폐기된 뒤에도, 열려 있던 터미널 패널로
// PTY 바이트가 계속 흘렀다 — 그 바이트에는 하네스가 화면에 그린 모든 것(토큰, 환경변수,
// 사람이 붙여 넣은 비밀)이 들어 있으므로, 이벤트 소켓보다 느슨해서는 안 된다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { AgentSessionView, AttachServerFrame } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let ownerToken: string;
let agentPat: string;
let baseUrl: string;
let runner: WebSocket;

const ALLOWED = 'tauri://localhost';
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// 이 파일은 attach 수명(티켓·인가·재접속)만 본다 — writer 차례는 agentInput 쪽이다.
// `acceptsInput: true`(인터랙티브 턴)로 두어, 수명 검증이 #369 의 판정에 흔들리지 않게 한다.
const session = (sessionId: string, agentAccountId: string): AgentSessionView => ({
  sessionId, agentAccountId, channelId: 'chan-1', threadRootId: null,
  harness: 'claude-code', startedAt: '2026-09-04T00:00:00.000Z', acceptsInput: true,
});

const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** attach 인가를 받아 티켓 하나를 얻는다. */
async function attachTicket(token: string, sessionId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/agent-sessions/${sessionId}/attach`, headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  return res.json().ticket as string;
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({
    pool,
    corsOrigins: [ALLOWED],
    // 실제 기본은 60초다. 재검증 한 바퀴를 실제로 보려면 짧아야 한다.
    wsRevalidateMs: 50,
  });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
  const created = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'owner', loginId: 'owner', displayName: 'owner', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const ownerId = created.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'owner', password: 'pw123456' },
  });
  ownerToken = login.json().token as string;

  const agent = await createAgent(app, adminToken, 'forge');
  agentPat = agent.pat;
  const patched = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${agent.accountId}`, headers: auth(adminToken),
    payload: { ownerAccountId: ownerId },
  });
  expect(patched.statusCode).toBe(200);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';

  // 러너 하나가 세션 두 개를 announce 한다. 테스트마다 티켓을 따로 받으므로(1회용) 세션도
  // 따로 쓴다 — 하나를 공유하면 앞 테스트가 소켓을 닫은 뒤 다음 테스트가 무엇을 보는지 흐려진다.
  runner = new WebSocket(`ws://${baseUrl}/agent-relay`, { headers: auth(agentPat) });
  await new Promise<void>((resolve, reject) => {
    runner.on('open', () => resolve());
    runner.on('error', reject);
  });
  runner.send(JSON.stringify({
    type: 'announce',
    sessions: [session('life-1', agent.accountId), session('life-2', agent.accountId)],
  }));
  // announce 가 반영됐는지 목록으로 확인한다 — 고정 지연으로 갈음하면 느린 머신에서
  // 이 파일이 자기 이유 없이 빨개진다.
  const seen = async () => {
    const res = await app.inject({ method: 'GET', url: '/agent-sessions', headers: auth(ownerToken) });
    return (res.json().sessions as AgentSessionView[]).length === 2;
  };
  const start = Date.now();
  while (!(await seen())) {
    if (Date.now() - start > 4000) throw new Error('announce timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
});
afterAll(async () => { runner.close(); await app.close(); await stop(); });

describe('#141 뷰어 소켓의 Origin 허용 목록', () => {
  it('목록 밖의 Origin 이면 핸드셰이크를 거절한다', async () => {
    // WS 핸드셰이크는 CORS 의 보호를 받지 않는다 — 이벤트 소켓만 막고 터미널 소켓을
    // 열어 두면 더 민감한 쪽(PTY 바이트)이 더 느슨해진다.
    const socket = new WebSocket(
      `ws://${baseUrl}/agent-attach?ticket=${await attachTicket(ownerToken, 'life-1')}`,
      { headers: { origin: 'https://evil.example' } },
    );
    // 거절을 **기다리다 굶지 않는다**: 판정이 없으면 소켓은 그냥 열려 있고 이 약속은
    // 안 풀린다 — 파일 타임아웃(2분)으로만 빨개지면 무엇이 깨졌는지가 로그에서 사라진다.
    const code = await Promise.race([
      new Promise<number>((resolve) => {
        socket.on('close', (c) => resolve(c));
        socket.on('error', () => { /* close 로 판정한다 */ });
      }),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3_000)),
    ]);
    expect(code).toBe(4403);
  });

  it('허용된 Origin 과 Origin 부재는 붙는다', async () => {
    for (const headers of [{ origin: ALLOWED }, {}]) {
      const socket = new WebSocket(
        `ws://${baseUrl}/agent-attach?ticket=${await attachTicket(ownerToken, 'life-1')}`,
        { headers },
      );
      const frames: AttachServerFrame[] = [];
      socket.on('message', (d) => frames.push(JSON.parse(String(d)) as AttachServerFrame));
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      await waitFor(() => frames.length > 0);
      expect(frames[0]).toEqual({ type: 'status', state: 'running' });
      socket.close();
    }
  });
});

describe('#141 뷰어 소켓의 수명은 자격증명을 따른다', () => {
  it('세션이 만료되면 열려 있던 터미널 소켓이 닫히고 바이트가 더 오지 않는다', async () => {
    const socket = new WebSocket(
      `ws://${baseUrl}/agent-attach?ticket=${await attachTicket(ownerToken, 'life-2')}`,
    );
    const frames: AttachServerFrame[] = [];
    socket.on('message', (d) => frames.push(JSON.parse(String(d)) as AttachServerFrame));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    await waitFor(() => frames.length > 0);

    // 붙어 있는 동안에는 바이트가 온다 — 이 확인이 없으면 아래의 "더 오지 않는다"가
    // "애초에 오지 않았다"로도 초록이 된다.
    runner.send(JSON.stringify({ type: 'replay', sessionId: 'life-2', data: Buffer.from('전').toString('base64') }));
    await waitFor(() => frames.some((f) => f.type === 'output'));
    const before = frames.filter((f) => f.type === 'output').length;

    // 닫힘을 **기다리다 굶지 않는다**: 감시가 없으면 이 약속은 영원히 안 풀리고, 그러면
    // 파일 타임아웃(2분)으로만 빨개져 무엇이 깨졌는지가 로그에서 사라진다.
    const closed = Promise.race([
      new Promise<number>((resolve) => socket.on('close', (c) => resolve(c))),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3_000)),
    ]);
    // 이 사람의 로그인 세션이 죽는다(로그아웃·만료·비밀번호 재설정이 모두 이 모양이다).
    await pool.query(`update session set expires_at = now() - interval '1 day'`);
    expect(await closed).toBe(4401);

    // 닫힌 뒤에는 러너가 보내도 이 소켓으로 가지 않는다.
    runner.send(JSON.stringify({ type: 'output', sessionId: 'life-2', data: Buffer.from('후').toString('base64') }));
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.filter((f) => f.type === 'output').length).toBe(before);
  });
});
