import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let plainToken: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'plainuser', displayName: 'Plain User', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle: 'plainuser', password: 'pw123456' },
  });
  plainToken = login.json().token as string;
});
afterAll(async () => { await app.close(); await stop(); });

const admin = () => ({ authorization: `Bearer ${adminToken}` });

const getDefaults = () =>
  app.inject({ method: 'GET', url: '/settings/agent-defaults', headers: admin() });

const putDefaults = (payload: object, headers = admin()) =>
  app.inject({ method: 'PUT', url: '/settings/agent-defaults', headers, payload });

const createAgentWith = (payload: object) =>
  app.inject({ method: 'POST', url: '/accounts/agents', headers: admin(), payload });

/**
 * harness 를 라우트가 아니라 SQL 로 심는 이유: `RUNNABLE_HARNESSES` 가 지금
 * `claude-code` 하나뿐이라, 라우트로는 스키마 기본값과 **다른** harness 를 기본값에
 * 넣을 수 없다. 그러면 "기본값이 복사됐다"와 "스키마 기본값이 그대로다"가 구분되지 않는다.
 * 검증되는 것은 라우트가 아니라 생성 경로의 복사 동작이므로 여기서는 DB 로 직접 심는다.
 */
const seedDefaults = (harness: string, model: string | null, effort: string | null) =>
  pool.query(`update agent_defaults set harness = $1, model = $2, effort = $3 where id = true`,
    [harness, model, effort]);

beforeEach(async () => { await seedDefaults('claude-code', null, null); });

let seq = 0;
const uniqueHandle = (prefix: string) => `${prefix}${(seq += 1)}`;

describe('새 에이전트의 기본값 (#171)', () => {
  it('기본값을 바꾼 뒤 harness 없이 만든 에이전트가 그 harness 를 갖는다', async () => {
    await seedDefaults('codex', 'sonnet-x', 'high');

    const res = await createAgentWith({ handle: uniqueHandle('inherit'), displayName: 'Inherit' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ harness: 'codex', model: 'sonnet-x', effort: 'high' });
  });

  // 서식은 요청을 이기지 못한다. 되돌리기 실험은 '기본값이 항상 이긴다'로 바꾸는 것이다 —
  // 변경 이전 상태(기본값 자체가 없음)로 되돌리면 이 단언은 그대로 초록이라 아무것도 지키지 않는다.
  it('요청이 준 값이 기본값을 이긴다 — 명시적 null 도 요청이 준 값이다', async () => {
    await seedDefaults('codex', 'sonnet-x', 'high');

    const res = await createAgentWith({
      handle: uniqueHandle('explicit'), displayName: 'Explicit',
      harness: 'claude-code', model: null,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().harness).toBe('claude-code');
    // model 을 명시적 null 로 준 것은 '이 에이전트는 harness 기본값을 쓴다'는 선택이다.
    expect(res.json().model).toBeNull();
    // effort 는 키 자체가 없었으므로 기본값이 채운다.
    expect(res.json().effort).toBe('high');
  });

  // 결정 1(복사본이지 참조가 아니다)의 회귀선. 참조였다면 운영자가 기본값을 고치는 순간
  // 돌고 있는 에이전트의 harness 가 중간에 바뀐다.
  it('기본값을 바꿔도 이미 만들어진 에이전트는 그대로다', async () => {
    await seedDefaults('claude-code', 'first-model', 'low');
    const created = await createAgentWith({ handle: uniqueHandle('frozen'), displayName: 'Frozen' });
    const id = created.json().id as string;

    await seedDefaults('codex', 'second-model', 'max');

    const after = await app.inject({ method: 'GET', url: '/accounts/agents', headers: admin() });
    const row = (after.json().agents as { id: string; harness: string; model: string | null; effort: string | null }[])
      .find((a) => a.id === id);
    expect(row).toMatchObject({ harness: 'claude-code', model: 'first-model', effort: 'low' });
  });

  it('model 에 명시적 null 을 주면 실제로 지워진다', async () => {
    await putDefaults({ model: 'sonnet-x' });
    expect((await getDefaults()).json().model).toBe('sonnet-x');

    const cleared = await putDefaults({ model: null });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().model).toBeNull();
    expect((await getDefaults()).json().model).toBeNull();
  });

  it('키를 빼면 손대지 않는다 — 지우기와 구분된다', async () => {
    await putDefaults({ model: 'sonnet-x', effort: 'high' });

    await putDefaults({ effort: 'low' });

    expect((await getDefaults()).json()).toMatchObject({ model: 'sonnet-x', effort: 'low' });
  });

  it('admin 이 아니면 PUT 이 403 이고 값도 바뀌지 않는다', async () => {
    await putDefaults({ model: 'admin-set' });

    const res = await putDefaults({ model: 'intruder' }, { authorization: `Bearer ${plainToken}` });

    expect(res.statusCode).toBe(403);
    expect((await getDefaults()).json().model).toBe('admin-set');
  });

  it('admin 이 아니면 GET 도 403 이다 — 이 파일의 에이전트 관리 라우트와 같은 게이트다', async () => {
    const res = await app.inject({
      method: 'GET', url: '/settings/agent-defaults',
      headers: { authorization: `Bearer ${plainToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  // 행이 둘이 되면 "기본값이 무엇인가"에 답이 둘이 된다. 두 제약을 따로 찌른다 —
  // PK 유일성이 true 행 중복을, check (id) 가 false 행을 막는다.
  it('행을 하나 더 넣으려 하면 DB 가 거절한다', async () => {
    await expect(pool.query(`insert into agent_defaults (id) values (true)`)).rejects.toThrow();
    await expect(pool.query(`insert into agent_defaults (id) values (false)`)).rejects.toThrow();

    const rows = await pool.query(`select count(*)::int as n from agent_defaults`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('기본값 변경을 감사에 남긴다', async () => {
    await putDefaults({ effort: 'xhigh' });

    const rows = await pool.query(
      `select detail from audit_log where action = 'agent.defaults.updated' order by id desc limit 1`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].detail.after).toMatchObject({ effort: 'xhigh' });
  });

  it('실행할 수 없는 harness 는 기본값으로도 받지 않는다', async () => {
    const res = await putDefaults({ harness: 'gemini' });

    expect(res.statusCode).toBe(400);
  });
});
