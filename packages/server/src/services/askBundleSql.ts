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
 * **두 조각 모두 `CASE WHEN <종류> THEN <하위 질의> ELSE false END` 꼴이다**(2026-10-13 쿼리 개선 Q1). 이 조각은 집계의
 * `FILTER (WHERE … AND …)` 안에 끼워 쓰이는데, 거기서 Postgres 는 `AND` 를 적힌 순서대로 끊어 주지 않았다 — 종류가 다른
 * 행에서도 하위 질의가 돌아 보드 머리 한 번에 스레드의 **모든 행**만큼(로컬 17,698번) 묶음 색인을 두드렸다. `CASE` 는 평가
 * 순서를 약속하므로 종류가 맞는 행에서만 돈다. 종류가 다른 행의 값(false)은 두 자리 모두 바깥 조건이 이미 거짓이라 결과가 같다.
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
export const bundledRootSql = (alias: string) => `(CASE WHEN ${alias}.meta->>'kind' = 'ask' THEN (
        NOT (${alias}.meta ? 'permissionRequest' OR ${alias}.meta ? 'mergeDenial')
        AND EXISTS (
          SELECT 1 FROM message bnd
            JOIN channel bc ON bc.id = bnd.channel_id
           WHERE bnd.meta->>'kind' = 'askBundle' AND bnd.deleted_at IS NULL
             AND bc.kind = 'standard' AND bc.visibility = 'public' AND bc.archived_at IS NULL
             AND bnd.meta->'askBundle'->'items' @> jsonb_build_array(jsonb_build_object('rootId', ${alias}.id::text)))) ELSE false END)`;

/**
 * 이 글(`alias`)이 **열린 줄을 하나라도 가진** 묶음 카드인가. 줄의 상태는 원본에서 읽는다(정본은 원본).
 *
 * **`br.id` 쪽을 캐스팅하지 않는다**(2026-10-12). 예전 꼴 `br.id::text = bi->>'rootId'` 는 `message_pkey` 를
 * 못 타서, 이 조각이 도는 행마다 message 를 통째로 훑었다 — 스레드 상태(`FACTS_SQL`)·채널 목록
 * (`THREAD_STATE_FACTS`)이 스레드 글 수 × 시퀀셜 스캔이 되어 Postgres 가 메모리 한도로 죽었다.
 * 값 쪽을 uuid 로 바꾸면 pkey 를 탄다.
 *
 * uuid 꼴이 아닌 rootId 는 `CASE` 로 먼저 걸러 null 로 둔다(그 줄은 아무 원본과도 맞지 않는다). 그냥
 * `::uuid` 하면 jsonb 에 이상한 값이 하나만 들어가도 이 조각을 쓰는 쿼리 전체가 터진다 — 채널 목록이
 * 통째로 500 이 된다. WHERE 의 AND 는 평가 순서를 약속하지 않으므로 거르기는 반드시 CASE 안에서 한다.
 * 지금 쓰는 길(`upsertAskBundle`)은 원본 행을 읽어 확인한 id 만 넣으므로 걸리는 값은 없어야 한다.
 */
export const openBundleSql = (alias: string) => `(CASE WHEN ${alias}.meta->>'kind' = 'askBundle' THEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(${alias}.meta->'askBundle'->'items') bi
          JOIN message br ON br.id = CASE
            WHEN bi->>'rootId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (bi->>'rootId')::uuid END
         WHERE br.deleted_at IS NULL
           AND br.meta->'ask'->>'answeredWith' IS NULL
           AND br.meta->'ask'->>'closedAt' IS NULL) ELSE false END)`;
