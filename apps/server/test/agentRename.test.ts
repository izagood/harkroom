import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

/**
 * #843: **에이전트 이름을 만든 뒤에도 바꾼다.**
 *
 * 그 전에는 `PATCH /accounts/:id/handle` 이 에이전트를 400 `agent_handle_immutable` 로
 * 거절했고, 에이전트 PATCH 는 `handle` 을 아예 받지 않았다. 이름을 잘못 지으면 남은 길은
 * 지우고 다시 만드는 것뿐이었는데, 그러면 계정 id 가 바뀌어 러너 상태가 통째로 날아간다.
 *
 * 막았던 근거(러너 상태 디렉터리가 이름으로 스코프된다)는 `agent/stateDir.ts` 에서 없앴다 —
 * 그쪽 테스트가 "이름이 바뀌어도 같은 디렉터리"를 지킨다. 이 파일이 지키는 것은 서버 쪽
 * 계약이다: 유니크·감사·WS 이벤트.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let token: string;
let pool: import('pg').Pool;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

const auth = () => ({ authorization: `Bearer ${token}` });

const create = async (handle: string, displayName = handle): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: '/accounts/agents', headers: auth(),
    payload: { handle, displayName, harness: 'claude-code' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};

const patch = (id: string, payload: object) =>
  app.inject({ method: 'PATCH', url: `/accounts/agents/${id}`, headers: auth(), payload });

describe('agent rename (#843)', () => {
  it('이름을 바꾸면 새 이름으로 답하고 목록에도 새 이름이다', async () => {
    const id = await create('forge');
    const res = await patch(id, { handle: 'anvil' });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toBe('anvil');

    const listed = await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth() });
    expect(listed.json().agents.find((a: { id: string }) => a.id === id).handle).toBe('anvil');
  });

  /**
   * 표시 이름은 만들 때 이름과 같게 생긴다. 그대로였다면 "손대지 않았다"는 뜻이므로 따라간다 —
   * 안 따라가면 설정 카드가 굵게 옛 이름, 아래 옅게 새 `@이름` 을 그린다.
   */
  it('손대지 않은 표시 이름은 따라온다', async () => {
    const id = await create('tin');
    expect((await patch(id, { handle: 'zinc' })).json().displayName).toBe('zinc');
  });

  /** 직접 지은 표시 이름은 이름 변경이 덮지 않는다. */
  it('직접 지은 표시 이름은 그대로 남는다', async () => {
    const id = await create('lead', '납땜쟁이');
    const res = await patch(id, { handle: 'solder' });
    expect(res.json().handle).toBe('solder');
    expect(res.json().displayName).toBe('납땜쟁이');
  });

  it('이미 쓰는 이름이면 409 이고 아무것도 바뀌지 않는다', async () => {
    const a = await create('copper');
    await create('bronze');
    const res = await patch(a, { handle: 'bronze' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('handle_taken');

    const after = await app.inject({ method: 'GET', url: `/accounts/agents`, headers: auth() });
    expect(after.json().agents.find((x: { id: string }) => x.id === a).handle).toBe('copper');
  });

  /** 이름공간은 계정과 집합이 나눠 쓴다 — 한쪽만 보면 `@foo` 가 무엇인지 갈린다. */
  it('집합과 같은 이름은 거절한다', async () => {
    const id = await create('iron');
    const group = await app.inject({
      method: 'POST', url: '/handle-groups', headers: auth(),
      payload: { handle: 'smiths', displayName: 'Smiths' },
    });
    expect(group.statusCode).toBe(201);
    const res = await patch(id, { handle: 'smiths' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('handle_taken');
  });

  /**
   * 자기 이름을 그대로 다시 보내는 것은 흔하다 — 화면이 초안 전체를 싣기 때문이다.
   * 여기서 자기 자신과 부딪혀 409 가 되면 이름 말고 다른 것을 고치러 온 저장이 전부 실패한다.
   */
  it('같은 이름으로 다시 저장해도 통과한다', async () => {
    const id = await create('nickel');
    const res = await patch(id, { handle: 'nickel', instructions: '다시 저장' });
    expect(res.statusCode).toBe(200);
    expect(res.json().instructions).toBe('다시 저장');
  });

  /** 값이 안 바뀐 저장은 이름 변경 감사를 남기지 않는다 — 남기면 "언제 바뀌었나"를 못 찾는다. */
  it('실제로 바뀔 때만 감사를 남긴다', async () => {
    const id = await create('cobalt');
    await patch(id, { handle: 'cobalt' });
    const quiet = await pool.query(
      `select count(*)::int as n from audit_log where action = 'account.handle.changed' and target = $1`, [id]);
    expect(quiet.rows[0].n).toBe(0);

    await patch(id, { handle: 'chrome' });
    const loud = await pool.query(
      `select detail from audit_log where action = 'account.handle.changed' and target = $1`, [id]);
    expect(loud.rows).toHaveLength(1);
    expect(loud.rows[0].detail).toMatchObject({ from: 'cobalt', to: 'chrome' });
  });

  /**
   * 이름공간 구멍: 생성은 집합 이름을 막는데(`026_handle_group.sql` 결정 3) **이름 변경
   * 경로는 안 막고 있었다** — 만들 때 못 쓰는 이름을 나중에 바꿔서 차지할 수 있었다.
   * 사람 쪽 두 문(self·admin)도 같이 막는다.
   */
  it('사람도 집합 이름을 차지하지 못한다 (self · admin 두 문)', async () => {
    const group = await app.inject({
      method: 'POST', url: '/handle-groups', headers: auth(),
      payload: { handle: 'forgers', displayName: 'Forgers' },
    });
    expect(group.statusCode).toBe(201);

    const me = await app.inject({
      method: 'PATCH', url: '/accounts/me/handle', headers: auth(), payload: { handle: 'forgers' },
    });
    expect(me.statusCode).toBe(409);
    expect(me.json().error.code).toBe('handle_taken');
  });

  it('문법에 맞지 않는 이름은 400 이다', async () => {
    const id = await create('zinc2');
    expect((await patch(id, { handle: 'a' })).statusCode).toBe(400);
    expect((await patch(id, { handle: '대장장이' })).statusCode).toBe(400);
  });
});
