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
       ($1, 'mem/log', 'v', null, 'journal', 0)`,
    [agent],
  );
});
afterAll(async () => { await stop(); });

describe('memory-metrics.sql', () => {
  it('has the named statements', () => {
    expect(statements.map((s) => s.name)).toEqual([
      'memory_by_agent', 'core_size_by_agent', 'recall_use_by_agent', 'distill_batch_size', 'distill_batch_summary',
    ]);
  });

  it('every statement runs against the current schema', async () => {
    for (const s of statements) await pool.query(s.text);
  });

  it('memory_by_agent separates kinds and state-like records', async () => {
    const rows = (await pool.query(statements.find((s) => s.name === 'memory_by_agent')!.text)).rows;
    const r = rows.find((x: { handle: string }) => x.handle === 'metrics-agent');
    expect(r).toMatchObject({ mem_total: '4', topic: '2', procedure: '1', journal: '1', state_like: '2' });
    expect(Number(r.procedure_pct)).toBeCloseTo(33.3, 1);
    expect(Number(r.state_like_pct)).toBeCloseTo(66.7, 1);
  });
});
