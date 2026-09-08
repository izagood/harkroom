import type { Pool, PoolClient } from 'pg';
import { CHANNEL_MENTION_HANDLE, mentionedHandles, mentionedIds, mentionScanText, normalizeMentions, readAskMeta, type InboxEntry, type MessageRow } from '@murmur/shared';
import { attachToMessage, type AttachFailure } from './attachments.js';
import { channelVisibleSql } from './channels.js';
import { emitEvent } from '../events.js';
import { getHandleGroupByHandle, listHandleGroupMembers } from './handleGroups.js';
import { getTeamByName, listTeamMembers } from './teams.js';

/**
 * 채널 안에서 `seq` 발급을 직렬화하는 advisory lock 의 classid(#523).
 *
 * 두 인자 형태(`classid, objid`)를 쓰는 이유: 한 인자 형태는 64비트 공간 하나를
 * 통째로 쓰므로 migrate.ts 의 `0x6d726d72`·testDb.ts 의 `0x6d726d73` 과 같은 방에
 * 산다. 채널 uuid 를 해시해 넣으면 그 상수들과 우연히 겹칠 수 있고, 겹치는 날
 * 마이그레이션이 게시를 기다리거나 그 반대가 된다. classid 를 따로 두면 그 방이
 * 아예 갈라져 충돌이 원리적으로 불가능하다.
 */
const SEQ_LOCK_CLASS = 0x6d736571; // 'mseq'

/**
 * 채널 하나를 가리키는 32비트 objid. `hashtext` 로 uuid 를 접는다 — Postgres 내장이라
 * 서버가 여러 대여도 같은 값이 나온다(애플리케이션에서 해시하면 구현이 갈릴 수 있다).
 *
 * 해시 충돌은 안전하다. 서로 다른 두 채널이 같은 락을 잡으면 **불필요하게 직렬화될 뿐**
 * 정확성은 그대로다 — 락은 성능 장치이지 가시성 판정이 아니다. 반대 방향(같은 채널이
 * 다른 락을 잡는 것)은 일어날 수 없으므로 결함이 되살아나지 않는다.
 */
export const lockChannelForSeq = (client: PoolClient, channelId: string): Promise<unknown> =>
  client.query('select pg_advisory_xact_lock($1, hashtext($2))', [SEQ_LOCK_CLASS, channelId]);

/**
 * 게시 결과. 첨부 연결이 거절되면 메시지 자체가 만들어지지 않는다(트랜잭션 롤백) —
 * 그래서 성공/실패가 배타적인 합 타입이다. 둘을 optional 필드로 섞으면 호출부가
 * 실패를 확인하지 않고 `message` 를 만질 수 있다.
 */
export type PostMessageResult =
  | { message: MessageRow; notified: string[]; replayed: boolean; failure?: undefined }
  | { failure: AttachFailure; message?: undefined };

export interface PostMessageInput {
  channelId: string;
  authorId: string;
  body: string;
  threadRootId?: string | null;
  /**
   * #144: 'progress' 값은 진행 설명 메시지를 표시 — 결과 발화로 세지 않는다.
   * 마이그레이션 040: 'wake' 는 에이전트가 걸어 둔 대기 줄이다. 역시 결과 발화가 아니며,
   * 이것만 **작성자 자신에게** inbox 를 만든다(아래 자기제외 예외).
   */
  kind?: 'user' | 'system' | 'progress' | 'wake';
  meta?: Record<string, unknown>;
  idempotencyKey?: string | null;
  /** 이 메시지에 붙일 업로드들. 같은 트랜잭션에서 연결한다 — 따로 하면 첨부 없는 메시지가 보인다. */
  attachmentIds?: string[];
  /** 스레드 답을 채널에도 함께 올린다(#231). threadRootId 가 없으면 무시된다. */
  alsoInChannel?: boolean;
}

// 리액션을 COLS 에 넣는 이유: 메시지를 내주는 경로가 네 갈래(목록·POST·PATCH·idempotency
// 재생)라 조회 뒤에 붙이는 방식은 언젠가 한 갈래를 빼먹고 그 응답에서만 리액션이 사라진다.
// 여기 두면 message 를 읽는 모든 쿼리가 자동으로 맞다.
const REACTIONS = `coalesce((
  select json_agg(json_build_object('emoji', r.emoji, 'accountIds', r."accountIds") order by r."firstAt")
  from (
    select emoji, array_agg(account_id::text order by created_at) as "accountIds",
           min(created_at) as "firstAt"
    from message_reaction where message_id = message.id group by emoji
  ) r
), '[]'::json) as reactions`;

// 첨부도 리액션과 같은 이유로 COLS 에 있다 — 조회 뒤에 붙이면 네 갈래 중 하나를 빼먹는다.
// storage_key 는 **의도적으로 빼 두었다**: 스토리지 키가 응답에 새면 그 자체가 접근 경로다.
const ATTACHMENTS = `coalesce((
  select json_agg(json_build_object(
    'id', a.id, 'filename', a.filename,
    'contentType', a.content_type, 'sizeBytes', a.size_bytes::int
  ) order by a.attached_at, a.created_at)
  from attachment a where a.message_id = message.id
), '[]'::json) as attachments`;

// #218: 핀 목록도 이 컬럼 집합으로 메시지를 내주기 때문에 export 다. 핀 전용으로 컬럼을
// 다시 적으면 위에 적은 "네 갈래" 가 다섯이 되고, 리액션·첨부가 그 응답에서만 빠진다.
//
// 스레드 상태 재료(`openAsk*`·`*failureCount`·`last*`)도 `replyCount` 와 **같은 처지**로
// null 이다. 이 컬럼 집합을 쓰는 경로(POST·PATCH·링크·핀·담기)는 스레드를 요약하는 자리가
// 아니라 **방금 그 한 줄**을 답하는 자리다. 여기서 굳이 집계하면 메시지를 하나 쓸 때마다
// 스레드 전체를 훑는 비용이 붙는데, 정작 화면이 그 값을 쓰는 곳(채널 목록·사이드바)은
// `LIST_COLS` 로 온다. 그래도 컬럼 자체는 있어야 한다 — 빠지면 같은 `MessageRow` 가 경로에
// 따라 키를 갖다 안 갖다 해서, 화면이 'null(모른다)'과 '키 없음'을 구분할 수 없다.
export const COLS = `id, seq::int as seq, channel_id as "channelId", thread_root_id as "threadRootId",
  author_id as "authorId", body, kind, meta, created_at as "createdAt",
  edited_at as "editedAt", ${REACTIONS}, ${ATTACHMENTS},
  null::int as "replyCount", null::int as "activityCount",
  null::text as "lastReplyAt", null::text[] as "participantIds",
  null::int as "openAskHumanCount", null::text[] as "openAskAccountIds", null::jsonb as "openAskLinks",
  null::int as "failureCount", null::int as "unresolvedFailureCount",
  null::text as "lastKind", null::text as "lastAuthorId",
  also_in_channel as "alsoInChannel", deleted_at as "deletedAt"`;

/**
 * 스레드 상태 판정의 **재료**(Task 6 Step 2). 판정 자체는 여기서 하지 않는다.
 *
 * **왜 재료만 싣는가:** 판정은 이미 화면의 순수 함수 `threadState()`(desktop/src/lib/threadState.ts)에
 * 있고, 그 함수의 마지막 축인 **러너 생존(presence)은 클라이언트만 안다** — 서버는 소켓이
 * 끊겼는지("모른다")와 정말 죽었는지를 구분해 줄 수 없다. 서버가 상태를 계산해 실어 보내면
 * 같은 5단 판정이 두 벌이 되고, 둘은 반드시 갈라진다. 그래서 서버는 **SQL 로만 알 수 있는
 * 사실**(누구에게 미답 물음이 갔는가 · 실패가 있는가 · 마지막 말이 진행인가)만 낸다.
 *
 * **왜 루트를 포함하는가:** 아래의 `thread_stats` 는 `thread_root_id = m.id` 라서 **루트 자신을
 * 세지 않는다** — 답글 수의 정의가 그렇기 때문이다. 그러나 상태의 정의는 다르다:
 * `threadState()` 는 루트를 포함한 스레드 전체를 훑고, 실제로 물음·실패·진행은 **루트에서
 * 시작되는 것이 보통**이다(에이전트가 채널에 물음을 던지고 답글이 아직 없는 경우). 루트를
 * 빼면 답글 없는 물음이 전부 '끝남'으로 보인다 — 이 작업이 고치려던 바로 그 거짓말이다.
 * 그래서 `(id = m.id OR thread_root_id = m.id)` 로 루트와 답글을 함께 훑는다.
 *
 * **왜 `openAskHumanCount` 와 `openAskAccountIds` 를 나누는가:** `ask.to` 가 합 타입이기
 * 때문이다(`AskAudience`). `{kind:'human'}` 은 특정 계정이 아니라 **'사람 아무나'** 라서
 * 계정 배열에 담을 id 가 없고, 담을 수 없다고 빠뜨리면 사람에게 온 물음이 화면에서 사라진다.
 * 반대로 '사람 아무나'를 아무 계정 id 로 대신 채우면 그 사람만 강조를 받는다. 둘 다 거짓이라
 * 사실을 있는 그대로 두 필드로 나눈다 — 화면의 `threadState()` 가 쓰는 분기와 같은 모양이다.
 *
 * **왜 `answeredWith is null` 인가:** 답한 물음은 더 이상 아무도 막지 않는다. `readAskMeta`
 * 를 쓰는 `threadState()` 가 `answeredWith != null` 인 것을 건너뛰는 것과 같은 규칙이다.
 *
 * `kind = 'ask'` / `'failure'` 를 관문으로 보는 것은 shared 의 `readAskMeta`·`readFailureMeta`
 * 가 똑같이 `meta.kind` 를 먼저 보기 때문이다. 그 판정과 어긋나면 서버가 실은 재료를 화면이
 * 못 쓴다. 다만 shared 의 판정은 옵션 수·`retryable` 타입까지 검사하므로 이쪽이 **조금 더
 * 너그럽다** — 그래도 안전한 방향이다: 재료가 남는 것은 화면이 걸러 내지만, 모자라면 화면은
 * 없는 사실을 만들어 낼 수 없다.
 *
 * 마지막 말은 `seq` 로 고른다 — `created_at` 은 같은 밀리초에 둘이 들어오면 순서가 갈리지만
 * `seq` 는 채널 안에서 단조 증가라 언제나 하나로 정해진다.
 */
