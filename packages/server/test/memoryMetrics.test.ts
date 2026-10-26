import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';

// S0: 지표 쿼리(scripts/memory-metrics.sql)가 지금 스키마에서 돌아가는지만 본다 — 표·열 이름이 바뀌면 여기서 깨진다.
const sql = readFileSync(fileURLToPath(new URL('../scripts/memory-metrics.sql', import.meta.url)), 'utf8');
const statements = sql.split(/^-- name: /m).slice(1).map((chunk) => {
  const [name, ...rest] = chunk.split('\n');
  return { name: name!.trim(), text: rest.join('\n').trim().replace(/;\s*$/, '') };
});

let pool: Pool;
let stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const agent = (await pool.query(
    `insert into account (handle, display_name, kind) values ('metrics-agent', 'metrics', 'agent') returning id`,
  )).rows[0].id as string;
  await pool.query(
    `insert into agent_memory (account_id, slug, value, description, kind, recall_count) values
       ($1, 'core', 'core', null, 'topic', 0),
       ($1, 'mem/delegation-x', 'v', '위임 상태', 'topic', 3),
       ($1, 'mem/deploy', 'v', '#12 CI 초록 머지 대기', 'topic', 1),
       ($1, 'mem/how-to', 'v', '배포 절차', 'procedure', 2),
       ($1, 'mem/log', 'v', null, 'journal', 0),
       ($1, 'mem/policy', 'v', '#3 policy decision', 'topic', 0),
       ($1, 'mem/ci-glued', 'v', '#5 CI초록', 'topic', 0)`,
    [agent],
  );
  // 백그라운드 회차(P5): done 넷(쓰기 있음 셋 — 그중 하나는 되돌림, 쓰기 없음 하나) · failed 하나. 토큰은 하나만 null.
  await pool.query(
    `insert into bg_job (account_id, kind, day, status, writes, tokens, duration_ms, reverted_at) values
       ($1, 'distill', current_date - 1, 'done', 3, 1000, 60000, now()),
       ($1, 'distill', current_date - 2, 'done', 1, 2000, 30000, null),
       ($1, 'distill', current_date - 3, 'done', 2, null, 30000, null),
       ($1, 'distill', current_date - 4, 'done', 0, 500, 10000, null),
       ($1, 'distill', current_date - 5, 'failed', 0, 300, 600000, null),
       ($1, 'cleanup', current_date - 1, 'done', 5, 4000, 90000, null)`,
    [agent],
  );
});
afterAll(async () => { await stop(); });

describe('memory-metrics.sql', () => {
  it('has the named statements', () => {
    expect(statements.map((s) => s.name)).toEqual([
      'memory_by_agent', 'core_size_by_agent', 'recall_use_by_agent', 'distill_batch_size', 'distill_batch_summary',
      'memory_targets_summary', 'bg_runs_by_agent', 'bg_tokens_weekly',
    ]);
  });

  it('every statement runs against the current schema', async () => {
    for (const s of statements) await pool.query(s.text);
  });

  it('memory_by_agent separates kinds and state-like records', async () => {
    const rows = (await pool.query(statements.find((s) => s.name === 'memory_by_agent')!.text)).rows;
    const r = rows.find((x: { handle: string }) => x.handle === 'metrics-agent');
    // mem/policy(#3 policy decision)는 상태가 아니고 mem/ci-glued(#5 CI초록)는 상태다 — CI 는 대문자 낱말로만(security n1).
    expect(r).toMatchObject({ mem_total: '6', topic: '4', procedure: '1', journal: '1', state_like: '3' });
    expect(Number(r.procedure_pct)).toBeCloseTo(20, 1);
    expect(Number(r.state_like_pct)).toBeCloseTo(60, 1);
  });

  it('recall_use_by_agent 는 상태 기록 비율을 준다(recall_count 합 기준)', async () => {
    const r = (await pool.query(statements.find((s) => s.name === 'recall_use_by_agent')!.text)).rows
      .find((x: { handle: string }) => x.handle === 'metrics-agent');
    // recall 6(3+1+2) 중 상태 기록 4(delegation-x 3 + deploy 1).
    expect(r).toMatchObject({ recalls: '6', state_like_recalls: '4' });
    expect(Number(r.state_like_recall_pct)).toBeCloseTo(66.7, 1);
  });

  it('memory_targets_summary 는 전체 procedure 비율·recall 중 상태 기록 비율을 한 줄로', async () => {
    const [r] = (await pool.query(statements.find((s) => s.name === 'memory_targets_summary')!.text)).rows;
    expect(Number(r.procedure_pct)).toBeCloseTo(20, 1); // 지식 5개 중 procedure 1
    expect(Number(r.state_like_recall_pct)).toBeCloseTo(66.7, 1);
  });

  it('bg_runs_by_agent 는 증류 수율·되돌리기 비율·토큰을 종류별로', async () => {
    const rows = (await pool.query(statements.find((s) => s.name === 'bg_runs_by_agent')!.text)).rows
      .filter((x: { handle: string }) => x.handle === 'metrics-agent');
    const d = rows.find((x: { kind: string }) => x.kind === 'distill');
    expect(d).toMatchObject({ runs: '5', done: '4', failed: '1', skipped: '0', reverted: '1', tokens: '3800' });
    expect(Number(d.yield_pct)).toBeCloseTo(75, 1); // done 4 중 쓰기 있음 3
    expect(Number(d.revert_pct)).toBeCloseTo(33.3, 1); // 쓰기 있던 done 3 중 되돌림 1
    expect(Number(d.avg_writes)).toBeCloseTo(1.5, 1);
    expect(rows.find((x: { kind: string }) => x.kind === 'cleanup')).toMatchObject({ runs: '1', done: '1', tokens: '4000' });
  });

  it('bg_tokens_weekly 는 주별 토큰 합', async () => {
    const rows = (await pool.query(statements.find((s) => s.name === 'bg_tokens_weekly')!.text)).rows
      .filter((x: { handle: string }) => x.handle === 'metrics-agent');
    expect(rows.reduce((n: number, x: { tokens: string }) => n + Number(x.tokens), 0)).toBe(7800);
    expect(rows.reduce((n: number, x: { runs: string }) => n + Number(x.runs), 0)).toBe(6);
  });
});
