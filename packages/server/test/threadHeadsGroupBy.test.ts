import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { MessageRow } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { THREAD_HEADS_LATERAL_SQL, THREAD_HEADS_SQL } from '../src/services/messages.js';

/**
 * 스레드 머리 문장(`THREAD_HEADS_SQL`)의 group-by 꼴이 옛 lateral 꼴(`THREAD_HEADS_LATERAL_SQL`)과 **행마다 같은가**(s39 E1).
 *
 * 왜: 머리 집계를 「머리마다 lateral 셋」에서 「스레드 줄을 한 번 모아 루트로 group by」로 바꿨다. 판정 문장은 옮겨 적었지만
 * 빈 집계의 값(0·`'{}'`·`'[]'`)·지운 머리·묶음으로 옮겨 간 물음·풀린 실패·위임 마디의 순서가 하나라도 어긋나면 보드의 열이 바뀐다.
 * 같은 픽스처·같은 인자로 두 문장을 돌려 결과 전체를 견준다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminId: string;
let botId: string;
let channelId: string;
let privateId: string;
const ids: string[] = [];

async function insert(body: string, opts: { root?: string | null; meta?: object; kind?: string; author?: string | null; channel?: string } = {}) {
  const r = await pool.query(
    `insert into message (channel_id, author_id, body, kind, meta, thread_root_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [opts.channel ?? channelId, opts.author === undefined ? adminId : opts.author, body, opts.kind ?? 'user',
      JSON.stringify(opts.meta ?? {}), opts.root ?? null],
  );
  return r.rows[0].id as string;
}

const ask = (to: object, extra: object = {}) => ({ kind: 'ask', ask: { options: [{ id: 'a', label: '가' }], to, ...extra } });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  adminId = admin.accountId;
  ({ accountId: botId } = await createAgent(app, admin.token, 'headsbot'));
  const mk = async (name: string, visibility?: string) => (await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${admin.token}` },
    payload: visibility ? { name, visibility } : { name },
  })).json().id as string;
  channelId = await mk('heads-groupby');
  privateId = await mk('heads-private', 'private');

  // 재료가 고루 서게 — 물음(사람·계정·답함·닫힘), 실패(풀림·안 풀림·account_gate), 위임 마디, 진행·대기·시스템 줄, 지운 답글.
  for (let i = 0; i < 24; i++) {
    const root = await insert(`머리 ${i}`, { meta: i % 6 === 0 ? ask({ kind: 'human' }) : {}, author: i % 2 ? botId : adminId });
    ids.push(root);
    for (let j = 0; j < 6; j++) {
      const k = (i + j) % 9;
      const author = (i + j) % 3 === 0 ? botId : adminId;
      const meta = k === 0 ? ask({ kind: 'account', accountId: adminId })
        : k === 1 ? { kind: 'failure', failure: { retryable: true } }
          : k === 2 ? { kind: 'delegation', delegation: { open: [adminId, botId] } }
            : k === 3 ? { kind: 'failure', failure: { code: 'account_gate', awaitingAccountId: adminId, retryable: true } }
              : k === 4 ? ask({ kind: 'human' }, { answeredWith: 'a' })
                : k === 5 ? ask({ kind: 'human' }, { closedAt: '2026-11-20T00:00:00Z' })
                  : k === 6 ? { kind: 'report' }
                    : {};
      const kind = k === 7 ? 'progress' : k === 8 ? (j % 2 ? 'wake' : 'system') : 'user';
      const id = await insert(`답글 ${i}.${j}`, { root, meta, kind, author: kind === 'system' ? adminId : author });
      if (i % 5 === 0 && j === 5) await pool.query('update message set deleted_at = now() where id = $1', [id]);
    }
  }
  // 묶음 카드 — 원 스레드(ids[0])의 사람 물음은 묶음으로 옮겨 가 세지 않는다. 묶음 머리 자신도 견줄 머리에 넣는다.
  ids.push(await insert('묶음', { meta: { kind: 'askBundle', askBundle: { items: [{ rootId: ids[0] }, { rootId: 'not-a-uuid' }] } } }));
  // 답글 없는 머리 — 집계가 비었을 때의 값(0·'{}'·'[]')을 견준다.
  ids.push(await insert('외톨이'));
  // 지운 머리 + 살아 있는 답글 — 자리표시자로 남고, 집계는 답글만 센다.
  const gone = await insert('지울 머리', { meta: ask({ kind: 'human' }) });
  await insert('남은 답글', { root: gone, meta: ask({ kind: 'account', accountId: botId }), author: botId });
  await pool.query('update message set deleted_at = now() where id = $1', [gone]);
  ids.push(gone);
  // 지운 머리 + 진행만 남음 — 두 문장 모두 내지 않아야 한다.
  const goneQuiet = await insert('조용히 지울 머리');
  await insert('진행', { root: goneQuiet, kind: 'progress', author: botId });
  await pool.query('update message set deleted_at = now() where id = $1', [goneQuiet]);
  ids.push(goneQuiet);
  // 내가 멤버가 아닌 비공개 채널의 머리 — 거른다. 답글 id·없는 id 도 섞는다(머리가 아니면 내지 않는다).
  await pool.query('delete from channel_member where channel_id = $1 and account_id = $2', [privateId, adminId]);
  const hidden = await insert('비공개 머리', { channel: privateId, author: botId });
  await insert('비공개 답글', { channel: privateId, root: hidden, author: botId });
  ids.push(hidden);
  ids.push((await pool.query('select id from message where thread_root_id = $1 limit 1', [ids[1]])).rows[0].id);
  ids.push('00000000-0000-4000-8000-000000000000');
  await pool.query('analyze message');
}, 120_000);
afterAll(async () => { await app.close(); await stop(); });

describe('THREAD_HEADS_SQL(group by) — 옛 lateral 꼴과 행마다 같다', () => {
  for (const [name, who] of [['사람', () => adminId], ['에이전트', () => botId]] as const) {
    it(`${name} 계정으로 견준다`, async () => {
      const args = [ids, who()];
      const want = (await pool.query(THREAD_HEADS_LATERAL_SQL, args)).rows as MessageRow[];
      const got = (await pool.query(THREAD_HEADS_SQL, args)).rows as MessageRow[];
      expect(got.length).toBeGreaterThan(20);
      expect(got).toEqual(want);
    });
  }

  it('견준 행에 집계가 실제로 실려 있다(빈 값끼리 같아서 통과한 것이 아니다)', async () => {
    const rows = (await pool.query(THREAD_HEADS_SQL, [ids, adminId])).rows as MessageRow[];
    expect(rows.some((r) => (r.replyCount ?? 0) > 0)).toBe(true);
    expect(rows.some((r) => (r.activityCount ?? 0) > (r.replyCount ?? 0))).toBe(true);
    expect(rows.some((r) => (r.participantIds ?? []).length > 1)).toBe(true);
    expect(rows.some((r) => (r.openAskHumanCount ?? 0) > 0)).toBe(true);
    expect(rows.some((r) => (r.openAskAccountIds ?? []).length > 0)).toBe(true);
    expect(rows.some((r) => (r.openGateAccountIds ?? []).length > 0)).toBe(true);
    expect(rows.some((r) => (r.unresolvedFailureCount ?? 0) > 0)).toBe(true);
    expect(rows.some((r) => (r.failureCount ?? 0) > (r.unresolvedFailureCount ?? 0))).toBe(true);
    expect(rows.some((r) => (r.openAskLinks as unknown[] | null ?? []).length > 2)).toBe(true);
    expect(rows.some((r) => r.deletedAt !== null)).toBe(true);
    expect(rows.some((r) => r.replyCount === 0 && r.lastKind !== null)).toBe(true);
    // 비공개 채널 머리·답글 id·없는 id 는 내지 않는다.
    expect(rows.every((r) => r.threadRootId === null && r.channelId === channelId)).toBe(true);
  });
});
