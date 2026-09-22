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
import {
  denormalizeMentions, mentionedHandles, mentionedTargets, mentionTargetKey,
  MENTION_TOKEN_PATTERN, normalizeMentions,
} from '@harkroom/shared';

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
  const map = new Map(res.rows.map((r) => [r.handle, r.id]));
  /**
   * 집합·팀도 본문에서 토큰이 됐으므로(#845) 질의도 같은 모양이어야 한다 — 안 그러면
   * `@팀이름` 으로 검색한 사람이 그 팀을 부른 메시지를 **하나도** 못 찾는다. 본문 저장과
   * 같은 우선순위(계정 > 집합 > 팀)를 쓴다.
   */
  const rest = handles.filter((h) => !map.has(h));
  if (rest.length) {
    const groups = await db.query<{ id: string; handle: string }>(
      `select id, lower(handle) as handle from handle_group where lower(handle) = any($1)`, [rest],
    );
    for (const r of groups.rows) map.set(r.handle, mentionTargetKey('group', r.id));
    const teams = await db.query<{ id: string; name: string }>(
      `select id, lower(name) as name from agent_team where lower(name) = any($1)`, [rest],
    );
    for (const r of teams.rows) if (!map.has(r.name)) map.set(r.name, mentionTargetKey('team', r.id));
  }
  return normalizeMentions(query, map);
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
  const groupIds = new Set<string>();
  const teamIds = new Set<string>();
  const token = new RegExp(MENTION_TOKEN_PATTERN, 'g');
  for (const row of rows) {
    for (const m of row.body.matchAll(token)) if (m[1]) ids.add(m[1]);
    // 집합·팀 토큰(#845). 에이전트가 `@팀이름` 으로 생각하는 것은 계정과 같다 — 되돌려
    // 주지 않으면 프롬프트에 `<@team:uuid>` 라는 뜻 없는 글자가 실린다.
    for (const t of mentionedTargets(row.body)) {
      (t.kind === 'group' ? groupIds : teamIds).add(t.id);
    }
  }
  if (!ids.size && !groupIds.size && !teamIds.size) return rows;
  const idToHandle = new Map<string, string>();
  if (ids.size) {
    const res = await db.query<{ id: string; handle: string }>(
      `select id, handle from account where id = any($1)`, [[...ids]],
    );
    for (const r of res.rows) idToHandle.set(r.id, r.handle);
  }
  if (groupIds.size) {
    const res = await db.query<{ id: string; handle: string }>(
      `select id, handle from handle_group where id = any($1)`, [[...groupIds]],
    );
    for (const r of res.rows) idToHandle.set(mentionTargetKey('group', r.id), r.handle);
  }
  if (teamIds.size) {
    const res = await db.query<{ id: string; name: string }>(
      `select id, name from agent_team where id = any($1)`, [[...teamIds]],
    );
    for (const r of res.rows) idToHandle.set(mentionTargetKey('team', r.id), r.name);
  }
  return rows.map((row) => ({ ...row, body: denormalizeMentions(row.body, idToHandle) }));
}
