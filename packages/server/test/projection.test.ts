import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { startFakeAvcs } from './helpers/fakeAvcsServer.js';
import { httpAvcsClient } from '../src/avcs/client.js';
import { ProjectionWorker, ensureSystemAccount } from '../src/avcs/projection.js';
import { createChannel } from '../src/services/channels.js';

let pool: Pool;
let stop: () => Promise<void>;
let fake: Awaited<ReturnType<typeof startFakeAvcs>>;
let worker: ProjectionWorker;
let channelId: string;
const REPO = 'proj-repo';

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  fake = await startFakeAvcs();
  const systemAccountId = await ensureSystemAccount(pool);
  worker = new ProjectionWorker({ pool, avcs: httpAvcsClient(fake.url), systemAccountId });
  channelId = (await createChannel(pool, { name: 'proj', repo: REPO })).id;
});
afterAll(async () => { await fake.close(); await stop(); });

const messages = async () =>
  (await pool.query(
    `select body, kind, thread_root_id as root, meta from message where channel_id = $1 order by seq`,
    [channelId],
  )).rows;

describe('projection', () => {
  it('intent creates system message + work_thread; ops merge into one thread message', async () => {
    fake.push(REPO, { oid: 'i1', type: 'intent', actorKeyId: 'k9', intentOid: 'i1', summary: 'fix bug' });
    fake.push(REPO, { oid: 'op1', type: 'operation', actorKeyId: 'k9', intentOid: 'i1', summary: 'put_file a' });
    fake.push(REPO, { oid: 'op2', type: 'operation', actorKeyId: 'k9', intentOid: 'i1', summary: 'put_file b' });
    const applied = await worker.runOnce(REPO, channelId);
    expect(applied).toBe(3);

    const rows = await messages();
    expect(rows).toHaveLength(2); // intent 1 + 병합된 operation 1
    expect(rows[0].body).toContain('fix bug');
    expect(rows[0].body).toContain('외부 작업자(k9)'); // 미등록 키 → 외부 작업자 분기
    expect(rows[1].body).toContain('2 operations');
    expect(rows[1].root).not.toBeNull(); // 작업 스레드에 붙음
    expect(rows[1].meta.oid).toBe('op2'); // 병합 메시지의 대표 oid = 배치 내 마지막 op

    const wt = await pool.query(`select 1 from work_thread where repo = $1 and intent_oid = 'i1'`, [REPO]);
    expect(wt.rowCount).toBe(1);
  });

  it('is idempotent: rerun from cursor 0 does not duplicate', async () => {
    await pool.query(`update projection_cursor set last_log_index = 0 where repo = $1`, [REPO]);
    await worker.runOnce(REPO, channelId);
    expect(await messages()).toHaveLength(2);
  });

  it('decision lands in the work thread; finalize lands at channel level', async () => {
    fake.push(REPO, { oid: 'd1', type: 'decision', actorKeyId: 'k9', intentOid: 'i1', summary: 'kept ours' });
    fake.push(REPO, { oid: 'f1', type: 'finalize', actorKeyId: 'k9', intentOid: null, summary: 'head advanced' });
    await worker.runOnce(REPO, channelId);
    const rows = await messages();
    expect(rows).toHaveLength(4);
    expect(rows[2].body).toContain('kept ours');
    expect(rows[2].root).not.toBeNull();
    expect(rows[3].root).toBeNull();
  });

  it('lease updates active_lease state instead of messages', async () => {
    fake.push(REPO, { oid: 'l1', type: 'lease', actorKeyId: 'k9', intentOid: null, summary: 'lease src/x',
      lease: { path: 'src/x.ts', expiresAt: new Date(Date.now() + 60_000).toISOString(), released: false } });
    await worker.runOnce(REPO, channelId);
    const leases = await pool.query(`select path from active_lease where repo = $1`, [REPO]);
    expect(leases.rows.map((r) => r.path)).toEqual(['src/x.ts']);
    expect(await messages()).toHaveLength(4); // 메시지 증가 없음

    fake.push(REPO, { oid: 'l2', type: 'lease', actorKeyId: 'k9', intentOid: null, summary: 'release src/x',
      lease: { path: 'src/x.ts', expiresAt: new Date().toISOString(), released: true } });
    await worker.runOnce(REPO, channelId);
    const after = await pool.query(`select 1 from active_lease where repo = $1`, [REPO]);
    expect(after.rowCount).toBe(0);
  });

  it('actor label resolves @handle for a registered account_key', async () => {
    const acct = await pool.query(
      `insert into account (handle, display_name, kind) values ('alice', 'Alice', 'human') returning id`,
    );
    await pool.query(
      `insert into account_key (key_id, account_id, public_key_pem) values ('k-alice', $1, 'PEM')`,
      [acct.rows[0].id],
    );
    fake.push(REPO, { oid: 'c1', type: 'checkpoint', actorKeyId: 'k-alice', intentOid: null, summary: 'checkpoint cut' });
    await worker.runOnce(REPO, channelId);
    const rows = await messages();
    expect(rows).toHaveLength(5);
    expect(rows[4].body).toContain('@alice');
  });
});