const THREAD_STATE_FACTS = `LEFT JOIN LATERAL (
  SELECT
    -- 사람 아무나에게 간 미답 물음의 수. 누구인지 물을 수 없으므로 수로만 낸다.
    COUNT(*) FILTER (
      WHERE t.meta->>'kind' = 'ask'
        AND t.meta->'ask'->>'answeredWith' IS NULL
        AND t.meta->'ask'->'to'->>'kind' = 'human'
    )::int as open_ask_human_count,
    -- 특정 계정에게 간 미답 물음의 수신자들. 화면이 "이것이 내 차례인가"를 여기서 가른다.
    COALESCE(ARRAY_AGG(DISTINCT t.meta->'ask'->'to'->>'accountId') FILTER (
      WHERE t.meta->>'kind' = 'ask'
        AND t.meta->'ask'->>'answeredWith' IS NULL
        AND t.meta->'ask'->'to'->>'kind' = 'account'
        AND t.meta->'ask'->'to'->>'accountId' IS NOT NULL
    ), '{}'::text[]) as open_ask_account_ids,
    COUNT(*) FILTER (WHERE t.meta->>'kind' = 'failure')::int as failure_count,
    -- **안 풀린** 실패만 따로 센다. 위의 누적 개수로 '막힘'을 칠하면 한 번 실패한 스레드는
    -- 그 뒤에 에이전트가 다시 붙어 진행 설명을 올리고 있어도 영원히 붉게 남는다 — 사람이
    -- 보는 화면에서 "작업 중"이 계속 "막힘"으로 뒤집히던 것이 이것이다.
    --
    -- 해소의 정의: **그 실패보다 뒤에 에이전트의 말이 있으면 풀린 것이다.** 에이전트의
    -- 말이란 (a) 진행 설명·대기 줄(kind), (b) 완료 보고(meta.kind), (c) **그 실패를 낸
    -- 계정 자신의 아무 말**이다. (c) 가 필요한 이유는 마지막 답을 평범한 글로 내는 러너가
    -- 있어서고, 그때 그 계정이 에이전트라는 것은 실패를 낸 자가 그 계정이라는 사실이
    -- 이미 말해 준다 — account 를 조인하지 않고도 안다.
    --
    -- 사람이 되묻는 말은 풀지 않는다. 그때는 정말로 막혀 있는 것이고, 그것을 '끝남'으로
    -- 칠하는 것이 이 필드가 막으려는 반대쪽 거짓말이다.
    COUNT(*) FILTER (
      WHERE t.meta->>'kind' = 'failure'
        AND NOT EXISTS (
          SELECT 1 FROM message r
          WHERE (r.id = m.id OR r.thread_root_id = m.id)
            AND r.deleted_at IS NULL
            AND r.seq > t.seq
            AND (r.kind IN ('progress', 'wake')
              OR r.meta->>'kind' = 'report'
              OR r.author_id = t.author_id)
        )
    )::int as unresolved_failure_count,
    -- 마디들: 누가 → 누구를 기다리는가(#488 A3-b). 위의 두 집계로는 부족하다 —
    -- open_ask_account_ids 는 '답해야 하는 쪽'만 모은 집합이라 누가 물었는지가
    -- 지워지고, 사슬을 이으려면 짝이 필요하다.
    --
    -- ARRAY_AGG 가 아니라 JSONB_AGG 인 이유가 그것이다: 두 값을 한 행으로 묶어
    -- 내보내야 짝이 유지된다. 배열 둘로 내면 순서가 같다는 보장이 없다.
    --
    -- 'human' 은 blockedBy = null 로 낸다 — 계정 id 로 대신 채우면 그 사람만
    -- 기다리는 것처럼 보인다(open_ask_human_count 를 따로 둔 것과 같은 이유).
    COALESCE(JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'waiter', t.author_id::text,
        'blockedBy', CASE WHEN t.meta->'ask'->'to'->>'kind' = 'account'
          THEN t.meta->'ask'->'to'->>'accountId' END,
        'askedAt', t.created_at
      ) ORDER BY t.seq
    ) FILTER (
      WHERE t.meta->>'kind' = 'ask'
        AND t.meta->'ask'->>'answeredWith' IS NULL
        AND t.author_id IS NOT NULL
        -- 사람 아무나(human)와 특정 계정(account) 둘 다 마디가 된다. 그 밖의
        -- to.kind 는 화면이 이을 수 없으므로 넣지 않는다.
        AND (t.meta->'ask'->'to'->>'kind' = 'human'
          OR (t.meta->'ask'->'to'->>'kind' = 'account'
            AND t.meta->'ask'->'to'->>'accountId' IS NOT NULL))
    ), '[]'::jsonb) as open_ask_links
  FROM message t
  WHERE (t.id = m.id OR t.thread_root_id = m.id) AND t.deleted_at IS NULL
) thread_state ON true
LEFT JOIN LATERAL (
  -- 마지막 말 하나. 그것이 진행이고 저자가 살아 있는 에이전트일 때만 '도는 중'이므로,
  -- 화면은 이 둘(kind·저자)에 자기가 아는 생존을 곱해 판정한다.
  SELECT t.kind as last_kind, t.author_id::text as last_author_id
  FROM message t
  WHERE (t.id = m.id OR t.thread_root_id = m.id) AND t.deleted_at IS NULL
  ORDER BY t.seq DESC LIMIT 1
) thread_last ON true`;

