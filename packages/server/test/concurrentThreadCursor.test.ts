// #347 — 스펙 §14 기준 10 의 **서버 쪽 절반**을 잰다.
//
// 기준 10 은 "한 스레드에 에이전트 둘이 각자 세션·workspace 로 **동시에** 답하고, 다음
// 턴에 서로의 발화를 안다"이다. 그 중 "서로의 발화를 안다"는 러너가 스레드를 어떻게
// 읽느냐에 달려 있고, 러너의 읽기는 커서 하나다 —
// `murmur.ts::readThread(channelId, threadRootId, since)` → `message.read` →
// `listMessages` 의 `m.seq > $since`(services/messages.ts:591).
//
// **왜 단위 테스트가 이것을 못 잡는가**(스펙 §10 이 경고한 자리 그대로다). 러너의 큐잉·
// 클램프·프롬프트 조립은 단위 3건이 이미 초록이고, 그것들은 전부 `seq` 를 **주어진 값**
// 으로 받는다. 여기서 깨지는 것은 그 위층이다: `message.seq` 는 채널별이 아니라 전역
// `generated always as identity`(001_init.sql:57) 이고, identity 는 **트랜잭션 밖에서**
// 값을 뽑는다. 즉 seq 를 먼저 받은 트랜잭션이 나중에 커밋할 수 있다.
//
// `postMessage`(services/messages.ts:288)의 트랜잭션은 짧지 않다 — `insert into message`
// 로 seq 를 점유한 뒤에도 첨부 처리·idempotency 기록·멘션 fan-out(inbox 행 생성)이
// 남아 있다. 에이전트 둘이 같은 스레드에 동시에 답하면 그 구간이 통째로 겹친다.
//
// 그때 나는 일이 이것이다: **B(높은 seq)가 먼저 커밋되고 A(낮은 seq)가 아직 안 보이는
// 순간**에 러너가 스레드를 읽으면, 커서가 B 로 전진한다. 그 뒤 A 가 커밋돼도 커서는
// 이미 A 를 지나쳤으므로 `seq > B` 는 A 를 **영원히** 반환하지 않는다. 동료의 발화가
// 조용히 사라지고, 기준 10 의 "서로의 발화를 안다"가 무너진다.
//
// 이 파일은 그 창을 실제 Postgres 트랜잭션 둘로 열어 재현한다. 앱도 러너도 띄우지
// 않는다 — 커서 규칙은 전부 서버가 정하기 때문이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages, postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let agentA: string;
let agentB: string;
let channelId: string;
let rootId: string;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: agentA } = await createAgent(app, adminToken, 'alpha'));
  ({ accountId: agentB } = await createAgent(app, adminToken, 'bravo'));

  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'concurrent' },
  });
  channelId = ch.json().id as string;

  // 스레드 루트 하나 — 사람이 에이전트 둘을 같은 스레드에서 부른 자리다.
  const root = await postMessage(pool, {
    channelId, authorId: agentA, body: '스레드 루트', threadRootId: null,
  });
  rootId = root.message!.id;
});
afterAll(async () => { await app.close(); await stop(); });

/** 러너가 스레드를 읽는 그 경로 — 커서는 `since` 하나다. */
const readThread = (since: number): Promise<number[]> =>
  listMessages(pool, channelId, { threadRootId: rootId, since })
    .then((rows) => rows.map((r) => Number(r.seq)));

