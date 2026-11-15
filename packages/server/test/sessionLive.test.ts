import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import type { AgentSessionView } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { createSessionLiveStore, listLiveSessions } from '../src/services/sessionLive.js';

// S5.3 C6c-2 — 살아 있는 세션 사본(agent_session_live). security C6c ①·①′·①″ 를 시험으로 고정한다.
let pool: Pool;
let stop: () => Promise<void>;
let agentA: string;
let agentB: string;
let operatorId: string;
const channelId = '00000000-0000-4000-8000-0000000000c1';

const session = (sessionId: string, agentAccountId: string, extra: Record<string, unknown> = {}): AgentSessionView => ({
  sessionId, agentAccountId, channelId, threadRootId: null, harness: 'claude-code', startedAt: '2026-01-01T00:00:00.000Z',
  mode: 'mention', ...extra,
}) as AgentSessionView;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const acc = async (h: string, kind: string) => (await pool.query<{ id: string }>(
    `insert into account (handle, display_name, kind) values ($1, $1, $2) returning id`, [h, kind])).rows[0]!.id;
  const owner = (await pool.query<{ id: string }>(
    `insert into account (handle, login_id, display_name, kind, password_hash) values ('sl_owner', 'sl_owner', 'O', 'human', 'x') returning id`)).rows[0]!.id;
  agentA = await acc('sl_a', 'agent');
  agentB = await acc('sl_b', 'agent');
  operatorId = (await pool.query<{ id: string }>(
    `insert into operator (owner_account_id, name, token_hash) values ($1, 'op', 'sl-op-hash') returning id`, [owner])).rows[0]!.id;
});
afterAll(async () => { await stop(); });

