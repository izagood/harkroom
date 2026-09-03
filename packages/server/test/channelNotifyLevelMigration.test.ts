import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { runMigrations } from '../src/db/migrate.js';

/**
 * #224 회귀선 — 024 마이그레이션이 **이미 음소거한 채널을 `none` 으로 옮기는가.**
 *
 * 이것을 확인하지 않으면 배포 순간 모든 음소거가 조용히 풀린다. 사람이 이미 내린 결정을
 * 마이그레이션이 뒤집는 것은 데이터 손실과 같은 종류의 사고다.
 *
 * 확인 방법: 이미 적용된 024 를 **되돌린 뒤**(컬럼 제거 + 적용 기록 삭제) 마이그레이션 이전
 * 상태의 행을 심고 `runMigrations` 를 다시 돌린다. 파일의 `update` 절을 직접 통과시키는
 * 유일한 방법이다 — 이미 마이그레이션이 끝난 DB 에 행을 넣으면 default 'all' 이 붙어서
 * backfill 이 있든 없든 결과가 같아진다.
 */

const MIGRATION = '024_channel_notify_level.sql';

let pool: Pool;
let stop: () => Promise<void>;
let accountId: string;
let mutedChannelId: string;
let plainChannelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;

  const acc = await pool.query(
    `insert into account (handle, display_name, kind, password_hash, is_admin)
     values ('migrator', 'Migrator', 'human', 'x', true) returning id`,
  );
  accountId = acc.rows[0].id;
  const muted = await pool.query(
    `insert into channel (kind, name) values ('standard', 'muted-one') returning id`,
  );
  mutedChannelId = muted.rows[0].id;
  const plain = await pool.query(
    `insert into channel (kind, name) values ('standard', 'plain-one') returning id`,
  );
  plainChannelId = plain.rows[0].id;
});
afterAll(async () => { await stop(); });

describe('024_channel_notify_level', () => {
  it('moves an existing mute to none and leaves the rest at all', async () => {
    // 024 이전 상태로 되돌린다.
    await pool.query('alter table channel_pref drop column notify_level');
    await pool.query('delete from schema_migrations where name = $1', [MIGRATION]);

    await pool.query(
      `insert into channel_pref (account_id, channel_id, muted_at) values ($1, $2, now())`,
      [accountId, mutedChannelId],
    );
    await pool.query(
      `insert into channel_pref (account_id, channel_id, muted_at) values ($1, $2, null)`,
      [accountId, plainChannelId],
    );

    await runMigrations(pool);

    const res = await pool.query(
      `select channel_id, notify_level from channel_pref where account_id = $1`,
      [accountId],
    );
    const byChannel = Object.fromEntries(res.rows.map((r) => [r.channel_id, r.notify_level]));
    expect(byChannel[mutedChannelId]).toBe('none');
    // 음소거하지 않은 채널은 건드리지 않는다 — 마이그레이션이 사람을 조용하게 만들지 않는다.
    expect(byChannel[plainChannelId]).toBe('all');
  });

  it('defaults a brand new pref row to all', async () => {
    const fresh = await pool.query(
      `insert into channel (kind, name) values ('standard', 'fresh-one') returning id`,
    );
    await pool.query(
      `insert into channel_pref (account_id, channel_id) values ($1, $2)`,
      [accountId, fresh.rows[0].id],
    );
    const res = await pool.query(
      `select notify_level from channel_pref where account_id = $1 and channel_id = $2`,
      [accountId, fresh.rows[0].id],
    );
    expect(res.rows[0].notify_level).toBe('all');
  });

  it('rejects a level outside the three', async () => {
    const fresh = await pool.query(
      `insert into channel (kind, name) values ('standard', 'bad-one') returning id`,
    );
    await expect(pool.query(
      `insert into channel_pref (account_id, channel_id, notify_level) values ($1, $2, 'sometimes')`,
      [accountId, fresh.rows[0].id],
    )).rejects.toThrow();
  });
});
