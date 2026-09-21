// 인가 판정 함수 하나(`auth/permissions.ts::can`)의 회귀선 — 스펙 2026-09-20 §6.
//
// 라우트를 거치지 않고 함수를 직접 부른다: 이 함수가 곧 판정이고, 라우트는 그것을 부를 뿐이다
// (#253 의 원칙). 여기서 세 층(소유 ∨ grant ∨ 역할)의 순서와 경계를 고정해 두면 라우트
// 테스트는 "어느 capability 를 물었나"만 보면 된다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import type { AccountView } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { can, hasGrant } from '../src/auth/permissions.js';

let pool: Pool; let stop: () => Promise<void>;
let ownerId: string; let memberId: string; let otherId: string; let agentId: string;

const view = (id: string, role: AccountView['role']): AccountView => ({
  id, handle: `h-${id.slice(0, 4)}`, displayName: 'x', kind: 'human',
  isAdmin: role === 'owner' || role === 'admin', role,
  ownerAccountId: null, disabled: false, deleted: false,
  status: 'available', statusText: null, avatarAttachmentId: null,
});

beforeAll(async () => {
  const db = await startTestDb(); pool = db.pool as Pool; stop = db.stop;
  // 사람 계정은 login_id 가 필수다(#271, 033). 에이전트는 null 이어야 한다.
  const ins = async (handle: string, kind: string, role: string) => (await pool.query(
    `insert into account (handle, login_id, display_name, kind, is_admin, role)
     values ($1, case when $2 = 'human' then $1 end, $1, $2, $3, $4) returning id`,
    [handle, kind, role === 'owner' || role === 'admin', role])).rows[0].id as string;
  ownerId = await ins('owner', 'human', 'owner');
  memberId = await ins('member', 'human', 'member');
  otherId = await ins('other', 'human', 'member');
  agentId = await ins('bot', 'agent', 'member');
  await pool.query(`insert into agent_config (account_id, owner_account_id) values ($1, $2)`, [agentId, memberId]);
});
afterAll(async () => { await stop(); });

describe('can()', () => {
  it('role >= admin 은 전부 통과한다', async () => {
    expect(await can(pool, view(ownerId, 'owner'), 'agent.create')).toBe(true);
  });
  it('member 는 grant 가 없으면 거절된다', async () => {
    expect(await can(pool, view(memberId, 'member'), 'agent.create')).toBe(false);
  });
  it('member 기본 capability(operator.register)는 grant 없이 통과한다', async () => {
    expect(await can(pool, view(memberId, 'member'), 'operator.register')).toBe(true);
  });
  it('guest 는 기본 capability 도 없다', async () => {
    expect(await can(pool, view(otherId, 'guest'), 'operator.register')).toBe(false);
  });
  it('전역 grant 가 있으면 통과한다', async () => {
    await pool.query(`insert into account_grant (account_id, capability, granted_by) values ($1, 'agent.create', $2)`, [memberId, ownerId]);
    expect(await hasGrant(pool, memberId, 'agent.create', '')).toBe(true);
    expect(await can(pool, view(memberId, 'member'), 'agent.create')).toBe(true);
  });
  it('만료된 grant 는 없는 것이다', async () => {
    await pool.query(`insert into account_grant (account_id, capability, scope, granted_by, expires_at)
      values ($1, 'team.create', '', $2, now() - interval '1 minute')`, [otherId, ownerId]);
    expect(await can(pool, view(otherId, 'member'), 'team.create')).toBe(false);
  });
  it('scope 가 있는 grant 는 그 대상에만 통과한다', async () => {
    await pool.query(`insert into account_grant (account_id, capability, scope, granted_by)
      values ($1, 'agent.manage', $2, $3)`, [otherId, `agent:${agentId}`, ownerId]);
    expect(await can(pool, view(otherId, 'member'), 'agent.manage', { kind: 'agent', id: agentId })).toBe(true);
    expect(await can(pool, view(otherId, 'member'), 'agent.manage', { kind: 'agent', id: memberId })).toBe(false);
  });
  it('소유자는 grant 없이 자기 것을 manage 한다', async () => {
    expect(await can(pool, view(memberId, 'member'), 'agent.manage', { kind: 'agent', id: agentId })).toBe(true);
    expect(await can(pool, view(ownerId, 'member'), 'agent.manage', { kind: 'agent', id: agentId })).toBe(false);
  });
  it('아직 없는 소유 테이블(operator)은 소유 아님으로 답한다 — 던지지 않는다', async () => {
    expect(await can(pool, view(memberId, 'member'), 'operator.manage', { kind: 'operator', id: agentId })).toBe(false);
  });
});