// 스레드 메타데이터: 루트 메시지에만 계산. LATERAL join으로 같은 쿼리에서 계산한다 (N+1 방지).
//
// **답글 수는 화면이 답글로 그리는 것만 센다**(2026-09-09). 여기 있던 주석은 반대를 적어
// 두었다 — *"진행 설명도 답글 수에 포함한다 … 제외하면 개수가 안 맞는 것처럼 보인다."*
// 그 근거는 진행이 말풍선으로 흐르던 시절의 것이고, `#144` 이후로는 성립하지 않는다:
// 스레드는 연속된 `progress` 를 **상태 한 줄**로 접고(`ProgressRow`), `wake` 는 대기 줄로
// 그린다(`WakeRow`). 그래서 "답글 2개" 를 눌러 열면 말풍선이 하나뿐이었다 — 사용자가
// 2026-09-09 에 화면 둘을 나란히 놓고 지적한 그 상태다(실측: 진행 1 + 결과 1 = `2`).
//
// 세는 기준은 **러너의 기준과 같은 하나**다: `progress`·`wake` 는 결과 발화가 아니다
// (`shared::countsAsReply` · `agent/src/prompt.ts::countOwnPostsSince`). 셋이 같은 문장을
// 쓰지 않으면 화면과 러너가 같은 스레드를 다르게 센다. SQL 은 그 함수를 부를 수 없어
// 목록을 여기 다시 적는다 — **종류가 늘면 두 자리를 함께 고친다.**
//
// **`activity_count` 는 그 대신 남는다** — 접힌 진행만 있는 스레드에서도 요약 줄이 서야
// 하기 때문이다. 그 줄이 사라지면 `작업 중` 배지도 함께 사라져, 열어 보지 않은 스레드가
// **도는지 끝났는지 화면에서 알 수 없다**(그것이 아래 `THREAD_STATE_FACTS` 가 존재하는
// 이유이기도 하다). 답글 수는 `0` 이라 글자로 그려지지 않고(규칙 06), 자리만 남는다.
//
// **참여자 순서는 '마지막으로 말한 순'이다**(identity 문서 · Task 13). 원래는
// `ARRAY_AGG(DISTINCT author_id)` 였는데, `DISTINCT` 가 uuid 로 정렬해 버려 **순서가 사실상
// 무작위이고 영원히 움직이지 않았다.** 화면이 앞에서 셋만 남기면 방금 말한 사람이 잘리고
// 같은 얼굴이 계속 서 있는다 — 문서가 "명단은 움직이지 않는다"고 지적한 그 상태다.
//
// 그래서 저자별 최근 발화 시각으로 정렬한 뒤 배열로 만든다. 화면은 **앞에서부터** 셋을
// 취하므로 방금 말한 사람이 항상 보인다.
const THREAD_STATS = `LEFT JOIN LATERAL (
  SELECT COUNT(*) FILTER (WHERE kind NOT IN ('progress', 'wake'))::int as reply_count,
    COUNT(*)::int as activity_count,
    MAX(created_at) FILTER (WHERE kind NOT IN ('progress', 'wake'))::text as last_reply_at,
    COALESCE((
      SELECT ARRAY_AGG(author_id ORDER BY last_at DESC)
      FROM (
        SELECT author_id, MAX(created_at) as last_at
        FROM message
        WHERE thread_root_id = m.id AND deleted_at IS NULL AND author_id IS NOT NULL
        GROUP BY author_id
      ) recent
    ), '{}'::uuid[]) as participant_ids
  FROM message WHERE thread_root_id = m.id AND deleted_at IS NULL
) thread_stats ON true
${THREAD_STATE_FACTS}`;

// listMessages 에서 사용하는 컬럼: 루트면 메타데이터 있음, 답글이면 null.
//
// **지워진 행의 본문·meta·첨부·리액션은 비운다.** 아래 `LIST_VISIBLE` 때문에 이 목록에는
// 지워진 스레드 머리가 자리표시자로 한 행 섞여 올 수 있고, 그 행에 내용을 그대로 실으면
// 삭제가 삭제가 아니다 — 화면만 가려도 API 응답과 에이전트 프롬프트에는 남는다(핀·나중에
// 보기가 같은 판단을 한다: `savedMessages.ts` 의 `message: smDeleted ? null`). 남는 것은
// **스레드가 여기서 시작했다는 사실**뿐이다: id·seq·시각·답글 집계.
//
// `meta` 를 비우는 것이 특히 중요하다 — 지운 머리에 미답 물음(`ask`)이 실려 있으면
// 그 스레드는 영원히 "누군가를 기다리는" 것으로 보인다.
const LIST_COLS = `m.id, m.seq::int as seq, m.channel_id as "channelId", m.thread_root_id as "threadRootId",
  m.author_id as "authorId",
  case when m.deleted_at is null then m.body else '' end as body,
  m.kind, case when m.deleted_at is null then m.meta else '{}'::jsonb end as meta,
  m.created_at as "createdAt",
  m.edited_at as "editedAt",
  case when m.deleted_at is null then (${REACTIONS.replace(/message\./g, 'm.').replace(/ as reactions$/, '')}) else '[]'::json end as reactions,
  case when m.deleted_at is null then (${ATTACHMENTS.replace(/message\./g, 'm.').replace(/ as attachments$/, '')}) else '[]'::json end as attachments,
  case when m.thread_root_id is null then thread_stats.reply_count end as "replyCount",
  case when m.thread_root_id is null then thread_stats.activity_count end as "activityCount",
  case when m.thread_root_id is null then thread_stats.last_reply_at end as "lastReplyAt",
  case when m.thread_root_id is null then thread_stats.participant_ids end as "participantIds",
  case when m.thread_root_id is null then thread_state.open_ask_human_count end as "openAskHumanCount",
  case when m.thread_root_id is null then thread_state.open_ask_account_ids end as "openAskAccountIds",
  case when m.thread_root_id is null then thread_state.failure_count end as "failureCount",
  case when m.thread_root_id is null then thread_state.unresolved_failure_count end as "unresolvedFailureCount",
  case when m.thread_root_id is null then thread_state.open_ask_links end as "openAskLinks",
  case when m.thread_root_id is null then thread_last.last_kind end as "lastKind",
  case when m.thread_root_id is null then thread_last.last_author_id end as "lastAuthorId",
  m.also_in_channel as "alsoInChannel", m.deleted_at as "deletedAt"`;

/**
 * 목록에 들어오는 조건. `deleted_at is null` **하나가 아니다** — 예외가 정확히 하나 있다:
 * **답글이 남은 스레드 머리.**
 *
 * 왜: 스레드를 시작한 말을 지우면 지금까지는 그 한 행만 사라졌다. 답글은 살아 있는데
 * 목록에서 머리가 빠지므로, 채널에서는 스레드 자체가 없어진 것으로 보이고 그 안의
 * 히스토리로 들어갈 문이 없어진다(2026-09-09 신고). 반대로 답글까지 함께 지우면
 * 남의 말이 내 삭제로 사라진다 — 그래서 **머리 자리만** 남기고 본문은 위에서 뗀다.
 *
 * 답글이 하나도 없으면(또는 남은 답글이 모두 지워지면) 이 조건이 거짓이 되어 머리도
 * 목록에서 사라진다 — "댓글 없으면 그냥 삭제"가 별도 분기 없이 이 한 줄에서 나온다.
 *
 * 답글 자신은 이 예외를 못 받는다(`m.thread_root_id is null` 이 머리만 고른다):
 * 답글에는 매달릴 자식이 없으므로 자리표시자로 남길 이유가 없다.
 */
const LIST_VISIBLE = `(m.deleted_at is null or (m.thread_root_id is null and exists (
  select 1 from message r where r.thread_root_id = m.id and r.deleted_at is null
)))`;

/**
 * 숨긴 채널(#376)을 다시 나타나게 하는 inbox 사유들. **`dm` 은 없다.**
 *
 * `mention`·`thread_reply` 는 누군가 나를 **지목한** 것이다(평범한 멘션·`@channel`·집합·내가
 * 세운 스레드의 답). `dm` 은 그 채널의 **모든** 메시지가 갖는 사유라서, 그것으로 숨김을 풀면
 * DM 을 숨기는 일이 첫 메시지에 무너진다 — #376 이 거부한 (C) "안 읽음이 생기면 나타난다"가
 * 사실상 그것이다.
 */
const REVEAL_REASONS: ReadonlySet<InboxEntry['reason']> = new Set(['mention', 'thread_reply']);

async function insertInbox(
  client: PoolClient, accountId: string, messageId: string, reason: InboxEntry['reason'], notified: Set<string>,
): Promise<void> {
  await client.query(
    `insert into inbox (account_id, message_id, reason) values ($1, $2, $3)`,
    [accountId, messageId, reason],
  );
  /**
   * 숨김 되돌리기(#376 결정 B) — **부름은 숨김을 뚫는다.** 이 자리인 이유: inbox 항목을
   * 만드는 관문이 이 함수 하나이므로, "알림을 받은 사람"과 "사이드바에 다시 나타나는 사람"이
   * 갈라질 수 없다. 호출부(평범한 멘션·`@channel`·집합·스레드) 넷에 흩어 놓으면 하나를
   * 빠뜨리는 순간 그 경로의 부름만 조용히 삼켜진다 — 이 저장소가 오늘 반복해 고친 결함이다.
   *
   * 채널을 인자로 받지 않고 메시지에서 되찾는 이유: 인자로 받으면 호출부가 다른 채널을
   * 넘겨 그 메시지와 다른 채널의 숨김이 풀리는 경우가 표현된다. 여기서는 표현되지 않는다.
   *
   * **읽은 뒤 자동으로 다시 숨지 않는다**(#376 이 나에게 남긴 결정). 이유:
   * - 자동 재숨김은 "읽었는데 사라졌다"를 만든다. 방금 본 채널이 스스로 없어지면 사람은
   *   그것이 어디로 갔는지, 지금 숨겨진 상태인지 아닌지를 화면에서 알 수 없다.
   * - 숨김은 **사람의 명시적 조작으로만 바뀌는 상태**여야 예측된다. 서버가 되돌린 것은
   *   `hidden_at = null` 로 **저장**되므로, 사이드바에 보이는 것이 곧 지금 상태다.
   * - "한 번 쓰고 버리는 것이 된다"는 걱정은 다시 숨기는 값이 클릭 한 번이라 크지 않다.
   *   반대쪽 비용(상태를 사람이 못 읽는다)은 화면을 못 믿게 만드는 종류다.
   *
   * `hidden_at is not null` 을 조건에 두어 숨기지 않은 채널의 행은 건드리지 않는다 —
   * 아무것도 바뀌지 않는 update 가 매 멘션마다 pref 행을 잠그는 것을 막는다.
   */
  if (REVEAL_REASONS.has(reason)) {
    await client.query(
      `update channel_pref set hidden_at = null
        where account_id = $1 and hidden_at is not null
          and channel_id = (select channel_id from message where id = $2)`,
      [accountId, messageId],
    );
  }
  notified.add(accountId);
}

