/**
 * 묶음 카드(선택 카드 P1)의 🙋·Inbox 집계 조각(3c, 2026-10-11). 시안 v2 8~13절: **묶음 하나에 한 줄** — 묶음에 담긴
 * 원본 카드는 원 스레드에서 따로 차례를 세우지 않고, 묶음 카드가 열린 줄을 하나라도 가지면 그 묶음 스레드가 한 번 센다.
 *
 * 두 자리(`messages.ts` 의 `THREAD_STATE_FACTS`, `threadStatus.ts` 의 `FACTS_SQL`)가 **같은 판정**을 써야 Inbox 보드와
 * 스레드 상태 리액션이 갈라지지 않는다. 그래서 문장을 여기 하나 두고 둘이 끼워 쓴다.
 *
 * 색인: 마이그레이션 117 의 부분 GIN(`meta->'askBundle'->'items'`, `meta->>'kind' = 'askBundle'`). 아래 `@>` 와 `kind`
 * 조건이 그 색인을 탄다.
 */

/** 이 물음(`alias`)이 지워지지 않은 묶음 카드에 줄로 담겼는가. */
export const bundledRootSql = (alias: string) => `EXISTS (
        SELECT 1 FROM message bnd
         WHERE bnd.meta->>'kind' = 'askBundle' AND bnd.deleted_at IS NULL
           AND bnd.meta->'askBundle'->'items' @> jsonb_build_array(jsonb_build_object('rootId', ${alias}.id::text)))`;

/** 이 글(`alias`)이 **열린 줄을 하나라도 가진** 묶음 카드인가. 줄의 상태는 원본에서 읽는다(정본은 원본). */
export const openBundleSql = (alias: string) => `(${alias}.meta->>'kind' = 'askBundle' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(${alias}.meta->'askBundle'->'items') bi
          JOIN message br ON br.id::text = bi->>'rootId'
         WHERE br.deleted_at IS NULL
           AND br.meta->'ask'->>'answeredWith' IS NULL
           AND br.meta->'ask'->>'closedAt' IS NULL))`;