describe('#347 기준 10 — 한 스레드에 에이전트 둘이 동시에 답한다', () => {
  it('seq 는 커밋 순서가 아니라 삽입 시도 순서로 발급된다 — 낮은 seq 가 늦게 보일 수 있다', async () => {
    // 트랜잭션 둘을 실제로 겹친다. A 가 먼저 seq 를 뽑고, B 가 그다음을 뽑는다.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('begin');
      await b.query('begin');

      const ra = await a.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind)
         values ($1, $2, $3, 'A 의 답', 'user') returning seq`,
        [channelId, rootId, agentA],
      );
      const rb = await b.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind)
         values ($1, $2, $3, 'B 의 답', 'user') returning seq`,
        [channelId, rootId, agentB],
      );
      const seqA = Number(ra.rows[0].seq);
      const seqB = Number(rb.rows[0].seq);

      // 발급 순서는 A < B 다.
      expect(seqA).toBeLessThan(seqB);

      // 그런데 **B 가 먼저 커밋한다**. 여기가 §14-10 의 창이다 — A 의 fan-out 이
      // 아직 안 끝났을 뿐인데, 스레드에는 B 만 보인다.
      await b.query('commit');

      const midway = await readThread(0);
      expect(midway).toContain(seqB);
      expect(midway).not.toContain(seqA);

      await a.query('commit');
    } finally {
      a.release();
      b.release();
    }
  });

  it('그 창에서 커서를 전진시키면 동료의 발화를 영원히 건너뛴다 — 기준 10 이 여기서 깨진다', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    let seqA = 0;
    let seqB = 0;
    try {
      await a.query('begin');
      await b.query('begin');
      seqA = Number((await a.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind)
         values ($1, $2, $3, 'A 의 두 번째 답', 'user') returning seq`,
        [channelId, rootId, agentA],
      )).rows[0].seq);
      seqB = Number((await b.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind)
         values ($1, $2, $3, 'B 의 두 번째 답', 'user') returning seq`,
        [channelId, rootId, agentB],
      )).rows[0].seq);

      await b.query('commit');

      // 러너가 **바로 이 순간** 폴한다. 커서는 B 까지 전진한다 — 그것이 스레드의
      // 끝으로 보이기 때문이다. 러너는 A 가 존재한다는 것조차 모른다.
      const seen = await readThread(0);
      const cursor = seen.reduce((max, s) => Math.max(max, s), 0);
      expect(cursor).toBe(seqB);
      // 이 순간 A 는 보이지 않는다 — 커서가 A 를 "이미 지난 것"으로 오해하는 근거다.
      expect(seen).not.toContain(seqA);

      await a.query('commit');
    } finally {
      a.release();
      b.release();
    }

    // A 가 커밋됐다. 이제 다음 턴이 그 커서로 읽는다.
    const next = await readThread(seqB);

    // **이것이 결함이다.** A 의 발화는 커밋됐고 스레드에 있는데, 커서보다 seq 가
    // 작아서 다음 턴의 델타에 들어오지 않는다. `#347` 기준 10 의 "다음 턴에 서로의
    // 발화를 알고 있다"가 성립하지 않는다.
    expect(next).not.toContain(seqA);

    // 전체 조회에는 분명히 있다 — 소실이 아니라 **커서가 지나친 것**이다.
    // (둘을 혼동하면 "데이터가 없다"를 찾다가 원인을 못 만난다.)
    const all = await readThread(0);
    expect(all).toContain(seqA);
    expect(all).toContain(seqB);
  });

  it('순차로 답하면 이 문제가 없다 — 2026-09-02 에 닫힌 것이 이쪽이다(roadmap §5)', async () => {
    // 대조군. 로드맵이 "닫힌 것은 순차이고 동시는 별개"라고 구분한 그 순차 경로다.
    // 커밋이 겹치지 않으면 seq 순서와 가시성 순서가 일치해 커서가 아무것도 건너뛰지
    // 않는다 — 즉 위 두 테스트의 실패는 **동시성 고유**이지 커서 규칙 자체의 결함이
    // 아니다.
    const before = (await readThread(0)).reduce((max, s) => Math.max(max, s), 0);

    const first = await postMessage(pool, {
      channelId, authorId: agentA, body: 'A 가 순차로 답한다', threadRootId: rootId,
    });
    const second = await postMessage(pool, {
      channelId, authorId: agentB, body: 'B 가 순차로 답한다', threadRootId: rootId,
    });

    const delta = await readThread(before);
    expect(delta).toContain(Number(first.message!.seq));
    expect(delta).toContain(Number(second.message!.seq));
  });
});
