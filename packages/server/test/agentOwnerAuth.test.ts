import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
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
let ownedAgentId: string;
let orphanAgentId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/**
 * 소유자가 `owner` 인 에이전트를 **새로** 만든다.
 *
 * 되돌려 RED 를 하다 알게 된 것: 게이트를 되돌리면 테스트 7 의 PATCH 가 실제로 소유권을
 * 남에게 넘겨 버려, 뒤따르는 테스트 8·9 가 "소유자가 아니게 된" 상태 때문에 초록/빨강이
 * 된다. 즉 공용 에이전트를 쓰면 8 이 자기 이유로 빨간지 알 수 없다. 그래서 소유권을
 * 건드릴 수 있는 테스트는 각자 자기 에이전트를 쓴다.
 */
async function makeOwnedAgent(handle: string): Promise<string> {
  const created = await createAgent(app, adminToken, handle);
  const patched = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${created.accountId}`, headers: auth(adminToken),
    payload: { ownerAccountId: ownerId },
  });
  expect(patched.statusCode).toBe(200);
  return created.accountId;
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const owner = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'owner', displayName: 'Owner', password: 'pw123456', inviteToken: inv.json().token as string },
  });
  const ownerLogin = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle: 'owner', password: 'pw123456' },
  });
  ownerToken = ownerLogin.json().token as string;
  ownerId = owner.json().id as string;

  const inv2 = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const stranger = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'stranger', displayName: 'Stranger', password: 'pw123456', inviteToken: inv2.json().token as string },
  });
  const strangerLogin = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle: 'stranger', password: 'pw123456' },
  });
  strangerToken = strangerLogin.json().token as string;

  ownedAgentId = await makeOwnedAgent('ownedagent');

  const orphan = await createAgent(app, adminToken, 'orphanagent');
  orphanAgentId = orphan.accountId;
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${orphanAgentId}`, headers: auth(adminToken),
    payload: { ownerAccountId: null },
  });
});
afterAll(async () => { await app.close(); await stop(); });

