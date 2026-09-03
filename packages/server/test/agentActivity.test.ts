// 에이전트가 마지막으로 턴을 마친 시각(#176). **생존 신호가 아니다** — 그것은 #124 의
// 인메모리 presence 가 답하고(mcp/presence.ts), 여기 값은 "마지막으로 언제 움직였나" 하나다.
//
// 이 파일이 지키는 경계 셋:
//  - 시각은 **서버가** 찍는다(러너가 보낸 값은 무시한다). 러너 시계가 앞선 머신에서
//    "3분 뒤에 활동함"이 화면에 뜨는 것을 막는 유일한 장치다.
//  - 자기 행만 갱신한다(라우트가 대상 id 를 받지 않는다).
//  - 사람 계정에는 뜻이 없다 — 400 이고, 거절했으면 아무것도 쓰지 않는다.
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
let humanToken: string;
let humanId: string;

// 시나리오마다 에이전트를 나눈다 — 한 마리로 다 하면 앞 테스트의 보고가 뒤 테스트의
// 전제를 오염시켜 "한 번도 안 돌린 에이전트는 null 이다"를 증명할 수 없다.
let actor: { accountId: string; pat: string };
let bystander: { accountId: string; pat: string };
let virgin: { accountId: string; pat: string };
let clockBot: { accountId: string; pat: string };

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  actor = await createAgent(app, adminToken, 'actorbot');
  bystander = await createAgent(app, adminToken, 'bystanderbot');
  virgin = await createAgent(app, adminToken, 'virginbot');
  clockBot = await createAgent(app, adminToken, 'clockbot');

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'humanuser', displayName: 'Human User', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  humanId = reg.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle: 'humanuser', password: 'pw123456' },
  });
  humanToken = login.json().token as string;
});
afterAll(async () => { await app.close(); await stop(); });

/** 러너가 턴을 마치고 부르는 것과 같은 호출. 본문이 없다 — 시각은 서버가 찍는다. */
const report = (token: string, payload?: unknown) => app.inject({
  method: 'POST', url: '/agent/activity',
  headers: { authorization: `Bearer ${token}` },
  ...(payload === undefined ? {} : { payload }),
});

/** 운영자 화면이 보는 것과 같은 뷰. 화면과 러너가 같은 값을 봐야 한다. */
const adminView = async (accountId: string) => {
  const res = await app.inject({
    method: 'GET', url: '/accounts/agents', headers: { authorization: `Bearer ${adminToken}` },
  });
  const agents = res.json().agents as { id: string; lastTurnAt: string | null }[];
  return agents.find((a) => a.id === accountId)!;
};

describe('에이전트 마지막 활동 시각 (#176)', () => {
  it('턴을 마쳤다고 보고하면 AgentView.lastTurnAt 이 채워진다', async () => {
    // 보고 전에는 아직 아무 활동도 없다 — 이 전제가 없으면 아래 단언이 무엇을 증명하는지 모른다.
    expect((await adminView(actor.accountId)).lastTurnAt).toBeNull();

    const res = await report(actor.pat);
    expect(res.statusCode).toBe(200);

    expect((await adminView(actor.accountId)).lastTurnAt).not.toBeNull();
  });

  it('러너가 보낸 시각이 아니라 서버 시각이다 — 본문의 미래 시각은 무시된다', async () => {
    // 시계가 크게 앞선 러너를 흉내낸다. 이 값을 그대로 저장하면 화면에 "76년 뒤에 활동함"이 뜬다.
    const bogus = '2099-01-01T00:00:00.000Z';
    const before = Date.now();
    const res = await report(clockBot.pat, { lastTurnAt: bogus, at: bogus, timestamp: bogus });
    expect(res.statusCode).toBe(200);
    const after = Date.now();

    const stored = (await adminView(clockBot.accountId)).lastTurnAt;
    expect(stored).not.toBeNull();
    const storedMs = new Date(stored!).getTime();
    expect(storedMs).not.toBe(new Date(bogus).getTime());
    // 서버가 now() 를 찍었다면 이 요청이 도는 동안의 시각이어야 한다. 여유(60초)는 DB·프로세스
    // 시계 오차용이고, 위 단언이 "미래 값이 그대로 저장되지 않았다"를 이미 못박는다.
    expect(storedMs).toBeGreaterThanOrEqual(before - 60_000);
    expect(storedMs).toBeLessThanOrEqual(after + 60_000);
  });

  it('사람 계정은 400 이고 아무것도 바뀌지 않는다', async () => {
    const res = await report(humanToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_account');
    // 400 을 주고도 행을 만들면 가드가 아니다 — 사람 계정에 에이전트 정의가 생긴다.
    const rows = await pool.query('select 1 from agent_config where account_id = $1', [humanId]);
    expect(rows.rowCount).toBe(0);
  });

  it('한 에이전트의 보고가 다른 에이전트의 값을 바꾸지 않는다', async () => {
    expect((await adminView(bystander.accountId)).lastTurnAt).toBeNull();

    await report(actor.pat);

    // 라우트가 대상 id 를 받지 않는다는 것의 실제 의미: 남의 활동 시각은 쓸 수 없다.
    expect((await adminView(bystander.accountId)).lastTurnAt).toBeNull();
  });

  it('한 번도 턴을 돌리지 않은 에이전트는 null 이다 (필드가 빠지지 않는다)', async () => {
    const view = await adminView(virgin.accountId);
    expect(view.lastTurnAt).toBeNull();
    // 키 자체가 있어야 한다 — 빠지면 화면이 '활동 없음'과 '서버가 이 사실을 모른다'를
    // 구분할 수 없다(backfill 하지 않는 이유가 그것이다).
    expect('lastTurnAt' in view).toBe(true);
  });

  it('감사 로그에 쌓지 않는다 — 매 턴 일어나는 일이다', async () => {
    // 감사에 쌓으면 권한을 바꾼 조작이 활동 보고에 묻혀 사람이 읽을 수 없게 된다.
    const entries = await listAudit(pool, {});
    expect(entries.some((e) => e.action.startsWith('agent.activity'))).toBe(false);
  });
});
