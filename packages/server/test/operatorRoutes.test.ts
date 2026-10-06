// 오퍼레이터 신원 — 스펙 2026-09-20-operator-and-permissions §3. 오퍼레이터는 사람의 기기다:
// 등록 코드(1회용·5분) → 장기 토큰 교환 → 폐기. 오퍼레이터 토큰은 계정이 아니므로
// `req.account` 가 서지 않고 `req.operator` 만 선다 — 그 경계를 여기서 잰다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let memberToken: string; let otherToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken } = await createMember(app, adminToken, 'mac'));
  ({ token: otherToken } = await createMember(app, adminToken, 'other'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('오퍼레이터 등록', () => {
  let code: string; let operatorId: string; let opToken: string;
  it('member 는 기본 capability 로 등록 코드를 받는다', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(memberToken) });
    expect(res.statusCode).toBe(200);
    code = res.json().code; expect(code).toMatch(/^hkreg_/);
    expect(typeof res.json().expiresAt).toBe('string');
  });
  it('코드로 토큰을 교환한다 — 인증 없이', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '맥북' } });
    expect(res.statusCode).toBe(200);
    opToken = res.json().token; operatorId = res.json().operator.id;
    expect(opToken).toMatch(/^hkop_/);
    expect(res.json().operator.name).toBe('맥북');
    expect(res.json().operator.online).toBe(false);
  });
  it('코드는 1회용이다', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '또' } });
    expect(res.statusCode).toBe(401);
  });
  it('소유자는 자기 오퍼레이터를 본다, 남은 못 본다, admin 은 전부 본다', async () => {
    const mine = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(mine.json().operators.map((o: { id: string }) => o.id)).toEqual([operatorId]);
    const theirs = await app.inject({ method: 'GET', url: '/operators', headers: auth(otherToken) });
    expect(theirs.json().operators).toEqual([]);
    const admin = await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) });
    expect(admin.json().operators).toHaveLength(1);
  });
  it('오퍼레이터 토큰으로 요청하면 req.operator 가 서고 req.account 는 비어 있다', async () => {
    const res = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(opToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(operatorId);
    const asHuman = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(opToken) });
    expect(asHuman.statusCode).toBe(401);
  });
  it('남은 남의 오퍼레이터를 폐기할 수 없다', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/operators/${operatorId}`, headers: auth(otherToken) });
    expect(del.statusCode).toBe(403);
  });
  it('소유자가 폐기하면 토큰이 죽고 감사에 남는다', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/operators/${operatorId}`, headers: auth(memberToken) });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(opToken) });
    expect(res.statusCode).toBe(401);
    const gone = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(gone.json().operators).toEqual([]);
  });
  it('모르는 코드는 401, 이름 없는 claim 은 400', async () => {
    const bad = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code: 'hkreg_nope', name: 'x' } });
    expect(bad.statusCode).toBe(401);
    const noName = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code: 'hkreg_nope' } });
    expect(noName.statusCode).toBe(400);
  });
});

// 다시 등록(`replaces`). 보안 조건: 코드 발급자의 옛 행만 폐기, 남의 id 는 조용히 무시(오류로 구별하지 않는다),
// 배정은 같은 트랜잭션에서 새 id 로, 감사에 옮긴 수, 옛 소켓은 끊는다(DELETE 와 같다).
describe('다시 등록 — 옛 등록 자동 폐기', () => {
  const claimWith = async (ownerToken: string, name: string, replaces?: string) => {
    const code = (await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(ownerToken) })).json().code as string;
    return app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name, ...(replaces ? { replaces } : {}) } });
  };

  it('자기 옛 등록을 폐기하고 배정을 새 id 로 옮기고, 옛 토큰은 죽는다', async () => {
    const old = await registerOperator(app, memberToken, 'this-mac');
    const { accountId: agentId } = await createAgent(app, adminToken, 'rereg-agent');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $1)`, [agentId, old.operatorId]);

    const res = await claimWith(memberToken, 'this-mac', old.operatorId);
    expect(res.statusCode).toBe(200);
    const fresh = res.json().operator.id as string;
    expect(res.json().replaced).toEqual({ operatorId: old.operatorId, movedAssignments: 1 });

    const asg = await pool.query(`select operator_id from agent_assignment where agent_id = $1`, [agentId]);
    expect(asg.rows[0].operator_id).toBe(fresh);
    const self = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(old.token) });
    expect(self.statusCode).toBe(401);
    const list = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(list.json().operators.map((o: { id: string }) => o.id)).toEqual([fresh]);
    const audit = await pool.query(`select detail from audit_log where action = 'operator.revoked' and target = $1`, [old.operatorId]);
    expect(audit.rows[0].detail).toEqual({ replacedBy: fresh, movedAssignments: 1 });
    await app.inject({ method: 'DELETE', url: `/operators/${fresh}`, headers: auth(memberToken) });
  });

  it('남의 operatorId 를 넣으면 조용히 무시한다 — 새 등록은 되고, 남의 것은 살아 있고, 응답으로 구별되지 않는다', async () => {
    const theirs = await registerOperator(app, otherToken, 'their-mac');
    const { accountId: agentId } = await createAgent(app, adminToken, 'their-agent');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $1)`, [agentId, theirs.operatorId]);

    const res = await claimWith(memberToken, 'sneaky', theirs.operatorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().replaced).toBeNull();
    // 없는 id 와 같은 응답 모양이다.
    const missing = await claimWith(memberToken, 'sneaky2', '00000000-0000-4000-8000-000000000000');
    expect(missing.statusCode).toBe(200);
    expect(missing.json().replaced).toBeNull();

    const self = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(theirs.token) });
    expect(self.statusCode).toBe(200);
    const asg = await pool.query(`select operator_id from agent_assignment where agent_id = $1`, [agentId]);
    expect(asg.rows[0].operator_id).toBe(theirs.operatorId);
    const leaked = await pool.query(`select 1 from audit_log where action = 'operator.revoked' and target = $1`, [theirs.operatorId]);
    expect(leaked.rowCount).toBe(0);
  });

  it('replaces 없이 claim 하면 옛 동작 그대로 — replaced: null', async () => {
    const res = await claimWith(memberToken, 'plain');
    expect(res.statusCode).toBe(200);
    expect(res.json().replaced).toBeNull();
  });

  it('uuid 가 아닌 replaces 는 400', async () => {
    const res = await claimWith(memberToken, 'bad', 'not-a-uuid');
    expect(res.statusCode).toBe(400);
  });
});

