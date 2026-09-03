// 멘션 토큰(`<@id>`)과 handle 사이를 오가는 **서버 쪽 가장자리**(#271).
//
// 정본은 `<@id>` 다(스펙 2부). 그래서 handle 을 바꿔도 본문을 다시 쓰지 않는다 — 대신
// 가장자리에서만 현재 handle 로 바꿔 준다. 그 가장자리가 셋이고, 셋 다 이 파일을 지난다:
//
//   - 검색어(`GET /search`, MCP `message.search`)  `@handle` → `<@id>`  (질의를 정본에 맞춘다)
//   - MCP 응답(`message.read`·`message.search`·`inbox.*`)  `<@id>` → `@handle`  (에이전트는 handle 로 생각한다)
//   - 데스크탑 화면                                  `<@id>` → `@현재handle`  (`shared` 의 `renderMentions`)
//
// **여기 두 함수를 라우트마다 인라인으로 다시 쓰지 않는다.** 처음 구현이 그렇게 놓였고,
// 세 사본이 각각 `account` 를 통째로 읽으면서 그중 둘은 존재하지 않는 컬럼(`disabled`)을
// 봐서 조용히 500 이 됐다. 규칙이 한 곳에 있으면 그런 어긋남이 생길 자리가 없다.
import type { Pool, PoolClient } from 'pg';
import { denormalizeMentions, mentionedHandles, MENTION_TOKEN_PATTERN, normalizeMentions } from '@murmur/shared';

type Queryable = Pool | PoolClient;

/**
 * 검색어의 `@handle` 을 `<@id>` 로 바꾼다.
 *
 * 계정을 통째로 읽지 않고 **질의에 실제로 나온 handle 만** 찾는다 — 워크스페이스가 커질수록
 * 검색 한 번의 비용이 계정 수에 비례하면 안 된다.
 *
 * 없는 handle 은 글자 그대로 남는다(본문 정규화와 같은 규칙) — 그래야 `@notanaccount` 로
 * 검색한 사람이 그 글자를 담은 메시지를 찾을 수 있다.
 */
export async function normalizeSearchQuery(db: Queryable, query: string): Promise<string> {
  const handles = mentionedHandles(query);
  if (!handles.length) return query;
  const res = await db.query<{ id: string; handle: string }>(
    `select id, lower(handle) as handle from account where lower(handle) = any($1)`, [handles],
  );
  return normalizeMentions(query, new Map(res.rows.map((r) => [r.handle, r.id])));
}

/**
 * MCP 로 나가는 본문의 `<@id>` 를 **현재** handle 로 되돌린다.
 *
 * 본문에 실제로 있는 id 만 조회한다(계정 전체를 읽지 않는다). 제네릭인 이유: 이 함수는
 * `body` 만 건드리므로 나머지 필드의 타입이 호출부에서 그대로 살아 있어야 한다 — 좁게
 * 받으면 `MessageRow` 가 `{ body: string }` 으로 뭉개진 채 응답으로 나간다.
 */
export async function denormalizeBodies<T extends { body: string }>(
  db: Queryable, rows: T[],
): Promise<T[]> {
  const ids = new Set<string>();
  const token = new RegExp(MENTION_TOKEN_PATTERN, 'g');
  for (const row of rows) {
    for (const m of row.body.matchAll(token)) if (m[1]) ids.add(m[1]);
  }
  if (!ids.size) return rows;
  const res = await db.query<{ id: string; handle: string }>(
    `select id, handle from account where id = any($1)`, [[...ids]],
  );
  const idToHandle = new Map(res.rows.map((r) => [r.id, r.handle]));
  return rows.map((row) => ({ ...row, body: denormalizeMentions(row.body, idToHandle) }));
}