describe('agent_session_live', () => {
  it('keeps only allow-listed columns and never the account/pool names', async () => {
    const s = createSessionLiveStore(pool);
    await s.start();
    s.started(operatorId, agentA, session('s-allow', agentA, {
      claudeAccount: 'Some Person', claudePool: 'home', claudePoolRank: 2, claudeAccountRank: 1, viewKey: 'k'.repeat(32),
    }));
    await s.flush();
    const cols = (await pool.query(
      `select column_name from information_schema.columns where table_name = 'agent_session_live' order by ordinal_position`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(['session_id', 'agent_account_id', 'operator_id', 'channel_id', 'thread_root_id', 'harness', 'mode',
      'started_at', 'status', 'claude_pool_rank', 'claude_account_rank', 'hub_epoch', 'updated_at']);
    const row = (await pool.query(`select row_to_json(l)::text as j from agent_session_live l where session_id = 's-allow'`)).rows[0];
    expect(row.j).not.toMatch(/Some Person|home|kkkk/);
    expect(await listLiveSessions(pool, [agentA])).toEqual([{ sessionId: 's-allow', agentAccountId: agentA, channelId, threadRootId: null }]);
    await s.stop();
    // 멈춘 허브의 행은 cascade 로 사라진다.
    expect(await listLiveSessions(pool)).toEqual([]);
  });

  it("another agent's runner cannot take over or end a session id", async () => {
    const s = createSessionLiveStore(pool);
    await s.start();
    s.started(operatorId, agentA, session('s-own', agentA));
    s.started(operatorId, agentB, session('s-own', agentB, { channelId: '00000000-0000-4000-8000-0000000000c2' }));
    s.ended(agentB, 's-own');
    s.replaced(operatorId, agentB, []);
    await s.flush();
    const r = (await pool.query(`select agent_account_id::text, channel_id::text from agent_session_live where session_id = 's-own'`)).rows;
    expect(r).toEqual([{ agent_account_id: agentA, channel_id: channelId }]);
    s.ended(agentA, 's-own');
    await s.flush();
    expect(await listLiveSessions(pool)).toEqual([]);
    await s.stop();
  });

  it('announce replaces the list; runner exit drops its rows', async () => {
    const s = createSessionLiveStore(pool);
    await s.start();
    s.started(operatorId, agentA, session('s-1', agentA));
    s.started(operatorId, agentA, session('s-2', agentA));
    s.replaced(operatorId, agentA, [session('s-2', agentA), session('s-3', agentA)]);
    await s.flush();
    expect((await listLiveSessions(pool, [agentA])).map((x) => x.sessionId)).toEqual(['s-2', 's-3']);
    s.runnerGone(operatorId, agentA);
    await s.flush();
    expect(await listLiveSessions(pool, [agentA])).toEqual([]);
    await s.stop();
  });

  it('a dead hub is swept by liveness only; a live hub is never swept', async () => {
    const dead = createSessionLiveStore(pool);
    const alive = createSessionLiveStore(pool);
    await dead.start();
    await alive.start();
    dead.started(operatorId, agentA, session('s-dead', agentA));
    alive.started(operatorId, agentB, session('s-alive', agentB));
    await dead.flush();
    await alive.flush();
    // dead 는 박동을 멈춘 채 죽었다(stop 없이) — seen_at 만 TTL 밖으로 민다.
    await pool.query(`update relay_hub set seen_at = now() - interval '10 minutes' where hub_epoch = $1`, [dead.epoch]);
    // 읽기는 쓸기 전에도 죽은 허브의 행을 보지 않는다.
    expect((await listLiveSessions(pool)).map((x) => x.sessionId)).toEqual(['s-alive']);
    // 새 인스턴스가 떠서 쓴다 — 살아 있는 다른 허브(alive)의 줄은 남는다.
    const fresh = createSessionLiveStore(pool);
    await fresh.start();
    const hubs = (await pool.query(`select hub_epoch::text from relay_hub order by hub_epoch`)).rows.map((r) => r.hub_epoch).sort();
    expect(hubs).toEqual([alive.epoch, fresh.epoch].sort());
    expect((await pool.query(`select session_id from agent_session_live order by session_id`)).rows.map((r) => r.session_id)).toEqual(['s-alive']);
    await fresh.stop();
    await alive.stop();
    await dead.stop();
  });

  it('r1: a hub swept while stalled re-registers on its next beat and rewrites its sessions', async () => {
    const s = createSessionLiveStore(pool);
    await s.start();
    s.started(operatorId, agentA, session('s-r1a', agentA));
    s.started(operatorId, agentA, session('s-r1b', agentA, { claudeAccount: 'Some Person' }));
    s.started(operatorId, agentA, session('s-r1c', agentA));
    s.started(operatorId, agentB, session('s-r1a', agentB)); // 남의 러너 — 사본의 주인도 바뀌지 않는다
    s.ended(agentA, 's-r1c');
    await s.flush();
    // 박동이 살아 있으면 줄을 새로 넣지 않는다.
    expect(await s.beatOnce()).toBe(false);
    // 멈춘 사이 다른 허브가 이 줄을 쓸었다(행은 cascade).
    await pool.query(`delete from relay_hub where hub_epoch = $1`, [s.epoch]);
    expect(await listLiveSessions(pool)).toEqual([]);
    expect(await s.beatOnce()).toBe(true);
    const rows = (await pool.query(
      `select session_id, agent_account_id::text, hub_epoch::text, row_to_json(l)::text as j from agent_session_live l order by session_id`)).rows;
    expect(rows.map((r) => [r.session_id, r.agent_account_id, r.hub_epoch])).toEqual([
      ['s-r1a', agentA, s.epoch], ['s-r1b', agentA, s.epoch],
    ]);
    expect(rows.map((r) => r.j).join()).not.toMatch(/Some Person/);
    expect((await listLiveSessions(pool)).map((x) => x.sessionId)).toEqual(['s-r1a', 's-r1b']);
    // 러너가 물러난 뒤엔 다시 살아나도 쓸 것이 없다.
    s.runnerGone(operatorId, agentA);
    await s.flush();
    await pool.query(`delete from relay_hub where hub_epoch = $1`, [s.epoch]);
    expect(await s.beatOnce()).toBe(true);
    expect(await listLiveSessions(pool)).toEqual([]);
    await s.stop();
  });
});
