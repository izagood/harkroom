import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CHANNEL_MENTION_HANDLE, countsAsReply, MENTION_EDIT_WINDOW_MS, type MentionEditSkipReason, headMentionRunEnd, isAskOpen, MENTION_CHAIN_LIMIT, mentionedHandles, mentionedIds, mentionTargetKey, normalizeMentions, readAskMeta, splitMentionCalls, type InboxEntry, type InboxTeamCall, type InboxThreadState, type MessageRow } from '@harkroom/shared';
import { attachToMessage, type AttachFailure } from './attachments.js';
import { getMentionPolicy } from './mentionPolicy.js';
import { preemptWakesForThread } from './agentWakes.js';
import { closeDelegationsForReply, outcomesFor } from './delegations.js';
import { assertChannelVisible, audienceFor, channelVisibleSql } from './channels.js';
import { emitEvent } from '../events.js';
import { getHandleGroupByHandle, listHandleGroupMembers } from './handleGroups.js';
import { getTeam, getTeamByName, listTeamMembers } from './teams.js';
import { invokeFactsFor, mayInvoke, mayInvokeTeam, type InvokeVia } from './invokeGate.js';
import { closeReplyGrants, openReplyGrants } from './replyGrants.js';
import { enqueueInboxPush } from './push/pushJobs.js';
import { displayBodySql } from './systemBody.js';

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

/** 회신권 판정과 닫기를 (작성자, 스레드) 단위로 직렬화한다 — `postMessage` 의 주석 참고. */
const REPLY_LOCK_CLASS = 0x6d72706c; // 'mrpl'

const lockReplyGrantsFor = (client: PoolClient, authorId: string, threadRootId: string): Promise<unknown> =>
  client.query('select pg_advisory_xact_lock($1, hashtext($2))', [REPLY_LOCK_CLASS, `${authorId}:${threadRootId}`]);

/**
 * 게시 결과. 첨부 연결이 거절되면 메시지 자체가 만들어지지 않는다(트랜잭션 롤백) —
 * 그래서 성공/실패가 배타적인 합 타입이다. 둘을 optional 필드로 섞으면 호출부가
 * 실패를 확인하지 않고 `message` 를 만질 수 있다.
 */
export type PostMessageResult =
  | {
    message: MessageRow; notified: string[]; replayed: boolean; failure?: undefined;
    /**
     * 이 게시로 **목록에 되돌아온 스레드 머리**(2026-09-09 후속). 지워진 머리는 답글로
     * 세는 자식이 하나도 없으면 목록에서 빠지는데(`LIST_VISIBLE`), 그 스레드에 결과가
     * 달리면 다시 조건을 만족한다. 그 사실을 화면에 알리지 않으면 답은 도착했는데
     * 채널에 머리가 없어 **그 답이 어디에도 그려지지 않는다.**
     *
     * 낼 이벤트는 `message.created` 가 아니라 `message.updated` 이고, 이 답의
     * `message.created` **뒤에** 나가야 한다 — 이유는 둘 다 `emitPosted` 에 적었다.
     * 평소에는 `null` 이다(머리가 지워져 있지 않았거나, 이 말이 답글로 세지 않는 종류).
     */
    rootBack: MessageRow | null;
  }
  | { failure: AttachFailure | 'bad_thread'; message?: undefined; rejection?: undefined }
  /** `beforeCommit` 이 거절했다 — 트랜잭션은 롤백됐고 글은 없다. */
  | { failure: 'rejected'; rejection: { status: number; code: string; message: string }; message?: undefined };

/** `bad_thread` 거절의 문구 — REST 와 MCP 가 같은 말을 한다. */
export const BAD_THREAD_MESSAGE = 'threadRootId must be a top-level message in this channel';

/**
 * 이 글이 **이 채널의 최상위 글**이라 스레드 머리가 될 수 있나(`bad_thread` 판정). 게시와 예약
 * 생성이 같은 이 함수를 본다 — 예약만 검사하지 않으면 나쁜 스레드 id 가 보낼 때가 돼서야
 * `failed_reason=bad_thread` 로 떨어진다. 지워진 머리도 참이다(지워진 스레드에 답하는 경로가 있다).
 */
export async function isThreadRootOf(
  db: Pick<PoolClient, 'query'>, channelId: string, threadRootId: string,
): Promise<boolean> {
  const res = await db.query(
    `select 1 from message where id = $1 and channel_id = $2 and thread_root_id is null`, [threadRootId, channelId]);
  return Boolean(res.rowCount);
}

