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

/**
 * 이 물음(`alias`)의 차례가 **묶음 카드로 옮겨 갔는가** — 그러면 원 스레드에서는 세지 않는다.
 *
 * 옮겨 가는 것은 두 조건을 다 채울 때뿐이다(#1313 security F1). 아니면 원 스레드에서도 계속 센다 — 두 번 서는
 * 쪽으로 실패한다. 차례 표시가 숨는 것(답할 사람이 어디에서도 🙋 를 못 받는 것)이 더 나쁘다.
 * - **묶음이 공개 standard 채널에 있다**(보관되지 않은). 공개 채널은 같은 커뮤니티 사람 모두가 보므로(`channelVisibleSql`)
 *   차례가 옮겨 가도 잃는 사람이 없다. 비공개 채널·DM 에 묶으면 답할 사람이 그 묶음을 못 볼 수 있다.
 * - **권한 요청·머지 거절 카드가 아니다.** 그 결정은 원 스레드에서만 나므로(묶음에서는 링크 줄) 🙋 도 거기 남는다.
 */
export const bundledRootSql = (alias: string) => `(
        NOT (${alias}.meta ? 'permissionRequest' OR ${alias}.meta ? 'mergeDenial')
        AND EXISTS (
          SELECT 1 FROM message bnd
            JOIN channel bc ON bc.id = bnd.channel_id
           WHERE bnd.meta->>'kind' = 'askBundle' AND bnd.deleted_at IS NULL
             AND bc.kind = 'standard' AND bc.visibility = 'public' AND bc.archived_at IS NULL
             AND bnd.meta->'askBundle'->'items' @> jsonb_build_array(jsonb_build_object('rootId', ${alias}.id::text))))`;

/** 이 글(`alias`)이 **열린 줄을 하나라도 가진** 묶음 카드인가. 줄의 상태는 원본에서 읽는다(정본은 원본). */
export const openBundleSql = (alias: string) => `(${alias}.meta->>'kind' = 'askBundle' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(${alias}.meta->'askBundle'->'items') bi
          JOIN message br ON br.id::text = bi->>'rootId'
         WHERE br.deleted_at IS NULL
           AND br.meta->'ask'->>'answeredWith' IS NULL
           AND br.meta->'ask'->>'closedAt' IS NULL))`;