/**
 * 이름 하나를 여러 사람으로 펼쳐 inbox 에 넣는다. `@channel`(#225)과 집합(#230)이 **같은
 * 함수를 쓴다.**
 *
 * 한 자리로 모아 둔 이유: 확장 지점이 둘이 되면 하나만 고치는 사고가 난다. 여기 묶여 있는
 * 규칙은 셋이고, 어느 하나를 한쪽에서만 빠뜨리면 조용히 새거나 조용히 빠진다.
 *
 * ① **가시성**은 `channelVisibleSql` 이 판정한다 — 멤버십을 여기서 다시 정의하지 않는다.
 *    판정이 갈라지면 private 채널의 비멤버에게 알림이 새거나(채널의 존재 자체가 샌다),
 *    public 채널에서 조용히 빠지는 사람이 생긴다. 술어가 계정 id 를 파라미터가 아니라
 *    컬럼(`a.id`)으로 받는 덕에 방향을 뒤집어 "이 채널을 볼 수 있는 계정 전부"로 쓸 수 있다.
 * ② **부른 사람 자신은 뺀다** — 자기 발화로 자기에게 알림이 오면 안 된다
 *    (`readPositions.ts` 의 `author_id <> $1` 과 같은 규칙).
 * ③ **이미 알린 사람은 다시 넣지 않는다** — 평범한 멘션으로 이미 불린 사람이 집합에도
 *    들어 있으면 inbox 항목이 둘 생긴다.
 *
 * 비활성 계정을 따로 거르지 않는 것은 평범한 멘션과 같은 처지로 두기 위해서다.
 *
 * `candidateIds` 가 `null` 이면 "이 채널을 볼 수 있는 사람 전부"(`@channel`), 배열이면
 * 그중 볼 수 있는 사람(집합의 명단)이다.
 */
async function fanOutMention(
  client: PoolClient,
  input: { channelId: string; authorId: string; messageId: string },
  candidateIds: string[] | null,
  notified: Set<string>,
): Promise<void> {
  if (candidateIds !== null && candidateIds.length === 0) return;
  const audience = await client.query<{ id: string }>(
    `select a.id from account a, channel c
      where c.id = $1 and a.id <> $2
        and ($3::uuid[] is null or a.id = any($3))
        and ${channelVisibleSql('c', 'a.id')}`,
    [input.channelId, input.authorId, candidateIds],
  );
  for (const row of audience.rows) {
    if (!notified.has(row.id)) await insertInbox(client, row.id, input.messageId, 'mention', notified);
  }
}