describe('#253 소유자 기반 인가', () => {
  describe('PAT 발급·조회·폐기', () => {
    it('1. 소유자가 자기 에이전트의 PAT 를 발급·조회·폐기할 수 있다', async () => {
      const issueRes = await app.inject({
        method: 'POST', url: `/accounts/${ownedAgentId}/pats`, headers: auth(ownerToken),
        payload: { label: 'owner-pat' },
      });
      expect(issueRes.statusCode).toBe(201);
      const token = issueRes.json().token as string;

      const listRes = await app.inject({
        method: 'GET', url: `/accounts/${ownedAgentId}/pats`, headers: auth(ownerToken),
      });
      expect(listRes.statusCode).toBe(200);
      expect((listRes.json() as { pats: { label: string }[] }).pats).toContainEqual(
        expect.objectContaining({ label: 'owner-pat' }),
      );

      const revokeRes = await app.inject({
        method: 'DELETE', url: `/accounts/${ownedAgentId}/pats/owner-pat`, headers: auth(ownerToken),
      });
      expect(revokeRes.statusCode).toBe(200);

      const checkPat = await pool.query('select 1 from pat where account_id = $1 and label = $2 and revoked_at is null', [ownedAgentId, 'owner-pat']);
      expect(checkPat.rowCount).toBe(0);
    });

    it('2. 남(admin 아님, 소유자 아님)은 403 이고 발급되지 않는다', async () => {
      const res = await app.inject({
        method: 'POST', url: `/accounts/${ownedAgentId}/pats`, headers: auth(strangerToken),
        payload: { label: 'stranger-pat' },
      });
      expect(res.statusCode).toBe(403);

      const checkPat = await pool.query('select 1 from pat where account_id = $1 and label = $2', [ownedAgentId, 'stranger-pat']);
      expect(checkPat.rowCount).toBe(0);
    });

    it('3. 소유자 없는 에이전트는 admin 만 발급할 수 있다', async () => {
      const byOwner = await app.inject({
        method: 'POST', url: `/accounts/${orphanAgentId}/pats`, headers: auth(ownerToken),
        payload: { label: 'orphan-pat-owner' },
      });
      expect(byOwner.statusCode).toBe(403);

      const byStranger = await app.inject({
        method: 'POST', url: `/accounts/${orphanAgentId}/pats`, headers: auth(strangerToken),
        payload: { label: 'orphan-pat-stranger' },
      });
      expect(byStranger.statusCode).toBe(403);

      const byAdmin = await app.inject({
        method: 'POST', url: `/accounts/${orphanAgentId}/pats`, headers: auth(adminToken),
        payload: { label: 'orphan-pat-admin' },
      });
      expect(byAdmin.statusCode).toBe(201);
    });

    it('4. admin 은 언제나 된다(소유자가 따로 있어도)', async () => {
      const res = await app.inject({
        method: 'POST', url: `/accounts/${ownedAgentId}/pats`, headers: auth(adminToken),
        payload: { label: 'admin-pat' },
      });
      expect(res.statusCode).toBe(201);

      const listRes = await app.inject({
        method: 'GET', url: `/accounts/${ownedAgentId}/pats`, headers: auth(adminToken),
      });
      expect(listRes.statusCode).toBe(200);
    });
  });

  describe('메모리 조회·삭제', () => {
    it('5. 소유자가 자기 에이전트의 메모리를 읽고 지울 수 있다. 남은 403', async () => {
      const slug = 'test-memory';
      await pool.query(
        `insert into agent_memory (account_id, slug, value) values ($1, $2, $3)`,
        [ownedAgentId, slug, 'test content'],
      );

      const readByOwner = await app.inject({
        method: 'GET', url: `/accounts/agents/${ownedAgentId}/memory`, headers: auth(ownerToken),
      });
      expect(readByOwner.statusCode).toBe(200);

      const deleteByOwner = await app.inject({
        method: 'DELETE', url: `/accounts/agents/${ownedAgentId}/memory/${slug}`, headers: auth(ownerToken),
      });
      expect(deleteByOwner.statusCode).toBe(204);

      const readByStranger = await app.inject({
        method: 'GET', url: `/accounts/agents/${ownedAgentId}/memory`, headers: auth(strangerToken),
      });
      expect(readByStranger.statusCode).toBe(403);

      // 읽기만 막고 삭제가 열려 있으면 최악이다 — 못 보는 것을 지울 수 있다.
      // 상태 코드만 보지 않고 **행이 살아 있는지**까지 본다.
      await pool.query(
        `insert into agent_memory (account_id, slug, value) values ($1, $2, $3)`,
        [ownedAgentId, 'survives-stranger', 'still here'],
      );
      const deleteByStranger = await app.inject({
        method: 'DELETE', url: `/accounts/agents/${ownedAgentId}/memory/survives-stranger`,
        headers: auth(strangerToken),
      });
      expect(deleteByStranger.statusCode).toBe(403);
      const survived = await pool.query(
        'select 1 from agent_memory where account_id = $1 and slug = $2',
        [ownedAgentId, 'survives-stranger'],
      );
      expect(survived.rowCount).toBe(1);
    });
  });

  describe('에이전트 설정 수정', () => {
    it('6. 소유자가 instructions 를 고칠 수 있다', async () => {
      const res = await app.inject({
        method: 'PATCH', url: `/accounts/agents/${ownedAgentId}`, headers: auth(ownerToken),
        payload: { instructions: 'new instructions' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { instructions: string }).instructions).toBe('new instructions');
    });

    it('7. 소유자가 ownerAccountId 를 바꾸려 하면 403 이고 다른 필드도 바뀌지 않는다', async () => {
      // 자기 에이전트를 쓴다 — 게이트가 빠지면 이 PATCH 가 소유권을 실제로 넘겨 버려서,
      // 공용 에이전트였다면 뒤 테스트가 남의 이유로 색이 바뀐다.
      const agentId = await makeOwnedAgent('ownr7agent');
      const inv3 = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
      const stranger2 = await app.inject({
        method: 'POST', url: '/auth/register',
        payload: {
          handle: 'stranger2', displayName: 'Stranger2', password: 'pw123456',
          inviteToken: inv3.json().token as string,
        },
      });
      const stranger2IdStr = stranger2.json().id as string;

      const readRow = () => pool.query<{ instructions: string | null; owner_account_id: string | null }>(
        'select c.instructions, c.owner_account_id from account a left join agent_config c on c.account_id = a.id where a.id = $1',
        [agentId],
      );
      const before = await readRow();
      const beforeInstructions = before.rows[0]!.instructions;
      const beforeOwner = before.rows[0]!.owner_account_id;
      expect(beforeOwner).toBe(ownerId);

      const res = await app.inject({
        method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(ownerToken),
        payload: { ownerAccountId: stranger2IdStr, instructions: 'should not change' },
      });
      expect(res.statusCode).toBe(403);

      // **부분 적용 금지.** 소유자가 만질 수 있는 필드(instructions)도 함께 거절돼야 한다 —
      // 하나만 적용되면 사람은 전부 됐다고 믿는다.
      const after = await readRow();
      expect(after.rows[0]!.instructions).toBe(beforeInstructions);
      expect(after.rows[0]!.owner_account_id).toBe(beforeOwner);
    });

    it('8. 소유자가 disabled 를 바꾸려 하면 403 이고 계정이 살아 있다', async () => {
      const agentId = await makeOwnedAgent('ownr8agent');
      const res = await app.inject({
        method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(ownerToken),
        payload: { disabled: true },
      });
      expect(res.statusCode).toBe(403);

      // 상태 코드만 보면 "403 을 받았지만 이미 꺼졌다"를 놓친다. 비활성화는 PAT 를 통째로
      // 폐기하므로(러너가 멈춘다) 되돌리기 어려운 조작이다.
      const acct = await pool.query<{ disabled_at: Date | null }>(
        'select disabled_at from account where id = $1', [agentId],
      );
      expect(acct.rows[0]!.disabled_at).toBeNull();
    });

    it('10. 인증 없는 PATCH 는 401 이고 아무것도 바뀌지 않는다', async () => {
      // 필드별 게이트를 넣느라 preHandler 를 지우면 이 라우트만 인증 없이 열린다 —
      // 익명 요청이 소유자 판정까지 흘러들어 에이전트의 존재 여부(404 vs 403)를 흘리거나
      // `req.account!` 에서 500 으로 터진다.
      const agentId = await makeOwnedAgent('ownr10agent');
      const res = await app.inject({
        method: 'PATCH', url: `/accounts/agents/${agentId}`,
        payload: { instructions: 'anonymous write' },
      });
      expect(res.statusCode).toBe(401);

      const after = await pool.query<{ instructions: string | null }>(
        'select instructions from agent_config where account_id = $1', [agentId],
      );
      expect(after.rows[0]!.instructions).not.toBe('anonymous write');
    });
  });

  describe('감사 로그', () => {
    it('9. 소유자의 조작이 감사에 그 소유자의 actorId 로 남는다', async () => {
      await pool.query('delete from pat where account_id = $1 and label = $2', [ownedAgentId, 'audit-test']);

      await app.inject({
        method: 'POST', url: `/accounts/${ownedAgentId}/pats`, headers: auth(ownerToken),
        payload: { label: 'audit-test' },
      });

      const audit = await pool.query(
        `select actor_id, action from audit_log where target = $1 and action = 'pat.issued' order by id desc limit 1`,
        [ownedAgentId],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].actor_id).toBe(ownerId);
    });
  });
});