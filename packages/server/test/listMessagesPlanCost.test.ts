import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { listMessages, readListRow } from '../src/services/messages.js';

/**
 * 목록 쿼리의 **플래너 추정 비용**이 JIT 문턱 아래에 있는가(2026-10-24).
 *
 * 왜 비용을 재는가: 운영 DB 는 JIT 가 켜져 있고(`jit_above_cost` 10만), 답글 행마다 머리 집계 lateral 을 붙이던 꼴은
 * 실행 6ms 인 스레드 around 하나를 추정 133만으로 만들어 매번 JIT 컴파일에 5초를 썼다. 실행 시간은 그대로라
 * 기능 시험으로는 보이지 않는다 — 계획의 `Total Cost` 를 직접 물어야 다시 새는 것을 잡는다.
 *
 * 응답이 같은가는 **행마다** `readListRow`(한 행을 `THREAD_STATS` 로 곧장 읽는 길)와 견준다 — 답글 갈래(`REPLY_COLS`)와
 * 채널 페이지(`pageWithHeads`)가 머리 집계를 다른 자리에서 붙여도 한 글자도 다르지 않아야 한다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let channelId: string;
let adminId: string;
let bigRoot: string;
const roots: string[] = [];

/** 비용 문턱 — 운영의 `jit_above_cost` 기본값. 이 아래면 JIT 를 아예 고려하지 않는다. */
const JIT_ABOVE_COST = 100_000;

async function insert(body: string, opts: { root?: string | null; meta?: object; kind?: string; alsoInChannel?: boolean } = {}) {
  const r = await pool.query(
    `insert into message (channel_id, author_id, body, kind, meta, thread_root_id, also_in_channel)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, seq::int as seq`,
    [channelId, adminId, body, opts.kind ?? 'user', JSON.stringify(opts.meta ?? {}), opts.root ?? null, opts.alsoInChannel ?? false],
  );
  return r.rows[0] as { id: string; seq: number };
}