export async function postMessage(
  pool: Pool, input: PostMessageInput,
): Promise<PostMessageResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    /**
     * `seq` 발급을 채널 단위로 직렬화한다(#523).
     *
     * **왜 여기인가.** `seq` 는 `generated always as identity`(001_init.sql:57)라
     * 시퀀스에서 나오고, 시퀀스는 트랜잭션 밖에서 값을 준다. 그래서 낮은 seq 를 받은
     * 트랜잭션이 늦게 커밋할 수 있다 — 발급 순서와 커밋(가시성) 순서가 갈라진다.
     * 커서가 `seq > $since` 인 이상(listMessages) 그 갈라짐은 곧 **건너뛴 메시지**다:
     * B(높은 seq)가 먼저 커밋된 순간 리더가 폴하면 커서가 B 로 가고, 뒤늦게 커밋되는
     * A 는 `seq > B` 에 영영 안 걸린다.
     *
     * 락을 `begin` 직후, **insert 보다 앞에** 잡는 것이 핵심이다. insert 뒤에 잡으면
     * 이미 seq 가 나간 뒤라 아무것도 막지 못한다. 여기서 잡으면 "seq 를 받은 트랜잭션은
     * 커밋할 때까지 다음 트랜잭션이 seq 를 못 받는다"가 되어 두 순서가 **같아진다**.
     *
     * `xact` 형태를 쓰므로 커밋이든 롤백이든 자동으로 풀린다. 첨부 거절 경로가
     * `rollback` 으로 빠져나가는데(아래), 수동 해제였다면 그 경로마다 해제를 빠뜨릴
     * 위험이 있고 한 번 빠뜨리면 그 채널의 게시가 통째로 멈춘다.
     *
     * **왜 채널 단위인가.** seq 는 전역이지만 커서는 채널·스레드 단위다. 다른 채널의
     * 미커밋 seq 가 이 채널 커서를 지나칠 수는 없다 — 그 seq 는 이 채널 델타의
     * `where channel_id = $1` 에 애초에 걸리지 않기 때문이다(실측 확인). 전역으로
     * 잠그면 무관한 채널끼리 줄을 서게 되어 처치가 병보다 나빠진다.
     *
     * **버린 후보들.** ① 읽기 시점에 미커밋 구간을 피하기 — 불가능하다. 미커밋 행은
     * 리더에게 **보이지 않으므로** 그 seq 를 알아낼 질의가 없다. `pg_sequence_last_value`
     * 도 못 쓴다: 이 결함의 창에서는 B 가 가장 큰 seq 를 가져가 커밋하므로
     * `last_value == max(보이는 seq)` 가 되어 구멍이 신호에 안 잡힌다(실측).
     * ② "안 보이는 발급분" 을 구멍으로 보고 클램프 — 롤백이 **영구 구멍**을 남기므로
     * (실측) 커서가 첫 롤백에서 영원히 멈춘다. postMessage 자신이 첨부 거절 때
     * 롤백하므로 흔한 경로다. ③ `xmin` 을 커서로 — xid 는 커밋 순서가 아니라 시작
     * 순서라 같은 결함이 그대로 있고, 순환(wraparound)까지 떠안는다. ④ 델타를 "안 본
     * 것" 집합으로 — 커서가 스칼라 하나라는 클라이언트 계약(러너의 `lastFedSeq`,
     * 데스크톱의 `since`)을 전부 바꿔야 한다.
     *
     * **읽기에 더한 비용은 없다.** 이 고침은 전부 쓰기 경로에 있고 `listMessages` 의
     * 질의는 한 글자도 바뀌지 않는다 — "읽기가 흔하다"는 제약에 맞춘 선택이다.
     */
    await lockChannelForSeq(client, input.channelId);

    if (input.idempotencyKey) {
      // key는 클라이언트가 고르는 값이라 전역 유일하지 않다. 재생은 같은 author가 같은 채널로
      // 보낸 재시도일 때만이며, 그 범위를 벗어난 조회는 남의 메시지를 읽는 경로가 된다.
      const dup = await client.query(
        `select message_id from idempotency_key
         where key = $1 and author_id = $2 and channel_id = $3`,
        [input.idempotencyKey, input.authorId, input.channelId],
      );
      if (dup.rowCount) {
        const existing = await client.query(`select ${COLS} from message where id = $1`, [dup.rows[0].message_id]);
        await client.query('commit');
        return { message: existing.rows[0], notified: [], replayed: true };
      }
    }

    // threadRootId 가 없으면 alsoInChannel 은 의미 없다 — 조용히 false 로 정규화한다.
    // threadRootId 없이 true 를 보내는 것은 이미 채널 메시지이기 때문이다.
    const alsoInChannel = input.threadRootId ? (input.alsoInChannel ?? false) : false;

    /**
     * 멘션 정규화(#271). 저장되는 정본은 `<@id>` 다 — 그래야 handle 을 바꿔도 과거 본문을
     * 다시 쓰지 않는다.
     *
     * **삽입 전에 한다.** 넣고 나서 update 로 고치면 그 사이에 읽는 경로(`COLS` 재조회,
     * WS 이벤트)가 정규화 전 본문을 보고, 같은 메시지가 두 형식으로 존재하는 순간이 생긴다.
     *
     * 대상은 **워크스페이스의 모든 계정**이다. 채널 멤버로 좁히면 public standard 채널에는
     * `channel_member` 행이 아예 없으므로(`createChannel` — private 만 첫 멤버를 넣는다)
     * 정규화가 통째로 비고, 그 채널의 멘션은 알림이 하나도 가지 않는다.
     *
     * `mentionedHandles` 가 코드 구간(#298)과 인용 줄(#592)을 걷어내므로 그 안의 `@handle` 은
     * 여기 목록에 들어오지 않고, `normalizeMentions` 도 같은 판정으로 그 구간을 비껴간다.
     */
    const bodyHandles = mentionedHandles(input.body);
    const mentionedAccounts = bodyHandles.length
      ? (await client.query(
          `select id, lower(handle) as handle from account where lower(handle) = any($1)`,
          [bodyHandles],
        )).rows as { id: string; handle: string }[]
      : [];
    const handleToId = new Map(mentionedAccounts.map((r) => [r.handle, r.id]));
    const normalizedBody = normalizeMentions(input.body, handleToId);

    const inserted = await client.query(
      `insert into message (channel_id, thread_root_id, author_id, body, kind, meta, also_in_channel)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [input.channelId, input.threadRootId ?? null, input.authorId, normalizedBody,
       input.kind ?? 'user', JSON.stringify(input.meta ?? {}), alsoInChannel],
    );
    const messageId = inserted.rows[0].id as string;

    // 첨부를 **같은 트랜잭션에서** 연결한다. 따로 하면 첨부 없는 메시지가 잠깐 보이고,
    // 연결이 실패하면 본문만 남는다.
    const failure = await attachToMessage(client, {
      messageId, actorId: input.authorId, attachmentIds: input.attachmentIds ?? [],
    });
    if (failure) {
      await client.query('rollback');
      return { failure };
    }

    // 연결 뒤에 읽는다 — COLS 가 첨부를 함께 가져오므로 순서가 뒤바뀌면 빈 배열이 나간다.
    const read = await client.query(`select ${COLS} from message where id = $1`, [messageId]);
    const message: MessageRow = read.rows[0];

    if (input.idempotencyKey) {
      await client.query(
        `insert into idempotency_key (key, message_id, author_id, channel_id) values ($1, $2, $3, $4)`,
        [input.idempotencyKey, message.id, input.authorId, input.channelId],
      );
    }

    const notified = new Set<string>();

    /**
     * 알림 판정은 **정규화된 본문의 `<@id>` 토큰**에서 한다(#271 요구 6). 옛 handle 경로를
     * 남겨 두면 두 판정이 갈라지고, 그때 본문에 남은 것과 알림이 간 곳이 달라진다.
     *
     * 코드 구간을 한 번 더 걷어내는 이유: 사람이 코드 블록 안에 `<@uuid>` 를 **직접** 적을
     * 수 있다. 정규화는 코드를 비껴가지만 그렇게 손으로 적힌 토큰까지 막지는 못한다 —
     * 코드 안은 알림을 만들지 않는다는 #298 의 결정을 여기서도 같은 함수로 지킨다.
     *
     * 작성자 자신은 걸러 낸다.
     */
    for (const accountId of mentionedIds(mentionScanText(normalizedBody))) {
      if (accountId !== input.authorId) {
        await insertInbox(client, accountId, message.id, 'mention', notified);
      }
    }

    // `@channel`(#225) — 채널 전체 호출. 본문은 손대지 않는다: `@channel` 은 원문에
    // 그대로 남고 서버는 inbox 항목만 펼쳐 넣는다. 본문을 치환하면 원문이 사라져
    // 수정할 때 되돌릴 수 없다(계정이 없으므로 정규화도 지나친다).
    //
    // `@channel` 이라는 handle 의 **계정이 실제로 있으면 계정이 이긴다** — 위에서 이미
    // 평범한 멘션으로 처리됐고 여기서는 아무것도 하지 않는다. 사람의 이름이 예약어에
    // 밀리면 그 사람은 영영 불릴 수 없다.
    const accountHandles = new Set(handleToId.keys());
    if (bodyHandles.includes(CHANNEL_MENTION_HANDLE) && !accountHandles.has(CHANNEL_MENTION_HANDLE)) {
      // 대상은 **그 채널을 볼 수 있는 사람 전부**다. 규칙은 `fanOutMention` 하나에 있다.
      await fanOutMention(client, { ...input, messageId: message.id }, null, notified);
    }

    /**
     * 집합(#230)과 팀(#172) — 저장된 명단을 펼친다. 본문은 손대지 않는다: `@release` 는
     * 원문에 그대로 남고 서버는 inbox 항목만 펼쳐 넣는다(`@channel` 과 같은 이유다).
     *
     * **한 자리에서 둘을 본다.** 팀을 위한 새 루프를 만들지 않는 이유: 이 루프가 이미
     * "이 handle 은 계정이 아니다 → 저장된 명단인가?" 를 묻고 있고, 팀은 그 물음의
     * 두 번째 답일 뿐이다. 루프를 하나 더 두면 `notified` 중복 제거가 두 루프에 걸쳐
     * 살고, `CHANNEL_MENTION_HANDLE`·`accountHandles` 예외를 양쪽에 베껴야 한다 —
     * 한쪽만 고치는 날 `@channel` 이라는 이름의 팀이 채널 전체를 두 번 부른다.
     *
     * **가시성과 중복 제거를 여기서 다시 쓰지 않는다.** 대상 목록만 만들어
     * `fanOutMention` 에 넘긴다 — 그 함수 하나가 `channelVisibleSql` 로 볼 수 있는
     * 사람만 남기고, 작성자를 빼고, `notified` 에 이미 든 사람을 건너뛴다. 집합이 하는
     * 것과 **똑같이** 한다.
     *
     * ## 해석 순서: 계정 → 집합 → 팀
     *
     * **계정이 이긴다.** `@foo` 가 계정이면 위에서 이미 평범한 멘션으로 처리됐고 여기서는
     * 건너뛴다. 서버가 양방향 충돌을 막으므로 정상 경로에서는 겹치지 않지만, 026 이전에
     * 만들어진 행이나 동시 생성 경합으로 겹칠 수 있다 — 그때 사람의 이름이 집합에 밀리면
     * 그 사람은 영영 불릴 수 없다.
     *
     * **집합과 팀 사이의 순서는 실측하면 결과를 바꿀 수 있다.** `createTeam` 은 세 겹침을
     * 모두 확인하지만(계정·집합·팀) 반대 방향은 그렇지 않다 — `createHandleGroup` 은
     * `account` 만 보고 `agent_team` 을 안 보며, 계정 생성(`authRoutes.ts` 의 register,
     * `services/agents.ts` 의 에이전트 생성)도 `handle_group` 만 본다. 즉 팀 이름과 같은
     * 집합·계정을 **나중에 만들 수 있고**, 그러면 한 handle 이 두 대상을 가리킨다.
     * `036_agent_team.sql` 은 *"유일성도 멘션 해석과 같은 기준이어야 한다"* 고 적었지만
     * 그 기준을 지키는 문장은 팀 쪽에만 있다.
     *
     * 그 구멍을 여기서 메우지 않는다 — 계정·집합 생성 경로에 검사를 더하는 것은 그
     * 라우트들의 사실이고, 이 함수는 **이미 겹쳐 있는 데이터에도 답을 하나로 정해야**
     * 한다. 그래서 순서를 못 박는다: **집합이 팀을 이긴다.** 집합은 사람이고 팀은
     * 에이전트다(`addHandleGroupMembers` 는 `kind = 'human'`, 팀 라우트는
     * `not_an_agent` 로 거절한다) — 사람의 부름이 에이전트의 부름에 밀리면 그 사람들은
     * 영영 불릴 수 없고, 그것은 계정이 집합을 이기는 것과 같은 판단이다.
     *
     * 집합을 찾은 뒤 `continue` 로 **이 handle 을 끝내는 것**이 그 순서를 실행에 옮기는
     * 자리다(다음 handle 로 넘어간다). 겹침이 없는 정상 경로에서는 어느 쪽이 먼저든
     * 결과가 같지만, 겹친 데이터에서 두 명단이 **둘 다** 펼쳐지는 것이 가장 나쁘다:
     * `@foo` 가 사람 집합인지 에이전트 팀인지 부른 사람이 모르게 된다.
     *
     * 조회를 `client` 로 하는 이유: 트랜잭션 클라이언트를 쥔 채 `pool` 에서 또 다른 연결을
     * 얻으면 풀이 포화된 순간 자기 자신을 기다리는 교착이 된다. 같은 트랜잭션 스냅샷을
     * 보는 것도 이쪽이 맞다.
     */
    for (const handle of bodyHandles) {
      if (handle === CHANNEL_MENTION_HANDLE) continue;
      if (accountHandles.has(handle)) continue;

      const group = await getHandleGroupByHandle(client, handle);
      if (group) {
        const members = await listHandleGroupMembers(client, group.id);
        await fanOutMention(
          client, { ...input, messageId: message.id }, members.map((m) => m.accountId), notified,
        );
        continue;
      }

      /**
       * 에이전트 팀(#172). `036_agent_team.sql` 이 *"나중에 `@팀` 멘션을 열 여지를
       * 남기기 위한 예약"* 이라고 적어 둔 그 여지를 여기서 쓴다.
       *
       * **비활성 팀원은 부르지 않는다.** `036` 은 *"비활성화는 팀원을 지우지 않는다 …
       * 걸러지는 자리는 채널에 넣는 시점 하나다"* 라고 적었고, 이 줄은 그 문장에 자리를
       * 하나 더한다. 그 결정을 뒤집는 것이 아니라 **같은 결정을 새로 생긴 경로에
       * 적용하는 것**이다: 그 문장이 지킨 것은 "명단을 지우지 않는다"이고, 걸러는
       * "닿게 하지 않는다"다. 멘션은 채널에 넣기와 나란히 **닿게 하는 두 번째 경로**라
       * 같은 필터가 필요하다 — `AddTeamToChannelResult.skipped` 가 이미 그 개념을 갖고 있다.
       *
       * 왜 부르지 않는가 — 비활성 에이전트는 **깰 수 없다**. inbox 항목은 러너가 턴을
       * 시작하는 신호이고(`agentWake`), 비활성 계정은 그 턴을 시작하지 않는다. 그것을
       * 넣으면 아무도 읽지 않는 항목이 쌓이고, 그 계정을 다시 켜는 날 몇 주 전의 부름이
       * 한꺼번에 되살아난다 — 그때 시작되는 턴은 이미 끝난 일에 대한 것이다.
       *
       * **가시성 필터로는 이것을 대신할 수 없다.** 비활성 에이전트도 채널 멤버로 남으므로
       * (`disabled` 는 멤버십을 지우지 않는다) `channelVisibleSql` 을 통과한다 — 서버
       * 테스트가 그 조합을 지킨다(`teamMention.test.ts` 3: 비활성이면서 채널 멤버).
       * 그래서 `fanOutMention` 안이 아니라 **후보를 만드는 이 자리**가 필터의 자리다:
       * 그 함수는 채널 가시성의 규칙이고 계정 상태의 규칙이 아니다.
       *
       * 반면 `memberCount` 는 비활성 팀원도 센다(`AgentTeamRow.memberCount`). 그
       * 어긋남은 결함이 아니라 화면이 말해야 하는 사실이다 — 넷을 불러 셋이 깼다면
       * 하나는 꺼져 있거나 채널을 못 본다.
       */
      const team = await getTeamByName(client, handle);
      if (!team) continue;

      const teamMembers = await listTeamMembers(client, team.id);
      await fanOutMention(
        client, { ...input, messageId: message.id },
        teamMembers.filter((m) => !m.disabled).map((m) => m.accountId),
        notified,
      );
    }

    if (input.threadRootId) {
      const root = await client.query(`select author_id from message where id = $1`, [input.threadRootId]);
      const rootAuthor = root.rows[0]?.author_id;
      if (rootAuthor && rootAuthor !== input.authorId && !notified.has(rootAuthor)) {
        await insertInbox(client, rootAuthor, message.id, 'thread_reply', notified);
      }
    }

    const channel = await client.query(`select kind from channel where id = $1`, [input.channelId]);
    if (channel.rows[0]?.kind === 'dm') {
      const members = await client.query(
        `select account_id from channel_member where channel_id = $1 and account_id <> $2`,
        [input.channelId, input.authorId],
      );
      for (const row of members.rows) {
        if (!notified.has(row.account_id)) await insertInbox(client, row.account_id, message.id, 'dm', notified);
      }
    }

    await client.query('commit');
    return { message, notified: [...notified], replayed: false };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 주어진 seq 보다 오래된 메시지가 남아 있는가. 클라이언트의 '더 불러오기' 표시에 쓴다. */
export async function hasOlderMessages(pool: Pool, channelId: string, oldestSeq: number): Promise<boolean> {
  const res = await pool.query(
    `select 1 from message where channel_id = $1 and seq < $2 and deleted_at is null limit 1`,
    [channelId, oldestSeq],
  );
  return (res.rowCount ?? 0) > 0;
}

export type MutationRefusal = 'not_found' | 'forbidden';

/** 수정은 작성자 본인만, user 메시지만. system 메시지는 avcs 투영의 산물이라 사람이 고칠 수 없다. */
export async function editMessage(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string; body: string },
): Promise<MessageRow | MutationRefusal> {
  const found = await pool.query(
    `select author_id, kind from message
     where id = $1 and channel_id = $2 and deleted_at is null`,
    [args.messageId, args.channelId],
  );
  if (!found.rowCount) return 'not_found';
  const row = found.rows[0];
  if (row.author_id !== args.actorId || row.kind !== 'user') return 'forbidden';

  /**
   * 수정도 **같은 정규화**를 탄다(#271) — 안 그러면 고친 메시지만 옛 형식으로 남아,
   * 그 메시지의 멘션만 이름 변경을 따라가지 못한다.
   *
   * `postMessage` 와 같은 이유로 채널 멤버가 아니라 **모든 계정**에서 찾는다:
   * public standard 채널에는 `channel_member` 행이 없다.
   *
   * 알림은 여기서 다시 만들지 않는다 — 그것은 이 함수가 원래 하지 않던 일이고,
   * 수정으로 뒤늦게 알림이 가는 것은 이 작업의 범위가 아니다.
   */
  const bodyHandles = mentionedHandles(args.body);
  const accounts = bodyHandles.length
    ? (await pool.query(
        `select id, lower(handle) as handle from account where lower(handle) = any($1)`,
        [bodyHandles],
      )).rows as { id: string; handle: string }[]
    : [];
  const normalizedBody = normalizeMentions(args.body, new Map(accounts.map((r) => [r.handle, r.id])));

  const updated = await pool.query(
    `update message set body = $2, edited_at = now() where id = $1 returning ${COLS}`,
    [args.messageId, normalizedBody],
  );
  return updated.rows[0];
}

/**
 * 선택 요청에 답을 기록한다. **원본을 고치는 것이 아니라 답을 덧붙이는 것**이므로
 * `edited_at` 은 건드리지 않는다 — 사람이 글을 고친 것이 아니다.
 *
 * **중복 답 방지가 이 함수의 핵심이다.** 두 사람이 같은 순간에 누르면 먼저 도착한 것이
 * 이긴다. 그 판정을 "읽고 나서 쓴다"로 하면 두 요청이 사이에 끼어 둘 다 통과하므로,
 * `meta->'ask'->>'answeredWith' is null` 을 **UPDATE 의 조건에 넣어** 한 문장으로 끝낸다.
 * 갱신된 행이 0개면 누군가 이미 답한 것이다.
 *
 * `already_answered` 를 `MutationRefusal` 에 섞지 않는 이유: 그 둘은 호출부가 다르게
 * 대접해야 한다. 없는 메시지는 404 지만, 이미 답한 것은 **정상 경로의 경합**이다.
 */
export async function recordAskAnswer(
  pool: Pool,
  args: { messageId: string; actorId: string; optionId: string },
): Promise<MessageRow | MutationRefusal | 'already_answered' | 'unknown_option'> {
  const found = await pool.query(
    `select meta from message where id = $1 and deleted_at is null`, [args.messageId],
  );
  if (!found.rowCount) return 'not_found';
  const ask = readAskMeta(found.rows[0].meta as Record<string, unknown>);
  // 선택 요청이 아닌 메시지에 답을 달 수는 없다. 형식을 못 알아보는 것도 여기 걸린다 —
  // `readAskMeta` 가 그 판정의 유일한 자리다(shared 에 두어 화면과 같은 판정을 쓴다).
  if (!ask) return 'not_found';
  if (!ask.options.some((o) => o.id === args.optionId)) return 'unknown_option';

  /**
   * 수신자가 정해져 있으면 그 계정만 답할 수 있다. 이것이 없으면 남에게 간 물음을
   * 아무나 가로채 답할 수 있고, 그러면 `to` 를 실은 뜻이 사라진다.
   */
  if (ask.to.kind === 'account' && ask.to.accountId !== args.actorId) return 'forbidden';

  const updated = await pool.query(
    `update message
        set meta = jsonb_set(
              jsonb_set(
                jsonb_set(meta::jsonb, '{ask,answeredWith}', to_jsonb($2::text)),
                '{ask,answeredBy}', to_jsonb($3::text)),
              '{ask,answeredAt}', to_jsonb(now()))
      where id = $1
        and deleted_at is null
        and meta->'ask'->>'answeredWith' is null
      returning ${COLS}`,
    [args.messageId, args.optionId, args.actorId],
  );
  if (!updated.rowCount) return 'already_answered';

  /**
   * **답이 왔음을 물어본 쪽에 알린다**(2026-09-09). 이것이 없으면 `message.ask` 의 약속
   * ("고르면 즉시 진행")이 성립하지 않는다: 답은 meta 에만 남고, 물어본 에이전트는 그
   * 사실을 영영 모른다. 게다가 `message.ask` 는 발화라서 그 턴은 답을 올린 뒤 회수되므로
   * (agent/src/mentionTurn.ts), 사람이 고민하는 사이 물어본 자리는 이미 비어 있다.
   * 실측(03:41): 답을 기록한 뒤 15분 동안 그 스레드에 아무 일도 없었다.
   *
   * **UPDATE 가 성공한 뒤에만** 만든다 — 위 `answeredWith is null` 조건이 경합에서 진
   * 쪽을 걸러 주므로, 두 사람이 동시에 눌러도 깨움은 하나다.
   *
   * `message_id` 는 **물음 자신**이다. 러너는 그 메시지의 meta 에서 `answeredWith` 를
   * 읽어 무엇이 골라졌는지 안다 — 별도 메시지를 만들지 않는 이유가 이것이다(스레드에
   * "답했다"는 줄이 하나 더 생기면 그 대화를 읽는 사람에게 소음이다).
   *
   * **자기 자신은 깨우지 않는다.** 에이전트가 다른 에이전트의 물음에 답하는 경로가
   * 있고(`to.kind === 'account'`), 그때 답한 쪽이 곧 물은 쪽이면 자기를 깨우게 된다.
   *
   * 실패해도 던지지 않는다 — 답은 이미 기록됐고, 그것이 이 함수가 약속한 것이다.
   * 깨우지 못하면 사람이 다시 멘션하는 길이 남는다(더 나쁜 쪽은 답이 사라지는 것이다).
   */
  const authorId = updated.rows[0].authorId as string;
  if (authorId !== args.actorId) {
    try {
      await pool.query(
        `insert into inbox (account_id, message_id, reason) values ($1, $2, 'ask_answered')`,
        [authorId, args.messageId],
      );
      emitEvent({ type: 'inbox.updated', accountId: authorId });
    } catch (err) {
      console.error('[recordAskAnswer] 깨움 실패(답은 기록됐다):', err);
    }
  }
  return updated.rows[0];
}

/** 삭제는 작성자 또는 admin. 수정과 달리 원문을 왜곡하지 않고 가리는 일이라 운영자에게 열어둔다. */
/**
 * 채널에 함께 올린 스레드 답을 **채널에서만** 거둔다(#231 의 되돌리기).
 *
 * 지우기가 아니다 — 메시지는 스레드에 그대로 남고 `also_in_channel` 만 false 가 된다.
 * 스레드에서 하던 이야기를 채널로 잘못 흘린 것을 되돌리는 자리라, 잘못 흘린 사람이
 * 고를 수 있는 것은 지금까지 "메시지째 지우기" 하나뿐이었다. 그것은 스레드에서
 * 이야기하던 사람들의 문맥까지 같이 지운다.
 *
 * **삭제와 같은 권한**을 쓴다(작성자 또는 admin). 지울 수 있는 사람이 그보다 약한 일을
 * 못 하면 화면은 더 거친 쪽을 권하게 된다.
 *
 * `kind` 를 보지 않는다 — 에이전트가 `alsoInChannel` 로 올린 progress·user 답도 같은
 * 실수를 할 수 있고, 되돌리는 것은 본문을 고치는 일이 아니다. 같은 이유로 `edited_at`
 * 도 건드리지 않는다: 사람이 글을 고친 것이 아니다.
 *
 * **이미 꺼져 있으면 그대로 돌려준다**(멱등). 두 번 눌러도 404 가 아니라 같은 결과다 —
 * 다른 창에서 먼저 거둔 뒤 이 창에서 누르는 것은 정상 경로다.
 *
 * 알림은 되돌리지 않는다. 채널에 뜬 것을 보고 이미 읽은 사람이 있고, 멘션으로 깬
 * 사람의 inbox 항목은 그 사람의 것이다 — 남의 읽음 상태를 이 호출이 되감지 않는다.
 */
export async function recallFromChannel(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string; actorIsAdmin: boolean },
): Promise<MessageRow | MutationRefusal> {
  const found = await pool.query(
    `select author_id from message
     where id = $1 and channel_id = $2 and deleted_at is null`,
    [args.messageId, args.channelId],
  );
  if (!found.rowCount) return 'not_found';
  if (found.rows[0].author_id !== args.actorId && !args.actorIsAdmin) return 'forbidden';

  const updated = await pool.query(
    `update message set also_in_channel = false where id = $1 returning ${COLS}`,
    [args.messageId],
  );
  return updated.rows[0];
}

/**
 * 이미 쓴 스레드 답을 **나중에** 채널로 올린다(#231 의 나머지 절반).
 *
 * `recallFromChannel` 의 반대다. 두 방향이 한 자원(`also-in-channel`)의 DELETE·PUT 인
 * 이유는 바뀌는 것이 본문이 아니라 "채널에도 보인다"는 성질 하나이기 때문이다 —
 * PATCH(본문 수정)에 얹으면 `edited_at` 이 찍혀, 글을 고치지 않았는데 고쳤다는 자국이 남는다.
 *
 * **작성자만** 할 수 있다. 거두기는 admin 에게도 열려 있지만(잘못 흘린 말을 치우는 조정),
 * 이쪽은 조정이 아니라 **발화**다 — 남의 스레드 글을 채널로 퍼뜨리는 것은 그 사람이 하지
 * 않은 선택이고, 그것을 admin 이 대신 할 수 있으면 "스레드에만 쓴다"는 판단이 지켜지지 않는다.
 *
 * 스레드 답이 아니면 `not_thread_reply` 다. 채널 최상위 메시지는 이미 채널에 있으므로
 * 켤 것이 없다 — `postMessage` 가 같은 경우를 조용히 false 로 정규화하는 것과 달리 여기서는
 * 사유를 돌려준다: 저기서는 "채널 메시지에 이 옵션은 뜻이 없다"이고, 여기서는 **사람이
 * 그 메시지를 겨냥해 눌렀다**는 뜻이라 아무 일도 없이 200 을 주면 화면이 거짓말을 한다.
 *
 * 새로 부르지 않는다(inbox 를 건드리지 않는다): 멘션은 글을 쓴 그 순간 이미 알렸고,
 * 채널로 옮겨 보인다고 같은 사람을 두 번 깨우면 알림이 대화량을 넘어선다.
 */
export async function promoteToChannel(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string },
): Promise<MessageRow | MutationRefusal | 'not_thread_reply'> {
  const found = await pool.query(
    `select author_id, thread_root_id from message
     where id = $1 and channel_id = $2 and deleted_at is null`,
    [args.messageId, args.channelId],
  );
  if (!found.rowCount) return 'not_found';
  if (found.rows[0].author_id !== args.actorId) return 'forbidden';
  if (found.rows[0].thread_root_id === null) return 'not_thread_reply';

  // 이미 켜져 있어도 같은 결과다 — 다른 창에서 먼저 올린 뒤 이 창에서 누르는 것은
  // 정상 경로이므로 거절하지 않는다(거두기의 두 번 호출과 같은 판단).
  const updated = await pool.query(
    `update message set also_in_channel = true where id = $1 returning ${COLS}`,
    [args.messageId],
  );
  return updated.rows[0];
}

/**
 * 목록에 보이는 모양 그대로 한 행을 읽는다. `getMessageById` 와 다른 점이 두 가지다 —
 * `LIST_COLS`(답글 집계 포함)로 읽고, `LIST_VISIBLE` 을 쓰므로 **자리표시자도 돌려준다.**
 *
 * `deleteMessage` 가 이것을 쓰는 이유: 지운 뒤 그 자리가 목록에서 아예 사라졌는지
 * 자리표시자로 남았는지를 **판정 규칙을 다시 쓰지 않고** 알아내려면, 목록이 쓰는 조건에
 * 그대로 물어보는 것이 유일한 방법이다. 여기서 `null` 이면 사라진 것이다.
 */
async function readListRow(pool: Pool, channelId: string, messageId: string): Promise<MessageRow | null> {
  const res = await pool.query(
    `select ${LIST_COLS} from message m ${THREAD_STATS}
     where m.channel_id = $1 and m.id = $2 and ${LIST_VISIBLE}`,
    [channelId, messageId],
  );
  return res.rows[0] ?? null;
}

/**
 * 삭제 결과. 행 하나가 사라지는 것으로 끝나지 않기 때문에 합 타입이 아니라 두 필드다 —
 * 부른 쪽은 이 둘을 보고 어떤 이벤트를 낼지 정한다.
 */
export interface DeleteMessageOutcome {
  /**
   * 지웠는데도 **목록에 자리가 남은** 경우 그 행(= 답글이 살아 있는 스레드 머리).
   * 이때 화면에 낼 이벤트는 `message.deleted` 가 아니라 `message.updated` 다: 행을 빼면
   * 스레드로 들어갈 문이 함께 사라진다.
   */
  tombstone: MessageRow | null;
  /**
   * 이 메시지가 **마지막 남은 답글**이어서 자리표시자로 서 있던 머리까지 함께 사라졌으면
   * 그 머리의 id. 답글 하나를 지운 결과로 다른 행이 사라지는 유일한 경우다.
   */
  rootGone: string | null;
}

export async function deleteMessage(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string; actorIsAdmin: boolean },
): Promise<DeleteMessageOutcome | MutationRefusal> {
  const found = await pool.query(
    `select author_id, thread_root_id as "threadRootId" from message
     where id = $1 and channel_id = $2 and deleted_at is null`,
    [args.messageId, args.channelId],
  );
  if (!found.rowCount) return 'not_found';
  if (found.rows[0].author_id !== args.actorId && !args.actorIsAdmin) return 'forbidden';
  const threadRootId: string | null = found.rows[0].threadRootId;

  await pool.query(`update message set deleted_at = now() where id = $1`, [args.messageId]);

  /**
   * 지운 것이 스레드 머리면 그 자리가 남았는지 목록에 물어본다(답글이 하나라도 살아
   * 있으면 남는다 — `LIST_VISIBLE`). 답글을 지운 경우에는 그 반대를 묻는다: 이 답글이
   * 마지막이어서 자리표시자로 서 있던 머리까지 사라졌는가. 두 질문 다 조건을 여기서
   * 다시 쓰지 않고 `readListRow` 에 넘긴다.
   */
  if (threadRootId === null) {
    return { tombstone: await readListRow(pool, args.channelId, args.messageId), rootGone: null };
  }
  const root = await readListRow(pool, args.channelId, threadRootId);
  return { tombstone: null, rootGone: root === null ? threadRootId : null };
}

/**
 * 링크 하나(#178)로 여는 경로. **채널을 모른 채 id 만 들고 온다** — 그래서 채널 조건이 없고,
 * 가시성 판정은 이 결과의 `channelId` 로 호출부가 `assertChannelVisible` 을 부른다.
 * 여기서 규칙을 다시 쓰면 같은 계산이 두 곳에 생긴다.
 *
 * `deleted_at is null` 이 조건에 들어 있는 것이 핵심이다: 지워진 메시지는 본문을 담아
 * 돌려준 뒤 걸러 내는 것이 아니라 **애초에 없는 것**이 되어 404 로 떨어진다.
 */
export async function getMessageById(pool: Pool, messageId: string): Promise<MessageRow | null> {
  const res = await pool.query(
    `select ${COLS} from message where id = $1 and deleted_at is null`, [messageId],
  );
  return res.rows[0] ?? null;
}

export async function listMessages(
  pool: Pool, channelId: string,
  opts: { since?: number; before?: number; threadRootId?: string | null; limit?: number },
): Promise<MessageRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  if (opts.threadRootId) {
    // 스레드 조회에서는 루트를 항상 포함한다 — limit 와 관계없이.
    if (opts.since !== undefined && opts.since > 0) {
      const res = await pool.query(
        `select ${LIST_COLS} from message m ${THREAD_STATS}
         where m.channel_id = $1 and (m.id = $2 or m.thread_root_id = $2) and m.seq > $3 and ${LIST_VISIBLE}
         order by m.seq limit $4`,
        [channelId, opts.threadRootId, opts.since, limit],
      );
      return res.rows;
    }
    const res = await pool.query(
      `select * from (
        select ${LIST_COLS} from message m ${THREAD_STATS}
        where m.channel_id = $1 and m.id = $2 and ${LIST_VISIBLE}
        union all
        select ${LIST_COLS} from message m ${THREAD_STATS}
        where m.channel_id = $1 and m.thread_root_id = $2 and ${LIST_VISIBLE}
        order by seq desc limit $3
      ) latest
      order by seq`,
      [channelId, opts.threadRootId, limit],
    );
    return res.rows;
  }
  // 역방향 페이지: before 보다 오래된 것 중 '가장 최신 limit 개'를 잡아 오름차순으로 되돌린다.
  // desc 로 잡지 않으면 채널 맨 앞부터 limit 개를 주게 되어 페이지가 이어지지 않는다.
  if (opts.before !== undefined) {
    const res = await pool.query(
      `select * from (
         select ${LIST_COLS} from message m ${THREAD_STATS}
         where m.channel_id = $1 and m.seq < $2 and ${LIST_VISIBLE}
         order by m.seq desc limit $3
       ) older
       order by seq`,
      [channelId, opts.before, limit],
    );
    return res.rows;
  }
  const since = opts.since ?? 0;
  if (since > 0) {
    const res = await pool.query(
      `select ${LIST_COLS} from message m ${THREAD_STATS}
       where m.channel_id = $1 and m.seq > $2 and ${LIST_VISIBLE}
       order by m.seq limit $3`,
      [channelId, since, limit],
    );
    return res.rows;
  }
  // since 미지정(0): 오래된 200개가 아니라 최신 N개를 반환한다 (반환 순서는 seq 오름차순 유지)
  const res = await pool.query(
    `select * from (
       select ${LIST_COLS} from message m ${THREAD_STATS}
       where m.channel_id = $1 and ${LIST_VISIBLE}
       order by m.seq desc limit $2
     ) latest
     order by seq`,
    [channelId, limit],
  );
  return res.rows;
}

export async function listInbox(
  pool: Pool, accountId: string, opts: { unreadOnly?: boolean },
): Promise<InboxEntry[]> {
  const res = await pool.query(
    `select i.id::int as id, i.message_id as "messageId", i.reason, i.read_at as "readAt",
            m.channel_id as "channelId",
            -- 줄이 네 가지를 말할 재료(#488 C2): 누가 · 무슨 말 · 무엇을 · 언제·어디.
            -- 이미 message 를 join 하고 있었으므로 컬럼만 더한다 — 새 왕복이 없다.
            m.author_id as "authorId", m.body, m.meta,
            m.created_at as "createdAt", m.thread_root_id as "threadRootId"
     from inbox i join message m on m.id = i.message_id
     -- 지워진 말은 인박스에도 남지 않는다. 본문을 싣기 시작했으므로 이 조건이 없으면
     -- 지운 글이 인박스 줄에 그대로 보인다(전에는 id 만 실어 보이지 않았다).
     where i.account_id = $1 and m.deleted_at is null
       ${opts.unreadOnly ? 'and i.read_at is null' : ''}
     order by i.id`,
    [accountId],
  );
  return res.rows;
}

/** 읽음 처리된 항목 수를 돌려준다. account_id 스코프이므로 남의 entry id 는 아무 것도 지우지 않는다. */
export async function markInboxRead(pool: Pool, accountId: string, ids: number[]): Promise<number> {
  const res = await pool.query(
    `update inbox set read_at = now() where account_id = $1 and id = any($2) and read_at is null`,
    [accountId, ids],
  );
  return res.rowCount ?? 0;
}

/**
 * `channelId` 를 주면 그 채널 안만 본다. 클라이언트에서 거르지 않는 이유(#221): 전역 검색은
 * seq desc 상위 N 건에서 잘리므로, 다른 채널의 일치가 많으면 이 채널 것이 애초에 응답에
 * 들어오지 않는다 — "이 대화 안에 있는 걸 아는데 못 찾는" 정확히 반대되는 결과가 된다.
 * 그래서 질의 자체를 좁힌다.
 */
export async function searchMessages(
  pool: Pool, requesterId: string, query: string, limit = 50, channelId: string | null = null,
): Promise<MessageRow[]> {
  const res = await pool.query(
    `select m.id, m.seq::int as seq, m.channel_id as "channelId", m.thread_root_id as "threadRootId",
       m.author_id as "authorId", m.body, m.kind, m.meta, m.created_at as "createdAt",
       m.edited_at as "editedAt", '[]'::json as reactions, '[]'::json as attachments,
       null::int as "replyCount", null::int as "activityCount",
  null::text as "lastReplyAt", null::text[] as "participantIds",
       m.also_in_channel as "alsoInChannel"
     from message m
     join channel c on c.id = m.channel_id
     where m.search @@ websearch_to_tsquery('simple', $1) and m.deleted_at is null
       -- 검색은 채널 목록을 우회해 본문에 바로 닿는 표면이다. 여기만 넓으면 목록에도
       -- 배지에도 없는 private 채널의 발언이 검색 결과로 통째로 나온다 — 그래서 목록·배지와
       -- **같은 술어**를 쓴다. admin 예외 없다(결과가 곧 메시지 본문이다).
       and ${channelVisibleSql('c', '$3')}
       -- 스코프는 가시성 **위에** 얹는 별개 조건이다. null 이면 절이 상수로 접혀 전역 검색의
       -- 계획이 그대로 남는다 — 기존 동작을 건드리지 않는다.
       and ($4::uuid is null or m.channel_id = $4)
     order by m.seq desc limit $2`,
    [query, Math.min(limit, 100), requesterId, channelId],
  );
  return res.rows;
}
