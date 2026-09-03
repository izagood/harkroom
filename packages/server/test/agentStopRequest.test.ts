// 러너 종료 요청(#129 두 번째 절반). **재시작이 아니다** — murmur 는 러너를 띄우지 않으므로
// 서버가 할 수 있는 것은 정의에 시각을 남기고, 러너가 그것을 읽어 갔는지까지 관측하는 것뿐이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listAudit } from '../src/audit.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let plainToken: string;

// 시나리오마다 에이전트를 나눈다 — 한 마리로 다 하면 앞 테스트의 요청·수령이 뒤 테스트의
// 전제를 오염시켜 "다른 에이전트에는 안 온다"나 "요청되지도 않았다"를 증명할 수 없다.
let stopBot: { accountId: string; pat: string };
let ackBot: { accountId: string; pat: string };
let otherBot: { accountId: string; pat: string };
let guardBot: { accountId: string; pat: string };

/** 감사에 원문이 새지 않는지 보려면 감사에 절대 없어야 할 문자열이 정의에 있어야 한다. */
const SECRET_INSTRUCTIONS = '사내 비밀 저장소 secret-repo 를 우선 살펴본다';

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  stopBot = await createAgent(app, adminToken, 'stopbot');
  ackBot = await createAgent(app, adminToken, 'ackbot');
  otherBot = await createAgent(app, adminToken, 'otherbot');
  guardBot = await createAgent(app, adminToken, 'guardbot');

  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${stopBot.accountId}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { instructions: SECRET_INSTRUCTIONS },
  });

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'plainuser', loginId: 'plainuser', displayName: 'Plain User', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'plainuser', password: 'pw123456' },
  });
  plainToken = login.json().token as string;
});
afterAll(async () => { await app.close(); await stop(); });

const requestStop = (accountId: string, token = adminToken) => app.inject({
  method: 'POST', url: `/accounts/agents/${accountId}/stop`,
  headers: { authorization: `Bearer ${token}` },
});

/** 러너가 자기 정의를 읽는 것과 같은 호출 — 종료 요청은 이 응답을 타고 간다. */
const readOwnConfig = async (pat: string) => {
  const res = await app.inject({
    method: 'GET', url: '/agent/config', headers: { authorization: `Bearer ${pat}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { stopRequestedAt: string | null; stopAckedAt: string | null };
};

const adminView = async (accountId: string) => {
  const res = await app.inject({
    method: 'GET', url: '/accounts/agents', headers: { authorization: `Bearer ${adminToken}` },
  });
  const agents = res.json().agents as
    { id: string; stopRequestedAt: string | null; stopAckedAt: string | null }[];
  return agents.find((a) => a.id === accountId)!;
};

describe('러너 종료 요청 (#129)', () => {
  it('종료를 요청하면 그 에이전트의 GET /agent/config 응답에 stopRequestedAt 이 온다', async () => {
    const before = await readOwnConfig(stopBot.pat);
    expect(before.stopRequestedAt).toBeNull();

    const res = await requestStop(stopBot.accountId);
    expect(res.statusCode).toBe(200);

    // 러너가 다음 턴에 자기 정의를 읽으면 요청이 실려 온다 — 새 채널이 아니라 이 경로다.
    const def = await readOwnConfig(stopBot.pat);
    expect(def.stopRequestedAt).not.toBeNull();
  });

  it('러너가 그것을 읽어 가면 stopAckedAt 이 남는다', async () => {
    await requestStop(ackBot.accountId);
    // 요청 직후에는 아직 아무도 읽어 가지 않았다 — 이 구분이 없으면 화면이 '멈췄다'고 단정한다.
    expect((await adminView(ackBot.accountId)).stopAckedAt).toBeNull();

    const def = await readOwnConfig(ackBot.pat);
    expect(def.stopAckedAt).not.toBeNull();
    const acked = (await adminView(ackBot.accountId)).stopAckedAt;
    expect(acked).not.toBeNull();

    // 두 번째로 읽어도 수령 시각은 밀리지 않는다 — 밀리면 "언제 도달했나"가 아니라
    // "러너가 마지막으로 정의를 읽은 시각"이 되어 버린다.
    await readOwnConfig(ackBot.pat);
    expect((await adminView(ackBot.accountId)).stopAckedAt).toBe(acked);
  });

  it('다른 에이전트의 정의에는 그 값이 오지 않는다', async () => {
    const def = await readOwnConfig(otherBot.pat);
    expect(def.stopRequestedAt).toBeNull();
    expect(def.stopAckedAt).toBeNull();
  });

  it('admin 이 아니면 403 이고 실제로 요청되지도 않는다', async () => {
    const res = await requestStop(guardBot.accountId, plainToken);
    expect(res.statusCode).toBe(403);
    // 403 을 주고도 요청이 남으면 가드가 아니다 — 러너는 그 요청을 그대로 집어 간다.
    expect((await adminView(guardBot.accountId)).stopRequestedAt).toBeNull();
    expect((await readOwnConfig(guardBot.pat)).stopRequestedAt).toBeNull();
  });

  it('감사에 기록이 남고, detail 에 지시문·본문이 들어가지 않는다', async () => {
    const entries = await listAudit(pool, { action: 'agent.stop.requested' });
    const mine = entries.find((e) => e.target === stopBot.accountId);
    expect(mine).toBeDefined();
    expect(mine!.actorHandle).toBe('admin');
    expect(mine!.detail).toEqual({ handle: 'stopbot' });
    // 지시문 원문이 감사에 복사되면 "지웠다"가 지운 것이 아니게 된다.
    expect(JSON.stringify(mine!.detail)).not.toContain(SECRET_INSTRUCTIONS);
  });
});
