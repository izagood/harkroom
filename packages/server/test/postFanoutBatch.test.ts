// 글 올리기의 부름 팬아웃을 묶어서 넣는다(2026-10-13 쿼리 개선 Q3) — 동시성 회귀선.
//
// `postMessage` 는 채널 seq 락을 **커밋까지** 쥔다(#523, concurrentThreadCursor.test). 그 안에서 받는 사람마다 질의 셋
// (inbox·푸시 job·숨김 되돌리기)을 내던 것을 `insertInboxMany` 의 질의 셋으로 줄였다. 이 파일은 그 바꿈이 규칙을
// 바꾸지 않았는지, 그리고 여러 글이 **동시에** 몰려도 그런지 잰다:
//   ① 받는 사람마다 정확히 한 줄(중복·누락 없음), 작성자 자신은 없음
//   ② 차단(109)한 사람은 받지 않음
//   ③ 기기가 있는 사람에게만 푸시 job 이 inbox 줄마다 하나
//   ④ 숨긴 채널은 부름으로 다시 보임(#376)
//   ⑤ 동시에 몰린 글을 커서로 따라 읽어도 건너뛰는 글이 없음(#523 이 그대로 섬)
//   ⑥ 본문에 같은 사람을 두 번 불러도 한 줄
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { listMessages, postMessage } from '../src/services/messages.js';

let app: FastifyInstance; let pool: Pool; let stop: () => Promise<void>;
let adminToken: string; let adminId: string;
const members: { id: string; handle: string }[] = [];
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  for (let i = 0; i < 6; i++) {
    const m = await createMember(app, adminToken, `fan${i}`);
    members.push({ id: m.accountId, handle: `fan${i}` });
  }
  channelId = (await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'fanout' },
  })).json().id;
  // fan0 은 admin 을 차단했다 — admin 의 글로는 부름을 받지 않는다.
  await pool.query(`insert into account_block (blocker_id, blocked_id) values ($1, $2)`, [members[0]!.id, adminId]);
  // fan1 은 이 채널을 숨겼다.
  await pool.query(`insert into channel_pref (account_id, channel_id, hidden_at) values ($1, $2, now())`, [members[1]!.id, channelId]);
  // fan2 는 폰이 있다.
  const sess = (await pool.query(`select token_hash from session where account_id = $1 limit 1`, [members[2]!.id])).rows[0];
  await pool.query(
    `insert into push_device (account_id, session_token_hash, platform, apns_env, token, prefs)
     values ($1, $2, 'ios', 'sandbox', $3, '{}'::jsonb)`,
    [members[2]!.id, sess.token_hash, 'a'.repeat(64)]);
});
afterAll(async () => { await app.close(); await stop(); });

describe('부름 팬아웃 묶음 넣기 (Q3)', () => {
  it('@channel 글 여럿이 동시에 몰려도 받는 사람마다 한 줄 · 차단·푸시·숨김 규칙 그대로 · 커서가 건너뛰지 않는다', async () => {
    const authors = [adminId, members[3]!.id, members[4]!.id];
    const N = 12;
    // ⑤ 커서 읽기: 쓰는 동안 계속 since 로 따라간다.
    const seen = new Set<string>();
    let cursor = (await pool.query(`select coalesce(max(seq), 0)::int as s from message where channel_id = $1`, [channelId])).rows[0].s as number;
    let writing = true;
    const reader = (async () => {
      while (writing) {
        const rows = await listMessages(pool, channelId, { since: cursor, limit: 500 });
        for (const r of rows) { seen.add(r.id); cursor = Math.max(cursor, r.seq); }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const posted = await Promise.all(Array.from({ length: N }, (_, i) =>
      postMessage(pool, { channelId, authorId: authors[i % authors.length]!, threadRootId: null, body: `@channel 공지 ${i}`, meta: {} })));
    writing = false; await reader;
    for (const r of await listMessages(pool, channelId, { since: cursor, limit: 500 })) seen.add(r.id);
    const ids = posted.map((p) => (p as { message: { id: string } }).message.id);
    expect(ids.every((id) => seen.has(id))).toBe(true);

    const everyone = [adminId, ...members.map((m) => m.id)];
    for (let i = 0; i < N; i++) {
      const author = authors[i % authors.length]!;
      const rows = (await pool.query(`select account_id from inbox where message_id = $1`, [ids[i]])).rows.map((r) => r.account_id as string);
      // ① 한 줄씩, 작성자 없음
      expect(new Set(rows).size).toBe(rows.length);
      expect(rows).not.toContain(author);
      // ② 차단: admin 의 글이면 fan0 은 없다
      const expected = everyone.filter((a) => a !== author && !(author === adminId && a === members[0]!.id));
      expect([...rows].sort()).toEqual([...expected].sort());
      // ③ 푸시: fan2 에게 inbox 줄마다 하나
      const jobs = (await pool.query(`select account_id from push_job where message_id = $1`, [ids[i]])).rows.map((r) => r.account_id);
      expect(jobs).toEqual([members[2]!.id]);
    }
    // ④ 숨김이 풀렸다
    const pref = (await pool.query(`select hidden_at from channel_pref where account_id = $1 and channel_id = $2`, [members[1]!.id, channelId])).rows[0];
    expect(pref.hidden_at).toBeNull();
  });

  it('본문에 같은 사람을 두 번 불러도 inbox 는 한 줄이고, 순서는 본문 순서다', async () => {
    const r = await postMessage(pool, {
      channelId, authorId: adminId, threadRootId: null, meta: {},
      body: `@fan5 @fan3 @fan5 @fan4 봐 줘`,
    });
    const id = (r as { message: { id: string } }).message.id;
    const rows = (await pool.query(`select a.handle from inbox i join account a on a.id = i.account_id where i.message_id = $1 order by i.id`, [id])).rows.map((x) => x.handle);
    expect(rows).toEqual(['fan5', 'fan3', 'fan4']);
  });
});