// 이름 바꾸기(스레드 e12e6780). `name`(등록 때의 호스트명)은 그대로 두고 `label` 만 바꾼다 —
// 비우면 호스트명으로 돌아가고, 권한은 폐기와 같고, 끊긴 오퍼레이터도 된다(이름은 서버가 든 값이다).
describe('이름 바꾸기 — label', () => {
  const rename = (token: string, id: string, label: unknown) =>
    app.inject({ method: 'PATCH', url: `/operators/${id}`, headers: auth(token), payload: { label } });

  it('소유자가 바꾸면 label 이 서고 name 은 그대로, 감사에 from·to 가 남는다 — 붙어 있지 않아도 된다', async () => {
    const op = await registerOperator(app, memberToken, 'NO-202509-002.local');
    const res = await rename(memberToken, op.operatorId, '  회사 맥북  ');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: op.operatorId, name: 'NO-202509-002.local', label: '회사 맥북', online: false });
    const list = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(list.json().operators.find((o: { id: string }) => o.id === op.operatorId).label).toBe('회사 맥북');
    const audit = await pool.query(`select detail from audit_log where action = 'operator.renamed' and target = $1`, [op.operatorId]);
    expect(audit.rows.map((r) => r.detail)).toEqual([{ from: null, to: '회사 맥북' }]);

    // 같은 값은 감사를 더 남기지 않는다.
    await rename(memberToken, op.operatorId, '회사 맥북');
    const again = await pool.query(`select 1 from audit_log where action = 'operator.renamed' and target = $1`, [op.operatorId]);
    expect(again.rowCount).toBe(1);

    // 비우면(공백만이어도) 호스트명으로 돌아간다 — null 도 같다.
    const cleared = await rename(memberToken, op.operatorId, '   ');
    expect(cleared.json().label).toBeNull();
    expect(cleared.json().name).toBe('NO-202509-002.local');
    await rename(memberToken, op.operatorId, 'x');
    expect((await rename(memberToken, op.operatorId, null)).json().label).toBeNull();
    await app.inject({ method: 'DELETE', url: `/operators/${op.operatorId}`, headers: auth(memberToken) });
  });

  it('64자까지 받고 65자는 400, label 이 없으면 400', async () => {
    const op = await registerOperator(app, memberToken, 'len-mac');
    expect((await rename(memberToken, op.operatorId, 'a'.repeat(64))).statusCode).toBe(200);
    expect((await rename(memberToken, op.operatorId, 'a'.repeat(65))).statusCode).toBe(400);
    const noBody = await app.inject({ method: 'PATCH', url: `/operators/${op.operatorId}`, headers: auth(memberToken), payload: {} });
    expect(noBody.statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: `/operators/${op.operatorId}`, headers: auth(memberToken) });
  });

  it('남은 못 바꾸고 admin 은 바꾼다, 폐기된 것은 404, 같은 이름은 막지 않는다', async () => {
    const a = await registerOperator(app, memberToken, 'dup-a');
    const b = await registerOperator(app, memberToken, 'dup-b');
    expect((await rename(otherToken, a.operatorId, 'mine now')).statusCode).toBe(403);
    expect((await rename(adminToken, a.operatorId, '같은 이름')).statusCode).toBe(200);
    expect((await rename(memberToken, b.operatorId, '같은 이름')).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/operators/${b.operatorId}`, headers: auth(memberToken) });
    expect((await rename(memberToken, b.operatorId, 'gone')).statusCode).toBe(404);
    await app.inject({ method: 'DELETE', url: `/operators/${a.operatorId}`, headers: auth(memberToken) });
  });

  it('다시 등록(replaces)하면 label 이 새 행으로 옮겨 간다', async () => {
    const old = await registerOperator(app, memberToken, 'vm.local');
    await rename(memberToken, old.operatorId, 'work VM');
    const code = (await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(memberToken) })).json().code as string;
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: 'vm.local', replaces: old.operatorId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().operator).toMatchObject({ name: 'vm.local', label: 'work VM' });
    const list = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(list.json().operators.find((o: { id: string }) => o.id === res.json().operator.id).label).toBe('work VM');
    await app.inject({ method: 'DELETE', url: `/operators/${res.json().operator.id}`, headers: auth(memberToken) });
  });
});
