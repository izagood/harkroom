// 위임 재설계 v1 의 스키마 자리(164). 동작은 아직 없으므로 여기서는 표가 받는 값과 거절하는 값만 본다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { delegationV2Enabled } from '../src/services/delegations.js';

let pool: Pool; let stop: () => Promise<void>; let app: FastifyInstance;
let leadId: string; let memberId: string; let channelId: string; let rootId: string;
const HEAD = 'a'.repeat(40);

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  leadId = (await createAgent(app, admin.token, 'v2-lead')).accountId;
  memberId = (await createAgent(app, admin.token, 'v2-member')).accountId;
  channelId = (await pool.query<{ id: string }>(
    `insert into channel (kind, name) values ('standard', 'v2-schema') returning id`)).rows[0]!.id;
  rootId = (await pool.query<{ id: string }>(
    `insert into message (channel_id, author_id, body, kind) values ($1, $2, 'root', 'user') returning id`, [channelId, leadId])).rows[0]!.id;
});
afterAll(async () => { await app.close(); await stop(); });

async function delegation(extra: { kind?: string; planStepId?: string | null } = {}): Promise<string> {
  const cols = ['message_id', 'lead_account_id', 'channel_id', 'thread_root_id', 'deadline_at'];
  const vals: unknown[] = [rootId, leadId, channelId, rootId, new Date(Date.now() + 600_000)];
  if (extra.kind !== undefined) { cols.push('kind'); vals.push(extra.kind); }
  if (extra.planStepId !== undefined) { cols.push('plan_step_id'); vals.push(extra.planStepId); }
  const r = await pool.query<{ id: string }>(
    `insert into team_delegation (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals);
  return r.rows[0]!.id;
}

describe('164 위임 재설계 스키마', () => {
  it('옛 위임은 kind=delegate·단계 없음으로 그대로 들어간다', async () => {
    const id = await delegation();
    const r = await pool.query(`select kind, plan_step_id from team_delegation where id = $1`, [id]);
    expect(r.rows[0]).toEqual({ kind: 'delegate', plan_step_id: null });
  });

  it('kind 는 delegate·mention 만, 단계 id 는 계획판 꼴만 받는다', async () => {
    await expect(delegation({ kind: 'mention', planStepId: 's7' })).resolves.toBeTruthy();
    await expect(delegation({ kind: 'wake' })).rejects.toThrow(/check/);
    await expect(delegation({ planStepId: 'step-7' })).rejects.toThrow(/check/);
  });

  it('의무는 reported 를 받고, closed 는 까닭과 함께일 때만 받는다', async () => {
    const id = await delegation();
    await pool.query(`insert into team_delegation_item (delegation_id, delegate_account_id) values ($1, $2)`, [id, memberId]);
    await pool.query(`update team_delegation_item set outcome = 'reported', last_activity_at = now() where delegation_id = $1`, [id]);
    await expect(pool.query(`update team_delegation_item set outcome = 'closed' where delegation_id = $1`, [id])).rejects.toThrow(/check/);
    await expect(pool.query(`update team_delegation_item set closed_reason = 'idle' where delegation_id = $1`, [id])).rejects.toThrow(/check/);
    await pool.query(`update team_delegation_item set outcome = 'closed', closed_reason = 'idle' where delegation_id = $1`, [id]);
    await expect(pool.query(`update team_delegation_item set closed_reason = 'bored' where delegation_id = $1`, [id])).rejects.toThrow(/check/);
  });

  it('165: 열린 의무(outcome null)에 closed_reason 만 붙는 것을 거절한다', async () => {
    const id = await delegation();
    await pool.query(`insert into team_delegation_item (delegation_id, delegate_account_id) values ($1, $2)`, [id, memberId]);
    await expect(pool.query(`update team_delegation_item set closed_reason = 'idle' where delegation_id = $1`, [id])).rejects.toThrow(/check/);
    await expect(pool.query(
      `insert into team_delegation_item (delegation_id, delegate_account_id, outcome, closed_reason) values ($1, $2, null, 'idle')`,
      [await delegation(), memberId])).rejects.toThrow(/check/);
  });

  it('PR 감시는 (repo, number, head, until) 로 열린 것이 하나뿐이고, 끝나면 다시 열 수 있다', async () => {
    const open = (until = 'checks') => pool.query<{ id: string }>(
      `insert into pr_watch (repo, number, head, until, expires_at) values ('o/r', 12, $1, $2, now() + interval '6 hours') returning id`, [HEAD, until]);
    const first = (await open()).rows[0]!.id;
    await expect(open()).rejects.toThrow(/duplicate key/);
    await expect(open('merged')).resolves.toBeTruthy();
    await expect(pool.query(`update pr_watch set state = 'done' where id = $1`, [first])).rejects.toThrow(/check/);
    await pool.query(`update pr_watch set state = 'done', ended_at = now() where id = $1`, [first]);
    await expect(open()).resolves.toBeTruthy();
    await expect(pool.query(
      `insert into pr_watch (repo, number, head, until, expires_at) values ('o/r', 12, 'abc', 'checks', now())`)).rejects.toThrow(/check/);
  });

  it('구독자는 감시마다 계정·스레드로 하나이고, 위임이 지워져도 남는다', async () => {
    const watch = (await pool.query<{ id: string }>(
      `insert into pr_watch (repo, number, head, until, expires_at) values ('o/r', 99, $1, 'merged', now() + interval '6 hours') returning id`, [HEAD])).rows[0]!.id;
    const dlg = await delegation();
    const sub = (account: string, source = 'manual') => pool.query(
      `insert into pr_watch_subscriber (watch_id, account_id, channel_id, thread_root_id, delegation_id, source) values ($1, $2, $3, $4, $5, $6)`,
      [watch, account, channelId, rootId, dlg, source]);
    await sub(leadId);
    await sub(memberId, 'merge_queue');
    await expect(sub(leadId)).rejects.toThrow(/duplicate key/);
    await pool.query(`delete from team_delegation where id = $1`, [dlg]);
    const r = await pool.query(`select delegation_id from pr_watch_subscriber where watch_id = $1`, [watch]);
    expect(r.rows).toEqual([{ delegation_id: null }, { delegation_id: null }]);
  });

  it('inbox 가 delegation_update 사유를 받는다', async () => {
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'delegation_update')`, [leadId, rootId]);
  });

  it('스위치는 기본 꺼짐이다', () => {
    expect(delegationV2Enabled({})).toBe(false);
    expect(delegationV2Enabled({ HARKROOM_DELEGATION_V2: 'on' })).toBe(true);
    expect(delegationV2Enabled({ HARKROOM_DELEGATION_V2: 'off' })).toBe(false);
  });
});