const ask = (to: object) => ({ kind: 'ask', ask: { options: [{ id: 'a', label: '가' }, { id: 'b', label: '나' }], to } });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  adminId = admin.accountId;
  channelId = (await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${admin.token}` }, payload: { name: 'plan-cost' },
  })).json().id;

  // 스레드 상태 재료가 고루 서게 심는다 — 미답 물음(사람·계정)·안 풀린 실패·풀린 실패·묶음 카드·위임·지운 머리.
  for (let i = 0; i < 40; i++) {
    const root = await insert(`머리 ${i}`, i % 5 === 0 ? { meta: ask({ kind: 'human' }) } : {});
    roots.push(root.id);
    for (let j = 0; j < 4; j++) {
      const k = (i + j) % 6;
      const meta = k === 0 ? ask({ kind: 'account', accountId: adminId })
        : k === 1 ? { kind: 'failure', failure: { retryable: true } }
          : k === 2 ? { kind: 'delegation', delegation: { open: [adminId] } }
            : {};
      await insert(`답글 ${i}.${j}`, { root: root.id, meta, kind: k === 3 ? 'progress' : 'user', alsoInChannel: j === 0 && i % 7 === 0 });
    }
  }
  // 열린 물음을 담은 묶음 카드 하나(공개 standard 채널) — 원 스레드의 물음은 묶음으로 옮겨 가 세지 않는다.
  await insert('묶음', { meta: { kind: 'askBundle', askBundle: { items: [{ rootId: roots[0] }, { rootId: 'not-a-uuid' }] } } });
  // 지운 머리 + 살아 있는 답글 — 자리표시자로 남는다.
  const gone = await insert('지울 머리');
  await insert('남은 답글', { root: gone.id });
  await pool.query(`update message set deleted_at = now() where id = $1`, [gone.id]);

  // 신고된 스레드(답글 339)와 같은 꼴 — 답글이 limit 보다 많다.
  bigRoot = (await insert('긴 스레드', { meta: ask({ kind: 'human' }) })).id;
  for (let j = 0; j < 400; j++) {
    await insert(`긴 답글 ${j}`, { root: bigRoot, kind: j % 9 === 0 ? 'progress' : 'user', meta: j % 50 === 0 ? { kind: 'failure', failure: { retryable: true } } : {} });
  }
  await pool.query('analyze message');
}, 120_000);
afterAll(async () => { await app.close(); await stop(); });

/** listMessages 가 보낸 질의를 붙잡아 같은 인자로 계획을 묻는다. */
async function listWithCost(opts: Parameters<typeof listMessages>[2]) {
  let sent: { text: string; values: unknown[] } | null = null;
  const spy = { query: (text: string, values: unknown[]) => { sent = { text, values }; return pool.query(text, values); } } as unknown as Pool;
  const rows = await listMessages(spy, channelId, opts);
  const { text, values } = sent!;
  const plan = await pool.query(`explain (format json) ${text}`, values);
  const cost = (plan.rows[0]['QUERY PLAN'] as { Plan: { 'Total Cost': number } }[])[0]!.Plan['Total Cost'];
  return { rows, cost };
}

const seqOf = async (rootId: string, offset: number) =>
  (await pool.query(`select seq::int as seq from message where thread_root_id = $1 order by seq offset $2 limit 1`, [rootId, offset])).rows[0].seq as number;

describe('listMessages — 추정 비용이 JIT 문턱 아래, 응답은 한 행씩 읽은 것과 같다', () => {
  const cases: [string, () => Promise<Parameters<typeof listMessages>[2]>][] = [
    ['스레드 첫 페이지', async () => ({ threadRootId: bigRoot, limit: 200 })],
    ['스레드 around', async () => ({ threadRootId: bigRoot, around: await seqOf(bigRoot, 200), limit: 200 })],
    ['스레드 before', async () => ({ threadRootId: bigRoot, before: await seqOf(bigRoot, 300), limit: 200 })],
    ['스레드 since', async () => ({ threadRootId: bigRoot, since: 1, limit: 200 })],
    ['스레드 since(루트 뒤)', async () => ({ threadRootId: bigRoot, since: await seqOf(bigRoot, 10), limit: 50 })],
    ['채널 첫 페이지', async () => ({ limit: 500 })],
    ['채널 before', async () => ({ before: await seqOf(bigRoot, 100), limit: 500 })],
    ['채널 before(feed)', async () => ({ before: await seqOf(bigRoot, 100), limit: 500, feed: true })],
    ['채널 around', async () => ({ around: await seqOf(roots[20]!, 0), limit: 200 })],
    ['채널 since', async () => ({ since: 1, limit: 500 })],
  ];

  for (const [name, make] of cases) {
    it(name, async () => {
      const { rows, cost } = await listWithCost(await make());
      expect(rows.length).toBeGreaterThan(0);
      expect(cost).toBeLessThan(JIT_ABOVE_COST);
      // 순서는 seq 오름차순 그대로.
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.seq).toBeGreaterThan(rows[i - 1]!.seq);
      // 행마다 한 행 읽기와 같다 — 머리의 집계도, 답글의 null 도.
      for (const row of rows) expect(row).toEqual(await readListRow(pool, channelId, row.id));
    });
  }

  it('견준 행에 머리 집계가 실제로 실려 있다(빈 값끼리 같아서 통과한 것이 아니다)', async () => {
    const { rows } = await listWithCost({ limit: 500 });
    const heads = rows.filter((r) => r.threadRootId === null);
    expect(heads.some((r) => (r.replyCount ?? 0) > 0)).toBe(true);
    expect(heads.some((r) => (r.openAskHumanCount ?? 0) > 0)).toBe(true);
    expect(heads.some((r) => (r.unresolvedFailureCount ?? 0) > 0)).toBe(true);
    expect(heads.some((r) => (r.openAskAccountIds ?? []).length > 0)).toBe(true);
    expect(heads.some((r) => (r.openAskLinks as unknown[] | null ?? []).length > 0)).toBe(true);
    expect(heads.some((r) => r.deletedAt !== null)).toBe(true);
    for (const r of rows.filter((x) => x.threadRootId !== null)) {
      expect(r.replyCount).toBeNull();
      expect(r.lastKind).toBeNull();
    }
  });
});
