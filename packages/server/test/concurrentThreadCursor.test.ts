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
//
// ─────────────────────────────────────────────────────────────────────────────
// **#523 에서 고쳐졌다. 이 파일은 이제 특성화가 아니라 회귀선이다.**
//
// 고침은 `postMessage` 가 `begin` 직후 **insert 보다 앞에서** 채널 단위 advisory lock
// (`pg_advisory_xact_lock('mseq', hashtext(channel_id))`)을 잡는 것이다. seq 를 받은
// 트랜잭션이 커밋할 때까지 같은 채널의 다음 트랜잭션이 seq 를 못 받으므로 **발급 순서와
// 커밋 순서가 같아진다.** 그러면 위에 적은 역전 자체가 성립하지 않는다.
//
// 그래서 아래 ①②의 단언 **방향이 뒤집혔다**:
//   ① 이제 두 게시가 겹쳐도 낮은 seq 가 먼저 커밋된다 — 역전이 관측되지 않는다.
//   ② 그 결과 커서를 전진시켜도 동료의 발화를 건너뛰지 않는다.
// ③(대조군)은 **그대로 두었다** — 고침이 순차 경로를 깨지 않았음을 잰다.
//
// ①②는 `postMessage` 를 통과해야 한다. 날 `insert into message` 로는 락을 안 잡으므로
// (예전 판이 그랬다) 결함이 그대로 재현되고, 그것은 제품 경로가 아니다.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages, lockChannelForSeq, postMessage } from '../src/services/messages.js';

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

/**
 * **동시 게시를 결정적으로 재현한다.**
 *
 * 그냥 `Promise.all([postMessage, postMessage])` 로는 이 결함을 못 잰다 — 실측했다.
 * 두 트랜잭션이 워낙 짧아 대개 줄줄이 끝나 버리고, 고침을 빼도 테스트가 초록으로 남는다
 * (그러면 아무것도 재지 않는 테스트다). 창을 **손으로 벌려야** 한다.
 *
 * 그래서 `postMessage` 의 트랜잭션 모양을 그대로 흉내 낸다:
 *   begin → (고침) 채널 락 → insert(=seq 발급) → **느린 뒷일** → commit
 * 여기서 '느린 뒷일'이 실제의 첨부·멱등성·멘션 팬아웃 구간이다. A 에게만 그 지연을 주면
 * "낮은 seq 가 늦게 커밋된다"가 확정적으로 만들어진다.
 *
 * `useLock` 을 끄면 고침 이전의 코드가 된다 — 되돌려 RED 를 이 스위치로 잰다.
 */
const postLikeProduction = async (
  authorId: string, body: string, holdMs: number, useLock: boolean,
): Promise<number> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (useLock) await lockChannelForSeq(client, channelId);
    const res = await client.query(
      `insert into message (channel_id, thread_root_id, author_id, body, kind)
       values ($1, $2, $3, $4, 'user') returning seq`,
      [channelId, rootId, authorId, body],
    );
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
    await client.query('commit');
    return Number(res.rows[0].seq);
  } finally {
    client.release();
  }
};

/**
 * A(느림) 와 B(빠름) 를 겹친다. 먼저 커밋된 seq 를 `firstCommitted`, 나중 것을
 * `secondCommitted` 로 낸다 — 배열 인덱스로 내면 호출부마다 undefined 를 걷어내야 한다.
 */
const raceTwoPosts = async (useLock: boolean, tag: string): Promise<{
  firstCommitted: number; secondCommitted: number; seqA: number; seqB: number;
}> => {
  const commitOrder: number[] = [];
  const pa = postLikeProduction(agentA, `A ${tag}`, 300, useLock)
    .then((s) => { commitOrder.push(s); return s; });
  // A 가 먼저 seq 를 잡도록 조금 기다렸다 B 를 띄운다.
  await new Promise((r) => setTimeout(r, 50));
  const pb = postLikeProduction(agentB, `B ${tag}`, 0, useLock)
    .then((s) => { commitOrder.push(s); return s; });
  const [seqA, seqB] = await Promise.all([pa, pb]);
  const [firstCommitted, secondCommitted] = commitOrder;
  if (firstCommitted === undefined || secondCommitted === undefined) {
    throw new Error('두 게시가 모두 커밋되지 않았다 — 이 테스트의 전제가 깨졌다');
  }
  return { firstCommitted, secondCommitted, seqA, seqB };
};

