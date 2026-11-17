import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';

/**
 * AC6 — 오퍼레이터 코어가 Rust 에 있으면 TS 허브가 비어 있다. 그때 모델 검사·고르개는 Rust 가 적은
 * 스냅숏(`operator_capability`)을 읽는다. `seen_at` 이 낡으면 「모른다」(막지 않음)로 돌아간다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let member: { token: string; accountId: string };
let agentId: string;
let operatorId: string;
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const caps = {
  agentIds: [],
  harnesses: {
    'claude-code': { installed: true, loggedIn: true, models: [{ id: 'sonnet', efforts: ['low', 'medium', 7] }, { id: 'opus' }, { label: 'no id' }] },
  },
};

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  const admin = await bootstrapAdmin(app);
  member = await createMember(app, admin.token, 'mina');
  agentId = (await createAgent(app, admin.token, 'capy')).accountId;
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(admin.token),
    payload: { harness: 'claude-code', model: 'sonnet', effort: 'medium' },
  });
  operatorId = (await pool.query<{ id: string }>(
    `insert into operator (owner_account_id, name, token_hash) values ($1, 'snap-mac', 'snap-hash') returning id`, [admin.accountId])).rows[0]!.id;
  await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, operatorId, admin.accountId]);
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'snap' } });
  channelId = ch.json().id as string;
});

afterAll(async () => {
  await app.close();
  await stop();
});

describe('operator capability snapshot (AC6)', () => {
  it('허브가 비어 있으면 스냅숏의 목록으로 고르개를 채우고 모르는 모델을 막는다. 낡으면 「모른다」', async () => {
    const opts = async () => (await app.inject({ method: 'GET', url: `/agents/${agentId}/model-options`, headers: auth(member.token) })).json();
    expect((await opts()).models).toBeUndefined();

    await pool.query(`insert into operator_capability (operator_id, body) values ($1, $2)`, [operatorId, JSON.stringify(caps)]);
    // 모양을 믿지 않는다: id 없는 항목은 빠지고 effort 는 문자열만 남는다.
    expect((await opts()).models).toEqual([{ id: 'sonnet', efforts: ['low', 'medium'] }, { id: 'opus' }]);

    const root = (await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(member.token), payload: { body: 'root' } })).json().id as string;
    const put = (payload: Record<string, unknown>) => app.inject({
      method: 'PUT', url: `/channels/${channelId}/threads/${root}/agent-models/${agentId}`, headers: auth(member.token), payload,
    });
    const unknown = await put({ model: 'haiku' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('model_not_offered');
    const badEffort = await put({ effort: 'max' });
    expect(badEffort.json().error.code).toBe('effort_not_offered');
    expect((await put({ model: 'opus' })).statusCode).toBe(200);

    // Rust 가 죽어 지우지 못한 줄 — seen_at 이 낡으면 「모른다」로 돌아가 막지 않는다.
    await pool.query(`update operator_capability set seen_at = now() - interval '10 minutes' where operator_id = $1`, [operatorId]);
    expect((await opts()).models).toBeUndefined();
    expect((await put({ model: 'haiku' })).statusCode).toBe(200);
  });
});
