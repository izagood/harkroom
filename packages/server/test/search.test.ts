import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { searchMessages, searchHasMore, SEARCH_MAX_OFFSET } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'archive' },
  });
  channelId = ch.json().id;
  for (const body of ['deploy pipeline is green', 'lunch anyone?', 'pipeline failed again']) {
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
    });
  }
});
afterAll(async () => { await app.close(); await stop(); });

describe('search', () => {
  it('finds messages by word, orders by seq desc, and respects limit', async () => {
    // Test 1: finds messages by word with correct seq desc ordering
    const res = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toHaveLength(2);
    expect(bodies).toContain('deploy pipeline is green');
    expect(bodies).toEqual(['pipeline failed again', 'deploy pipeline is green']); // newest first, seq desc

    // Test 2: limit parameter works (before soft delete, when 2 messages match)
    const allResults = await searchMessages(pool, adminId, 'pipeline');
    const limitedResults = await searchMessages(pool, adminId, 'pipeline', { limit: 1 });
    expect(allResults.messages).toHaveLength(2);
    expect(allResults.hasMore).toBe(false);
    // 잘렸다는 사실이 응답에 실린다 — 팔레트가 '더 보기'를 세울지 판단하는 유일한 근거다.
    expect(limitedResults.messages).toHaveLength(1);
    expect(limitedResults.hasMore).toBe(true);
    // offset 이 그 뒤를 잇는다(정렬이 rank 라 seq 커서는 이 순서에서 뜻이 없다).
    const second = await searchMessages(pool, adminId, 'pipeline', { limit: 1, offset: 1 });
    expect(second.messages[0]!.id).not.toBe(limitedResults.messages[0]!.id);
  });

  /**
   * 부실함의 대부분이 여기였다: `simple` config 는 어간을 떼지 않아 조사 하나가 붙으면
   * tsvector 매치가 통째로 죽는다(실측: '검색을' @@ '검색' → false). 부분문자열 갈래가
   * 그것과 파일명 부분일치를 살린다.
   */
  it('finds Korean words with a particle attached, and partial identifiers', async () => {
    for (const body of ['검색을 켜고 왔다', 'SearchPalette.tsx 를 고쳤다']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    const ko = await app.inject({
      method: 'GET', url: '/search?q=%EA%B2%80%EC%83%89', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ko.json().messages.map((m: { body: string }) => m.body)).toContain('검색을 켜고 왔다');

    const partial = await app.inject({
      method: 'GET', url: '/search?q=SearchPalette', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(partial.json().messages.map((m: { body: string }) => m.body)).toContain('SearchPalette.tsx 를 고쳤다');
  });

  /**
   * `_` 는 like 의 메타문자다("아무 글자 하나"). 이스케이프하지 않으면 `a_b` 로 찾을 때
   * `aXb` 가 딸려 온다 — 사람이 친 글자 그대로 찾는 것이 아니게 된다.
   *
   * 미끼(`zqzaXbzqz`)를 한 낱말로 둔 것은 tsvector 갈래가 이 줄을 대신 맞혀 버리지 않게
   * 하기 위해서다 — 그러면 이스케이프가 깨져도 초록이 된다.
   */
  it('treats like metacharacters in the query as literal text', async () => {
    for (const body of ['token zqza_bzqz here', 'token zqzaXbzqz here']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    const res = await app.inject({
      method: 'GET', url: '/search?q=zqza_bzqz', headers: { authorization: `Bearer ${adminToken}` },
    });
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toContain('token zqza_bzqz here');
    expect(bodies).not.toContain('token zqzaXbzqz here');
  });

  /**
   * 진행 줄은 사람이 찾는 말이 아니다 — 답글 수에서 뺀 것과 같은 목록(shared::countsAsReply).
   * 여기 없으면 에이전트 진행 줄이 상위 N 건을 채워 정작 찾던 말이 응답에 안 들어온다.
   */
  it('leaves progress and wake lines out of the results', async () => {
    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'zebra anchor' },
    });
    await pool.query(
      `insert into message (id, channel_id, thread_root_id, author_id, body, kind)
       values (gen_random_uuid(), $1, $2, $3, 'zebra progress line', 'progress')`,
      [channelId, posted.json().id, adminId],
    );
    const res = await app.inject({
      method: 'GET', url: '/search?q=zebra', headers: { authorization: `Bearer ${adminToken}` },
    });
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toContain('zebra anchor');
    expect(bodies).not.toContain('zebra progress line');
  });

  /** ⌘F 스코프. 루트 자신도 포함한다 — 루트의 말을 못 찾으면 "이 스레드에서 찾기"가 아니다. */
  it('scopes to one thread, root included', async () => {
    const root = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'quokka root' },
    });
    const rootId = root.json().id;
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'quokka reply', threadRootId: rootId },
    });
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'quokka elsewhere' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=quokka&channelId=${channelId}&threadRootId=${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies.sort()).toEqual(['quokka reply', 'quokka root']);
  });

  /**
   * 접두 tsquery(`'검색':*`)로 바꾸면서 **의도해서 잃은 것**이 여기 있다: 2글자 질의의
   * 중간일치(`검색` 으로 `재검색`). like 갈래를 3글자 미만에 걸면 OR 의 한쪽이 인덱스
   * 불가가 되어 tsvector 인덱스까지 함께 버려지고 계획 전체가 순차 스캔이 된다
   * (실측 200k 행: 42.9 ms vs 0.067 ms). 3글자부터는 like 갈래가 그대로 받는다 —
   * 이 테스트가 그 경계를 못박는다. 경계를 옮기려면 위 실측을 다시 재고 옮겨라.
   */
  it('matches prefixes at two characters, and middle matches from three', async () => {
    for (const body of ['재검색을 했다', '재빠르게 검색을 했다']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    const two = await searchMessages(pool, adminId, '검색');
    const twoBodies = two.messages.map((m) => m.body);
    // 접두는 잡는다(조사가 붙어도).
    expect(twoBodies).toContain('재빠르게 검색을 했다');
    // 중간일치는 2글자에서 놓는다 — 값을 아는 채로 둔 구멍이다.
    expect(twoBodies).not.toContain('재검색을 했다');

    // 3글자부터는 like 갈래가 켜져 중간일치가 돌아온다.
    const three = await searchMessages(pool, adminId, '재검색');
    expect(three.messages.map((m) => m.body)).toContain('재검색을 했다');
  });

  /**
   * 낱말이 하나도 안 나오는 질의다. 접두 tsquery 를 만들 때 여기에 `:*` 를 그냥 붙이면
   * `to_tsquery` 가 syntax error 로 터져 **500** 이 된다 — 사람이 칠 수 있는 글자다.
   *
   * **순서까지 보는 이유:** `!!!` 은 3글자라 tsquery 가 null 인 채로 like 갈래만 켜진다 —
   * 정렬 키 둘(`search @@ q`, `ts_rank`)이 **전 행에서 균일하게 null** 이 되는 유일한 구간이고,
   * 그래서 순서가 오직 `seq desc` 로 떨어진다. 아무도 안 보던 자리다(전에는 200 만 봤다).
   * 매치되는 줄을 **둘** 넣는다 — 하나면 어떤 정렬에서도 통과한다.
   *
   * 재 보고 적어 둔다: `coalesce(…, ''::tsquery)` 로 되돌려도 이 순서는 **안 바뀐다**
   * (키가 균일 `false` 로 바뀔 뿐이라 마찬가지로 `seq desc` 로 떨어진다 — 실측으로 확인했다).
   * 그러니 이 테스트는 그 되돌림의 가드가 아니라, **정렬 키를 건드리는** 변경의 가드다.
   * 되돌림을 잡는 것은 아래 notice 테스트다.
   */
  it('answers a query that yields no lexemes, newest first', async () => {
    const res = await app.inject({
      method: 'GET', url: '/search?q=%21%21%21', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    for (const body of ['먼저 쓴 줄 !!!', '나중에 쓴 줄 !!!']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    const mine = ['먼저 쓴 줄 !!!', '나중에 쓴 줄 !!!'];
    const rows = (await searchMessages(pool, adminId, '!!!')).messages
      .filter((m) => mine.includes(m.body));
    expect(rows.map((m) => m.body)).toEqual(['나중에 쓴 줄 !!!', '먼저 쓴 줄 !!!']);
    expect(rows[0]!.seq).toBeGreaterThan(rows[1]!.seq);
  });

  /**
   * **접두 히트가 like 중간일치-only 앞에 온다**는 계약을 본다. 순서만 다르고 결과 집합은
   * 같으므로 다른 테스트로는 안 잡힌다. 먼저 쓴 줄이 접두 히트, 나중에 쓴 줄이 중간일치-only
   * 라서, 순위가 사라져 `seq desc` 로만 떨어지면 **나중 것이 먼저** 와 뒤집힌다 — 이 검색이
   * 원래 앓던 병(흔한 낱말이면 상위 N 이 전부 최근 것)이 바로 그 꼴이다.
   *
   * 어느 키가 그 일을 하는지도 재 봤다(200k 프로브 아님, 값 자체): 정렬 첫 키
   * `(search @@ q) desc` 는 **두 번째 키 `ts_rank` 와 겹친다** — 매치되는 행의 ts_rank 는
   * 0.0607927, 안 되는 행은 정확히 0 이라 rank 만으로도 이 둘이 갈린다. 그래서 첫 키만
   * 빼서는 이 테스트가 안 빨개진다(확인함). 빨개지는 것은 **순위 자체를 잃을 때**다
   * (`order by m.seq desc` 만 남기면 뒤집힌다 — 확인함). 첫 키는 의도를 적어 두는 값이지
   * 이 테스트가 강제하는 대상이 아니다.
   */
  it('puts prefix hits ahead of middle-match-only rows', async () => {
    for (const body of ['kumquatzz 라는 낱말', 'xkumquatzzy 는 중간일치만']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    const rows = (await searchMessages(pool, adminId, 'kumquatzz')).messages;
    expect(rows.map((m) => m.body)).toEqual(['kumquatzz 라는 낱말', 'xkumquatzzy 는 중간일치만']);
    // 접두 히트가 더 **오래된** 줄이다 — 최신순만 남으면 이 순서가 뒤집힌다.
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
  });

  /**
   * `PREFIX_TSQUERY` 를 `coalesce(…, ''::tsquery)` 로 받으면 **빈 tsquery 리터럴이 파싱 시점에
   * 평가돼**, 낱말이 멀쩡히 있는 정상 질의에도 검색마다 pg 로그에 한 줄이 남는다
   * (`text-search query doesn't contain lexemes: ""`). 로그를 읽는 사람에게 "이 질의엔 낱말이
   * 없었다"로 보여 오해를 준다 — 결과에는 아무 흔적이 없어 다른 테스트로는 안 잡힌다.
   *
   * 풀이 아니라 **클라이언트 하나를 잡고** 듣는 이유: `notice` 는 연결 단위 이벤트라
   * 풀에서는 어느 연결이 쿼리를 받을지 모른다. 잡은 그 연결로 검색을 돌려야 확실하다.
   */
  it('leaves no notice behind for an ordinary query', async () => {
    const client = await pool.connect();
    const notices: string[] = [];
    client.on('notice', (n) => notices.push(n.message ?? ''));
    try {
      // 낱말이 있는 평범한 질의다 — 여기서 NOTICE 가 나면 그건 빈 리터럴이 낸 것이다.
      const found = await searchMessages(client as unknown as Pool, adminId, 'pipeline');
      expect(found.messages.length).toBeGreaterThan(0);
    } finally {
      client.removeAllListeners('notice');
      client.release();
    }
    expect(notices).toEqual([]);
  });

  /**
   * 접두를 **`websearch_to_tsquery` 의 text 꼴 위에** 얹는 이유가 이 넷이다. 낱말을
   * `tsvector_to_array` 로 날것으로 꺼내 이어 붙이는(더 "간단한") 꼴로 되돌리면 구·`or` 는
   * 그냥 AND 가 되고 **부정은 제외에서 요구로 뒤집힌다** — 조용히 반대 답을 준다. 그런데
   * 나머지 테스트는 전부 초록이다. 그래서 여기서 못박는다.
   */
  it('keeps websearch operators — phrase, or, negation — through the prefix rewrite', async () => {
    for (const body of ['zonkfruit zebrafish together', 'zebrafish zonkfruit reversed', 'zonkfruit alone here']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    // 구: 붙어 있는 것만. 순서가 뒤집힌 줄은 안 걸린다(`<->` 가 살아 있다).
    const phrase = await searchMessages(pool, adminId, '"zonkfruit zebrafish"');
    const phraseBodies = phrase.messages.map((m) => m.body);
    expect(phraseBodies).toContain('zonkfruit zebrafish together');
    expect(phraseBodies).not.toContain('zebrafish zonkfruit reversed');

    // or: 둘 중 하나만 있어도 걸린다(AND 로 접히지 않는다).
    const or = await searchMessages(pool, adminId, 'zonkfruit or zebrafish');
    expect(or.messages.map((m) => m.body)).toContain('zonkfruit alone here');

    // 부정: 뺀 낱말이 든 줄이 결과에 **없어야** 한다. 뒤집히면 정확히 그것만 나온다.
    const not = await searchMessages(pool, adminId, 'zonkfruit -zebrafish');
    const notBodies = not.messages.map((m) => m.body);
    expect(notBodies).toContain('zonkfruit alone here');
    expect(notBodies).not.toContain('zonkfruit zebrafish together');
  });

  /**
   * 채팅 검색에 URL 은 흔히 들어온다. lexeme 안에 `!`·`(`·`&` 가 그대로 들어 있어서,
   * 낱말을 날것으로 이어 붙이는 꼴이면 `to_tsquery` 가 그걸 다시 파싱하다 **500** 이 난다.
   */
  it('answers a pasted URL query', async () => {
    const url = 'http://x.com/zonkpath?b=1&c=2';
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: `보다가 ${url} 를 붙였다` },
    });
    const res = await app.inject({
      method: 'GET', url: `/search?q=${encodeURIComponent(url)}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages.map((m: { body: string }) => m.body)).toContain(`보다가 ${url} 를 붙였다`);
  });

  /**
   * 라우트의 offset 천장과 `hasMore` 는 **같은 값을 봐야 한다.** 어긋나면 마지막 페이지에도
   * '더 보기'가 서고, 누르는 순간 천장을 넘은 offset 이 나가 400 을 받는다.
   */
  it('stops offering more at the offset ceiling, and the route refuses past it', async () => {
    expect(searchHasMore(51, 50, 0)).toBe(true);
    expect(searchHasMore(51, 50, SEARCH_MAX_OFFSET - 50)).toBe(true);
    expect(searchHasMore(51, 50, SEARCH_MAX_OFFSET)).toBe(false);

    const res = await app.inject({
      method: 'GET', url: `/search?q=pipeline&offset=${SEARCH_MAX_OFFSET + 50}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('excludes deleted messages', async () => {
    // Get a message to delete
    const res = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    const pipelineMessages = res.json().messages;
    const messageToDelete = pipelineMessages[0];

    // Soft delete the message
    await pool.query('update message set deleted_at = now() where id = $1', [messageToDelete.id]);

    // Verify deleted message is excluded from search
    const afterDelete = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(afterDelete.json().messages).toHaveLength(1);
    expect(afterDelete.json().messages[0].body).toBe('deploy pipeline is green');
  });
});