export interface PostMessageInput {
  /**
   * 커밋 **직전**에, 같은 트랜잭션으로 부른다. 팬아웃이 끝나 실제로 깨운 계정(`notified`)이 정해진
   * 뒤다. 거절을 돌려주면 게시 전체를 롤백한다 — 에이전트의 모델 고르기(087)가 "이 글이 실제로
   * 깨우는 상대에게만" 을 그 자리에서 판정하고, 거절이면 글 자체를 남기지 않으려고 쓴다(결정 6).
   */
  beforeCommit?: (
    client: PoolClient, ctx: { message: MessageRow; notified: ReadonlySet<string> },
  ) => Promise<{ status: number; code: string; message: string } | null>;
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
  /**
   * 이 발화를 낸 턴을 띄운 메시지(러너 → 브릿지 → 오퍼레이터 → MCP `CAUSE_HEADER`). 연쇄 깊이를
   * 스레드에서 짐작하지 않고 이 메시지에서 물려받는다(`mentionDepthFor`). 없으면 옛 셈이다.
   */
  causeMessageId?: string | null;
  /**
   * 에이전트가 돌린 자동화 회차(082)가 물려준 연쇄 깊이. 자동화 글은 **사람(소유자) 이름**으로
   * 나가서 보통은 깊이 0 이다 — 그대로 두면 에이전트가 자동화를 돌려 연쇄 상한을 세탁할 수 있다.
   * 이 값이 있으면 사람 글이어도 이 깊이로 저장하고 상한을 판정한다. 없으면(사람·시계·외부 이벤트) 옛 셈이다.
   */
  chainDepth?: number | null;
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
//
// 미리보기(090)의 버전이면 `artifact` 를 더한다 — 카드가 제목·버전·"최신 vN 있음"을 그린다. 보통
// 첨부에는 키 자체가 없다(null 을 싣지 않는다): 첨부 모양을 정확히 비교하는 화면·시험이 많다.
// `latestVersion` 은 읽는 순간의 값이다 — 새 버전이 올라와도 옛 글에 이벤트를 다시 치지 않는다.
// `title`·`summary` 는 **그 글의 버전** 것이다(091) — 옛 카드는 그때 이름을 보인다. 최신 이름은 `latestTitle`.
const ATTACHMENTS = `coalesce((
  select json_agg((jsonb_build_object(
    'id', a.id, 'filename', a.filename,
    'contentType', a.content_type, 'sizeBytes', a.size_bytes::int
  ) || coalesce((
    select jsonb_build_object('artifact', jsonb_build_object(
      'artifactId', av.artifact_id, 'version', av.version, 'title', coalesce(av.title, ar.title), 'latestTitle', ar.title, 'summary', av.summary,
      'coverAttachmentId', av.cover_attachment_id,
      'latestVersion', (select max(av2.version) from artifact_version av2 where av2.artifact_id = av.artifact_id)))
    from artifact_version av join artifact ar on ar.id = av.artifact_id where av.attachment_id = a.id
  ), '{}'::jsonb)) order by a.attached_at, a.created_at)
  from attachment a where a.message_id = message.id
), '[]'::json) as attachments`;

/**
 * 스레드 상태 리액션(D안, `services/threadStatus.ts`). 루트 하나에 한 행이라 PK 조회 하나다.
 * `COLS` 에도 싣는 이유: 실시간 `message.updated` 가 이 값을 null 로 덮으면 화면의 상태가
 * 깜빡인다(판정 재료가 그렇게 사라져 채널 줄 배지가 안 그려졌다 — 0.3.107).
 */
function statusReactionOf(alias: string): string {
  return `(select json_build_object('status', ts.status, 'emoji', ts.emoji, 'accountId', ts.account_id,
    'reason', ts.reason, 'updatedAt', ts.updated_at) from thread_status ts where ts.root_id = ${alias}.id)`;
}

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
  null::text[] as "openGateAccountIds",
  null::int as "failureCount", null::int as "unresolvedFailureCount",
  null::text as "lastKind", null::text as "lastAuthorId",
  ${statusReactionOf('message')} as "statusReaction",
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
    -- **closedAt 도 닫는다**(2026-09-09). 답하지 않기로 한 물음은 열려 있지 않다 — 이
    -- 조건이 없으면 사람이 그만두기로 한 뒤에도 대기 줄과 '내 차례' 배지가 남는다. 같은
    -- 판정이 shared::isAskOpen 에 있다(SQL 은 그 함수를 부를 수 없어 다시 적는다) —
    -- **필드가 늘면 두 자리를 함께 고친다.**
    COUNT(*) FILTER (
      WHERE t.meta->>'kind' = 'ask'
        AND t.meta->'ask'->>'answeredWith' IS NULL
        AND t.meta->'ask'->>'closedAt' IS NULL
        AND t.meta->'ask'->'to'->>'kind' = 'human'
    )::int as open_ask_human_count,
    -- 특정 계정에게 간 미답 물음의 수신자들. 화면이 "이것이 내 차례인가"를 여기서 가른다.
    COALESCE(ARRAY_AGG(DISTINCT t.meta->'ask'->'to'->>'accountId') FILTER (
      WHERE t.meta->>'kind' = 'ask'
        AND t.meta->'ask'->>'answeredWith' IS NULL
        AND t.meta->'ask'->>'closedAt' IS NULL
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
    -- 안 풀린 account_gate 실패의 차례 주인들(2026-10-02). 해소 규칙은 바로 위와 **같다** —
    -- 갈라지면 🙋 가 풀린 뒤에도 Inbox 의 내 차례에 남는다. 차례 주인을 못 정한 실패
    -- (awaitingAccountId 없음)는 넣지 않는다: 아무 계정 id 로 채우면 그 사람만 강조를 받는다.
    COALESCE(ARRAY_AGG(DISTINCT t.meta->'failure'->>'awaitingAccountId') FILTER (
      WHERE t.meta->>'kind' = 'failure'
        AND t.meta->'failure'->>'code' = 'account_gate'
        AND t.meta->'failure'->>'awaitingAccountId' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM message r
          WHERE (r.id = m.id OR r.thread_root_id = m.id)
            AND r.deleted_at IS NULL
            AND r.seq > t.seq
            AND (r.kind IN ('progress', 'wake')
              OR r.meta->>'kind' = 'report'
              OR r.author_id = t.author_id)
        )
    ), '{}'::text[]) as open_gate_account_ids,
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
        AND t.meta->'ask'->>'closedAt' IS NULL
        AND t.author_id IS NOT NULL
        -- 사람 아무나(human)와 특정 계정(account) 둘 다 마디가 된다. 그 밖의
        -- to.kind 는 화면이 이을 수 없으므로 넣지 않는다.
        AND (t.meta->'ask'->'to'->>'kind' = 'human'
          OR (t.meta->'ask'->'to'->>'kind' = 'account'
            AND t.meta->'ask'->'to'->>'accountId' IS NOT NULL))
    ), '[]'::jsonb)
    -- 위임 마디(3-3). 팀장이 기다리는 팀원 하나마다 한 마디다.
    --
    -- 물음과 같은 목록에 넣는 이유: 사슬을 잇는 walk() 는 마디의 출처를 묻지 않는다 —
    -- 누가 누구를 기다리는가 하나만 본다. 목록을 갈라 두 벌로 내면 화면이 그 둘을 합치는
    -- 코드를 또 쓰게 되고, 그 합치기가 스레드 안(메시지에서 만든 사슬)과 갈라진다.
    --
    -- 위임 하나가 여러 마디가 되므로(팀원 N 명) jsonb_array_elements_text 로 펼친다.
    -- ask 는 상대가 하나라 그 펼침이 없었고, 그래서 별도 집계가 필요하다.
    || COALESCE((
      SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT('waiter', d.author_id::text, 'blockedBy', o.id, 'askedAt', d.created_at)
        ORDER BY d.seq
      )
      FROM message d, LATERAL JSONB_ARRAY_ELEMENTS_TEXT(d.meta->'delegation'->'open') AS o(id)
      WHERE (d.id = m.id OR d.thread_root_id = m.id) AND d.deleted_at IS NULL
        AND d.meta->>'kind' = 'delegation' AND d.author_id IS NOT NULL
        AND m.thread_root_id IS NULL
    ), '[]'::jsonb) as open_ask_links
  FROM message t
  WHERE (t.id = m.id OR t.thread_root_id = m.id) AND t.deleted_at IS NULL
    -- 루트에서만 계산한다 — 근거는 THREAD_STATS 위 주석.
    AND m.thread_root_id IS NULL
) thread_state ON true
LEFT JOIN LATERAL (
  -- 마지막 말 하나. 그것이 진행이고 저자가 살아 있는 에이전트일 때만 '도는 중'이므로,
  -- 화면은 이 둘(kind·저자)에 자기가 아는 생존을 곱해 판정한다.
  SELECT t.kind as last_kind, t.author_id::text as last_author_id
  FROM message t
  WHERE (t.id = m.id OR t.thread_root_id = m.id) AND t.deleted_at IS NULL
    -- 루트에서만 계산한다 — 근거는 THREAD_STATS 위 주석.
    AND m.thread_root_id IS NULL
  ORDER BY t.seq DESC LIMIT 1
) thread_last ON true`;

// 스레드 메타데이터: 루트 메시지에만 계산. LATERAL join으로 같은 쿼리에서 계산한다 (N+1 방지).
//
// **`AND m.thread_root_id IS NULL` 이 각 LATERAL 의 `WHERE` 안에 있다**(2026-09-21).
// 아래 `LIST_COLS` 가 이미 `case when m.thread_root_id is null then …` 로 답글 행의 값을
// 버리고 있었지만, 플래너는 바깥 `CASE` 를 보고 LATERAL 을 건너뛰지 못한다 — **버릴 값을
// 그대로 다 계산했다.** 채널 한 페이지에서 답글이 대부분이므로 그 헛계산이 곧 비용이었다.
//
// **`ON` 절로는 안 된다.** `ON m.thread_root_id IS NULL` 로 올려 보면 계획에 `Join Filter` 로
// 내려앉고, 안쪽은 `loops=500` 그대로 돈 뒤 결과만 버려진다(실측: `ON true` 745ms →
// `ON …` 665ms, 오차 범위). 조인 조건은 **이미 만들어진 행**을 거르는 자리이지 안쪽을
// 막는 자리가 아니다.
//
// 조건을 `WHERE` 안에 두면 다르다. 바깥 행마다 상수인 조건이라 Postgres 가 이것을
// **`One-Time Filter`** 로 세우고, 답글 행에서는 안쪽 스캔이 `never executed` 가 된다
// (같은 실측에서 745ms → 33ms). 그래서 이 줄은 조인이 아니라 각 서브쿼리 안에 있어야 한다 —
// 선택 목록의 스칼라 서브쿼리(참여자·위임 마디)까지 하나하나 붙인 이유도 그것이다:
// 집계는 빈 입력에도 한 행을 내므로, 거기까지 막지 않으면 그 둘만 계속 돈다.
//
// LEFT JOIN 이라 걸러진 행의 컬럼은 null 이 되고, 그것은 `CASE` 가 내던 값과 같다 —
// **응답은 한 글자도 바뀌지 않는다.** `CASE` 를 지우지 않는 이유가 그것이다: 둘은 같은
// 사실을 말하고, 남겨 두면 이 조건이 나중에 빠져도 답글 행에 스레드 값이 실리지 않는다.
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
          AND m.thread_root_id IS NULL
        GROUP BY author_id
      ) recent
    ), '{}'::uuid[]) as participant_ids
  FROM message WHERE thread_root_id = m.id AND deleted_at IS NULL
    -- 루트에서만 계산한다 — 근거는 THREAD_STATS 위 주석.
    AND m.thread_root_id IS NULL
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
  case when m.thread_root_id is null then thread_state.open_gate_account_ids end as "openGateAccountIds",
  case when m.thread_root_id is null then thread_state.failure_count end as "failureCount",
  case when m.thread_root_id is null then thread_state.unresolved_failure_count end as "unresolvedFailureCount",
  case when m.thread_root_id is null then thread_state.open_ask_links end as "openAskLinks",
  case when m.thread_root_id is null then thread_last.last_kind end as "lastKind",
  case when m.thread_root_id is null then thread_last.last_author_id end as "lastAuthorId",
  case when m.deleted_at is null then ${statusReactionOf('m')} end as "statusReaction",
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
 *
 * **자리를 남기는 기준은 `countsAsReply` 다**(2026-09-09 후속). 여기서 살아 있는 자식을
 * 아무거나 세었더니, 접힌 진행 줄만 남은 머리가 `채팅이 삭제되었습니다` 자리표시자로
 * 계속 서 있었다 — 눌러 들어가면 말풍선이 하나도 없고 `작업 중 · 13시간째` 상태 한 줄뿐이다
 * (사용자 신고: *"답글이 아니라 접혀진 작업 내역이야 … 이럴때는 채팅 자체가 삭제되는게 맞아"*).
 *
 * 그 자리표시자가 존재하는 이유는 **살아 있는 답글로 들어갈 문**을 남기는 것 하나였다.
 * 진행·대기는 답글이 아니므로(`shared::countsAsReply`) 들어갈 이유가 없고, 문만 남는다.
 * 그러면 지운 사람이 볼 것은 "내가 지웠는데 안 지워진 것"뿐이다.
 *
 * 남은 진행 행을 지우지는 않는다. 그 스레드에 **결과가 다시 달리면** 머리가 돌아오고,
 * 그때 작업 내역이 함께 보이는 것이 맞다 — 돌아오게 만드는 자리는 `postMessage` 다.
 *
 * `THREAD_STATS` 와 같은 목록을 두 번 적는 셈이다(SQL 은 그 함수를 부를 수 없다).
 * **종류가 늘면 세 자리를 함께 고친다.**
 */
const LIST_VISIBLE = `(m.deleted_at is null or (m.thread_root_id is null and exists (
  select 1 from message r
   where r.thread_root_id = m.id and r.deleted_at is null
     and r.kind not in ('progress', 'wake')
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

/**
 * `account_gate` 실패의 **차례 주인**(2026-10-02, 관문 대응 안 2) — 그 턴을 띄운 멘션을 쓴 사람.
 *
 * **믿기 전에 확인한다**(원인 헤더와 같은 규율): 그 메시지가 이 에이전트를 **실제로 깨웠고**
 * (inbox), 같은 채널이며, 작성자가 **사람**이고 **지금도 그 채널을 볼 수 있을** 때만 그 사람이다
 * (security F1 — 턴이 도는 사이 채널에서 빠진 사람의 Inbox 에 그 채널 글 본문이 실리지 않게). 아니면 `null` — 에이전트가
 * 아무 메시지 id 나 대서 남의 Inbox 에 "내 차례"를 꽂지 못하게 한다.
 */
export async function gateAwaitingAccount(
  pool: Pool, agentId: string, channelId: string, mentionId: string,
): Promise<string | null> {
  const res = await pool.query(
    `select m.author_id
       from inbox i
       join message m on m.id = i.message_id
       join account a on a.id = m.author_id
       join channel c on c.id = m.channel_id
      where i.account_id = $1 and i.message_id = $2 and m.channel_id = $3
        and a.kind = 'human' and m.deleted_at is null
        and ${channelVisibleSql('c', 'm.author_id')}
      limit 1`,
    [agentId, mentionId, channelId],
  );
  return (res.rows[0]?.author_id as string | undefined) ?? null;
}

/**
 * 차례 주인에게 이 실패를 Inbox 로 알린다 — `postMessage` 의 `beforeCommit` 안에서 부른다
 * (같은 트랜잭션, 팬아웃이 끝난 뒤). 이미 이 글로 알림을 받았으면(스레드 주인 등) 두 번 넣지 않는다.
 *
 * 사유가 `thread_reply` 인 이유: 사람이 받는 것은 "나를 지목했다"가 아니라 "내가 부른 스레드에
 * 답(실패)이 왔다"이고, 그 사유는 숨긴 채널도 다시 보이게 한다(`REVEAL_REASONS`).
 */
export async function notifyGateAwaiting(
  client: PoolClient, accountId: string, messageId: string, notified: ReadonlySet<string>,
): Promise<void> {
  if (notified.has(accountId)) return;
  await insertInbox(client, accountId, messageId, 'thread_reply', notified as Set<string>);
}

async function insertInbox(
  client: PoolClient, accountId: string, messageId: string, reason: InboxEntry['reason'], notified: Set<string>,
  /**
   * 팀 부름이면 그 팀(047). `reason === 'team_mention'` 과 짝이다 — 다른 사유에는 넘기지
   * 않는다. 인자를 하나 더 두는 것이 이 함수의 관문 성격(위 주석: 부름을 만드는 자리는
   * 여기 하나다)을 지키는 유일한 방법이다: 팀 부름만 따로 insert 하면 숨김 되돌리기가
   * 그 경로에서 빠진다.
   */
  teamId?: string,
): Promise<void> {
  const inserted = await client.query<{ id: string }>(
    `insert into inbox (account_id, message_id, reason, team_id) values ($1, $2, $3, $4) returning id`,
    [accountId, messageId, reason, teamId ?? null],
  );
  // 푸시(093): 같은 트랜잭션에 job 을 넣는다. 사람이고 기기가 있을 때만 행이 생긴다.
  // 이 관문이 부름을 만드는 유일한 자리라 "알림을 받은 사람"과 "폰이 울리는 사람"이 갈리지 않는다.
  await enqueueInboxPush(client, inserted.rows[0]!.id, accountId, messageId, reason);
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
  /**
   * 팀장 하나를 부르는 경우의 사유와 팀(047). 기본값이 `'mention'` 인 이유: 이 함수의
   * 호출부 셋(`@channel`·집합·팀 폴백)은 전부 평범한 부름이고, 그것을 각 호출부가
   * 적어야 하게 만들면 한 곳이 틀렸을 때 사유가 조용히 갈린다.
   */
  call: { reason: InboxEntry['reason']; teamId?: string } = { reason: 'mention' },
  /** 이 부름이 어떻게 왔나(스펙 2026-09-20 §6 게이트). 직접 멘션이 아니면 community 스코프만 통과한다. */
  via: InvokeVia = 'mention',
): Promise<void> {
  if (candidateIds !== null && candidateIds.length === 0) return;
  const audience = await client.query<{ id: string }>(
    `select a.id from account a, channel c
      where c.id = $1 and a.id <> $2
        and ($3::uuid[] is null or a.id = any($3))
        and ${channelVisibleSql('c', 'a.id')}`,
    [input.channelId, input.authorId, candidateIds],
  );
  // 호출 게이트(스펙 2026-09-20 §6). 사람은 스코프가 없다 — facts 에 없으면 그대로 통과. 여기서
  // 걸러진 부름은 meta 에 남지 않는다(행이 이미 나갔다) — 팀·auto-mention 은 넣는 시점에 400 으로
  // 막히므로 이 거름은 그 전에 들어간 옛 데이터를 위한 방어다.
  const facts = await invokeFactsFor(client, audience.rows.map((r) => r.id));
  for (const row of audience.rows) {
    if (notified.has(row.id)) continue;
    const fact = facts.get(row.id);
    if (fact && !(await mayInvoke(client, fact, { callerId: input.authorId, channelId: input.channelId, via }))) continue;
    await insertInbox(client, row.id, input.messageId, call.reason, notified, call.teamId);
  }
}

/**
 * 이 발화가 **연쇄의 몇 번째 고리인가**(4단계). 정의와 근거는
 * `043_mention_chain_depth.sql` 에 있다.
 *
 * ## 사람은 언제나 0 이다
 *
 * 사람은 연쇄의 시작이지 고리가 아니다. 그래서 사람이 한 번 끼어들면 깊이는 다시 0 에서
 * 세어지고, 상한에 걸려 멈춘 스레드도 사람이 말을 걸면 **정상으로 되살아난다** — 상한이
 * 스레드를 영구히 잠그는 장치가 되지 않게 하는 것이 이 규칙이다.
 *
 * ## 판정을 새로 만들지 않는다
 *
 * "이 메시지가 나를 불렀나"는 알림이 쓰는 그 판정(`splitMentionCalls(...).call`)으로 답한다.
 * SQL 의 `like '%<@id>%'` 로 대신하면 **인용 줄과 코드 블록 안의 토큰까지 세어** 부르지 않은
 * 것을 부른 것으로 취급한다 — 그러면 남의 말을 인용한 스레드가 이유 없이 상한에 걸린다.
 *
 * **지칭은 고리가 아니다.** 동료가 나를 이름으로 언급했을 뿐인 발화(머리 런 밖의 `@나`)는
 * 나를 부르지 않았으므로 내 앞 고리가 아니다. 그래서 이 스캔도 알림과 같은 함수를 쓰고,
 * 그러려면 **그 행의 작성자가 에이전트인지**를 알아야 한다(사람이 쓴 것은 자리와 무관하게
 * 전부 부름이다) — 그래서 쿼리가 `account` 를 함께 읽는다. 여기서 갈라지면 지칭만 오간
 * 스레드가 깊이를 쌓아 이유 없이 상한에 걸린다.
 *
 * 최근 `DEPTH_SCAN_LIMIT` 개만 훑는다. 연쇄는 직전 발화에서 이어지므로 더 거슬러 갈 이유가
 * 없고, 스레드가 수백 줄이어도 비용이 일정해야 한다.
 */
const DEPTH_SCAN_LIMIT = 50;

async function mentionDepthFor(
  client: PoolClient,
  input: {
    channelId: string; threadRootId: string | null; authorId: string; authorIsAgent: boolean;
    causeMessageId?: string | null;
  },
): Promise<number> {
  if (!input.authorIsAgent) return 0;
  if (input.causeMessageId) {
    const fromCause = await causeDepth(client, input.authorId, input.causeMessageId);
    if (fromCause !== null) return fromCause;
  }
  const rows = (await client.query(
    `select m.body, m.mention_depth as depth, (a.kind = 'agent') as author_is_agent,
            -- **실제로 나를 깨운 부름만 고리다**(2026-09-29). 본문만 다시 파싱하면 상한에
            -- 막혔거나(capped) 호출 범위에 거절된(denied) 부름도 "나를 부른 메시지"로 보여,
            -- 깨운 적 없는 부름이 깊이를 쌓았다. 그 부름으로 inbox 가 생겼는지를 함께 본다.
            -- thread_reply·wake 같은 사유는 부름이 아니므로 세지 않는다.
            exists (select 1 from inbox i
                     where i.message_id = m.id and i.account_id = $3
                       and i.reason in ('mention', 'dm', 'team_mention', 'team_delegated')) as woke
       from message m join account a on a.id = m.author_id
      where m.channel_id = $1
        -- **스레드 경계를 양쪽 다 지킨다**(2026-09-14).
        --
        -- 앞 판본은 두 번째 인자가 null 이면 이 조건을 통째로 비웠다 — 그래서 **새 채널
        -- 최상위** 발화가 채널의 다른 스레드에서 나를 부른 답을 앞 고리로 물려받았다.
        -- 무관한 새 대화인데 깊이가 3~4로 시작해 곧바로 상한에 걸렸고, 사람이 새 턴을
        -- 띄워 줘도 소용없었다(깊이가 내 턴이 아니라 채널 이력에서 왔으므로).
        --
        -- 최상위 발화는 **최상위 발화들끼리만** 고리로 본다. A·B 가 최상위로 서로를
        -- 부르며 도는 폭주는 그대로 잡히고(그 발화들도 최상위다), 다른 스레드의 옛
        -- 부름은 더 이상 새 대화의 앞 고리가 아니다.
        and (case when $2::uuid is null
                  then m.thread_root_id is null
                  else m.thread_root_id = $2 or m.id = $2 end)
        and m.deleted_at is null
      order by m.seq desc
      limit ${DEPTH_SCAN_LIMIT}`,
    [input.channelId, input.threadRootId, input.authorId],
  )).rows as { body: string; depth: number; author_is_agent: boolean; woke: boolean }[];
  for (const row of rows) {
    if (!row.woke) continue;
    // 나를 부른 **가장 최근** 메시지 하나가 내 앞 고리다 — 그것을 찾으면 멈춘다.
    // 대상은 나 하나뿐이므로 `isAgent` 도 나만 물으면 된다(위에서 이미 에이전트로 걸렀다).
    const { call } = splitMentionCalls(row.body, {
      authorIsAgent: row.author_is_agent,
      isAgent: (id) => id === input.authorId,
    });
    if (call.includes(input.authorId)) return row.depth + 1;
  }
  // 나를 부른 것이 없는 발화(스스로 올린 보고·깨움 뒤의 이어 말하기)는 연쇄가 아니다.
  return 0;
}

/**
 * **턴의 원인에서 물려받은 깊이**(2026-09-29). 사람이 #task 의 작업 관리 에이전트에게만 말하면
 * 그 에이전트가 담당을 부르는 작업 스레드에는 사람의 글이 없다 — 스레드를 훑는 셈으로는 사람이
 * 사슬을 시작했다는 것이 보이지 않아, 위임·회수가 두 번 오가면 반드시 상한에 걸렸다(#harkroom
 * seq 3336). 러너는 이 턴을 무엇이 띄웠는지 정확히 안다 — 그 메시지의 깊이 + 1 이 내 깊이다.
 * 채널·스레드가 달라도 된다.
 *
 * **원인으로 치는 것은 나를 실제로 깨운 메시지뿐이다.** 헤더는 에이전트 쪽에서 오는 값이므로,
 * 아무 사람 메시지 id 나 대면 깊이를 0 으로 되돌리는 우회로가 된다. 그래서 그 메시지가 나에게
 * inbox 를 만들었는지 본다. 사유도 가린다: 부름(mention·dm·team_*)이거나 **사람이 쓴 것**
 * (스레드 답·ask 답)만 원인이다. 내가 건 대기 줄(`wake`)이나 에이전트 글의 답글 알림으로 뜬
 * 턴은 원인에서 깊이를 물려받지 않는다 — 대기 줄은 내 발화라 물려받으면 깨어날 때마다 한 칸씩
 * 쌓이고, 에이전트 답글은 부름이 아니다. 그때는 null 로 옛 셈에 맡긴다.
 */
async function causeDepth(client: PoolClient, authorId: string, causeMessageId: string): Promise<number | null> {
  const row = (await client.query(
    `select m.mention_depth as depth, (a.kind = 'agent') as author_is_agent,
            (m.meta ? 'automation') as from_automation
       from message m join account a on a.id = m.author_id
      where m.id = $1 and m.deleted_at is null
        and exists (select 1 from inbox i
                     where i.message_id = m.id and i.account_id = $2
                       and (i.reason in ('mention', 'dm', 'team_mention', 'team_delegated')
                            or (a.kind = 'human' and i.reason in ('thread_reply', 'ask_answered'))))`,
    [causeMessageId, authorId],
  )).rows[0] as { depth: number; author_is_agent: boolean; from_automation: boolean } | undefined;
  if (!row) return null;
  // 사람은 언제나 0 이다(`mentionDepthFor`) — 저장된 값을 믿지 않고 규칙으로 센다. 예외는 에이전트가
  // 돌린 자동화 글(082)이다: 사람 이름이지만 사슬의 고리라 저장된 깊이를 잇는다(시계·버튼 회차는 0 이다).
  return row.author_is_agent || row.from_automation ? row.depth + 1 : 1;
}

/**
 * 한 본문이 **누구를 부르는가** — 정규화부터 상한·호출 게이트·팀 계획·`@channel` 판정까지.
 *
 * 게시(`postMessage`)와 수정(`editMessage`)이 **같은 함수를 쓴다.** 판정이 두 자리에 살던 동안
 * 수정 쪽만 #845(집합·팀 토큰)·061(삭제 계정)을 놓쳐, 고친 메시지의 `@팀` 은 글자로만 남았다.
 *
 * 디비를 읽기만 하고 아무것도 쓰지 않는다 — 결과는 insert·update 앞에서 meta 로 굳히고,
 * 실제로 inbox 를 넣는 일은 `fanOutCalls` 가 한다. 깊이는 부른 쪽이 잰다: 게시는 스레드를
 * 훑고(`mentionDepthFor`), 수정은 그 행에 이미 저장된 값을 쓴다.
 */
interface ResolvedMentionCalls {
  normalizedBody: string;
  /** 본문의 글자 `@handle` 가운데 계정으로 풀린 것 — `@channel` 이라는 계정이 있는지 보는 데 쓴다. */
  accountHandles: Set<string>;
  calledIds: string[];
  cappedIds: Set<string>;
  deniedIds: Set<string>;
  teamPlans: { teamId: string; recipients: string[]; viaLead: boolean }[];
  targetCall: { kind: 'group' | 'team'; id: string }[];
  channelCalled: boolean;
  /** 이 판정이 메시지에 남기는 사실(`mentionChainCapped`·`mentionDenied`·`mentionRefs`). */
  callMeta: Record<string, unknown>;
}

async function resolveMentionCalls(
  client: PoolClient,
  input: {
    body: string; channelId: string; authorId: string; authorIsAgent: boolean; mentionDepth: number;
    /** 사람 이름 글이지만 에이전트 사슬에서 나온 것(082, `PostMessageInput.chainDepth`) — 상한을 똑같이 본다. */
    chainBound?: boolean;
    /**
     * 회신권(084)을 찾을 스레드 — **결과 발화일 때만** 넘긴다(`invokeGate.mayInvoke` 의 ctx 주석).
     * 수정은 넘기지 않는다(에이전트 글의 수정은 부르지 않는다).
     */
    replyGrantThreadId?: string | null;
  },
): Promise<ResolvedMentionCalls> {
  const { authorIsAgent, mentionDepth } = input;
  const capsChain = authorIsAgent || input.chainBound === true;
  // 상한은 워크스페이스 설정이다(078). 에이전트 사슬의 발화일 때만 읽는다 — 사람은 막히지 않는다.
  const chainLimit = capsChain ? (await getMentionPolicy(client)).chainLimit : MENTION_CHAIN_LIMIT;
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
        // `kind` 를 함께 읽는다(4단계) — 연쇄 깊이 상한은 **에이전트만** 막으므로 부른
        // 대상이 사람인지 에이전트인지를 알아야 하고, 그 사실은 이미 이 조회에 있다.
        // 계정마다 다시 물으면 부른 수만큼 왕복이 늘고, 그 왕복은 게시 경로에 붙는다.
        // 삭제된 계정은 뺀다(061) — 이름은 그대로 잡혀 있으므로 빼지 않으면 `@handle` 이
        // 명부에 없는 에이전트를 부르고, 아무도 읽지 않는 인박스 항목이 쌓인다.
        `select id, lower(handle) as handle, kind from account
          where lower(handle) = any($1) and deleted_at is null`,
        [bodyHandles],
      )).rows as { id: string; handle: string; kind: 'human' | 'agent' }[]
    : [];
  const handleToId = new Map(mentionedAccounts.map((r) => [r.handle, r.id]));

  /**
   * 집합·팀도 정본으로 바꾼다(#845). 계정만 토큰이 되고 이 둘은 글자로 남아 있었는데,
   * **팀은 이름이 바뀐다**(`PATCH /teams/:id`) — 바뀌는 순간 과거 본문의 `@옛팀이름` 은
   * 아무것도 가리키지 않는다. #271 이 계정에 대해 푼 문제가 같은 이름공간에 남아 있었다.
   *
   * 지도의 **값**에 접두를 실어 `normalizeMentions` 자체는 손대지 않는다 — 그 함수는
   * `<@${값}>` 을 쓰므로 값이 `team:<uuid>` 면 토큰도 `<@team:<uuid>>` 가 된다.
   *
   * **우선순위는 아래 팬아웃 루프가 정본이다**: 계정 > 집합 > 팀. 여기서 그 순서를 다시
   * 정하지 않고 그대로 따른다 — 갈리면 한 발화에서 저장된 토큰과 실제로 깬 대상이 달라진다.
   * 겹친 데이터에서 집합이 팀을 이기는 근거는 그 루프의 주석에 있다.
   *
   * **`handleToId` 에 넣지 않고 사본(`nameToToken`)에 넣는다.** 그 지도의 키 집합이
   * 아래에서 `accountHandles` 가 되고, 팬아웃 루프는 그 집합에 든 이름을 *"이미 계정으로
   * 처리했다"* 며 건너뛴다 — 집합·팀을 원본에 넣으면 팬아웃이 그 둘을 통째로 지나쳐
   * **아무도 안 깬다**(실측: 팀·집합 테스트 15개가 한꺼번에 빨개졌다). 정규화용 지도와
   * "계정으로 처리한 이름" 목록은 서로 다른 사실이다.
   */
  const nameToToken = new Map(handleToId);
  for (const handle of bodyHandles) {
    if (handle === CHANNEL_MENTION_HANDLE || nameToToken.has(handle)) continue;
    const group = await getHandleGroupByHandle(client, handle);
    if (group) {
      nameToToken.set(handle, mentionTargetKey('group', group.id));
      continue;
    }
    const team = await getTeamByName(client, handle);
    if (team) nameToToken.set(handle, mentionTargetKey('team', team.id));
  }

  const normalizedBody = normalizeMentions(input.body, nameToToken);

  /*
    상한 판정을 **insert 보다 앞에서** 끝낸다. 뒤에서 `update ... meta` 로 얹으면 이미
    읽어 응답·WS 이벤트로 나간 행에는 그 사실이 없어서, 화면은 부르지 않은 호출을
    부른 것으로 그린다 — 같은 메시지가 두 형식으로 존재하는 순간을 만들지 않는다는
    정규화 주석의 규율과 같다.
  */
  const chainCapped = capsChain && mentionDepth >= chainLimit;

  /*
    **부름과 지칭을 가른다**(2026-09-09). 규칙과 근거는 `splitMentionCalls` 에 있다:
    에이전트가 동료 에이전트를 **본문 한가운데서** 이름으로 언급한 것은 부르는 것이
    아니다. 알림을 만드는 자리가 여기 하나뿐이므로 판정도 여기서 한 번만 한다.

    깊이 상한(`cappedIds`)도 이 결과 위에서 센다 — 애초에 부르지 않은 이름을 "막았다"고
    적으면 화면이 없던 호출을 있었다고 말하게 된다.
  */
  /*
    **본문에 처음부터 `<@id>` 로 적힌 계정도 함께 읽는다.** 위 조회는 `@handle` 글자만 보므로
    에이전트가 id 로 부른 계정은 거기 없다 — 그러면 `isAgent` 가 모르는 id 를 사람으로 보고
    (본문 한가운데의 지칭이 부름이 된다), 막힌 부름이 `mentionDenied`·`mentionChainCapped` 에
    남지 않고 조용히 사라진다(#rcms, task_manager → rcms 세 번). 판정이 보는 계정 목록은
    정규화된 본문의 토큰 전부여야 한다.

    `handleToId`(정규화 지도·`@channel` 예외의 "계정으로 처리한 이름")에는 넣지 않는다 —
    그 둘은 본문의 **글자** 에 대한 사실이다.
  */
  const knownIds = new Set(mentionedAccounts.map((a) => a.id));
  const rawIds = mentionedIds(normalizedBody).filter((id) => !knownIds.has(id));
  const tokenAccounts = rawIds.length
    ? (await client.query(
        `select id, lower(handle) as handle, kind from account
          where id = any($1::uuid[]) and deleted_at is null`,
        [rawIds],
      )).rows as { id: string; handle: string; kind: 'human' | 'agent' }[]
    : [];
  const calledAccounts = [...mentionedAccounts, ...tokenAccounts];
  const agentIds = new Set(calledAccounts.filter((a) => a.kind === 'agent').map((a) => a.id));
  const { call: calledIds, ref: refIds, targetCall, targetRef } = splitMentionCalls(normalizedBody, {
    authorIsAgent,
    isAgent: (id) => agentIds.has(id),
  });

  const cappedIds = new Set<string>();
  if (chainCapped) {
    for (const accountId of calledIds) {
      if (accountId === input.authorId) continue;
      // **에이전트만 막는다.** 사람을 부르는 것은 "이 스레드에 사람이 필요하다"는 뜻이라
      // 상한이 걸린 그때 오히려 더 필요하다.
      if (agentIds.has(accountId)) cappedIds.add(accountId);
    }
  }
  const cappedHandles = calledAccounts.filter((a) => cappedIds.has(a.id)).map((a) => a.handle);
  /*
    호출 게이트(스펙 2026-09-20 §6) — **insert 보다 앞에서** 잰다. 상한 판정과 같은 이유다:
    막힌 부름은 `meta.mentionDenied` 로 그 메시지에 남아야 하고, 응답·WS 이벤트로 이미 나간
    행에 뒤늦게 얹을 수 없다. 상한에 이미 막힌 것은 다시 세지 않는다 — 한 이름이 두 사유로
    두 번 적히면 화면이 "둘을 못 불렀다"로 읽는다.
  */
  const deniedIds = new Set<string>();
  const gateFacts = await invokeFactsFor(client, [...calledIds].filter((id) => id !== input.authorId && !cappedIds.has(id)));
  for (const [id, fact] of gateFacts) {
    if (!(await mayInvoke(client, fact, {
      callerId: input.authorId, channelId: input.channelId, via: 'mention', replyGrantThreadId: input.replyGrantThreadId,
    }))) deniedIds.add(id);
  }
  const deniedHandles = calledAccounts.filter((a) => deniedIds.has(a.id)).map((a) => a.handle);

  /*
    **팀 부름도 insert 앞에서 판정한다**(068). 예전에는 팀 게이트가 insert 뒤의 `fanOutMention`
    안에만 있어서 막힌 팀원이 `mentionDenied` 에 남지 않았다 — #udc 의 `@udc-team` 네 번이
    👀·실패·표시 없이 사라진 자리다. 여기서 누구를 깨울지(`teamPlans`)까지 정해 두고, 아래
    팬아웃은 그 결과만 넣는다.

    판정은 두 겹이다(`invokeGate.ts` 머리 주석): ① 팀의 범위, ② 팀원 각자의 범위(호출자 기준).
    막힌 것은 팀이면 팀 이름, 팀원이면 그 handle 로 `mentionDenied` 에 싣는다. 이름 공간이
    하나라(036) 둘이 겹치지 않는다.
  */
  const teamPlans: { teamId: string; recipients: string[]; viaLead: boolean }[] = [];
  const denyHandle = (h: string) => { if (!deniedHandles.includes(h)) deniedHandles.push(h); };
  for (const target of targetCall) {
    if (target.kind !== 'team') continue;
    // 토큰이 가리키는 팀이 그 사이 지워졌을 수 있다 — 그때는 부를 명단이 없다.
    const team = await getTeam(client, target.id);
    if (!team) continue;
    const teamCtx = { callerId: input.authorId, channelId: input.channelId };
    if (!(await mayInvokeTeam(client, { teamId: team.id, invokeScope: team.invokeScope, ownerAccountId: team.ownerAccountId }, teamCtx))) {
      denyHandle(team.name);
      continue;
    }
    /*
      **비활성 팀원은 부르지 않는다**(아래 팬아웃 주석의 근거 그대로) — 비활성 계정은 턴을
      시작하지 못하므로 넣으면 아무도 읽지 않는 항목이 쌓인다. 작성자 자신도 뺀다.
    */
    const awake = (await listTeamMembers(client, team.id)).filter((m) => !m.disabled && m.accountId !== input.authorId);
    const memberFacts = await invokeFactsFor(client, awake.map((m) => m.accountId));
    const allowed = new Set<string>();
    for (const m of awake) {
      const fact = memberFacts.get(m.accountId);
      if (!fact || (await mayInvoke(client, fact, { ...teamCtx, via: 'team' }))) allowed.add(m.accountId);
    }
    /*
      팀장이 있고 깰 수 있으면 팀장 하나(047). 팀장이 **이 호출자에게 막혔으면** 막혔다고 적고
      부를 수 있는 팀원 전원으로 떨어진다 — 비활성 팀장과 같은 폴백이다: 부름이 조용히 사라지는
      것이 여럿 깨는 것보다 나쁘다.
    */
    const leadMember = team.leadAccountId === null ? undefined : awake.find((m) => m.accountId === team.leadAccountId);
    if (leadMember && allowed.has(leadMember.accountId)) {
      teamPlans.push({ teamId: team.id, recipients: [leadMember.accountId], viaLead: true });
      continue;
    }
    for (const m of awake) if (!allowed.has(m.accountId)) denyHandle(m.handle);
    teamPlans.push({ teamId: team.id, recipients: [...allowed], viaLead: false });
  }

  /*
    지칭한 이름은 **그 메시지에 남긴다** — `mentionChainCapped` 와 같은 자리·같은 이유다.
    화면은 멘션을 옅은 배경 칩으로 그리므로, 부르지 않은 이름이 부른 것과 똑같이 보이면
    그 자체가 거짓말이다(design.md §4). 화면이 본문을 다시 파싱하지 않고 서버가 실제로 한
    일을 그대로 읽게 한다.

    **handle 이 아니라 id 를 싣는다.** `mentionChainCapped` 는 그 자리에서 글자로 읽히는
    값이라 handle 이지만, 이것은 본문의 칩과 **맞춰 볼 열쇠**다 — 그 사이 handle 이 바뀌면
    본문은 새 이름으로 그려지는데 meta 는 옛 이름이라 표시가 조용히 어긋난다.
  */
  /**
   * 화면이 *"부르지 않고 이름만 적었다"* 를 그리는 데 쓴다. 팀 지칭도 함께 싣는다(#849) —
   * 안 실으면 에이전트가 적은 `@팀이름` 이 부른 것과 **똑같이** 그려지고, 읽는 사람은
   * 그 팀이 깼다고 읽는다. 키 모양은 본문 토큰과 같아서(`team:<id>`) 화면의 지도가
   * 그대로 이름으로 되돌린다.
   */
  const refIdsForMeta = [
    ...refIds.filter((id) => id !== input.authorId),
    ...targetRef.map((t) => mentionTargetKey(t.kind, t.id)),
  ];

  // `@channel`(#225) — 채널 전체 호출. 본문은 손대지 않는다: `@channel` 은 원문에
  // 그대로 남고 서버는 inbox 항목만 펼쳐 넣는다. 본문을 치환하면 원문이 사라져
  // 수정할 때 되돌릴 수 없다(계정이 없으므로 정규화도 지나친다).
  //
  // `@channel` 이라는 handle 의 **계정이 실제로 있으면 계정이 이긴다** — 위에서 이미
  // 평범한 멘션으로 처리됐고 여기서는 아무것도 하지 않는다. 사람의 이름이 예약어에
  // 밀리면 그 사람은 영영 불릴 수 없다.
  //
  // **에이전트의 글에서는 맨 앞에 있을 때만 부름이다**(`splitMentionCalls` 와 같은 규칙).
  // 본문 한가운데의 `@channel` 은 그 기능을 **가리키는** 것이다 — 멘션 문법을 설명하던 보고
  // 한 줄이 채널의 에이전트 전부를 깨웠고, 깬 턴들이 원인을 설명하며 그 글자를 다시 옮겨
  // 적어 연쇄가 됐다(#harkroom seq 3452). 사람의 글은 어디에 있어도 부름이다.
  const accountHandles = new Set(handleToId.keys());
  const channelCalled = authorIsAgent
    ? mentionedHandles(normalizedBody.slice(0, headMentionRunEnd(normalizedBody))).includes(CHANNEL_MENTION_HANDLE)
    : bodyHandles.includes(CHANNEL_MENTION_HANDLE);
  return {
    normalizedBody,
    accountHandles,
    calledIds: [...calledIds],
    cappedIds,
    deniedIds,
    teamPlans,
    targetCall: targetCall as { kind: 'group' | 'team'; id: string }[],
    channelCalled,
    callMeta: {
      ...(cappedHandles.length
        ? { mentionChainCapped: cappedHandles, mentionChainLimit: chainLimit }
        : {}),
      ...(deniedHandles.length ? { mentionDenied: deniedHandles } : {}),
      ...(refIdsForMeta.length ? { mentionRefs: refIdsForMeta } : {}),
    },
  };
}

/**
 * 판정(`resolveMentionCalls`)대로 inbox 를 넣는다 — 계정 멘션 → `@channel` → 집합·팀 순서.
 * `notified` 에 이미 든 계정은 건너뛴다: 게시는 빈 집합으로, 수정은 **그 메시지로 이미 inbox 를
 * 받은 계정**으로 시작한다(같은 메시지로 두 번 부르지 않는다).
 */
async function fanOutCalls(
  client: PoolClient,
  ctx: { channelId: string; authorId: string; messageId: string },
  r: ResolvedMentionCalls,
  notified: Set<string>,
): Promise<void> {
  const { calledIds, cappedIds, deniedIds, teamPlans, targetCall, accountHandles, channelCalled } = r;
  /**
   * 알림 판정은 **정규화된 본문의 `<@id>` 토큰**에서 한다(#271 요구 6). 옛 handle 경로를
   * 남겨 두면 두 판정이 갈라지고, 그때 본문에 남은 것과 알림이 간 곳이 달라진다.
   *
   * 코드 구간을 한 번 더 걷어내는 이유: 사람이 코드 블록 안에 `<@uuid>` 를 **직접** 적을
   * 수 있다. 정규화는 코드를 비껴가지만 그렇게 손으로 적힌 토큰까지 막지는 못한다 —
   * 코드 안은 알림을 만들지 않는다는 #298 의 결정을 여기서도 같은 함수로 지킨다.
   *
   * 그 두 가지를 `splitMentionCalls` 하나가 한다(위에서 이미 돌았다). 그 함수가 코드·인용을
   * 걷어내고, 남은 것을 **부름과 지칭**으로 가른다 — 여기 도는 것은 부름뿐이다.
   *
   * 작성자 자신은 걸러 낸다.
   */
  /*
    **연쇄 깊이 상한**(4단계). 상한에 닿은 에이전트의 발화는 **다른 에이전트를 부르지
    못한다** — 그 지점부터가 관측된 폭주의 모양이고, 각 고리는 앞의 답을 그대로 다시 던진다.

    **사람에게 가는 알림은 막지 않는다.** 상한은 기계가 스스로 도는 것을 끊는 장치이고,
    사람을 부르는 것은 "이 스레드에 사람이 필요하다"는 뜻이라 그때 오히려 더 필요하다.
    막힌 호출은 조용히 사라지지 않고 `meta.mentionChainCapped` 로 그 메시지에 남는다 —
    화면이 그 사실을 그려야 사람이 "왜 아무도 안 왔나"를 묻지 않는다(design.md §4).
  */
  for (const accountId of calledIds) {
    // 상한에 걸린 에이전트는 **inbox 항목을 받지 않는다** — 그것이 곧 턴이 뜨지 않는다는
    // 뜻이다(러너는 inbox 를 폴한다). 판정은 위에서 이미 끝났고 여기서 다시 하지 않는다.
    // 지칭(`refIds`)도 같은 이유로 여기 오지 않는다 — 이름은 본문에 남고 턴은 뜨지 않는다.
    // 이미 받은 사람은 건너뛴다 — 게시에서는 이 시점에 비어 있고, 수정은 이 메시지로 이미 받은 명단으로 시작한다.
    if (notified.has(accountId)) continue;
    if (accountId !== ctx.authorId && !cappedIds.has(accountId) && !deniedIds.has(accountId)) {
      /*
        **팀과 그 팀장을 한 발화에서 함께 불렀으면 팀장 항목에 팀을 싣는다**(`@ops @lead`).
        이 루프가 팀 팬아웃보다 먼저 돌아 팀장을 평범한 `mention` 으로 넣으면, 팀 부름은
        `notified` 중복 제거로 그를 건너뛰고 팀장 턴은 명단(팀 블록)을 못 받는다 — #udc 에서
        `@udc-team @forge` 로 부른 forge 가 "udc-team 답이 없어 이어받는다"며 자기가 그 팀의
        팀장인 줄 몰랐던 자리다. 누가 팀장 하나로 가는지는 insert 앞에서 이미 정했다(`teamPlans`).
      */
      const ledTeam = teamPlans.find((p) => p.viaLead && p.recipients[0] === accountId);
      await insertInbox(
        client, accountId, ctx.messageId, ledTeam ? 'team_mention' : 'mention', notified, ledTeam?.teamId,
      );
    }
  }

  // `@channel`(#225) — 판정(`channelCalled`)과 근거는 `resolveMentionCalls` 에 있다.
  if (channelCalled && !accountHandles.has(CHANNEL_MENTION_HANDLE)) {
    // 대상은 **그 채널을 볼 수 있는 사람 전부**다. 규칙은 `fanOutMention` 하나에 있다.
    await fanOutMention(client, ctx, null, notified, { reason: 'mention' }, 'channel_all');
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
   * ## 무엇을 도는가 — **부름으로 판정된 대상만**(#849)
   *
   * 초판은 본문에 나온 이름을 전부 돌며 여기서 다시 집합·팀으로 풀었다. 이제는
   * `splitMentionCalls` 가 정규화된 본문의 `<@group:id>`·`<@team:id>` 에서 가른 **부름**
   * 목록을 돈다. 두 가지가 함께 달라진다:
   *
   * 1. **지칭이 팀을 깨우지 않는다.** 에이전트가 보고 한가운데 `@팀이름` 을 적으면 지금까지
   *    그 팀이 깼다 — 계정에 대해 #598 이 잰 "39% 가 부를 뜻이 없는 지칭" 을 팀이 그대로
   *    되풀이하던 자리다. 규칙과 근거는 그 함수에 있다(집합은 사람이라 언제나 부름이다).
   * 2. **이름을 다시 풀지 않는다.** 정규화가 이미 풀어 토큰에 담아 두었으므로 여기서
   *    `getHandleGroupByHandle`·`getTeamByName` 을 다시 부를 이유가 없다.
   *
   * ## 해석 순서: 계정 → 집합 → 팀 — **이제 정규화 단계가 정본이다**
   *
   * 아래 근거는 그대로 살아 있고, 그것을 실행에 옮기는 자리가 위(`nameToToken` 조립)로
   * 옮겼을 뿐이다. 그 순서가 토큰을 정하므로 이 루프는 결과만 물려받는다 —
   * `CHANNEL_MENTION_HANDLE` 과 계정 이름은 애초에 대상 토큰이 되지 않으므로 여기서
   * 걸러 낼 것도 없다.
   *
   * **계정이 이긴다.** `@foo` 가 계정이면 정규화가 계정 토큰으로 만들었고 위에서 평범한
   * 멘션으로 처리됐다. 서버가 양방향 충돌을 막으므로 정상 경로에서는 겹치지 않지만, 026 이전에
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
   * 겹침이 없는 정상 경로에서는 어느 쪽이 먼저든 결과가 같지만, 겹친 데이터에서 두
   * 명단이 **둘 다** 펼쳐지는 것이 가장 나쁘다: `@foo` 가 사람 집합인지 에이전트 팀인지
   * 부른 사람이 모르게 된다. 정규화가 이름 하나에 토큰 하나만 붙이므로 그 일은 없다.
   *
   * 조회를 `client` 로 하는 이유: 트랜잭션 클라이언트를 쥔 채 `pool` 에서 또 다른 연결을
   * 얻으면 풀이 포화된 순간 자기 자신을 기다리는 교착이 된다. 같은 트랜잭션 스냅샷을
   * 보는 것도 이쪽이 맞다.
   */
  for (const target of targetCall) {
    if (target.kind === 'group') {
      const members = await listHandleGroupMembers(client, target.id);
      await fanOutMention(
        client, ctx, members.map((m) => m.accountId), notified,
        { reason: 'mention' }, 'group',
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
    // 누구를 깨울지는 insert 앞에서 이미 정했다(`teamPlans`) — 팀·팀원 게이트와 팀장 폴백이 거기 있다.
    const plan = teamPlans.find((p) => p.teamId === target.id);
    if (!plan) continue;

    /**
     * **팀장이 있으면 팀장 하나만 깨운다**(047 · 046 의 `lead_account_id` 를 읽는 자리).
     *
     * 이 두 줄이 팀 멘션의 뜻을 바꾼다: 지금까지 `@팀` 은 명단을 펼치는 것이었고, 그래서
     * 턴이 팀원 수만큼 떠 같은 요청을 각자 처음부터 풀었다. 팀장이 정해져 있으면 그
     * 부름은 **창구 하나**로 간다 — 나눌 일은 팀장이 `@팀원` 으로 나눈다.
     *
     * ## 폴백이 있는 이유 (jaebin 승인)
     *
     * 팀장이 **없거나 비활성**이면 지금까지의 동작(전원)을 그대로 쓴다. 팀장만 부르고
     * 마는 쪽이 더 단순하지만, 그러면 팀 멘션이 **아무도 깨우지 않는 침묵**이 된다 —
     * 팀장 지정은 선택이므로(046) 지정하지 않은 팀이 정상 상태이고, 비활성 계정은 턴을
     * 시작하지 못한다(위 문단: inbox 항목은 러너가 턴을 시작하는 신호다). 부름이 조용히
     * 사라지는 것이 여럿 깨는 것보다 나쁘다.
     *
     * 비활성 판정을 `awake` 로 한 번에 하는 이유: 팀장도 팀원이므로(046 의 복합 FK)
     * 같은 필터를 통과해야 한다. 팀장이 비활성인데 그를 골라 넣으면 위 문단이 막으려는
     * 바로 그것 — 아무도 읽지 않는 항목 — 이 된다.
     *
     * `notified` 중복 제거는 `fanOutMention` 이 그대로 한다. 그래서 팀장이 이 발화에서
     * 이미 이름으로 불렸다면(`@ops @lead`) 팀 부름은 그를 건너뛴다 — 대신 위의 계정
     * 멘션 루프가 그 항목을 `team_mention` 으로 넣어 명단을 싣는다. 한 발화에서 팀과
     * 팀장을 함께 부르는 것은 팀을 부른 것과 같은 뜻이다(둘 다 팀장의 턴 하나다).
     */
    await fanOutMention(
      client, ctx,
      plan.recipients,
      notified,
      plan.viaLead ? { reason: 'team_mention', teamId: plan.teamId } : { reason: 'mention' },
      'team',
    );
  }
}

export async function postMessage(
  pool: Pool, input: PostMessageInput,
): Promise<PostMessageResult> {
  const client = await pool.connect();
  // 커밋 뒤에는 커넥션을 **먼저 돌려준다** — 아래 `readListRow` 가 풀에서 하나를 더 빌리므로,
  // 쥔 채로 빌리면 풀이 찬 순간 자기 자신을 기다린다(2026-10-01 풀 포화).
  let released = false;
  try {
    await client.query('begin');

    /*
      **스레드 머리는 같은 채널의 최상위 글이어야 한다**(084 보안 검토). 예전에는 확인하지 않아서
      다른 채널의 글 id 를 threadRootId 로 달 수 있었다 — 그 답글은 머리 주인에게 thread_reply 를
      보내고, 회신권(084)·위임 닫기·깨움 선점처럼 "그 스레드 안에서"를 전제한 판정을 다른
      채널에서 통과했다. 답글의 답글(머리가 답글)도 같은 이유로 막는다: 스레드는 한 단계다.
      지워진 머리는 받는다 — 지워진 스레드에 답이 달리는 경로가 따로 있다(`deletedRoot`).
    */
    if (input.threadRootId && !(await isThreadRootOf(client, input.channelId, input.threadRootId))) {
      await client.query('rollback');
      return { failure: 'bad_thread' };
    }

    // threadRootId 가 없으면 alsoInChannel 은 의미 없다 — 조용히 false 로 정규화한다.
    // threadRootId 없이 true 를 보내는 것은 이미 채널 메시지이기 때문이다.
    const alsoInChannel = input.threadRootId ? (input.alsoInChannel ?? false) : false;

    /*
      연쇄 깊이(4단계). **insert 보다 앞에서** 잰다 — 뒤에서 재면 자기 자신이 스캔 대상에
      들어가고, 그러면 자기 본문이 자기를 부른 것으로 보이는 경우(고정 멘션이 자기 handle
      을 담는 드문 경우) 깊이가 한 칸 부풀어 상한이 한 고리 일찍 닫힌다.

      작성자가 에이전트인지도 여기서 한 번만 읽는다 — 아래 상한 판정이 같은 값을 써야 한다.
    */
    const authorKind = (await client.query(
      `select kind from account where id = $1`, [input.authorId],
    )).rows[0]?.kind as 'human' | 'agent' | undefined;
    const authorIsAgent = authorKind === 'agent';
    /*
      **회신권 "결과 한 번"을 지키는 락**(084, 2026-10-01 보안 검토). 아래 멘션 해석이 회신권을
      읽고(`hasReplyGrant`), 결과 발화는 커밋 직전에 그것을 닫는다(`closeReplyGrants`). 예전에는
      채널 락이 이 읽기보다 앞에 있어서 같은 에이전트의 동시 결과 두 개가 줄을 섰고, 두 번째는
      첫 번째가 닫은 것을 봤다. 채널 락을 insert 앞으로 옮긴 뒤로는 둘 다 "열림"을 읽고 통과해
      좁은 범위의 에이전트를 두 번 깨울 수 있었다. 그래서 **같은 작성자·같은 스레드**만 여기서
      줄을 세운다 — 채널 전체가 서던 줄(풀 포화)은 되살리지 않는다.
      락 순서는 언제나 이것 → 채널 락이라 서로를 기다리며 막히지 않는다.
    */
    if (authorIsAgent && input.threadRootId && countsAsReply(input.kind ?? 'user')) {
      await lockReplyGrantsFor(client, input.authorId, input.threadRootId);
    }
    const scannedDepth = await mentionDepthFor(client, {
      channelId: input.channelId,
      threadRootId: input.threadRootId ?? null,
      authorId: input.authorId,
      authorIsAgent,
      causeMessageId: input.causeMessageId ?? null,
    });
    // 자동화 회차가 물려준 깊이(082)가 있으면 그것이 이 글의 자리다 — 사람 이름 글이라도 사슬의 고리다.
    const chainBound = input.chainDepth != null;
    const mentionDepth = chainBound ? Math.max(scannedDepth, input.chainDepth!) : scannedDepth;
    const calls = await resolveMentionCalls(client, {
      body: input.body, channelId: input.channelId, authorId: input.authorId, authorIsAgent, mentionDepth, chainBound,
      replyGrantThreadId: countsAsReply(input.kind ?? 'user') ? input.threadRootId ?? null : null,
    });

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
     * 락을 **insert 보다 앞에** 잡는 것이 핵심이다. insert 뒤에 잡으면
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
     * **락은 insert 바로 앞에서 잡는다**(2026-10-01). 그 위의 읽기(머리 확인·작성자 종류·연쇄
     * 깊이·멘션 해석)는 seq 순서와 무관하다 — 연쇄 깊이가 보는 "나를 부른 글"은 그 부름이
     * 나의 턴을 띄우기 전에 이미 커밋돼 있다. 예전에는 그 읽기를 락 안에서 해서, 같은 채널에
     * 글이 몰리면 줄 선 트랜잭션마다 풀 커넥션을 하나씩 쥐고 기다렸다(풀 10개가 차고
     * `/readyz` 의 `select 1` 까지 줄을 섰다). 재생 확인(idempotency)은 락 **뒤**에 둔다 —
     * 같은 키의 동시 재시도가 서로의 insert 를 봐야 한다.
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
        // 재생은 새로 생긴 것이 없다 — 되돌아온 머리도 없다(그때 이미 처리됐다).
        return { message: existing.rows[0], notified: [], replayed: true, rootBack: null };
      }
    }

    const inserted = await client.query(
      `insert into message (channel_id, thread_root_id, author_id, body, kind, meta, also_in_channel, mention_depth)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [input.channelId, input.threadRootId ?? null, input.authorId, calls.normalizedBody,
       input.kind ?? 'user',
       // 막힌 호출은 **그 메시지에 남는다** — 조용히 사라지면 사람은 "왜 아무도 안 왔나"를
       // 묻고, 그 답이 화면에 없다(design.md §4).
       JSON.stringify({
         ...(input.meta ?? {}),
         ...calls.callMeta,
       }),
       alsoInChannel, mentionDepth],
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
    let message: MessageRow = read.rows[0];

    if (input.idempotencyKey) {
      await client.query(
        `insert into idempotency_key (key, message_id, author_id, channel_id) values ($1, $2, $3, $4)`,
        [input.idempotencyKey, message.id, input.authorId, input.channelId],
      );
    }

    const notified = new Set<string>();
    await fanOutCalls(client, { channelId: input.channelId, authorId: input.authorId, messageId: message.id }, calls, notified);
    /*
      회신권(084)을 연다 — 실제로 inbox 가 간 상대에게만(막힌·상한 걸린 부름은 열지 않는다). 최상위
      글이면 그 글 자신이 스레드 머리다: 불린 쪽은 그 아래에 답한다. 작성자가 게이트에 걸리는
      에이전트가 아니면 `openReplyGrants` 가 아무것도 만들지 않는다.
    */
    if (authorIsAgent) {
      await openReplyGrants(client, {
        granterId: input.authorId,
        threadRootId: input.threadRootId ?? message.id,
        granteeIds: calls.calledIds.filter((id) => notified.has(id)),
      });
    }


    /**
     * 이 말이 **답글로 세어지는가**. `thread_reply`·`dm` 두 자리가 함께 본다.
     * 부름(`mention`)은 이 판정 위에 있다 — 아래 주석의 마지막 문단이 그 이유다.
     */
    const isReply = countsAsReply(input.kind ?? 'user');

    /**
     * 스레드 머리 주인에게 가는 `thread_reply` — **답글로 세어지는 것만** 넣는다(2026-09-09).
     *
     * `progress`(진행 한 줄)·`wake`(대기 줄)는 스레드에 달리지만 **답이 아니다**:
     * 화면은 그것을 말풍선이 아니라 `ProgressRow`·`WakeRow` 로 그리고, 답글 수에도
     * 세지 않는다(`countsAsReply`·위의 `THREAD_STATS`). 그런데 inbox 는 그 구분 없이
     * 항목을 만들고 있었고, 그 항목 하나가 곧 **OS 알림 하나**다 — 에이전트가 일을
     * 시작하며 남기는 "이제 조사한다" 한 줄마다 사람의 데스크탑이 울렸다.
     *
     * inbox 항목은 알림만이 아니다: 미읽음 배지가 되고, 숨긴 채널을 되살리며
     * (`insertInbox` 주석), 받는 쪽이 에이전트면 **턴을 하나 띄운다**
     * (`agent/src/mentionScheduler.ts`). 진행 한 줄이 남의 턴을 깨우는 것은 어느
     * 쪽으로도 옳지 않다. 그래서 알림을 그리는 쪽(데스크탑)이 아니라 **항목을 만드는
     * 이 자리**에서 막는다 — 화면·러너·배지가 저마다 같은 예외를 베끼면 한쪽만
     * 고쳐지는 날이 온다.
     *
     * 부름(`mention`)은 그대로 둔다. `progress` 안에 `@handle` 을 적었다면 그것은
     * 지목이고, 지목은 종류와 무관하게 닿아야 한다.
     */
    /**
     * 이 답이 **지워진 머리를 목록에 되돌리는가**(2026-09-09 후속). `LIST_VISIBLE` 이
     * 자리표시자를 세우는 기준이 `countsAsReply` 로 좁아진 뒤로, 접힌 진행만 남은
     * 머리는 목록에서 빠져 있다. 그 스레드에 결과가 달리면 조건이 다시 참이 되므로
     * **화면에도 그 사실을 알려야 한다** — 안 알리면 답은 도착했는데 채널에 머리가 없어
     * 그 답이 어디에도 그려지지 않는다(다시 받아올 때까지 조용히 사라진다).
     *
     * 판정을 여기서 다시 쓰지 않는다: 머리가 **지워져 있었다**는 사실만 기억해 두고,
     * 목록에 남았는지는 커밋 뒤 `readListRow` 가 `LIST_VISIBLE` 에 그대로 물어본다
     * (`deleteMessage` 의 `rootGone` 과 같은 방식이고, 같은 이유로 그렇게 한다).
     *
     * 지워져 있지 않았으면 아무 일도 하지 않는다 — 평범한 답글마다 왕복이 늘면 안 된다.
     */
    let deletedRoot: string | null = null;
    if (input.threadRootId && isReply) {
      const root = await client.query(
        `select author_id, deleted_at from message where id = $1`, [input.threadRootId],
      );
      const rootAuthor = root.rows[0]?.author_id;
      if (rootAuthor && rootAuthor !== input.authorId && !notified.has(rootAuthor)) {
        /*
          **스레드 답글도 호출 게이트를 지난다**(073). 머리 주인이 에이전트면 이 항목이 곧 그
          에이전트의 턴이다 — 게이트를 건너뛰면 owner 에이전트가 연 스레드에 누구든 답글을 달아
          그것을 깨울 수 있고, 대리 호출(073)과 이어지면 "남 → 대리자 → 개인 자격증명 에이전트"
          가 된다. 판정은 직접 멘션과 같다(via mention, 호출자 = 작성자). 사람은 facts 에 없어
          그대로 받는다. 막힌 답글은 meta 에 남기지 않는다 — 답글은 부르려던 것이 아니다.
        */
        const rootFact = (await invokeFactsFor(client, [rootAuthor])).get(rootAuthor);
        if (!rootFact || (await mayInvoke(client, rootFact, {
          // 이 자리는 `isReply` 안이다 — 결과 발화만 온다.
          callerId: input.authorId, channelId: input.channelId, via: 'mention', replyGrantThreadId: input.threadRootId,
        }))) {
          await insertInbox(client, rootAuthor, message.id, 'thread_reply', notified);
        }
      }
      if (root.rows[0]?.deleted_at) deletedRoot = input.threadRootId;
    }

    // DM 도 같은 기준이다(위 문단). 둘만 있는 방이라 진행 한 줄이 그대로 상대의
    // 알림이 되고, 상대가 에이전트면 턴까지 뜬다 — 스레드보다 오히려 더 곧장 닿는다.
    const channel = await client.query(`select kind from channel where id = $1`, [input.channelId]);
    if (channel.rows[0]?.kind === 'dm' && isReply) {
      const members = await client.query(
        `select account_id from channel_member where channel_id = $1 and account_id <> $2`,
        [input.channelId, input.authorId],
      );
      for (const row of members.rows) {
        if (!notified.has(row.account_id)) await insertInbox(client, row.account_id, message.id, 'dm', notified);
      }
    }

    /**
     * **사람이 말하면 그 스레드의 기다림은 끝난다**(2026-09-10). 판정과 두 갈래는
     * `agentWakes.ts::preemptWakesForThread` 가 갖는다 — 여기서 하는 일은 그것을 **같은
     * 커밋 안에서** 부르는 것뿐이다(발화는 남았는데 예약은 그대로인 창을 만들지 않는다).
     *
     * 앵커 없는 채널 최상위 발화에는 하지 않는다: 깨움은 반드시 스레드에 걸린다(040).
     */
    const wokeByPost = input.threadRootId
      ? await preemptWakesForThread(client, {
        threadRootId: input.threadRootId, authorId: input.authorId, notified,
      })
      : [];

    /**
     * **팀원의 답이 자기 의무를 닫는다**(050). 판정과 "정확히 한 번 깨우기"는
     * `delegations.ts::closeDelegationsForReply` 가 갖고, 여기서 하는 일은 위 깨움과
     * 똑같이 **같은 커밋 안에서** 부르는 것뿐이다 — 답은 남았는데 의무가 열려 있으면
     * 팀장은 기한이 될 때까지 그 답을 모른다.
     *
     * 스레드 밖(채널 최상위)에서는 하지 않는다: 위임은 언제나 스레드에 걸린다.
     *
     * 실패인지 여기서 판정해 넘긴다 — `meta` 의 모양을 아는 것은 이 자리이고
     * (`readAskMeta` 계열이 여기 산다), 그 판정이 `delegations.ts` 로 새면 meta 규약이
     * 두 곳에 살게 된다.
     */
    // 결과를 냈으면 이 스레드에서 받은 회신권을 닫는다(084) — 이 발화는 위에서 이미 게이트를 지났다.
    if (input.threadRootId && isReply && authorIsAgent) {
      await closeReplyGrants(client, { granteeId: input.authorId, threadRootId: input.threadRootId });
    }

    const wokeByDelegation = input.threadRootId
      ? await closeDelegationsForReply(client, {
        threadRootId: input.threadRootId,
        authorId: input.authorId,
        messageId: message.id,
        kind: input.kind ?? 'user',
        isFailure: (input.meta as { kind?: unknown } | undefined)?.kind === 'failure',
      })
      : [];

    if (input.beforeCommit) {
      const rejection = await input.beforeCommit(client, { message, notified });
      if (rejection) {
        await client.query('rollback');
        return { failure: 'rejected', rejection };
      }
      /*
        `beforeCommit` 은 이 글에 딸린 행을 더 쓸 수 있다 — `artifact.publish` 가 첨부를 미리보기 버전으로
        건다(090). 위에서 읽은 행은 그 전 것이라, 그대로 내보내면 실시간 `message.created` 와 도구 결과의
        첨부에 `artifact{}` 가 빠지고 앱은 새로 읽기 전까지 카드 대신 html 칩을 그린다(2026-10-02 실측:
        발행 응답의 첨부에 artifact 가 없었다). 같은 트랜잭션에서 다시 읽는다.
      */
      const reread = await client.query(`select ${COLS} from message where id = $1`, [message.id]);
      if (reread.rowCount) message = reread.rows[0];
    }

    await client.query('commit');
    client.release();
    released = true;

    // 이벤트는 **커밋 뒤**다 — 러너는 이것을 보고 즉시 폴하므로, 앞에서 치면 아직 안 보이는
    // inbox 를 읽고 빈손으로 돌아간다(sweep 이 같은 순서를 지키는 이유와 같다).
    for (const accountId of wokeByPost) emitEvent({ type: 'inbox.updated', accountId });
    // 결말이 난 팀장도 같은 자리에서 깨운다(위 주석의 이유가 그대로 적용된다).
    for (const accountId of wokeByDelegation) emitEvent({ type: 'inbox.updated', accountId });

    /**
     * 되돌아온 머리를 **돌려준다** — 여기서 직접 내지 않는다. 부른 쪽이 `message.created`
     * 를 낸 **뒤에** 나가야 하기 때문이다(`emitPosted` 가 그 순서를 지킨다).
     *
     * 순서가 뒤집히면 답글 수가 하나 더 세어진다: 머리가 먼저 들어오면 화면에 그 행이
     * 있게 되고, 뒤이어 오는 `message.created` 가 `bumpThreadCounts` 로 **또** 하나를
     * 더한다(서버가 준 행에는 이 답이 이미 세어져 있다). 뒤에 오면 그 반대가 된다 —
     * 머리가 없으니 bump 가 조용히 no-op 하고(`if (!parent) return`), 그다음 서버 행이
     * 정확한 수로 자리를 세운다.
     *
     * 커밋 밖에서 읽는 것이 맞다: 트랜잭션 안에서 만들면 롤백된 게시의 행이 나갈 수 있다.
     */
    const rootBack = deletedRoot ? await readListRow(pool, input.channelId, deletedRoot) : null;
    return { message, notified: [...notified], replayed: false, rootBack };
  } catch (err) {
    if (!released) await client.query('rollback');
    throw err;
  } finally {
    if (!released) client.release();
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

/**
 * 이 스레드에 `oldestSeq` 보다 오래된 답글이 남았나. 스레드 조회의 `hasMore` 다 — 채널의
 * [hasOlderMessages] 를 쓰면 **다른 스레드·채널 글**까지 세어 늘 참이 된다.
 */
export async function hasOlderThreadReplies(
  pool: Pool, channelId: string, threadRootId: string, oldestSeq: number,
): Promise<boolean> {
  const res = await pool.query(
    `select 1 from message
     where channel_id = $1 and thread_root_id = $2 and seq < $3 and deleted_at is null limit 1`,
    [channelId, threadRootId, oldestSeq],
  );
  return (res.rowCount ?? 0) > 0;
}

export type MutationRefusal = 'not_found' | 'forbidden';

/** 본문에 적힌 멘션 토큰 전부(`<@id>`·`<@team:id>`·`<@group:id>`)와 `@channel`. 수정으로 **새로 생긴** 부름이 있는지 보는 데만 쓴다. */
function mentionTokens(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/<@([^>\s]+)>/g)) if (m[1]) out.add(m[1]);
  if (mentionedHandles(body).includes(CHANNEL_MENTION_HANDLE)) out.add(CHANNEL_MENTION_HANDLE);
  return out;
}

export interface EditMessageOutcome {
  message: MessageRow;
  /** 이 수정으로 **새로** inbox 를 받은 계정. 앞서 이 메시지로 이미 받은 사람은 없다. */
  notified: string[];
  /** 새 멘션을 넣었지만 부르지 않았으면 그 이유. */
  mentionSkipped: MentionEditSkipReason | null;
}

/**
 * 수정은 작성자 본인만, user 메시지만. system 메시지는 avcs 투영의 산물이라 사람이 고칠 수 없다.
 *
 * ## 수정으로 넣은 멘션도 부른다 (jaebin 승인 D1~D5)
 *
 * 멘션 없이 쓴 글을 고쳐 `@handle` 을 넣으면 그 대상이 불린다. 규칙:
 * - **D1 누구를**: 새 본문이 부르는 대상에서 **이 메시지로 이미 inbox 를 받은 계정**을 뺀다.
 *   본문을 전후로 비교하지 않는 이유: 넣었다 빼고 다시 넣으면 비교로는 또 부르게 된다. inbox 를
 *   기준으로 하면 같은 메시지가 한 사람을 두 번 부르지 않고, thread_reply·팀 팬아웃으로 이미 받은
 *   사람도 저절로 빠진다. `fanOutCalls` 의 `notified` 에 그 명단을 **미리 넣어** 시작하면 된다.
 * - **D2 언제까지**: 작성 뒤 `MENTION_EDIT_WINDOW_MS`(24시간). 그 뒤의 수정은 저장만 한다.
 * - **D3 누구의 글**: 사람이 쓴 글만. 에이전트의 글을 고쳐 부르는 길을 열면 연쇄 한도가 보지 않는
 *   폭주 경로가 하나 생긴다(수정 도구가 MCP 에 없어 지금은 쓰이지 않는 길이기도 하다).
 * - **D4 `@channel`·집합**: 허용한다. 이미 받은 사람은 위와 같이 빠진다.
 * - **D5 멘션을 지우면**: 아무것도 거두지 않는다 — 이미 뜬 턴은 거둘 수 없다.
 *
 * 호출 게이트·연쇄 상한은 게시와 똑같이 `resolveMentionCalls` 가 판정한다(호출자 = 작성자).
 * 깊이는 새로 재지 않고 이 행에 저장된 값을 쓴다 — 사람의 글이라 0 이다.
 *
 * 부르지 않았는데 새 멘션이 있으면 `mentionSkipped` 로 이유를 돌려준다. 조용히 사라지면 사람은
 * "왜 안 오나"를 묻고, 그 답이 화면에 없다(design.md §4).
 *
 * thread_reply·dm·기다림 선점·위임 닫기는 하지 않는다 — 수정은 새 답이 아니다.
 */
export async function editMessage(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string; body: string },
): Promise<EditMessageOutcome | MutationRefusal> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // 행을 잠근다 — 같은 메시지를 두 번 빠르게 고치면 판정·inbox 넣기가 서로 엇갈려 두 번 부를 수 있다.
    const found = await client.query(
      `select m.author_id, m.kind, m.body, m.meta, m.mention_depth as depth, m.created_at,
              (a.kind = 'agent') as author_is_agent
         from message m join account a on a.id = m.author_id
        where m.id = $1 and m.channel_id = $2 and m.deleted_at is null
        for update of m`,
      [args.messageId, args.channelId],
    );
    if (!found.rowCount) {
      await client.query('rollback');
      return 'not_found';
    }
    const row = found.rows[0] as {
      author_id: string; kind: string; body: string; meta: Record<string, unknown> | null;
      depth: number; created_at: Date; author_is_agent: boolean;
    };
    if (row.author_id !== args.actorId || row.kind !== 'user') {
      await client.query('rollback');
      return 'forbidden';
    }

    /**
     * 수정도 **게시와 같은 판정**을 탄다(#271·#845) — `resolveMentionCalls` 하나다. 따로 두면
     * 고친 메시지만 옛 형식으로 남는다: 이 함수가 계정만 토큰으로 바꾸던 동안 수정으로 넣은
     * `@팀`·`@집합` 은 글자로 남았고, 삭제된 계정(061)도 걸러지지 않았다.
     */
    const calls = await resolveMentionCalls(client, {
      body: args.body, channelId: args.channelId, authorId: args.actorId,
      authorIsAgent: row.author_is_agent, mentionDepth: row.depth,
    });

    const before = mentionTokens(row.body);
    const added = [...mentionTokens(calls.normalizedBody)].some((t) => !before.has(t));
    const skip: MentionEditSkipReason | null = row.author_is_agent
      ? 'agent_author'
      : Date.now() - new Date(row.created_at).getTime() > MENTION_EDIT_WINDOW_MS ? 'too_old' : null;
    const invoke = skip === null;

    /*
      부름에 관한 meta 는 **새 본문의 판정으로 통째로 갈아 끼운다** — 부를 때만. 부르지 않는 수정에서
      `mentionDenied`·`mentionChainCapped` 를 새로 적으면 시도하지도 않은 부름을 "막혔다"고 말하게
      되므로 그때는 지칭 표시(`mentionRefs`)만 새 본문 기준으로 바꾼다.
    */
    const { mentionRefs: _refs, mentionDenied: _denied, mentionChainCapped: _capped, mentionChainLimit: _limit, ...rest } = row.meta ?? {};
    const meta = invoke
      ? { ...rest, ...calls.callMeta }
      : {
        ...rest,
        ...(_denied !== undefined ? { mentionDenied: _denied } : {}),
        ...(_capped !== undefined ? { mentionChainCapped: _capped, mentionChainLimit: _limit } : {}),
        ...(calls.callMeta.mentionRefs ? { mentionRefs: calls.callMeta.mentionRefs } : {}),
      };

    const updated = await client.query(
      `update message set body = $2, meta = $3, edited_at = now() where id = $1 returning ${COLS}`,
      [args.messageId, calls.normalizedBody, JSON.stringify(meta)],
    );

    let fresh: string[] = [];
    if (invoke) {
      const already = new Set(
        (await client.query<{ account_id: string }>(
          `select distinct account_id from inbox where message_id = $1`, [args.messageId],
        )).rows.map((r) => r.account_id),
      );
      const notified = new Set(already);
      await fanOutCalls(client, { channelId: args.channelId, authorId: args.actorId, messageId: args.messageId }, calls, notified);
      fresh = [...notified].filter((id) => !already.has(id));
      /*
        새로 넣은 항목에 "수정으로 생겼다"를 찍는다(076). `insertInbox` 에 인자를 더하지 않고 뒤에서
        찍는 이유: 그 함수까지 가는 길이 셋(계정·`@channel`·집합/팀)이라 인자를 모두에 꿰어야 하고,
        같은 트랜잭션이라 찍기 전의 항목을 누가 읽을 수도 없다.
      */
      if (fresh.length) {
        await client.query(
          `update inbox set via_edit = true where message_id = $1 and account_id = any($2::uuid[])`,
          [args.messageId, fresh],
        );
      }
    }
    await client.query('commit');
    return { message: updated.rows[0], notified: fresh, mentionSkipped: !invoke && added ? skip : null };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
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
   *
   * **사람 앞 물음은 사람만 답한다**(2026-09-29). 전에는 `account` 만 보고 `human` 은
   * 통과시켜서, 채널을 볼 수 있는 계정이면 에이전트든 HTTP 로 사람 카드를 누를 수 있었다.
   * MCP 에 답하는 도구가 없어 막혀 있었을 뿐 문은 열려 있었다 — 사람에게 물은 갈림길을
   * 에이전트가 정하면 그 물음을 사람 앞에 둔 뜻이 사라진다.
   */
  if (ask.to.kind === 'account' && ask.to.accountId !== args.actorId) return 'forbidden';
  if (ask.to.kind === 'human' && !(await isHumanAccount(pool, args.actorId))) return 'forbidden';

  /**
   * **거울 카드에 답하면 원본에 먼저 적는다**(2026-09-29). 정본은 원본이다 — 거울은
   * 원본을 사람 눈앞에 한 번 더 세워 둔 것일 뿐이라, 답은 원본에서 경합하고 거울들은
   * 그 결과를 **따라 적는다**(`syncAskMirrors`). 그래서 거울 둘과 원본에 세 사람이
   * 동시에 눌러도 이기는 것은 원본의 `answeredWith is null` 하나이고, 나머지는 모두
   * 이긴 답으로 닫힌다.
   *
   * 원본이 지워졌으면 거울만 답한다 — 물은 쪽이 사라졌어도 거울을 낸 쪽은 답을 기다린다.
   */
  if (ask.mirrorOf) {
    const root = await readAskRow(pool, ask.mirrorOf);
    if (root) {
      // 원본은 거울을 만들 때 검사했다(`checkAskMirror`). 여기서 다시 보는 것은 원본에 적는
      // 것이 **이 사람의 이름으로** 적는 일이기 때문이다 — 원본 채널을 못 보는 사람이
      // 거울을 거쳐 그 채널의 물음을 정하면 안 된다.
      if (root.ask.to.kind !== 'human') return 'forbidden';
      if (!root.ask.options.some((o) => o.id === args.optionId)) return 'unknown_option';
      if (!(await assertChannelVisible(pool, root.channelId, args.actorId))) return 'forbidden';

      const rootRow = await answerAskRow(pool, ask.mirrorOf, args.optionId, args.actorId);
      if (rootRow) {
        emitEvent({ type: 'message.updated', message: rootRow, audience: await audienceFor(pool, rootRow.channelId) });
      }
      // 이겼든 졌든 거울들을 원본에 맞춘다 — 졌으면 이 거울은 이긴 답으로 닫힌다.
      await syncAskMirrors(pool, ask.mirrorOf);
      if (!rootRow) return 'already_answered';
      return (await getMessageById(pool, args.messageId)) ?? 'not_found';
    }
  }

  const row = await answerAskRow(pool, args.messageId, args.optionId, args.actorId);
  if (!row) return 'already_answered';
  // 원본이면 거울들도 같은 답으로 닫는다. 거울이 없으면 갱신되는 행이 없을 뿐이다.
  if (!ask.mirrorOf) await syncAskMirrors(pool, args.messageId);
  return row;
}

/** 계정이 사람인가. 없는 계정은 사람이 아니다(답할 자격을 줄 근거가 없다). */
async function isHumanAccount(pool: Pool, accountId: string): Promise<boolean> {
  const res = await pool.query(`select kind from account where id = $1`, [accountId]);
  return res.rows[0]?.kind === 'human';
}

/** 물음 하나를 읽는다. 없거나 지워졌거나 물음이 아니면 null. */
async function readAskRow(
  pool: Pool, messageId: string,
): Promise<{ ask: NonNullable<ReturnType<typeof readAskMeta>>; channelId: string; authorId: string | null } | null> {
  const res = await pool.query(
    `select meta, channel_id as "channelId", author_id as "authorId"
       from message where id = $1 and deleted_at is null`,
    [messageId],
  );
  const row = res.rows[0] as { meta: Record<string, unknown>; channelId: string; authorId: string | null } | undefined;
  if (!row) return null;
  const ask = readAskMeta(row.meta);
  return ask ? { ask, channelId: row.channelId, authorId: row.authorId } : null;
}

/**
 * 물어본 쪽을 깨운다(`ask_answered`·`ask_closed`). **자기 자신은 깨우지 않는다** — 에이전트가
 * 다른 에이전트의 물음에 답하는 경로가 있고(`to.kind === 'account'`), 그때 답한 쪽이 곧
 * 물은 쪽이면 자기를 깨우게 된다.
 *
 * 실패해도 던지지 않는다 — 답(닫힘)은 이미 기록됐고, 그것이 부른 쪽이 약속한 것이다.
 * 깨우지 못하면 사람이 다시 멘션하는 길이 남는다(더 나쁜 쪽은 답이 사라지는 것이다).
 */
async function wakeAsker(
  pool: Pool, askerId: string | null, actorId: string, messageId: string, reason: 'ask_answered' | 'ask_closed',
): Promise<void> {
  if (!askerId || askerId === actorId) return;
  try {
    await pool.query(
      `insert into inbox (account_id, message_id, reason) values ($1, $2, $3)`,
      [askerId, messageId, reason],
    );
    emitEvent({ type: 'inbox.updated', accountId: askerId });
  } catch (err) {
    console.error(`[${reason}] 깨움 실패(기록은 됐다):`, err);
  }
}

/**
 * 물음 한 행에 답을 적고 물어본 쪽을 깨운다. 경합에서 졌으면 null.
 *
 * **답이 왔음을 물어본 쪽에 알린다**(2026-09-09). 이것이 없으면 `message.ask` 의 약속
 * ("고르면 즉시 진행")이 성립하지 않는다: 답은 meta 에만 남고, 물어본 에이전트는 그
 * 사실을 영영 모른다. 게다가 `message.ask` 는 발화라서 그 턴은 답을 올린 뒤 회수되므로
 * (agent/src/mentionTurn.ts), 사람이 고민하는 사이 물어본 자리는 이미 비어 있다.
 * 실측(03:41): 답을 기록한 뒤 15분 동안 그 스레드에 아무 일도 없었다.
 *
 * **UPDATE 가 성공한 뒤에만** 깨운다 — `answeredWith is null` 조건이 경합에서 진
 * 쪽을 걸러 주므로, 두 사람이 동시에 눌러도 깨움은 하나다.
 *
 * `message_id` 는 **물음 자신**이다. 러너는 그 메시지의 meta 에서 `answeredWith` 를
 * 읽어 무엇이 골라졌는지 안다 — 별도 메시지를 만들지 않는 이유가 이것이다(스레드에
 * "답했다"는 줄이 하나 더 생기면 그 대화를 읽는 사람에게 소음이다).
 */
async function answerAskRow(
  pool: Pool, messageId: string, optionId: string, actorId: string,
): Promise<MessageRow | null> {
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
    [messageId, optionId, actorId],
  );
  const row = updated.rows[0] as MessageRow | undefined;
  if (!row) return null;
  await wakeAsker(pool, row.authorId, actorId, messageId, 'ask_answered');
  return row;
}

/** 물음 한 행을 "답하지 않기로 했다"로 닫고 물어본 쪽을 깨운다. 이미 답했거나 닫혔으면 null. */
async function closeAskRow(pool: Pool, messageId: string, actorId: string): Promise<MessageRow | null> {
  const updated = await pool.query(
    `update message
        set meta = jsonb_set(
              jsonb_set(
                jsonb_set(meta::jsonb, '{ask,closedAt}', to_jsonb(now())),
                '{ask,closedBy}', to_jsonb($2::text)),
              '{ask,closedReason}', to_jsonb('declined'::text))
      where id = $1
        and deleted_at is null
        and meta->'ask'->>'answeredWith' is null
        and meta->'ask'->>'closedAt' is null
      returning ${COLS}`,
    [messageId, actorId],
  );
  const row = updated.rows[0] as MessageRow | undefined;
  if (!row) return null;
  /**
   * **물어본 쪽을 깨운다.** 답과 같은 이유다: `message.ask` 는 발화라서 그 턴은 물음을
   * 올린 뒤 회수되므로, 깨우지 않으면 "답하지 않겠다"는 결정을 물어본 에이전트가 영영
   * 모른다 — 그러면 그 턴은 접히지 않고 사람은 같은 물음을 다시 받는다. 사유를
   * `ask_answered` 와 가르는 이유는 러너가 할 일이 다르기 때문이다(고른 길로 가는 것이
   * 아니라 접는 것이다 — 마이그레이션 045).
   */
  await wakeAsker(pool, row.authorId, actorId, messageId, 'ask_closed');
  return row;
}

/**
 * **거울 카드를 원본에 맞춘다**(2026-09-29). 원본이 정해졌으면(답이든 닫힘이든) 아직 열린
 * 거울을 모두 같은 결과로 닫고, 각 거울을 낸 쪽을 깨우고, 그 채널에 알린다.
 *
 * 멱등이다 — 이미 맞춰진 거울은 조건에서 빠진다. 그래서 답·닫힘·거울 발행 **어디서든**
 * 불러도 된다: 거울을 발행하는 사이 원본이 정해지는 경합도 발행 직후 한 번 부르는 것으로
 * 닫힌다.
 *
 * 답은 **원본에 적힌 그대로**(`answeredBy`·`answeredAt` 까지) 옮긴다 — 누른 사람이 원본에
 * 누른 것이고 거울에서 누른 것이 아니어도, 거울이 말할 사실은 "무엇으로 누가 정했나"다.
 * 거울이 이미 닫혀 있어도 답은 덮는다: 답이 닫힘보다 강하다는 것은 `answerAskRow` 의
 * 규칙(`closedAt` 을 보지 않는다)과 같다. 닫힘은 열린 거울에만 옮긴다.
 */
export async function syncAskMirrors(pool: Pool, rootId: string): Promise<void> {
  const root = await readAskRow(pool, rootId);
  if (!root) return;
  let rows: MessageRow[] = [];
  let reason: 'ask_answered' | 'ask_closed';
  let actorId: string;
  if (root.ask.answeredWith != null) {
    reason = 'ask_answered';
    actorId = root.ask.answeredBy ?? '';
    rows = (await pool.query(
      `update message
          set meta = jsonb_set(
                jsonb_set(
                  jsonb_set(meta::jsonb, '{ask,answeredWith}', to_jsonb($2::text)),
                  '{ask,answeredBy}', to_jsonb($3::text)),
                '{ask,answeredAt}', to_jsonb($4::text))
        where meta->'ask'->>'mirrorOf' = $1
          and deleted_at is null
          and meta->'ask'->>'answeredWith' is null
        returning ${COLS}`,
      [rootId, root.ask.answeredWith, root.ask.answeredBy ?? null, root.ask.answeredAt ?? new Date().toISOString()],
    )).rows as MessageRow[];
  } else if (root.ask.closedAt != null) {
    reason = 'ask_closed';
    actorId = root.ask.closedBy ?? '';
    rows = (await pool.query(
      `update message
          set meta = jsonb_set(
                jsonb_set(
                  jsonb_set(meta::jsonb, '{ask,closedAt}', to_jsonb($2::text)),
                  '{ask,closedBy}', to_jsonb($3::text)),
                '{ask,closedReason}', to_jsonb('declined'::text))
        where meta->'ask'->>'mirrorOf' = $1
          and deleted_at is null
          and meta->'ask'->>'answeredWith' is null
          and meta->'ask'->>'closedAt' is null
        returning ${COLS}`,
      [rootId, root.ask.closedAt, root.ask.closedBy ?? null],
    )).rows as MessageRow[];
  } else {
    return;
  }
  for (const row of rows) {
    await wakeAsker(pool, row.authorId, actorId, row.id, reason);
    emitEvent({ type: 'message.updated', message: row, audience: await audienceFor(pool, row.channelId) });
  }
}

export type AskMirrorRefusal =
  | 'mirror_not_found' | 'mirror_of_mirror' | 'mirror_not_human' | 'mirror_options_mismatch' | 'mirror_resolved';

/**
 * `message.ask` 의 `mirrorOf` 를 받아도 되는가(2026-09-29, jaebin 이 #task 에서 (b) 를 골랐다).
 *
 * 거울은 **사람이 누를 자리를 하나 더 세우는 것**이지 대리 답이 아니다 — 누르는 것은 끝까지
 * 사람이고, 서버는 그 사람의 이름으로 원본에 옮겨 적을 뿐이다. 그래서 거절하는 경우는 모두
 * "옮겨 적는 것이 거짓이 되는" 경우다:
 *
 * - 원본이 없거나 부른 쪽이 그 채널을 못 본다 → `mirror_not_found`(있다는 것도 새지 않게 같은 답).
 * - 원본이 거울이다 → `mirror_of_mirror`. 정본을 하나로 두려고 사슬을 막는다(원본을 가리켜라).
 * - 원본이 사람 앞이 아니다 → `mirror_not_human`. 에이전트 앞 물음을 사람 카드로 세우면 사람이
 *   남의 물음을 가로채는 길이 된다(`to` 를 실은 뜻).
 * - 선택지 id 가 다르다 → `mirror_options_mismatch`. 거울에서 고른 id 가 원본에 없으면 옮길 수
 *   없고, 일부만 같으면 사람이 본 선택지와 원본의 선택지가 다른 것이다. 라벨은 달라도 된다
 *   (다른 채널에서 읽히게 다시 쓸 수 있다).
 * - 원본이 이미 정해졌다 → `mirror_resolved`. 정해진 것을 다시 묻는 카드는 소음이다.
 */
export async function checkAskMirror(
  pool: Pool, args: { rootId: string; callerId: string; optionIds: string[] },
): Promise<AskMirrorRefusal | null> {
  const root = await readAskRow(pool, args.rootId);
  if (!root) return 'mirror_not_found';
  if (!(await assertChannelVisible(pool, root.channelId, args.callerId))) return 'mirror_not_found';
  if (root.ask.mirrorOf) return 'mirror_of_mirror';
  if (root.ask.to.kind !== 'human') return 'mirror_not_human';
  const rootIds = root.ask.options.map((o) => o.id).sort();
  const ids = [...args.optionIds].sort();
  if (rootIds.length !== ids.length || rootIds.some((id, i) => id !== ids[i])) return 'mirror_options_mismatch';
  if (!isAskOpen(root.ask)) return 'mirror_resolved';
  return null;
}

/**
 * **답하지 않기로 한다**(2026-09-09). 고른 것은 없고, 이 물음은 닫힌다.
 *
 * ## 왜 필요한가
 *
 * 물음이 닫히는 길이 고르기 하나뿐이었다. 그 작업을 그만두기로 한 사람에게 남은 수단은
 * **그 메시지를 지우는 것**뿐이었고(집계가 `deleted_at is null` 로 걸러서 줄이 사라진다),
 * 지우면 무엇을 물었는지까지 사라진다. 턴을 중단해도(`/agent-sessions/:id/cancel`) 이
 * `meta.ask` 는 그대로여서 대기 줄이 **물어본 턴보다 오래 살았다.**
 *
 * ## 지우기가 아니라 닫기다
 *
 * 카드는 남는다 — 무엇을 물었고 사람이 답하지 않기로 했다는 것은 **기록**이다. 그래서
 * `answeredWith` 를 쓰지 않고 `closedAt` 을 따로 둔다(`shared::AskMeta` 참고).
 *
 * ## 누가 닫을 수 있는가
 *
 * 답할 수 있는 사람(`recordAskAnswer` 와 **같은 규칙** — 사람 앞 물음이면 사람), **물어본 쪽**,
 * 그리고 admin 이다. 물어본 쪽을 넣는 이유: 스스로 답을 찾았으면 자기 물음을 거두는 것이
 * 맞고, 그 길이 없으면 에이전트는 자기가 세운 대기 줄을 지울 수 없다.
 *
 * ## 거울과 함께 닫힌다 (2026-09-29)
 *
 * 원본이 닫히면 열린 거울도 닫힌다(`syncAskMirrors`). 거울에서 닫으면 **닫은 쪽이 사람일
 * 때만** 원본도 닫는다 — 거울을 낸 에이전트가 자기 거울을 거두는 것은 "사람이 답하지 않기로
 * 했다"가 아니다. 그것을 원본에 옮기면 에이전트가 사람 카드를 정하는 길이 된다.
 *
 * ## 이미 답이 있으면 거절한다
 *
 * `already_answered` 다 — 정해진 것을 "답하지 않았다"로 덮으면 그 결정이 사라진다.
 * 두 번 닫는 것은 **멱등**이다(경합에서 진 쪽도 원하던 결과를 얻는다): 이미 닫혀 있으면
 * 그 행을 그대로 돌려준다.
 */
export async function closeAsk(
  pool: Pool,
  args: { messageId: string; actorId: string; actorIsAdmin: boolean },
): Promise<MessageRow | MutationRefusal | 'already_answered'> {
  const found = await pool.query(
    `select meta, author_id as "authorId" from message where id = $1 and deleted_at is null`,
    [args.messageId],
  );
  if (!found.rowCount) return 'not_found';
  const ask = readAskMeta(found.rows[0].meta as Record<string, unknown>);
  if (!ask) return 'not_found';
  if (ask.answeredWith != null) return 'already_answered';

  const asker: string | null = found.rows[0].authorId;
  const actorIsHuman = await isHumanAccount(pool, args.actorId);
  const mayAnswer = ask.to.kind === 'human' ? actorIsHuman : ask.to.accountId === args.actorId;
  if (!mayAnswer && asker !== args.actorId && !args.actorIsAdmin) return 'forbidden';

  /**
   * 사람이 거울에서 닫으면 **원본을 먼저 닫는다** — 답과 같은 이유로 정본은 원본이다.
   * 원본이 이미 답을 가졌으면 이 닫힘은 경합에서 진 것이고, 거울은 그 답으로 맞춰진다.
   * 원본 채널을 못 보는 사람은 원본을 닫지 않는다(거울만 닫힌다).
   */
  if (ask.mirrorOf && actorIsHuman) {
    const root = await readAskRow(pool, ask.mirrorOf);
    if (root && root.ask.to.kind === 'human' && (await assertChannelVisible(pool, root.channelId, args.actorId))) {
      const rootRow = await closeAskRow(pool, ask.mirrorOf, args.actorId);
      if (rootRow) {
        emitEvent({ type: 'message.updated', message: rootRow, audience: await audienceFor(pool, rootRow.channelId) });
      }
      await syncAskMirrors(pool, ask.mirrorOf);
      const after = await getMessageById(pool, args.messageId);
      if (!after) return 'not_found';
      const askAfter = readAskMeta(after.meta);
      if (askAfter?.answeredWith != null) return 'already_answered';
      if (askAfter?.closedAt != null) return after;
      // 원본은 닫혔는데 이 거울만 남았다면(원본 없이 조건이 갈린 경우) 아래에서 거울만 닫는다.
    }
  }

  const row = await closeAskRow(pool, args.messageId, args.actorId);
  // 갱신된 행이 없으면 누군가 먼저 닫았거나 먼저 답했다. 답이 이겼는지 여기서 다시 읽어
  // 가른다 — 닫힘이 먼저였으면 사람이 원한 결과가 이미 나 있으므로 그 행을 그대로 준다.
  if (!row) {
    const after = await getMessageById(pool, args.messageId);
    if (!after) return 'not_found';
    const askAfter = readAskMeta(after.meta);
    return askAfter?.answeredWith != null ? 'already_answered' : after;
  }
  // 원본이면 열린 거울도 닫는다.
  if (!ask.mirrorOf) await syncAskMirrors(pool, args.messageId);
  return row;
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
  opts: { since?: number; before?: number; around?: number; threadRootId?: string | null; limit?: number },
): Promise<MessageRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  if (opts.threadRootId) {
    /**
     * 스레드 **안**의 옛 답글로 점프하는 창(⌘F 의 스레드 스코프). 아래 기본 분기는 스레드의
     * '최신 limit 개'를 주므로, 답글이 그보다 많은 스레드에서 옛 답글을 고르면 대상이 창에
     * 없고 강조가 조용히 아무 일도 하지 않는다 — 스레드 패널에는 위로 더 읽는 길도 없어
     * 그 말에 닿을 방법이 아예 없어진다. 채널 쪽 `around` 와 **같은 문장**이다.
     */
    if (opts.around !== undefined) {
      const half = Math.max(1, Math.ceil(limit / 2));
      const res = await pool.query(
        `select * from (
           (select ${LIST_COLS} from message m ${THREAD_STATS}
            where m.channel_id = $1 and m.id = $2 and ${LIST_VISIBLE})
           -- 루트는 아래 갈래(thread_root_id = $2)에 절대 걸리지 않으므로 중복이 없다.
           -- union(중복 제거)은 json 컬럼에 등호가 없어 터진다 — union all 이어야 한다.
           union all
           (select * from (
              (select ${LIST_COLS} from message m ${THREAD_STATS}
               where m.channel_id = $1 and m.thread_root_id = $2 and m.seq <= $3 and ${LIST_VISIBLE}
               order by m.seq desc limit $4)
              union all
              (select ${LIST_COLS} from message m ${THREAD_STATS}
               where m.channel_id = $1 and m.thread_root_id = $2 and m.seq > $3 and ${LIST_VISIBLE}
               order by m.seq limit $4)
            ) thread_window)
         ) window_rows
         order by seq`,
        [channelId, opts.threadRootId, opts.around, half],
      );
      return res.rows;
    }
    /**
     * 스레드의 **옛 답글 페이지**(위로 밀어 더 읽기). `before` 보다 오래된 답글 중 최신 limit 개.
     * **이 스레드의 답글만** 본다(`thread_root_id = $2`) — 전에는 이 갈래가 없어 `before` 가
     * 무시되고 최신 페이지가 다시 왔다. 루트는 첫 페이지(아래 기본 갈래)가 이미 싣고, 루트의
     * seq 는 모든 답글보다 작으므로 옛 페이지에는 싣지 않는다.
     */
    if (opts.before !== undefined) {
      const res = await pool.query(
        `select * from (
           select ${LIST_COLS} from message m ${THREAD_STATS}
           where m.channel_id = $1 and m.thread_root_id = $2 and m.seq < $3 and ${LIST_VISIBLE}
           order by m.seq desc limit $4
         ) older
         order by seq`,
        [channelId, opts.threadRootId, opts.before, limit],
      );
      return res.rows;
    }
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
    // `limit` 은 **답글에만** 건다. 전에는 `order by … limit` 이 union 전체에 걸려 답글이 limit
    // 을 넘는 스레드에서 루트가 잘려 나갔다(위 주석의 "항상 포함" 과 달리).
    const res = await pool.query(
      `select * from (
        (select ${LIST_COLS} from message m ${THREAD_STATS}
         where m.channel_id = $1 and m.id = $2 and ${LIST_VISIBLE})
        union all
        (select ${LIST_COLS} from message m ${THREAD_STATS}
         where m.channel_id = $1 and m.thread_root_id = $2 and ${LIST_VISIBLE}
         order by m.seq desc limit $3)
      ) latest
      order by seq`,
      [channelId, opts.threadRootId, limit],
    );
    return res.rows;
  }
  /**
   * 검색 결과로 **점프**할 때 쓰는 창(⌘F). before·since 는 한쪽 방향만 주므로,
   * 옛 메시지 하나를 화면에 세우려면 그 앞뒤가 함께 있어야 한다 — 앞만 있으면 그 말이
   * 화면 맨 아래에 홀로 서서 무슨 대화였는지 알 수 없다.
   *
   * 위·아래를 절반씩 나눠 뜬다. 위쪽은 대상 자신을 포함(`seq <= around`)하므로 지워졌거나
   * 안 보이는 메시지를 가리키면 그냥 그 자리의 창이 오고, 강조할 것이 없을 뿐이다.
   */
  if (opts.around !== undefined) {
    const half = Math.max(1, Math.ceil(limit / 2));
    const res = await pool.query(
      `select * from (
         (select ${LIST_COLS} from message m ${THREAD_STATS}
          where m.channel_id = $1 and m.seq <= $2 and ${LIST_VISIBLE}
          order by m.seq desc limit $3)
         union all
         (select ${LIST_COLS} from message m ${THREAD_STATS}
          where m.channel_id = $1 and m.seq > $2 and ${LIST_VISIBLE}
          order by m.seq limit $3)
       ) window_rows
       order by seq`,
      [channelId, opts.around, half],
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

/**
 * 인박스 항목들이 속한 **스레드의 머리**(Inbox 상태 보드, 2026-10-01).
 *
 * 보드는 메시지가 아니라 **일(스레드)** 단위로 선다 — 같은 일에서 온 다섯 줄이 카드 하나가
 * 된다. 카드를 어느 열(내 차례·막힘·진행·끝남)에 둘지는 줄의 `meta` 가 아니라 **스레드의
 * 지금 상태**가 정한다: 답한 물음, 풀린 실패는 옛 줄의 `meta` 로는 알 수 없다. 그 상태는
 * 채널 목록이 이미 머리에 싣는 `THREAD_STATS` 그대로라, 같은 열(`LIST_COLS`)을 머리에서만 읽는다
 * — 판정을 새로 적으면 채널의 배지와 보드의 열이 갈린다.
 *
 * 머리 수만큼만 돈다(항목 수가 아니라). 머리마다의 LATERAL 은 062 의
 * `(thread_root_id, seq)` 색인을 탄다.
 *
 * **볼 수 있는가는 지금 다시 잰다**(`channelVisibleSql`, security F1). 인박스 항목은 부를 때의
 * 가시성으로 만들어지고 그 뒤로 남는다 — 비공개 채널에서 내보내지거나(`removeChannelMember` 는
 * inbox 행을 안 지운다) 채널이 비공개로 바뀌어도 항목은 그대로다. 머리는 **계속 갱신되는**
 * 스레드 상태(본문·리액션·참여자·열린 물음)라, 거르지 않으면 나간 사람이 그 스레드를 계속 지켜본다.
 * 걸러진 머리의 카드는 보드에 서지 않는다(화면의 "머리가 안 오면 세우지 않는다").
 */
export async function listInboxThreads(pool: Pool, accountId: string, entries: InboxEntry[]): Promise<MessageRow[]> {
  return listThreadHeads(pool, accountId, entries.map((e) => e.threadRootId ?? e.messageId));
}

/**
 * 스레드 머리 행들 — `listInboxThreads` 와 「내 작업」 보드(`/inbox/board`)가 같이 쓴다. 가시성·지운
 * 머리 규칙이 한 자리에 있어야 두 조회가 같은 머리를 낸다.
 */
async function listThreadHeads(pool: Pool, accountId: string, ids: string[]): Promise<MessageRow[]> {
  const rootIds = [...new Set(ids)];
  if (rootIds.length === 0) return [];
  const res = await pool.query(
    `select ${LIST_COLS} from message m ${THREAD_STATS}
       join channel c on c.id = m.channel_id
      where m.id = any($1::uuid[]) and m.thread_root_id is null and ${LIST_VISIBLE}
        and ${channelVisibleSql('c', '$2')}`,
    [rootIds, accountId],
  );
  return res.rows;
}

/** 「내 작업」 보드가 inbox 밖에서 더 모으는 기간과 상한. */
export const BOARD_WINDOW_DAYS = 30;
export const BOARD_EXTRA_LIMIT = 300;

/**
 * 「내 작업」 보드(2026-10-03 jaebin 승인, 스레드 edd07149)가 **inbox 밖에서** 더 모으는 스레드 머리.
 *
 * 왜 inbox 만으로 모자란가: inbox 항목은 남이 나를 부르거나 내 스레드에 답할 때만 생긴다. 그래서
 * ① 내가 시켰는데 **아직 아무도 답하지 않은** 스레드와 ② 남이 연 스레드에 **내가 말만 얹은** 스레드는
 * 보드 어디에도 없었다 — "시켜 놓고 잊는" 일이 바로 ①이다.
 *
 * 범위 = (내가 연 머리 ∪ 내가 답한 스레드) 중 **최근 `days` 일 안에 내가 말한 것** ∩ **에이전트가 낀 것**.
 * "에이전트가 낀 것"은 `thread_status` 행이 있다는 뜻이다 — 서버 판정(`decideThreadStatus`)이
 * `agentInvolved` 가 아니면 행을 지운다. 사람끼리 나눈 말까지 일로 세우면 보드가 다시 넘친다(jaebin 결정).
 *
 * 가시성은 여기서 거르지 않는다 — 머리를 싣는 `listThreadHeads` 가 지금 기준으로 다시 잰다(한 자리).
 * 최근에 상태가 바뀐 것부터 `limit` 개. 넘쳤는지는 `truncated` 로 알린다.
 */
export async function listBoardRootIds(
  pool: Pool, accountId: string, opts: { days: number; limit: number },
): Promise<{ rootIds: string[]; truncated: boolean }> {
  const res = await pool.query(
    `with mine as (
       select coalesce(m.thread_root_id, m.id) as root_id
         from message m
        where m.author_id = $1 and m.deleted_at is null
          and m.created_at > now() - make_interval(days => $2::int)
     )
     select ts.root_id as id
       from (select distinct root_id from mine) r
       join thread_status ts on ts.root_id = r.root_id
      order by ts.updated_at desc, ts.root_id
      limit $3::int + 1`,
    [accountId, opts.days, opts.limit],
  );
  const ids = res.rows.map((r: { id: string }) => r.id);
  return { rootIds: ids.slice(0, opts.limit), truncated: ids.length > opts.limit };
}

/**
 * 「내 작업」 보드의 머리 = inbox 항목의 머리 ∪ `listBoardRootIds`. 응답 모양은 `?threads=1` 과 같다 —
 * 앱의 `buildBoard` 가 그대로 받는다. inbox 항목이 없는 머리는 `entries` 에 줄이 없이 `threads` 에만 선다.
 */
export async function listBoardThreads(
  pool: Pool, accountId: string, entries: InboxEntry[],
): Promise<{ threads: MessageRow[]; truncated: boolean }> {
  const extra = await listBoardRootIds(pool, accountId, { days: BOARD_WINDOW_DAYS, limit: BOARD_EXTRA_LIMIT });
  const threads = await listThreadHeads(pool, accountId, [
    ...entries.map((e) => e.threadRootId ?? e.messageId), ...extra.rootIds,
  ]);
  return { threads, truncated: extra.truncated };
}

export async function listInbox(
  pool: Pool, accountId: string, opts: { unreadOnly?: boolean },
): Promise<InboxEntry[]> {
  const res = await pool.query(
    `select i.id::int as id, i.message_id as "messageId", i.reason, i.read_at as "readAt",
            m.channel_id as "channelId",
            -- 줄이 네 가지를 말할 재료(#488 C2): 누가 · 무슨 말 · 무엇을 · 언제·어디.
            -- 이미 message 를 join 하고 있었으므로 컬럼만 더한다 — 새 왕복이 없다.
            -- 시스템 메시지의 자리표시자는 여기서 채운다 — 인박스 항목에는 kind 가 없어 화면이 못 채운다.
            m.author_id as "authorId", ${displayBodySql('m')} as body, m.meta,
            m.created_at as "createdAt", m.thread_root_id as "threadRootId",
            -- 팀 부름의 팀(047). 명단은 아래에서 한 번에 채운다 — 여기서 join 하면
            -- 팀원 수만큼 행이 불어나 항목이 여러 번 나온다.
            i.team_id as "teamId",
            -- 수정으로 생긴 부름(076). 참일 때만 싣는다 — 아래에서 거짓은 키째 지운다.
            i.via_edit as "viaEdit"
     from inbox i join message m on m.id = i.message_id
     join channel c on c.id = m.channel_id
     -- 지워진 말은 인박스에도 남지 않는다. 본문을 싣기 시작했으므로 이 조건이 없으면
     -- 지운 글이 인박스 줄에 그대로 보인다(전에는 id 만 실어 보이지 않았다).
     --
     -- **지금 볼 수 있는 채널의 것만**(2026-10-02, #1018 security F1 후속). 항목은 부를 때의
     -- 가시성으로 만들어지고 그 뒤로 남는다 — 비공개 채널에서 내보내지거나(removeChannelMember
     -- 는 inbox 행을 안 지운다) 채널이 비공개로 바뀌어도 그대로다. 거르지 않으면 나간 사람이
     -- 그 채널의 본문을 인박스로 계속 받는다. 행은 지우지 않는다: 다시 들어오면 다시 보인다.
     --
     -- 러너의 inbox.poll 도 이 함수를 쓴다 → 나간 채널의 부름으로는 **턴이 뜨지 않는다**.
     -- 의도다: 그 턴은 그 채널을 읽지도 거기에 쓰지도 못한다.
     where i.account_id = $1 and m.deleted_at is null
       and ${channelVisibleSql('c', '$1')}
       ${opts.unreadOnly ? 'and i.read_at is null' : ''}
     order by i.id`,
    [accountId],
  );

  /**
   * 팀 부름에 **명단을 붙인다**(047). 팀장은 이것으로 누구에게 무엇을 넘길지 판단한다 —
   * 명단이 없으면 근거가 없어 결국 혼자 다 한다(`InboxTeamCall` 주석).
   *
   * **행마다 조회하지 않는다.** 팀 부름은 드물지만 한 폴이 여러 개를 가져올 수 있고,
   * 그때 팀마다 왕복하면 폴 지연이 팀 수에 비례한다. 팀 id 를 모아 한 번에 읽는다.
   *
   * `specialty` 는 지시문 **첫 줄**이다. 자르는 근거는 `InboxTeamCall` 주석에 있다.
   * 빈 문자열은 `null` 로 접는다 — 지시문이 빈 에이전트가 있고, 그대로 흘리면 프롬프트가
   * "전문 영역: " 을 그린다.
   *
   * 팀이 그 사이 지워졌으면(047 의 `on delete set null`) 이 조회가 아무 행도 주지 않고
   * 항목은 `team` 없이 나간다 — 러너는 팀 블록 없이 평범한 부름처럼 처리한다.
   */
  const rows = res.rows as (InboxEntry & { teamId?: string | null })[];
  const teamIds = [...new Set(rows.map((r) => r.teamId).filter((id): id is string => typeof id === 'string'))];
  if (teamIds.length) {
    const teams = await pool.query(
      `select t.id, t.name, tm.agent_account_id as "accountId", a.handle,
              nullif(split_part(coalesce(ac.instructions, ''), E'\n', 1), '') as specialty,
              a.disabled_at is not null as disabled
         from agent_team t
         join agent_team_member tm on tm.team_id = t.id
         join account a on a.id = tm.agent_account_id
         left join agent_config ac on ac.account_id = a.id
        where t.id = any($1)
        order by a.handle`,
      [teamIds],
    );
    const byTeam = new Map<string, InboxTeamCall>();
    for (const row of teams.rows) {
      let call = byTeam.get(row.id);
      if (!call) {
        call = { id: row.id, name: row.name, members: [] };
        byTeam.set(row.id, call);
      }
      call.members.push({
        accountId: row.accountId, handle: row.handle,
        specialty: row.specialty ?? null, disabled: row.disabled,
      });
    }
    for (const row of rows) {
      const call = typeof row.teamId === 'string' ? byTeam.get(row.teamId) : undefined;
      if (call) row.team = call;
    }
  }
  /**
   * 결말이 난 위임에는 **결말 목록을 붙인다**(050). 명단(`team`)과 같은 판단이다 — 서버는
   * 이미 그 판정을 했고(누가 끝냈고 누가 무응답인가), 읽는 쪽이 다시 하면 갈라진다.
   *
   * 가리키는 메시지가 **위임 자신**이므로(043 의 "물음 자신"과 같은 규약) 그 id 로 되찾는다.
   */
  const doneIds = rows.filter((r) => r.reason === 'delegation_done').map((r) => r.messageId);
  if (doneIds.length) {
    const outcomes = await outcomesFor(pool, [...new Set(doneIds)]);
    for (const row of rows) {
      const found = row.reason === 'delegation_done' ? outcomes.get(row.messageId) : undefined;
      if (found) row.delegation = found;
    }
  }

  /**
   * **넘겨받은 일**에는 팀장과 기한을 붙인다(3-2). 러너가 그것으로 *"최종 답은 팀장이
   * 쓴다"* 블록을 만든다 — 팀장이 누구인지 모르면 그 문장을 쓸 수 없고, 기한을 모르면
   * 그 팀원은 자기 답이 언제 무응답으로 닫히는지 알 수 없다.
   *
   * 명단(`team`)·결말(`delegation`)과 같은 판단이다: 서버는 이미 안다(위임을 만든 것이
   * 서버다). 읽는 쪽이 다시 찾으면 두 출처가 생긴다.
   */
  const handedIds = rows.filter((r) => r.reason === 'team_delegated').map((r) => r.messageId);
  if (handedIds.length) {
    const handed = await pool.query<{
      message_id: string; leadHandle: string; teamName: string; deadlineAt: string;
    }>(
      `select d.message_id, a.handle as "leadHandle", t.name as "teamName",
              d.deadline_at as "deadlineAt"
         from team_delegation d
         join account a on a.id = d.lead_account_id
         join agent_team t on t.id = d.team_id
        where d.message_id = any($1)`,
      [[...new Set(handedIds)]],
    );
    const byMessage = new Map(handed.rows.map((r) => [r.message_id, r]));
    for (const row of rows) {
      const found = row.reason === 'team_delegated' ? byMessage.get(row.messageId) : undefined;
      if (found) {
        row.delegatedBy = {
          leadHandle: found.leadHandle, teamName: found.teamName,
          deadlineAt: new Date(found.deadlineAt).toISOString(),
        };
      }
    }
  }

  // `teamId` 는 계약이 아니다(`InboxEntry` 에 없다) — 명단으로 옮긴 뒤 지운다. 남겨 두면
  // 화면·러너가 그 값을 읽기 시작하고, 그러면 명단과 id 라는 두 출처가 생긴다.
  for (const row of rows) delete row.teamId;
  // `viaEdit` 는 참일 때만 나간다(`InboxEntry.viaEdit`) — 게시로 생긴 항목의 모양을 넓히지 않는다.
  for (const row of rows as { viaEdit?: boolean }[]) if (!row.viaEdit) delete row.viaEdit;
  return rows;
}

/**
 * 내 스레드 처리 상태들(089) — `GET /inbox?threads=1` 이 머리와 함께 싣는다. **지금 볼 수 있는
 * 채널의 것만** 낸다(`listInboxThreads` 와 같은 이유, security F1): 나간 채널의 상태 행이 남아
 * 있어도 그 존재가 응답에 새지 않게 한다.
 */
export async function listInboxThreadStates(pool: Pool, accountId: string, rootIds: string[]): Promise<InboxThreadState[]> {
  if (rootIds.length === 0) return [];
  const res = await pool.query(
    `select s.root_id as "rootId", s.state, s.until, s.updated_at as "updatedAt"
       from inbox_thread_state s
       join message m on m.id = s.root_id
       join channel c on c.id = m.channel_id
      where s.account_id = $1 and s.root_id = any($2::uuid[]) and ${channelVisibleSql('c', '$1')}`,
    [accountId, rootIds],
  );
  return res.rows.map((r) => ({
    rootId: r.rootId, state: r.state,
    until: r.until ? new Date(r.until).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
}

/** `setInboxThreadState` 가 거절한 이유. 라우트가 404·403 으로 옮긴다. */
export type InboxThreadStateRefusal = 'not_found' | 'not_root' | 'forbidden';

/**
 * 내 스레드 처리 상태를 정한다(`null` 이면 지운다). **바꾸는 것은 언제나 부른 계정 자신의 행**이다 —
 * 계정을 인자로 받지 않고 라우트가 `req.account` 를 넘기므로 남의 보드를 바꿀 길이 없다.
 *
 * 볼 수 없는 채널의 루트는 거절한다(`channelVisibleSql`). 안 그러면 루트 id 만 알면 그 채널에
 * 무엇이 있는지(있다는 사실)를 응답 코드로 떠볼 수 있다 — 그래서 없는 것과 볼 수 없는 것을
 * 가르지만, 볼 수 없는 채널의 루트인지는 루트가 있을 때만 말한다(메시지 링크 라우트와 같다).
 */
export async function setInboxThreadState(
  pool: Pool, accountId: string, rootId: string,
  next: { state: 'done' } | { state: 'later'; until: string } | null,
): Promise<InboxThreadState | null | InboxThreadStateRefusal> {
  const root = await pool.query<{ thread_root_id: string | null; visible: boolean }>(
    `select m.thread_root_id, ${channelVisibleSql('c', '$2')} as visible
       from message m join channel c on c.id = m.channel_id
      where m.id = $1 and m.deleted_at is null`,
    [rootId, accountId],
  );
  const row = root.rows[0];
  if (!row) return 'not_found';
  if (!row.visible) return 'forbidden';
  if (row.thread_root_id !== null) return 'not_root';
  if (next === null) {
    await pool.query(`delete from inbox_thread_state where account_id = $1 and root_id = $2`, [accountId, rootId]);
    return null;
  }
  const until = next.state === 'later' ? next.until : null;
  const res = await pool.query(
    `insert into inbox_thread_state (account_id, root_id, state, until)
     values ($1, $2, $3, $4)
     on conflict (account_id, root_id)
       do update set state = excluded.state, until = excluded.until, updated_at = now()
     returning root_id as "rootId", state, until, updated_at as "updatedAt"`,
    [accountId, rootId, next.state, until],
  );
  const r = res.rows[0];
  return {
    rootId: r.rootId, state: r.state,
    until: r.until ? new Date(r.until).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
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
export interface SearchScope {
  channelId?: string | null;
  /** 스레드 스코프(⌘F): 루트 자신과 그 답글만. 채널 스코프 **위에** 더 좁히는 조건이다. */
  threadRootId?: string | null;
  limit?: number;
  offset?: number;
  /**
   * 거르기(S1). 전부 **가시성·스코프 술어 위에 얹는 `and` 조건**이다 — 결과를 좁히기만 하고 넓히는
   * 갈래가 없다. 빈 배열·null 은 "거르지 않음"이다.
   *
   * - `authorIds`: 이 사람들이 쓴 것만. 개수는 [SEARCH_MAX_AUTHORS] 까지(라우트가 막고 여기서도 자른다).
   * - `after`·`before`: `created_at` 의 [after, before) 반열린 구간(ISO 시각). 「오늘」·「7일」 칩이 그대로 쓴다.
   * - `hasAttachment`: 첨부가 하나라도 붙은 것만.
   */
  authorIds?: readonly string[] | null;
  after?: string | null;
  before?: string | null;
  hasAttachment?: boolean | null;
  /** `relevance`(기본, 접두 일치 > ts_rank > 최신) · `recent`(최신순만). */
  sort?: SearchSort | null;
}

export type SearchSort = 'relevance' | 'recent';

/**
 * `authorIds` 의 천장. 칩으로 고르는 사람 수라 이 정도면 넉넉하고, 상한이 없으면 질의 하나에
 * uuid 수천 개를 실어 `= any($7)` 을 부풀릴 수 있다(security #1094 S1 ②).
 */
export const SEARCH_MAX_AUTHORS = 10;


export interface SearchPage {
  messages: MessageRow[];
  /** 이 페이지 뒤에 더 있는가. `limit + 1` 을 떠서 판별한다(count 왕복을 만들지 않는다). */
  hasMore: boolean;
}

/**
 * offset 의 천장. 깊은 offset 은 서버가 그만큼을 세고 버리는 것이라 값이 커질수록 그냥
 * 느려진다 — 그 자리까지 넘긴 사람은 검색어를 고치는 편이 낫다.
 *
 * **`hasMore` 가 이 값을 같이 알아야 한다.** 라우트만 막으면 마지막 페이지에서도 '더 보기'가
 * 그려지고, 누른 순간 천장을 넘은 offset 이 나가 400 을 받는다 — 결과는 그대로인 채 에러 줄만
 * 뜬다. 버튼이 아예 서지 않는 것이 맞다.
 */
export const SEARCH_MAX_OFFSET = 1000;

/**
 * 검색 입력의 **형식과 상한 한 벌**(S2). REST `/search` 와 MCP `message.search` 가 같은 조각을 쓴다 —
 * 서비스의 `slice` 는 두 번째 그물일 뿐이고, 형식 검증이 한쪽 표면에만 있으면 다른 표면이 그 구멍이 된다
 * (security #1097). 쿼리 문자열과 JSON 인자는 모양이 달라(되풀이 키·`'true'` 대 배열·boolean) 감싸는
 * 자리만 각자 둔다.
 */
export const searchInput = {
  query: z.string().min(1).max(256),
  authorIds: z.array(z.string().uuid()).max(SEARCH_MAX_AUTHORS),
  time: z.string().datetime({ offset: true }),
  sort: z.enum(['relevance', 'recent']),
  offset: z.number().int().min(0).max(SEARCH_MAX_OFFSET),
} as const;

/**
 * `limit + 1` 을 떠 왔으므로 한 줄이 더 있으면 다음 페이지가 있다 — **천장 안쪽일 때만**.
 * 천장을 넘어가는 offset 은 라우트가 400 으로 막으므로, 거기서 '더 있다'고 말하면 사람은
 * 누를 수 있는 버튼을 받고 에러만 돌려받는다.
 */
export function searchHasMore(fetched: number, limit: number, offset: number): boolean {
  return fetched > limit && offset + limit <= SEARCH_MAX_OFFSET;
}

/**
 * **접두** tsquery. `simple` config 는 어간을 떼지 않아 한국어가 조사 하나에 걸린다
 * (`'검색을' @@ '검색'` → false). 낱말마다 `:*` 를 붙이면 그 자리가 메워진다 —
 * `'검색':*` 이 `검색을`·`검색이`를, `'searchpalette':*` 이 `SearchPalette.tsx` 를 잡는다.
 *
 * 만드는 법: `websearch_to_tsquery` 의 **text 꼴**에 `:*` 를 얹는다. 이미 낱말마다 따옴표가
 * 쳐진 정본이라 URL(`'http' & '/x.com/a'`)·따옴표 든 낱말·구(`<->`)·부정(`!`)이 그대로
 * 살아 다시 파싱된다. 낱말을 `tsvector_to_array` 로 날것으로 꺼내 이어 붙이면 그 넷이 깨진다
 * (실측: `http://x.com/a` 가 엉뚱한 구 질의가 된다).
 *
 * 낱말이 하나도 안 나오는 질의(`!!!` 같은 것)는 text 꼴이 빈 문자열이고, 거기 `:*` 를 붙이면
 * `to_tsquery` 가 **syntax error 로 터진다**(=500). 그래서 nullif 로 빈 것을 걸러 **NULL** 로
 * 접는다 — `search @@ null` 은 null 이라 where 가 그 행을 버리고, order by 키도 전 행이 null
 * 이라 순서가 그대로다. 아무 것도 맞지 않을 뿐이다.
 *
 * 여기서 `coalesce(…, ''::tsquery)` 로 받지 **않는** 이유: 빈 tsquery 리터럴은 파싱 시점에
 * 평가돼서 **낱말이 멀쩡히 있는 정상 질의에도** 검색마다 pg 로그에 한 줄을 남긴다
 * (`NOTICE: text-search query doesn't contain lexemes: ""`). 로그를 읽는 사람에게 "질의에
 * 낱말이 없었다"로 보여 오해를 준다. 동작은 NULL 쪽과 같다.
 */
const PREFIX_TSQUERY = `nullif(
      regexp_replace(websearch_to_tsquery('simple', $1)::text, '''(\\s|$)', ''':*\\1', 'g'), ''
    )::tsquery`;

/**
 * 한 낱말이 두 갈래로 걸린다.
 *
 * 1. 접두 tsvector 매치(위) — 빠르고, 조사·파일명·부분 식별자를 잡는다.
 * 2. `lower(body) like '%q%'` — **중간일치**. 접두로 못 잡는 나머지(`검색` 으로 `재검색`)를
 *    이 갈래가 받는다. 044 의 trigram GIN 이 받는 자리이고, 확장을 못 켠 배포에서는 느릴 뿐
 *    답은 같다.
 *
 * ## 2번을 **3글자 미만에 걸지 않는 이유** (실측 200k 행)
 *
 * `gin_trgm_ops` 는 2글자 패턴에서 트라이그램 키를 하나도 못 뽑는다. 그러면 OR 의 한쪽이
 * 인덱스 불가가 되어 **BitmapOr 자체가 성립하지 않고, 1번의 tsvector 인덱스까지 함께 버려진다**
 * — 계획 전체가 순차 스캔이 된다(채널 스코프도 구제하지 못한다. 스코프는 필터로만 붙는다).
 *
 *     2글자 질의, 200k 행:  like ≥2 → Parallel Seq Scan 42.9 ms
 *                           like ≥3 → Bitmap Index Scan on m_search 0.067 ms
 *     3글자 질의:           BitmapOr(m_search + trgm) 0.38 ms — 그대로 잘 돈다
 *
 * 잃는 것은 "**2글자로 중간일치**" 하나뿐이다(`검색` 으로 `재검색`). 조사·파일명·부분 식별자는
 * 1번이 접두로 이미 잡는다.
 *
 * `%`·`_`·`\` 는 like 의 메타문자다. 사람이 친 그대로 찾도록 이스케이프한다 — 안 하면
 * `_` 한 글자가 "아무 글자 하나"가 되어 엉뚱한 것이 섞인다.
 */
const SEARCH_MATCH = `(
      m.search @@ ${PREFIX_TSQUERY}
      or (
        char_length($1) >= 3
        and lower(m.body) like '%' || replace(replace(replace(lower($1), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
      )
    )`;

export async function searchMessages(
  pool: Pool, requesterId: string, query: string, scope: SearchScope = {},
): Promise<SearchPage> {
  const limit = Math.min(scope.limit ?? 50, 100);
  const offset = Math.max(scope.offset ?? 0, 0);
  const authorIds = scope.authorIds?.length ? scope.authorIds.slice(0, SEARCH_MAX_AUTHORS) : null;
  // 정렬은 닫힌 두 값 중 하나다 — 문자열을 SQL 에 그대로 잇지 않고 여기서 고른다.
  const order = scope.sort === 'recent'
    ? `m.created_at desc, m.seq desc`
    : `(m.search @@ ${PREFIX_TSQUERY}) desc,
              ts_rank(m.search, ${PREFIX_TSQUERY}) desc,
              m.seq desc`;
  const res = await pool.query(
    `select m.id, m.seq::int as seq, m.channel_id as "channelId", m.thread_root_id as "threadRootId",
       m.author_id as "authorId", m.body, m.kind, m.meta, m.created_at as "createdAt",
       m.edited_at as "editedAt", '[]'::json as reactions,
       -- 결과 카드가 사진·파일을 그릴 수 있게 첨부 요약을 싣는다(S1). 이 하위 질의는 **아래 where 를
       -- 통과한 행**(볼 수 있고 지워지지 않은 메시지)에만 붙으므로 못 보는 메시지의 첨부를 끌어오지
       -- 않는다(security S1 ③). 모양은 목록 응답과 같은 ATTACHMENTS 한 곳에서 온다.
       ${ATTACHMENTS.replace(/message\./g, 'm.')},
       null::int as "replyCount", null::int as "activityCount",
  null::text as "lastReplyAt", null::text[] as "participantIds",
       m.also_in_channel as "alsoInChannel"
     from message m
     join channel c on c.id = m.channel_id
     where ${SEARCH_MATCH} and m.deleted_at is null
       -- 진행 줄(progress)·대기 줄(wake)은 사람이 찾는 **말**이 아니다. 답글 수에서
       -- 뺀 것과 **같은 목록**이다(shared::countsAsReply) — 종류가 늘면 두 자리를 같이 고친다.
       -- 여기 없으면 에이전트 진행 줄이 본문 결과를 밀어낸다(상위 N 건에서 잘리므로
       -- 정작 찾던 말이 응답에 애초에 안 들어온다).
       and m.kind not in ('progress', 'wake')
       -- 검색은 채널 목록을 우회해 본문에 바로 닿는 표면이다. 여기만 넓으면 목록에도
       -- 배지에도 없는 private 채널의 발언이 검색 결과로 통째로 나온다 — 그래서 목록·배지와
       -- **같은 술어**를 쓴다. admin 예외 없다(결과가 곧 메시지 본문이다).
       and ${channelVisibleSql('c', '$3')}
       -- 스코프는 가시성 **위에** 얹는 별개 조건이다. null 이면 절이 상수로 접혀 전역 검색의
       -- 계획이 그대로 남는다 — 기존 동작을 건드리지 않는다.
       and ($4::uuid is null or m.channel_id = $4)
       -- 스레드 스코프는 루트 자신을 포함한다 — 루트에 있는 말을 못 찾으면 "이 스레드에서
       -- 찾기"가 아니다(listMessages 의 스레드 분기와 같은 문장).
       and ($5::uuid is null or m.id = $5 or m.thread_root_id = $5)
       -- 거르기(S1)도 같은 자리다: 가시성·스코프 **위에** 얹는 and 뿐이라 결과를 좁히기만 한다
       -- (security S1 ①). null 이면 상수로 접혀 계획이 그대로 남는다.
       and ($7::uuid[] is null or m.author_id = any($7::uuid[]))
       and ($8::timestamptz is null or m.created_at >= $8::timestamptz)
       and ($9::timestamptz is null or m.created_at < $9::timestamptz)
       and ($10::boolean is not true or exists (select 1 from attachment a where a.message_id = m.id))
     -- 정확 일치(1번)를 부분문자열-only 히트 앞에 세우고, 그 안에서 ts_rank, 그다음 최신순.
     -- seq desc 만 있던 때는 흔한 낱말이면 상위 50 이 전부 최근 것으로 차서 정작 찾던
     -- 옛 메시지가 응답에 들어오지도 않았다.
     --
     -- 페이지는 offset 이다(seq 커서가 아니다): 순서가 seq 가 아니라 rank 이므로 seq 커서는
     -- 이 정렬에서 뜻이 없다.
     order by ${order}
     limit $2 offset $6`,
    [
      query, limit + 1, requesterId, scope.channelId ?? null, scope.threadRootId ?? null, offset,
      authorIds, scope.after ?? null, scope.before ?? null, scope.hasAttachment ?? null,
    ],
  );
  const rows = res.rows as MessageRow[];
  return { messages: rows.slice(0, limit), hasMore: searchHasMore(rows.length, limit, offset) };
}
