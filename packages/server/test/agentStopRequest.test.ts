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
// #427 되돌리기용. 여기도 시나리오마다 나눈다 — 되돌리기는 앞 테스트가 남긴 요청·수령을
// 지우는 조작이라, 한 마리를 공유하면 어느 테스트가 무엇을 지웠는지 알 수 없게 된다.
let undoBot: { accountId: string; pat: string };
let undoAckBot: { accountId: string; pat: string };
let undoGuardBot: { accountId: string; pat: string };
let neverBot: { accountId: string; pat: string };

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
  undoBot = await createAgent(app, adminToken, 'undobot');
  undoAckBot = await createAgent(app, adminToken, 'undoackbot');
  undoGuardBot = await createAgent(app, adminToken, 'undoguardbot');
  neverBot = await createAgent(app, adminToken, 'neverbot');

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

/** #427: 그 요청을 되돌린다. 요청과 **같은 관문**(requireAdmin)이어야 한다. */
const undoStop = (accountId: string, token = adminToken) => app.inject({
  method: 'POST', url: `/accounts/agents/${accountId}/stop/undo`,
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

/**
 * 종료 요청 되돌리기(#427).
 *
 * 한 번 누른 요청을 되돌리는 길이 없어서 그 에이전트가 앱 자동 기동에서 **영구히** 빠졌다.
 * DB 를 손으로 고쳐야 풀렸고, 그 우회는 감사에 아무것도 남기지 않는다.
 *
 * 자동 기동 필터 자체(`runnerLauncher.startAll` 의 `!a.stopRequestedAt`)는 앱에 있으므로
 * 여기서 재는 것은 **서버가 그 필터에 무엇을 먹이는가**다 — 되돌린 뒤 `stopRequestedAt` 이
 * null 이면 그 필터가 다시 고른다. 필터가 실제로 다시 고르는지는 desktop 쪽 회귀선이 잰다.
 */
describe('종료 요청 되돌리기 (#427)', () => {
  it('되돌리면 stopRequestedAt 이 사라져 자동 기동 필터가 다시 고른다', async () => {
    await requestStop(undoBot.accountId);
    expect((await adminView(undoBot.accountId)).stopRequestedAt).not.toBeNull();

    const res = await undoStop(undoBot.accountId);
    expect(res.statusCode).toBe(200);
    // 응답이 곧 갱신된 정의다 — 목록을 다시 받지 않고도 화면이 지워진 사실을 그린다.
    expect((res.json() as { stopRequestedAt: string | null }).stopRequestedAt).toBeNull();
    expect((await adminView(undoBot.accountId)).stopRequestedAt).toBeNull();

    // 러너가 자기 정의를 읽어도 요청이 실려 오지 않는다 — 지운 것이 러너에게까지 닿는다.
    expect((await readOwnConfig(undoBot.pat)).stopRequestedAt).toBeNull();
  });

  it('되돌리면 stop_acked_at 도 함께 지워진다', async () => {
    await requestStop(undoAckBot.accountId);
    // 러너가 읽어 가게 해서 수령까지 만들어 둔다 — 이것이 없으면 '함께 지운다'를 못 잰다.
    await readOwnConfig(undoAckBot.pat);
    expect((await adminView(undoAckBot.accountId)).stopAckedAt).not.toBeNull();

    await undoStop(undoAckBot.accountId);

    // **요청만 지우고 수령을 남기면 화면이 거짓을 말한다** — 세 상태(요청 없음 / 못 봄 /
    // 받아 감) 어디에도 속하지 않는 행이 되고, 화면은 있지도 않은 요청에 대한 수령을 그린다.
    const after = await adminView(undoAckBot.accountId);
    expect(after.stopRequestedAt).toBeNull();
    expect(after.stopAckedAt).toBeNull();
  });

  it('되돌린 뒤 러너가 정의를 읽어도 수령이 다시 찍히지 않는다', async () => {
    // accountRoutes 의 `stopRequestedAt && !stopAckedAt` 분기가 되돌린 뒤 거짓이 되는지.
    // 여기가 살아 있으면 '요청 없이 수령만 있는 행'이 다시 만들어진다.
    const def = await readOwnConfig(undoAckBot.pat);
    expect(def.stopRequestedAt).toBeNull();
    expect(def.stopAckedAt).toBeNull();
    expect((await adminView(undoAckBot.accountId)).stopAckedAt).toBeNull();
  });

  it('admin 이 아니면 403 이고 요청은 그대로 남는다', async () => {
    await requestStop(undoGuardBot.accountId);
    const requestedAt = (await adminView(undoGuardBot.accountId)).stopRequestedAt;
    expect(requestedAt).not.toBeNull();

    const res = await undoStop(undoGuardBot.accountId, plainToken);
    expect(res.statusCode).toBe(403);
    // 403 을 주고도 지워지면 가드가 아니다 — 되돌리기가 요청보다 느슨하면 종료 요청은
    // 남에게 강제할 수 없는 부탁이 된다.
    expect((await adminView(undoGuardBot.accountId)).stopRequestedAt).toBe(requestedAt);
  });

  it('요청이 없던 에이전트를 되돌려도 200 이고, 아무 값도 생기지 않는다', async () => {
    // "요청이 아예 없었다"는 "에이전트가 없다"와 **다른 사건**이다 — 404 로 돌려주면
    // 화면이 "그런 에이전트가 없다"고 거짓을 말한다. 부르는 쪽이 원한 상태가 이미
    // 성립해 있으므로 실패가 아니다.
    const res = await undoStop(neverBot.accountId);
    expect(res.statusCode).toBe(200);
    const after = await adminView(neverBot.accountId);
    expect(after.stopRequestedAt).toBeNull();
    expect(after.stopAckedAt).toBeNull();
  });

  it('없는 에이전트는 404 다 — 요청 없음과 구분된다', async () => {
    const res = await undoStop('00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('되돌린 사실이 감사에 남고, 되돌린 대상 요청 시각이 함께 남는다', async () => {
    const entries = await listAudit(pool, { action: 'agent.stop.undone' });
    const mine = entries.find((e) => e.target === undoBot.accountId);
    expect(mine).toBeDefined();
    expect(mine!.actorHandle).toBe('admin');
    // 요청 시각은 이 조작으로 정의에서 사라졌다 — 그 뒤로는 감사만이 "무엇을 되돌렸나"를
    // 답할 수 있으므로 detail 에 남긴다.
    expect(mine!.detail).toMatchObject({ handle: 'undobot' });
    expect((mine!.detail as { stopRequestedAt?: string }).stopRequestedAt).toBeTruthy();
    expect(JSON.stringify(mine!.detail)).not.toContain(SECRET_INSTRUCTIONS);
  });

  it('되돌릴 것이 없던 호출은 감사에 남지 않는다', async () => {
    // 아무 일도 일어나지 않은 호출까지 쌓으면 감사가 "이 러너를 누가 다시 돌게 했나"를
    // 답하지 못하는 잡음이 된다 — PATCH 가 값이 실제로 바뀐 것만 남기는 것과 같은 규칙.
    const entries = await listAudit(pool, { action: 'agent.stop.undone' });
    expect(entries.find((e) => e.target === neverBot.accountId)).toBeUndefined();
  });

  it('되돌린 사람이 stop_requested_by 로 남는다', async () => {
    // **누가 되돌렸는지도 사실이다.** 019 주석이 이 컬럼을 둔 이유는 "정의 옆에 행위자가
    // 있어야 이 한 행만 보고 답할 수 있다"였고, 되돌린 뒤 그 행이 답할 질문은 뒤집힌다 —
    // "이 러너가 왜 다시 뜨나". 요청자를 남겨 두면 행이 "이 사람이 세웠다"고 말하는데
    // 실제로는 도는 상태가 되어, 이 컬럼이 없애려던 오독이 되살아난다.
    const me = await app.inject({
      method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${adminToken}` },
    });
    const adminId = (me.json() as { id: string }).id;
    const row = await pool.query(
      'select stop_requested_by from agent_config where account_id = $1', [undoBot.accountId],
    );
    expect(row.rows[0].stop_requested_by).toBe(adminId);
  });
});
