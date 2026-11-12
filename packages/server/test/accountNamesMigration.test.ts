import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { runMigrations } from '../src/db/migrate.js';

/**
 * 169 회귀선(칩 ②, security #1978) — 지난 실패 글에 남은 claude 계정·풀 **이름**을 지우는가, 그리고 이름이 아닌
 * 것(순번·기본값·다른 글)은 건드리지 않는가. 169 적용 기록을 지우고 이전 꼴의 행을 심은 뒤 다시 돌린다.
 */

const MIGRATION = '169_drop_claude_account_names.sql';
const GATE_HEAD = '(Claude Code 가 설정 확인 화면에서 멈췄습니다. 답해 주세요. 답하면 이 턴이 그 자리에서 이어집니다. 계정: ';

let pool: Pool;
let stop: () => Promise<void>;
let authorId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const acc = await pool.query(
    `insert into account (handle, login_id, display_name, kind, password_hash, is_admin, role)
     values ('scrubber', 'scrubber', 'Scrubber', 'human', 'x', true, 'admin') returning id`,
  );
  authorId = acc.rows[0].id;
  const ch = await pool.query(`insert into channel (kind, name) values ('standard', 'scrub-one') returning id`);
  channelId = ch.rows[0].id;
});
afterAll(async () => { await stop(); });

async function seed(body: string, meta: unknown): Promise<string> {
  const r = await pool.query(
    `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, $3, 'system', $4) returning id`,
    [channelId, authorId, body, JSON.stringify(meta)],
  );
  return r.rows[0].id;
}
async function row(id: string): Promise<{ body: string; meta: { failure?: Record<string, unknown> } }> {
  return (await pool.query('select body, meta from message where id = $1', [id])).rows[0];
}

describe('169_drop_claude_account_names', () => {
  it('scrubs account names from failure bodies, reasons and meta, and leaves the rest alone', async () => {
    await pool.query('delete from schema_migrations where name = $1', [MIGRATION]);

    const gate = await seed(`${GATE_HEAD}work/alice-2)`, {
      kind: 'failure', failure: { retryable: false, code: 'account_gate', account: 'work/alice-2' },
    });
    const gateDefault = await seed(`${GATE_HEAD}(기본))`, { kind: 'failure', failure: { retryable: false } });
    const gateRank = await seed(`${GATE_HEAD}풀 2 · 계정 1)`, { kind: 'failure', failure: { retryable: false } });
    const trailBody = [
      '(사용량 한도에 걸려 답하지 못했습니다.)',
      '계정별 이유:',
      '- alice: 사용량 한도(11pm 에 풀림)',
      '- team/bob-x: 설정 확인 화면에서 사람의 선택을 기다림',
      '- (기본 계정): 로그인이 풀림',
      '- 계정 3: 입력창이 뜨지 않음(시간 초과)',
    ].join('\n');
    const trail = await seed(trailBody, {
      kind: 'failure',
      failure: { retryable: true, reason: 'alice: 사용량 한도 · team/bob-x: 설정 확인 화면에서 사람의 선택을 기다림 · (기본 계정): 로그인이 풀림' },
    });
    // 실패 글이 아니면 같은 꼴이라도 건드리지 않는다.
    const plain = await seed(`${GATE_HEAD}alice)\n- alice: 사용량 한도`, { kind: 'note' });

    await runMigrations(pool);

    const g = await row(gate);
    expect(g.body).toBe(`${GATE_HEAD}(지움))`);
    expect(g.meta.failure).toEqual({ retryable: false, code: 'account_gate' });
    expect((await row(gateDefault)).body).toBe(`${GATE_HEAD}(기본))`);
    expect((await row(gateRank)).body).toBe(`${GATE_HEAD}풀 2 · 계정 1)`);

    const t = await row(trail);
    expect(t.body).toBe([
      '(사용량 한도에 걸려 답하지 못했습니다.)',
      '계정별 이유:',
      '- (지움): 사용량 한도(11pm 에 풀림)',
      '- (지움): 설정 확인 화면에서 사람의 선택을 기다림',
      '- (기본 계정): 로그인이 풀림',
      '- 계정 3: 입력창이 뜨지 않음(시간 초과)',
    ].join('\n'));
    expect(t.meta.failure?.reason).toBe('(지움): 사용량 한도 · (지움): 설정 확인 화면에서 사람의 선택을 기다림 · (기본 계정): 로그인이 풀림');
    expect(JSON.stringify(t)).not.toMatch(/alice|bob-x/);

    expect((await row(plain)).body).toBe(`${GATE_HEAD}alice)\n- alice: 사용량 한도`);
  });
});