describe('#347 기준 10 — 한 스레드에 에이전트 둘이 동시에 답한다', () => {
  it('겹쳐 게시해도 seq 순서와 커밋 순서가 일치한다 — 낮은 seq 가 늦게 보이지 않는다', async () => {
    const { firstCommitted, secondCommitted } = await raceTwoPosts(true, '의 답');

    // **커밋 순서 == seq 오름차순.** 이것이 #523 고침의 본질이다.
    // 고침 전에는 여기서 [높은 seq, 낮은 seq] 가 나왔다 — 역전이다.
    expect(firstCommitted).toBeLessThan(secondCommitted);
  });

  it('동시에 답해도 커서가 동료의 발화를 건너뛰지 않는다 — 기준 10 이 여기서 성립한다', async () => {
    const before = (await readThread(0)).reduce((max, s) => Math.max(max, s), 0);

    // 러너 둘이 동시에 답하는 그 순간. A 는 느리고 B 는 빠르다.
    const { firstCommitted, secondCommitted, seqA, seqB } = await raceTwoPosts(true, '의 두 번째 답');

    // 먼저 커밋된 쪽이 보이는 순간 러너가 폴한다고 하자. 그때의 커서는 이것이다.
    // 락이 있으면 먼저 커밋되는 것은 **더 낮은 seq** 이므로, 이 커서는 아직 다른
    // 쪽을 지나치지 않았다.
    const cursorAtPoll = firstCommitted;

    // 둘 다 커밋된 뒤, 그 커서로 다음 턴이 읽는다.
    const next = await readThread(cursorAtPoll);

    // **고쳐진 지점.** 예전에는 늦게 커밋된 낮은 seq 가 델타에서 영영 빠졌다.
    // 이제 나머지 하나가 반드시 온다.
    expect(next).toContain(secondCommitted);

    // 그리고 스레드 전체에는 당연히 둘 다 있다 — 소실이 아니었음을 계속 가른다.
    const all = await readThread(0);
    expect(all).toContain(seqA);
    expect(all).toContain(seqB);

    // 커서가 뒤로 가지 않는다: 델타 끝까지 올리면 남는 것이 없다(회귀선 3).
    const cursor = next.reduce((max, s) => Math.max(max, s), cursorAtPoll);
    expect(await readThread(cursor)).toEqual([]);
  });

  it('되돌려 RED — 락을 빼면 같은 창에서 역전이 실제로 관측된다', async () => {
    // 이 테스트가 위 둘의 **증거**다. 고침을 뺀 경로(`useLock: false`)로 같은 창을
    // 열면 커밋 순서가 뒤집히고, 그 순간 커서를 올리면 낮은 seq 를 지나친다.
    // 위 둘이 초록인 것이 "창이 안 열려서"가 아니라 "고침이 닫아서"임을 여기서 잰다.
    const before = (await readThread(0)).reduce((max, s) => Math.max(max, s), 0);
    const { firstCommitted, seqA, seqB } = await raceTwoPosts(false, '락 없이');

    // 락이 없으면 B(높은 seq)가 먼저 커밋된다 — 역전이다.
    expect(seqA).toBeLessThan(seqB);
    expect(firstCommitted).toBe(seqB);

    // 그 순간 폴한 러너의 커서는 B 다. 그 커서로 읽으면 A 는 영영 안 온다.
    const next = await readThread(seqB);
    expect(next).not.toContain(seqA);

    // 그러나 스레드에는 있다 — 소실이 아니라 커서가 지나친 것이다.
    const all = await readThread(before);
    expect(all).toContain(seqA);
  });

  it('postMessage 가 실제로 그 락을 잡는다 — 위 둘은 헬퍼를 재므로 제품 경로를 따로 잰다', async () => {
    // ①② 는 `postLikeProduction` 이 락을 잡는다. 그것만으로는 **제품 코드가 락을 잡는지**
    // 를 재지 못한다 — `postMessage` 에서 락 한 줄을 지워도 ①② 는 초록으로 남는다(실측).
    // 그래서 제품 경로가 그 채널 락을 정말 쥐는지 여기서 직접 본다.
    //
    // 방법: 우리가 먼저 그 락을 잡고 `postMessage` 를 띄운다. 제품이 같은 락을 잡으려
    // 한다면 **막혀서 끝나지 않는다.** 우리가 풀어 준 뒤에야 끝난다.
    const holder = await pool.connect();
    let finished = false;
    try {
      await holder.query('begin');
      await lockChannelForSeq(holder, channelId);

      const posting = postMessage(pool, {
        channelId, authorId: agentB, body: '락을 기다린다', threadRootId: rootId,
      }).then((r) => { finished = true; return r; });

      // 락을 쥐고 있는 동안에는 끝나지 못해야 한다.
      await new Promise((r) => setTimeout(r, 250));
      expect(finished).toBe(false);

      // 풀어 주면 곧 끝난다.
      await holder.query('commit');
      const result = await posting;
      expect(result.message).toBeDefined();
      expect(finished).toBe(true);
    } finally {
      holder.release();
    }
  });

  it('채널 조회도 같은 보장을 받는다 — 스레드만 고치면 반쪽이다(messages.ts:629)', async () => {
    // `listMessages` 는 스레드(:591)와 채널(:629) 두 갈래로 `seq > $since` 를 쓴다.
    // 락은 채널 단위이므로 두 갈래가 같이 고쳐지지만, 그것을 **재 두지 않으면**
    // 다음 사람이 한쪽만 보고 안심한다.
    const readChannel = (since: number): Promise<number[]> =>
      listMessages(pool, channelId, { since }).then((rows) => rows.map((r) => Number(r.seq)));

    const before = (await readChannel(0)).reduce((max, s) => Math.max(max, s), 0);

    // 스레드가 아니라 **채널 최상위**로 동시에 올린다(threadRootId 없음).
    const posted = await Promise.all([
      postMessage(pool, { channelId, authorId: agentA, body: 'A 가 채널에 올린다', threadRootId: null }),
      postMessage(pool, { channelId, authorId: agentB, body: 'B 가 채널에 올린다', threadRootId: null }),
    ]);
    const seqs = posted.map((p) => Number(p.message!.seq));

    const delta = await readChannel(before);
    for (const s of seqs) expect(delta).toContain(s);
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
