//! S5.3 C1c-1 — 글 올리기 `POST /channels/{id}/messages` 의 **뼈대**: 사람이 앱(세션)으로 쓴 최상위 글 중 부수효과가 없는 것만
//! Rust 가 올린다. TS `routes/messageRoutes.ts` 의 같은 줄과 `services/messages.ts::postMessage` 의 그 갈래를 옮긴다.
//!
//! - **맡는 글**(나머지는 읽어 둔 본문 바이트 그대로 TS 로 넘긴다 — [`to_ts`]): 작성자가 사람이고 세션으로 섰다 ·
//!   `agentModels` 키가 없다 · DM 이 아니다 · 본문에 URL 후보가 없다(링크 미리보기는 TS 가 외부로 가져온다) · 글 승인 넓은 체
//!   (`CHAT_APPROVAL_GUARD_WORDS`, 메시지 링크 포함)에 안 걸린다. 그러면 TS 쪽 부수효과 중 스레드 답글 알림·깨움 선점·위임 닫기·
//!   DM 알림·글 승인·카드 닫기·링크 미리보기·모델 지정은 저절로 꺼진다.
//! - **부름**(C1c-2a): 멘션 해석([`super::mention_calls::resolve`])을 TS 처럼 트랜잭션 안 seq 락 **앞**에서 하고, 부름 meta 와
//!   고친 본문으로 넣은 뒤 [`super::mention_fanout::fan_out_calls`] 로 inbox·푸시 줄을 넣는다. 새 머리의 위임은
//!   [`super::mandate_stamp::stamp_root`]. 받은 사람마다 `inbox.updated`, 응답 헤더에 받은 사람 수·id(TS 와 같은 순서).
//! - **답글**(C1c-3a): 트랜잭션 첫 줄에서 머리가 이 채널의 최상위 글인지(아니면 400 `bad_thread`), seq 락 뒤에서 이 스레드가
//!   아직 TS 몫인지([`TS_THREAD_SQL`] — 카드 답으로 읽힐 글이면 되돌리고 TS 로) 본다. 맡으면 머리·
//!   `alsoInChannel` 을 넣고, 부름 뒤 머리의 위임을 잇고([`super::mandate_stamp::stamp_reply`]), 머리 주인에게 호출 게이트를 지난
//!   `thread_reply` 를 넣는다(TS 와 같이 위임 판정 **뒤**).
//! - **깨움 선점**(C1c-3b): 그 뒤 이 스레드의 남의 열린 깨움을 접거나(이 글이 부른 계정) 지금 깨운다([`super::wake_preempt`]).
//!   신호(`inbox.updated`·`thread.reportWakes.changed`·대기 줄 `message.updated`)는 TS 처럼 `message.created` 앞에 outbox 로.
//! - **에이전트 글**(C1c-4a): PAT·오퍼레이터로 선 에이전트의 REST 글도 맡는다(원인·턴 id 가 없는 판). 회신권 「결과 한 번」 락
//!   (`REPLY_LOCK_CLASS`)을 채널 락 앞에 잡고, 부름이 실제로 간 에이전트에게 회신권을 열고(`openReplyGrants`) 답글이면 받은
//!   회신권을 닫는다(`closeReplyGrants`). 위임 키·깨움 선점·카드 닫기는 TS 와 같이 사람 글에만. 아직 TS 로 넘기는 것:
//!   암묵 위임 쓰기 권한이 빠진 서버의 부름. 스위치 값이 없으면 TS 기본값으로 맡고, 암묵 위임은 [`implicit_delegation`] 이 적는다(C1c-4d).
//! - **사슬 깊이·정체 홉·사슬 시작은 적지 않는다**(O2): 홉 수·사슬 나이로 부름을 막지 않게 된 뒤로(O1) 읽는 곳이 없다.
//!   `message.mention_depth`·`stall_depth`·`chain_started_at` 은 기본값으로 남는다.
//! - 순서(TS 와 같다): 본문 읽기(413·400·415) → 인증(401, `route_layer`) → 경로·본문 검사(400) → 쓰기 게이트(403 `forbidden`·
//!   `channel_archived`) → **쓰기 트랜잭션 하나**: seq 락(TS `lockChannelForSeq`) → 재시도 키 재생(200, 헤더 없음) → insert →
//!   첨부 잇기(실패면 되돌리고 400 `bad_attachment`) → 다시 읽기 → 재시도 키 기록 → 부름 넣기 → 위임 → `message.created`·
//!   `inbox.updated` 를 outbox 에 → 커밋 → (새 위임이면) `mandate.created` 감사 → 201.
//! - **어느 단계든 `Err` 면 트랜잭션을 버리고 500** — 글도 첨부도 남지 않는다.
//! - 문장은 전부 TS 상수를 골든으로 받는다(`post_*`·`attach_*`·`channel_post_gate`·`url_candidate_source`·
//!   `chat_approval_guard_words`). 쓰기 권한은 [`MESSAGE_POST_PRIVILEGES`] — 하나라도 없으면 `main.rs` 가 이 줄을 붙이지 않는다.
use super::ask_reply_close;
use super::audience::audience_for;
use super::cause_link;
use super::delegate_write;
use super::implicit_delegation;
use super::invoke_gate;
use super::mandate_stamp;
use super::mention_calls::{self, Input};
use super::mention_fanout::{self, Post};
use super::msg_edit::{
    MAX_MESSAGE_BODY_CHARS, NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER, NOTIFIED_HEADER_MAX_IDS,
};
use super::msg_list::read_list_row;
use super::msg_read::{is_uuid, message_by_id};
use super::turn_settle;
use super::wake_preempt;
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err};
use crate::proxy::Upstream;
use crate::write::BODY_LIMIT;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

/// 이 줄이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 첨부는 잇는 칸만(칸 권한 — `for update` 도 이것으로 된다).
pub const MESSAGE_POST_PRIVILEGES: &[(&str, &str)] = &[
    // 링크 미리보기 가져오기(REST 글의 URL 후보 — [`super::link_preview_fetch::LINK_PREVIEW_WRITE_PRIVILEGES`] 와 같은 칸).
    ("link_preview.url", "SELECT"),
    ("link_preview.status", "SELECT"),
    ("link_preview.fetched_at", "SELECT"),
    ("link_preview.url", "INSERT"),
    ("link_preview.title", "INSERT"),
    ("link_preview.description", "INSERT"),
    ("link_preview.image_url", "INSERT"),
    ("link_preview.site_name", "INSERT"),
    ("link_preview.status", "INSERT"),
    ("link_preview.fetched_at", "INSERT"),
    ("link_preview.title", "UPDATE"),
    ("link_preview.description", "UPDATE"),
    ("link_preview.image_url", "UPDATE"),
    ("link_preview.site_name", "UPDATE"),
    ("link_preview.status", "UPDATE"),
    ("link_preview.fetched_at", "UPDATE"),
    ("message", "INSERT"),
    ("idempotency_key", "INSERT"),
    ("attachment.message_id", "UPDATE"),
    ("attachment.attached_at", "UPDATE"),
    ("event_outbox", "INSERT"),
    // C1c-2a 부름 — inbox·푸시 줄·숨긴 채널 되살리기(`mention_fanout`), 새 머리 위임(`mandate_stamp`)과 그 감사.
    ("inbox", "INSERT"),
    ("push_job", "INSERT"),
    ("channel_pref.hidden_at", "UPDATE"),
    ("mandate", "INSERT"),
    ("mandate.last_activity_at", "UPDATE"),
    ("message.mandate_id", "UPDATE"),
    ("audit_log", "INSERT"),
    // C1c-3b 깨움 선점(`wake_preempt`) — 접기·깨우기와 대기 줄 meta 의 닫힌 시각.
    ("agent_wake.fired_at", "UPDATE"),
    ("agent_wake.canceled_at", "UPDATE"),
    ("agent_wake.canceled_by_message_id", "UPDATE"),
    ("message.meta", "UPDATE"),
    // C1c-3d 담당 사람 글의 위임 활동 — 기한 밀기(`touchDelegationDeadline`)와 v1 대기 중 update.
    ("team_delegation.deadline_at", "UPDATE"),
    ("team_delegation_item.last_activity_at", "UPDATE"),
    ("team_delegation_item.update_pending_message_id", "UPDATE"),
    ("team_delegation_item.update_pending_at", "UPDATE"),
    // C1c-4a 에이전트 글의 회신권(`openReplyGrants`·`closeReplyGrants`) — 열기는 insert … on conflict do update, 닫기는 닫힌 시각.
    ("invoke_reply_grant", "INSERT"),
    ("invoke_reply_grant.opened_at", "UPDATE"),
    ("invoke_reply_grant.expires_at", "UPDATE"),
    ("invoke_reply_grant.closed_at", "UPDATE"),
];
/// MCP `message.post`(C1c-4c)가 [`MESSAGE_POST_PRIVILEGES`] 위에 더 쓰는 권한 — principal 옮겨 적기(위임 키 `message.mandate_id` 는
/// 이미 위에 있다). 따로 두는 까닭: 이것이 빠져도 REST 글 줄은 그대로 Rust 가 맡고, MCP 글만 TS 에 남는다.
pub const MCP_POST_EXTRA_PRIVILEGES: &[(&str, &str)] = &[
    ("message.principal_account_id", "UPDATE"),
    ("message.principal_cause_reasons", "UPDATE"),
    // C3b-2c-2 결과 글(fail·report)이 담당 의무를 닫고 위임자를 깨운다(`closeDelegationsForReply` 닫기 갈래 · `notifyIfSettled`).
    // 없으면 MCP 글·실패가 통째로 TS 에 남는다(fail-closed). 미결 meta·inbox·예약 접기 칸은 위 묶음에 이미 있다.
    ("team_delegation_item.outcome", "UPDATE"),
    ("team_delegation_item.closed_by_message_id", "UPDATE"),
    ("team_delegation_item.closed_at", "UPDATE"),
    ("team_delegation.notified_at", "UPDATE"),
];
pub const MESSAGE_POST_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `postMessage` 의 principal 옮겨 적기(152·153) — 다음 에이전트의 임대가 이것을 이어받는다. 판정에는 아직 쓰지 않는다.
/// 문장이 TS 와 같은지는 대조 시험이 행으로 본다(TS 는 인라인 문장이다).
/// TS `planAutoStamp` 의 도장.
const PLAN_AUTO_STAMP_SQL: &str =
    "update message set mandate_id = $2::uuid, principal_account_id = $3::uuid where id = $1::uuid";
const SET_PRINCIPAL_SQL: &str = "update message set principal_account_id = $2::uuid, principal_cause_reasons = $3 where id = $1::uuid";

/// TS `DELEGATION_SILENCE_SEC` — 담당 글 하나가 기한을 이만큼 뒤로 민다.
const DELEGATION_SILENCE_SEC: i32 = 10 * 60;

/// TS `REPLY_GRANT_TTL_SEC` — 결과를 끝내 안 낸 회신권이 닫히는 때(깨움·위임 상한 6h 와 같다).
const REPLY_GRANT_TTL_SEC: i32 = 6 * 60 * 60;

/// zod `attachmentIds.max(10)`.
const MAX_ATTACHMENTS: usize = 10;

#[derive(Clone)]
pub struct PostState {
    pub read: PgPool,
    pub write: PgPool,
    pub up: Upstream,
    /// 쓰기 풀에 암묵 위임 칸([`implicit_delegation::IMPLICIT_DELEGATION_PRIVILEGES`])이 있는가(C1c-4d). 없으면 암묵 위임을 적을
    /// 수 있는(모드가 꺼짐이 아닌) 에이전트 부름만 TS 로 넘긴다.
    pub implicit_ok: bool,
}

struct Sql {
    gate: String,
    channel_kind: String,
    dm_peers: String,
    lock: String,
    lock_class: i32,
    dup: String,
    insert: String,
    idem_insert: String,
    attach_update: String,
    url: regex::Regex,
    guard_words: Vec<String>,
    root_of: String,
    root_author: String,
    deleg_touch: String,
    deleg_pending: String,
    close_open: String,
    close_item_v0: String,
    close_item_v2: String,
    reply_open: String,
    reply_close: String,
    reply_lock_class: i32,
    set_mandate: String,
}

/// C1c-3a 갈래 판정(TS 동작이 아니라 **어느 쪽이 맡을지**) — 이 스레드에 답하면 TS 가 아직 Rust 에 없는 부수효과를 내는가.
/// 하나라도 참이면 트랜잭션을 버리고 TS 로 넘긴다. 조건은 그 부수효과의 문장보다 넓게(같거나 더 많이 걸리게) 잡는다:
/// (담당의 글은 Rust 가 맡는다 — 위임 스위치 값이 없으면 TS 기본값 v0 으로. [`delegation_v2_on`])
/// (지워진 머리는 C1c-3d 부터 Rust 가 `rootBack` 까지 맡는다.) 열린 선택 카드인데 글이 **카드 답으로 읽힐 수 있음**(`$2` 가 거짓 — TS `applyChatApproval` 의 글로 고르기, 받는 쪽·종류와
/// 무관하게 카드 전부). 에이전트 글은 `$2` 가 참이다 — TS 라우트가 카드 고르기·접기를 사람 글에만 한다. 글이 물음뿐이면([`question_only`]) 고르기가 될 수 없어 Rust 가 맡고 카드를 `replied` 로 닫는다(C1c-3c).
/// 쓰기 트랜잭션 안 seq 락 뒤에서 읽는다 — TS 가 같은 판정을 하는 때와 같은 창이다.
const TS_THREAD_SQL: &str = "select not $2::bool and exists(select 1 from message where (id = $1::uuid or thread_root_id = $1::uuid) \
                and deleted_at is null and meta->>'kind' = 'ask' \
                and meta->'ask'->>'answeredWith' is null and meta->'ask'->>'closedAt' is null)";

/// 이 글이 TS `parseAskPick` 에서 **반드시 null** 인가(카드 답이 될 수 없는가) — 넓게 TS 로 보내는 쪽으로만 틀린다.
/// TS 는 코드·인용 줄·링크·멘션을 걷어 낸 나머지에 `?`·`？` 가 있으면 null(`QUESTION`)이다. 여기서는 걷어 낼 거리(백틱·`>` 인용 줄)가
/// 하나라도 있으면 거짓으로 두고, 없을 때 본문에 물음표가 있으면 참이다. URL·메시지 링크 글은 이미 [`ts_body`] 로 TS 에 간다.
/// 멘션 토큰(`<@uuid>`)에는 물음표가 들 수 없다.
fn question_only(body: &str) -> bool {
    // JS `^` 는 m 플래그에서 \n·\r·U+2028·U+2029 뒤 모두에서 줄을 시작한다 — 같은 경계로 자른다.
    let quoted = body
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|l| l.trim_start_matches([' ', '\t']).starts_with('>'));
    // TS 는 링크를 걷어 낸 뒤 본다 — URL(쿼리의 `?`)이 있으면 판정하지 않는다(TS 로 넓게).
    if body.contains('`') || quoted || sql().url.is_match(body) {
        return false;
    }
    body.contains('?') || body.contains('？')
}

/// 글을 TS 로 넘기는 갈래를 한 줄 남긴다 — 앞단은 요청을 하나하나 기록하지 않아서, 이 줄이 없으면 어느 갈래로 넘어갔는지 운영에서
/// 가를 수 없다. 본문·헤더 값은 싣지 않는다(작성자·스레드 id 만).
fn ts_reason(reason: &str, author: &str, root: Option<&str>) {
    eprintln!(
        "front: post to TS reason={reason} author={author} thread={}",
        root.unwrap_or("-")
    );
}

/// TS `delegationV2Enabled`(`HARKROOM_DELEGATION_V2`)을 Rust 가 읽는 법 — **값이 없으면 모른다**(`None`).
/// TS 는 없으면 꺼짐(v0)으로 보지만, 앞단 컨테이너에 이 변수가 빠진 채 TS 만 켜져 있으면 두 서버가 다르게 군다. 그래서 Rust 는
/// 값이 있을 때만 위임 갈래를 맡고(`1`·`on`·`true` → v1, 그 밖의 값 → v0 — TS 와 같은 낱말), 없으면 TS 로 넘긴다(인박스·MCP 등).
/// 글 쓰기는 [`delegation_v2_on`] 을 쓴다.
/// TS 와 같이 부를 때마다 읽는다.
pub(crate) fn delegation_v2(raw: Option<&str>) -> Option<bool> {
    let v = raw?.trim().to_lowercase();
    if v.is_empty() {
        return None;
    }
    Some(matches!(v.as_str(), "1" | "on" | "true"))
}

/// 글 쓰기가 쓰는 위임 스위치 — 값이 없거나 비면 TS `delegationV2Enabled` 의 기본값(꺼짐)이다. [`delegation_v2`] 의 「모름」을
/// TS 로 넘기는 대신 TS 가 골랐을 값으로 맡는다.
pub(crate) fn delegation_v2_on(raw: Option<&str>) -> bool {
    delegation_v2(raw).unwrap_or(false)
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            gate: frag("channel_post_gate"),
            channel_kind: format!("select k.kind from ({}) k", frag("post_channel_kind")),
            dm_peers: format!(
                "select p.account_id::text from ({}) p",
                frag("post_dm_peers")
            ),
            lock: frag("post_seq_lock"),
            lock_class: frag("post_seq_lock_class").parse().expect("seq lock class"),
            dup: format!(
                "select d.message_id::text from ({}) d",
                frag("post_idempotency_find")
            ),
            insert: format!(
                "with ins as ({}) select ins.id::text from ins",
                frag("post_insert")
            ),
            idem_insert: frag("post_idempotency_insert"),
            attach_update: frag("attach_update"),
            url: regex::Regex::new(&frag("url_candidate_source")).expect("url candidate regex"),
            guard_words: serde_json::from_str(&frag("chat_approval_guard_words"))
                .expect("chat_approval_guard_words"),
            root_of: frag("post_thread_root_of"),
            deleg_touch: frag("delegation_touch_deadline"),
            deleg_pending: frag("delegation_v2_update_pending"),
            close_open: frag("close_reply_open"),
            close_item_v0: frag("close_reply_item_v0"),
            close_item_v2: frag("close_reply_item_v2"),
            reply_open: frag("reply_grant_open"),
            reply_close: frag("reply_grant_close"),
            set_mandate: frag("message_set_mandate"),
            reply_lock_class: frag("reply_grant_lock_class")
                .parse()
                .expect("reply grant lock class"),
            root_author: format!(
                "select r.author_id::text, r.deleted_at is not null from ({}) r",
                frag("post_root_author")
            ),
        }
    })
}

/// `attach_find` 는 `for update` 라 서브쿼리로 감싸지 않고 `with` 로 받는다(잠금은 그 안에서 걸린다) — 칸은 text 로 읽는다.
fn attach_find_raw() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        format!(
            "with f as ({}) select f.id::text, f.uploader_id::text, f.message_id::text from f",
            v["attach_find"]
                .as_str()
                .expect("golden fragment attach_find")
        )
    })
}

/// JS `String.prototype.trim` 이 걷는 글자(WhiteSpace + LineTerminator). Rust `char::is_whitespace` 와 다르다(U+0085 를 걷고 U+FEFF 를 남긴다).
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// zod 가 받는 본문.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PostBody {
    pub(crate) body: String,
    pub(crate) attachment_ids: Vec<String>,
    pub(crate) thread_root: Option<String>,
    /// TS 와 같이 머리가 없으면 false 로 정규화한다.
    pub(crate) also_in_channel: bool,
}

/// 글의 **원인 입력**(C1c-4c) — MCP 발화만 싣는다. REST 글은 비어 있다(`Origin::default()`).
#[derive(Debug, Default)]
pub(crate) struct Origin<'a> {
    /// TS `chainCause` — 사슬 고리·principal·위임에 쓰는 원인(오퍼레이터를 거친 요청의 헤더만).
    pub(crate) chain_cause: Option<&'a str>,
    /// TS `turnId` — 에이전트 글의 `meta.turnId`(오퍼레이터를 거친 요청의 헤더만).
    pub(crate) turn_id: Option<&'a str>,
    /// TS 입력 `meta` — MCP 는 모델 신고(`reportedModelMeta`)만 싣는다. 부름 meta 가 그 위에 얹힌다.
    pub(crate) meta: serde_json::Map<String, Value>,
    /// TS `serverNotice` — 서버가 에이전트 이름으로 세운 알림 줄(백스톱 카드, C1c-4d-2). 결과가 아니다: 회신권·위임 의무·암묵 위임을
    /// 건드리지 않고, 갈래 판정(TS 몫)도 하지 않는다(서버 안쪽 호출이라 넘길 TS 라우트가 없다). 라우트 입력에서는 켜지 않는다.
    pub(crate) server_notice: bool,
    /// 결과를 닫는 글(`meta.kind` 가 `failure`·`report`, C3b-2c). 작성자가 담당인 **안 닫힌** 위임 항목이 이 스레드에 있으면 TS
    /// `closeDelegationsForReply` 가 그 항목을 닫고 위임자를 깨운다.
    pub(crate) closes_delegation: bool,
    /// MCP `message.delegate`(C3b-2c-4b) — 게이트를 지난 위임. 있으면 같은 tx 에서
    /// 의무를 만든다(TS `createDelegation`, [`delegate_write`]). 위임 스위치 값이 없으면 v0 이다.
    pub(crate) delegation: Option<delegate_write::Plan<'a>>,
    /// TS `kind: 'system'`(S5.4 CH4b-2) — 서버가 사실을 남기는 줄(멤버 넣기·빼기). 라우트 입력에서는 켜지 않는다. TS `postMessage` 와 같이
    /// `kind` 칸이 `system` 이고 `meta`(`i18n` 포함)를 그대로 싣는다. 결과로는 센다(`countsAsReply`). 위임 키(`stampHumanMandate` 는
    /// `kind === 'user'` 만)와 암묵 위임(`kind !== 'system'`)은 하지 않는다. 스레드 안(머리 아래)에도 쓴다(S5.4 TM2) — 머리·DM 갈래
    /// (`isSystemLine`, S5.4 A1)는 머리 주인·DM 상대가 에이전트면 알리지 않고(그 턴을 깨우지 않는다) 사람 글이어도 선점·카드 닫기를 하지 않는다.
    /// 카드 답 판정([`TS_THREAD_SQL`] 의 ask 갈래)도 하지 않는다 — TS `closeAsksByReply` 는 라우트 몫이라 시스템 줄은 닿지 않는다.
    pub(crate) system: bool,
    /// TS `noMentions`(S5.4 TM2) — 부르지 않는 줄. 본문은 그대로 두고 부름 판정을 건너뛴다(TS `noMentionCalls`: 부름·`meta` 없음).
    /// 머리 주인 `thread_reply`·DM 갈래는 그대로다(부름이 아니다). 라우트 입력에서는 켜지 않는다.
    pub(crate) no_mentions: bool,
    /// TS `kind: 'progress'`(S5.4 A1, MCP `message.progress`) — 진행 한 줄. **결과가 아니다**(`countsAsReply` 거짓): 회신권 락·회신권
    /// 스레드·TS 몫 스레드 판정·회신권 닫기·암묵 위임·백스톱 카드·위임 닫기를 하지 않는다. 답글이 아니라 머리 주인(`thread_reply`)·
    /// DM 상대(`dm`)에게 알리지 않고 지워진 머리를 되돌리지 않는다. 부름(`mention`)은 그대로 닿는다. 위임 기한은 민다(살아 있다는 신호).
    pub(crate) progress: bool,
    /// TS `kind: 'wake'`(S5.4 A3, MCP `turn.wake`) — 대기 줄. `progress` 와 같이 **결과가 아니다**(`countsAsReply` 거짓) — 그 밖의 갈래도
    /// `progress` 와 같고 `kind` 칸 글자만 다르다(TS `postMessage` 가 두 종류를 `countsAsReply` 하나로만 가른다).
    pub(crate) wake: bool,
    /// TS `beforeCommit` — 글을 넣고 위임을 닫은 뒤, 커밋 **앞** 같은 tx 에서 부른다. 거절하면 롤백하고 [`Outcome::Rejected`].
    /// 지나면 행을 다시 읽어 내보낸다(이 훅이 글에 딸린 행을 더 쓸 수 있다 — TS 의 `reread`). 없으면 아무것도 바뀌지 않는다.
    pub(crate) before_commit: Option<&'a dyn BeforeCommit>,
    /// 서버 안쪽에서 TS 서비스 `postMessage` 를 바로 부른 사람 글(S5.4 TP5c, `plan/start`) — 라우트를 거치지 않으니 TS 라우트 몫인
    /// 카드 고르기(`applyChatApproval`)·카드 닫기(`closeAsksByReply`)가 없다. 그래서 카드 갈래 TS 몫 판정과 [`ask_reply_close`] 를 끈다.
    /// 서비스 몫(부름·`thread_reply`·깨움 선점·위임 기한·위임 키)은 그대로다. 라우트 입력에서는 켜지 않는다.
    pub(crate) service_call: bool,
    /// P3b-2 — 받은 사람의 `inbox.updated` 를 커밋 tx 에서 내지 않는다. 호출자가 글 승인 판정 **뒤에** 낸다
    /// (TS 라우트는 `applyChatApproval` 뒤에 낸다 — security n2: 같은 스레드의 `thread_reply` 턴이 뜰 때 grant 가 이미 있게).
    pub(crate) defer_inbox_events: bool,
    /// P3c — 사람 세션 REST 글이고 글 승인 입구가 켜졌다: 선택 카드 글 답(TS `answerAskFromMessage`)을 Rust 가 커밋 뒤에 한다.
    /// [`TS_THREAD_SQL`] 의 ask 갈래를 끈다(TS `parseAskPick` 과 같은 판정을 Rust 가 하므로 넓게 넘길 까닭이 없다).
    pub(crate) chat_ask_rust: bool,
    /// TS `planAutoStamp`(계획판 자동 진행 깨움) — 서버만 찍는다. `system` 글에만 위임 키(`mandate_id`)와 principal 을 같은 tx 에서
    /// 적는다(그 사람이 직접 부른 턴과 같은 키를 잇는다). `(mandate, principal)`. 라우트 입력에서는 켜지 않는다.
    pub(crate) plan_auto_stamp: Option<(Option<&'a str>, &'a str)>,
    /// P3c — 이 글이 카드 답이 될 수 있다(`parseAskPick` 이 Some). tx 안 [`ask_reply_close::close_by_reply`] 를 건너뛴다 —
    /// 부르는 쪽이 커밋 뒤 TS 라우트 순서(카드 답 → `inbox.updated` → `closeAsksByReply`)로 닫는다. 먼저 닫으면 카드가 `replied` 가 돼 답이 안 된다.
    pub(crate) close_asks_after_commit: bool,
}

/// TS `beforeCommit` 의 거절 — `{ status, code, message }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub(crate) status: u16,
    pub(crate) code: String,
    pub(crate) message: String,
}

/// 훅이 돌려주는 future.
pub(crate) type BeforeCommitFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Option<Rejection>, sqlx::Error>> + Send + 'a>,
>;

/// TS `postMessage` 의 `beforeCommit(client, { message, notified })` — 여기서는 tx 와 새 글 id 를 받는다.
pub(crate) trait BeforeCommit: std::fmt::Debug + Sync {
    fn run<'a>(
        &'a self,
        tx: &'a mut sqlx::Transaction<'static, sqlx::Postgres>,
        message_id: &'a str,
        notified: &'a HashSet<String>,
    ) -> BeforeCommitFuture<'a>;
}

/// zod 스키마 + refine. `agentModels` 는 [`super::msg_post_models::parse`] 가 따로 본다. `threadRootId` 는 uuid 글자만(null 포함 그 밖은 400 —
/// TS `z.string().uuid().optional()`).
fn parse_post(v: &Value) -> Option<PostBody> {
    let Value::Object(o) = v else { return None };
    let Some(Value::String(body)) = o.get("body") else {
        return None;
    };
    if body.encode_utf16().count() > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let attachment_ids: Vec<String> = match o.get("attachmentIds") {
        None => vec![],
        Some(Value::Array(a)) if a.len() <= MAX_ATTACHMENTS => {
            let mut ids = vec![];
            for x in a {
                match x {
                    Value::String(s) if is_uuid(s) => ids.push(s.clone()),
                    _ => return None,
                }
            }
            ids
        }
        _ => return None,
    };
    let also = match o.get("alsoInChannel") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return None,
    };
    let thread_root = match o.get("threadRootId") {
        None => None,
        Some(Value::String(r)) if is_uuid(r) => Some(r.clone()),
        Some(_) => return None,
    };
    if body.trim_matches(js_ws).is_empty() && attachment_ids.is_empty() {
        return None;
    }
    Some(PostBody {
        body: body.clone(),
        attachment_ids,
        also_in_channel: also && thread_root.is_some(),
        thread_root,
    })
}

/// TS `channelPostGate` 문장(`$1` 채널, `$2` 작성자 → `(멤버인가, 보관인가)`, 없는 채널은 줄 없음) — 예약 sweep 도 같은 술어를 쓴다.
pub(crate) fn gate_sql() -> &'static str {
    sql().gate.as_str()
}

/// 본문만 보고 TS 몫인가 — URL 후보(링크 미리보기)나 글 승인 넓은 체.
pub(crate) fn ts_body(body: &str) -> bool {
    sql().url.is_match(body) || ts_guard(body)
}

/// 글 승인 넓은 체만(REST 글 — URL 후보는 Rust 가 미리보기를 건다).
fn ts_guard(body: &str) -> bool {
    let s = sql();
    let low = body.to_lowercase();
    s.guard_words.iter().any(|w| low.contains(w.as_str()))
}

/// shared `trimTrailingPunctuation`.
fn trim_trailing_punctuation(token: &str) -> &str {
    let mut t = token;
    while let Some(ch) = t.chars().last() {
        if ".,;:!?'\"".contains(ch) {
            t = &t[..t.len() - ch.len_utf8()];
            continue;
        }
        if ch == ')' || ch == ']' {
            let open = if ch == ')' { '(' } else { '[' };
            if t.matches(open).count() <= t.matches(ch).count() {
                t = &t[..t.len() - 1];
                continue;
            }
        }
        break;
    }
    t
}

/// shared `extractPreviewUrls` — 정규화된 URL, 겹침 없이 최대 `max` 개.
pub(crate) fn extract_preview_urls(body: &str, max: usize) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for m in sql().url.find_iter(body) {
        let token = trim_trailing_punctuation(m.as_str());
        if token.is_empty() {
            continue;
        }
        let Some(n) = super::link_preview_read::normalize_preview_url(token) else {
            continue;
        };
        if out.contains(&n) {
            continue;
        }
        out.push(n);
        if out.len() >= max {
            break;
        }
    }
    out
}

fn bad() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid")
}

pub(crate) async fn to_ts(
    up: Upstream,
    peer: SocketAddr,
    parts: axum::http::request::Parts,
    bytes: axum::body::Bytes,
) -> Response {
    crate::proxy::forward(
        State(up),
        ConnectInfo(peer),
        Request::from_parts(parts, Body::from(bytes)),
    )
    .await
}

pub(crate) enum Outcome {
    Replayed(String),
    BadAttachment,
    /// 머리가 이 채널의 최상위 글이 아니다(TS `bad_thread`, 400).
    BadThread,
    /// 이 스레드는 TS 몫이다([`TS_THREAD_SQL`]) — 아무것도 쓰지 않았다.
    ToTs,
    /// [`Origin::before_commit`] 이 거절했다 — 롤백됐고 글은 없다(TS `failure: 'rejected'`).
    Rejected(Rejection),
    Posted {
        row: String,
        notified: Vec<String>,
        mandate: Option<mandate_stamp::Created>,
        /// [`Origin::delegation`] 으로 만든 위임 id.
        delegation_id: Option<String>,
    },
}

/// TS `resolveMentionCalls` 의 입력 — principal 없음(REST 에는 원인이 없다).
/// 회신권 스레드는 결과 발화면 머리다(REST 글은 언제나 `user` 라 결과다).
#[allow(clippy::too_many_arguments)]
async fn resolve_post(
    conn: &mut sqlx::PgConnection,
    channel: &str,
    author: &str,
    author_is_agent: bool,
    body: &str,
    thread_root: Option<&str>,
    now_ms: i64,
    principal: Option<&str>,
) -> Result<mention_calls::Resolved, sqlx::Error> {
    mention_calls::resolve(
        conn,
        &Input {
            body,
            channel_id: channel,
            author_id: author,
            author_is_agent,
            // TS 는 결과 발화면 사람 글에도 머리를 넘긴다(사람은 회신권 대상이 아니라 판정은 같다).
            reply_grant_thread_id: thread_root,
            principal: principal.map(|id| mention_calls::Principal { id }),
            now_ms,
            // 값이 없으면 TS 기본값(켬)이다.
            principal_invoke_enabled: mention_calls::principal_invoke_enabled(
                crate::env_once::get(&crate::env_once::PRINCIPAL_INVOKE),
            ),
        },
    )
    .await
    // A1 측정 — 호출 누락(새 글). 기록만.
    .inspect(|r| super::measure::calls_missed(author, channel, &r.missed))
}

/// TS `noMentionCalls` — 본문은 그대로, 부름·meta 는 없다.
fn no_mention_calls(body: &str) -> mention_calls::Resolved {
    mention_calls::Resolved {
        normalized_body: body.to_owned(),
        account_handles: HashSet::new(),
        called_ids: Vec::new(),
        denied_ids: HashSet::new(),
        team_plans: Vec::new(),
        target_call: Vec::new(),
        channel_called: false,
        call_meta: serde_json::Map::new(),
        missed: Vec::new(),
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 밀리초 시각을 ISO 8601(UTC, 밀리초)로 — TS 가 `Date` 를 넘기는 것과 같은 값을 `$11::timestamptz` 에 넣는다.
pub(crate) fn iso_ms(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant `civil_from_days`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// 글 하나를 올린다. 사슬 상한·백스톱 카드(TS `raiseChainBackstop`)는 없다(O1) — [`post_tx`] 를 그대로 부른다.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn post_in_tx(
    st: &PostState,
    channel: &str,
    author: &str,
    author_is_agent: bool,
    input: &PostBody,
    idempotency_key: Option<&str>,
    audience: &Value,
    is_dm: bool,
    origin: &Origin<'_>,
) -> Result<Outcome, sqlx::Error> {
    post_tx(
        st,
        channel,
        author,
        author_is_agent,
        input,
        idempotency_key,
        audience,
        is_dm,
        origin,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn post_tx(
    st: &PostState,
    channel: &str,
    author: &str,
    author_is_agent: bool,
    input: &PostBody,
    idempotency_key: Option<&str>,
    audience: &Value,
    is_dm: bool,
    origin: &Origin<'_>,
) -> Result<Outcome, sqlx::Error> {
    let s = sql();
    // TS `isReply = countsAsReply(kind)` — `progress`·`wake` 만 거짓.
    let is_reply = !(origin.progress || origin.wake);
    // TS `isResult` — 결과로 세는 에이전트 글(서버 알림 줄은 아니다).
    let is_result = is_reply && !origin.server_notice;
    let kind = match (origin.system, origin.progress, origin.wake) {
        (true, _, _) => "system",
        (false, true, _) => "progress",
        (false, false, true) => "wake",
        (false, false, false) => "user",
    };
    let (body, attachment_ids) = (input.body.as_str(), input.attachment_ids.as_slice());
    let root = input.thread_root.as_deref();
    let mut tx = st.write.begin().await?;
    // TS 와 같이 트랜잭션 첫 줄 — 같은 채널의 최상위 글만 머리가 된다(지워진 머리도 받는다).
    if let Some(r) = root {
        let ok = sqlx::query(s.root_of.as_str())
            .bind(r)
            .bind(channel)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        if !ok {
            tx.rollback().await?;
            return Ok(Outcome::BadThread);
        }
    }
    // TS 회신권 「결과 한 번」 락 — 같은 작성자·같은 스레드의 결과끼리 줄을 세운다(채널 락보다 언제나 앞).
    if let (true, true, Some(r)) = (author_is_agent, is_result, root) {
        sqlx::query("select pg_advisory_xact_lock($1, hashtext($2))")
            .bind(s.reply_lock_class)
            .bind(format!("{author}:{r}"))
            .execute(&mut *tx)
            .await?;
    }
    // 위임 스위치 — 값이 없으면 TS 기본값(꺼짐, v0)으로 글을 맡는다([`delegation_v2_on`]). 모른다고 TS 로 넘기지 않는다.
    let v2 = delegation_v2_on(crate::env_once::get(&crate::env_once::DELEGATION_V2));
    // TS 와 같이 멘션 해석은 seq 락 **앞**이다(그 읽기는 seq 순서와 무관하고, 락 안에서 하면 줄 선 트랜잭션이 커넥션을 쥔다).
    // principal(152) — 이 원인으로 받은 살아 있는 임대에서만 읽는다. 판정(부름)과 아래 옮겨 적기가 같은 값을 쓴다.
    let principal = match (author_is_agent, origin.chain_cause) {
        (true, Some(c)) => {
            match cause_link::principal_for_agent_post(&mut tx, author, c, now_ms(), iso_ms).await?
            {
                Some(p) => {
                    let reasons = cause_link::cause_reasons(&mut tx, author, c).await?;
                    Some((p, reasons))
                }
                None => None,
            }
        }
        _ => None,
    };
    let calls = if origin.no_mentions {
        no_mention_calls(body)
    } else {
        resolve_post(
            &mut tx,
            channel,
            author,
            author_is_agent,
            body,
            // TS `replyGrantThreadId: isResult ? threadRootId : null`.
            root.filter(|_| is_result),
            now_ms(),
            principal.as_ref().map(|(p, _)| p.as_str()),
        )
        .await?
    };
    // 암묵 위임(C1c-4d) 모드 — 값이 없으면 TS 기본값(v2 꺼짐이면 off, 켜짐이면 shadow)이다. 쓰기 칸이 있을 때만 여기서 적는다
    // (꺼짐이면 적을 것이 없다).
    let implicit = implicit_delegation::mode_or_default(
        v2,
        crate::env_once::get(&crate::env_once::DELEGATION_IMPLICIT),
    );
    if author_is_agent
        && is_result
        && !origin.system
        && !calls.called_ids.is_empty()
        && implicit != implicit_delegation::Mode::Off
        && !st.implicit_ok
    {
        // 암묵 위임 쓰기 권한이 빠진 서버 — 이 갈래만 남긴다(권한이 빠진 기능의 처리는 따로 정한다).
        tx.rollback().await?;
        ts_reason("implicit_privileges_missing", author, root);
        return Ok(Outcome::ToTs);
    }
    sqlx::query(s.lock.as_str())
        .bind(s.lock_class)
        .bind(channel)
        .execute(&mut *tx)
        .await?;
    // 서버 알림 줄은 라우트를 거치지 않는다(TS `raiseChainBackstop` 이 `postMessage` 를 바로 부른다) — 글로 카드 고르기·위임 닫기가 없다.
    if let (true, Some(r)) = (is_result, root) {
        let ts: bool = sqlx::query_scalar(TS_THREAD_SQL)
            .bind(r)
            // 시스템 줄은 카드 답이 되지 않는다(TS `closeAsksByReply` 는 라우트 몫) — ask 갈래를 끈다.
            // 에이전트 글도 그렇다 — TS 라우트는 카드 고르기(`applyChatApproval`)·카드 접기(`closeAsksByReply`)를 사람 글에만 하고,
            // MCP 도구는 서비스 `postMessage` 를 바로 부른다. 넘겨도 TS 가 할 카드 일이 없으니 Rust 가 맡는다.
            .bind(
                author_is_agent
                    || origin.system
                    || origin.service_call
                    || origin.chat_ask_rust
                    || question_only(body),
            )
            .fetch_one(&mut *tx)
            .await?;
        if ts {
            tx.rollback().await?;
            ts_reason("thread_open_ask", author, root);
            return Ok(Outcome::ToTs);
        }
    }
    if let Some(key) = idempotency_key {
        let dup: Option<String> = sqlx::query_scalar(s.dup.as_str())
            .bind(key)
            .bind(author)
            .bind(channel)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(id) = dup {
            let row = message_by_id(&mut *tx, &id).await?;
            tx.commit().await?;
            return Ok(match row {
                Some(r) => Outcome::Replayed(r),
                // TS 는 `existing.rows[0]`(undefined)을 그대로 보낸다 — 지울 수 없는 행이라 닿지 않는 갈래다.
                None => Outcome::Replayed("null".into()),
            });
        }
    }
    // TS `{...input.meta, ...calls.callMeta, turnId?}` — 입력 meta(모델 신고) 위에 부름 meta 가 얹힌다.
    let mut meta = origin.meta.clone();
    for (k, v) in &calls.call_meta {
        meta.insert(k.clone(), v.clone());
    }
    if let (true, Some(t)) = (author_is_agent, origin.turn_id) {
        meta.insert("turnId".into(), Value::String(t.to_owned()));
    }
    // TS `verifiedCauseLink` — 사슬 고리(118)는 오퍼레이터를 거친 원인이 나를 최근에 깨웠을 때만 적는다.
    let cause_link_id = match (author_is_agent, origin.chain_cause) {
        (true, Some(c)) => {
            cause_link::verified_cause_link(&mut tx, author, c, now_ms(), iso_ms).await?
        }
        _ => None,
    };
    let id: String = sqlx::query_scalar(s.insert.as_str())
        .bind(channel)
        .bind(root)
        .bind(author)
        .bind(&calls.normalized_body)
        .bind(kind)
        .bind(Value::Object(meta).to_string())
        .bind(input.also_in_channel)
        .bind(cause_link_id)
        .fetch_one(&mut *tx)
        .await?;
    if !attachment_ids.is_empty() {
        let found: Vec<(String, String, Option<String>)> = sqlx::query_as(attach_find_raw())
            .bind(attachment_ids)
            .fetch_all(&mut *tx)
            .await?;
        let ok = found.len() == attachment_ids.len()
            && found.iter().all(|(_, up, m)| up == author && m.is_none());
        if !ok {
            tx.rollback().await?;
            return Ok(Outcome::BadAttachment);
        }
        sqlx::query(s.attach_update.as_str())
            .bind(&id)
            .bind(attachment_ids)
            .execute(&mut *tx)
            .await?;
    }
    let Some(mut row) = message_by_id(&mut *tx, &id).await? else {
        return Err(sqlx::Error::RowNotFound);
    };
    if let Some(key) = idempotency_key {
        sqlx::query(s.idem_insert.as_str())
            .bind(key)
            .bind(&id)
            .bind(author)
            .bind(channel)
            .execute(&mut *tx)
            .await?;
    }
    let mut notified_set: HashSet<String> = HashSet::new();
    mention_fanout::fan_out_calls(
        &mut tx,
        &Post {
            channel_id: channel,
            author_id: author,
            message_id: &id,
        },
        &calls,
        &mut notified_set,
    )
    .await?;
    // 위임은 부름만 본다 — TS 는 `thread_reply` 를 넣기 **앞에서** 판정한다.
    let called = notified_in_order(&mut tx, &id, &notified_set, false).await?;
    // TS 는 사람·세션 글만 위임을 적는다. 에이전트 글은 원인(살아 있는 임대)이 있을 때만 그 위임과 principal 을 잇는다(C1c-4c).
    if let (true, Some(c)) = (author_is_agent, origin.chain_cause) {
        if let Some(m) =
            cause_link::mandate_for_agent_post(&mut tx, author, c, now_ms(), iso_ms).await?
        {
            sqlx::query(s.set_mandate.as_str())
                .bind(&id)
                .bind(&m)
                .execute(&mut *tx)
                .await?;
        }
        if let Some((p, reasons)) = &principal {
            sqlx::query(SET_PRINCIPAL_SQL)
                .bind(&id)
                .bind(p)
                .bind(reasons)
                .execute(&mut *tx)
                .await?;
        }
    }
    // TS `stampHumanMandate` 는 `kind === 'user'` 인 사람 글만 — 시스템 줄은 위임 키를 만들지도 잇지도 않는다.
    let mandate = match (author_is_agent || origin.system, root) {
        (true, _) => None,
        (false, None) => mandate_stamp::stamp_root(&mut tx, &id, author, channel, &called).await?,
        (false, Some(r)) => {
            mandate_stamp::stamp_reply(&mut tx, &id, author, channel, r, &called).await?
        }
    };
    // TS `openReplyGrants` — 실제로 inbox 가 간 상대에게만. 최상위 글이면 그 글이 머리다. 작성자가 게이트에 걸리는 에이전트가
    // 아니면(사람·community) 문장이 아무것도 넣지 않는다.
    if author_is_agent {
        let grantees: Vec<&String> = calls
            .called_ids
            .iter()
            .filter(|c| c.as_str() != author && notified_set.contains(c.as_str()))
            .collect();
        if !grantees.is_empty() {
            sqlx::query(s.reply_open.as_str())
                .bind(author)
                .bind(root.unwrap_or(&id))
                .bind(grantees)
                .bind(REPLY_GRANT_TTL_SEC)
                .execute(&mut *tx)
                .await?;
        }
    }
    // TS 암묵 위임(P4) — 회신권을 연 뒤, `thread_reply` 앞. 결과로 세는 에이전트 글(이 앞단이 맡는 글은 모두 `user` 다)이 부른,
    // inbox 가 실제로 간 계정 중 에이전트만 판정한다.
    // TS 는 `meta.kind` 가 `delegation` 인 글(`message.delegate`)을 암묵 위임으로 보지 않는다 — 그 도구가 진짜 위임을 만든다.
    let delegation_meta = origin.meta.get("kind").and_then(Value::as_str) == Some("delegation");
    // TS `input.kind !== 'system'` — 시스템 줄은 부름이 있어도 암묵 위임으로 보지 않는다.
    if let (true, true, false, false, mode) = (
        author_is_agent,
        is_result,
        delegation_meta,
        origin.system,
        implicit,
    ) {
        let called: Vec<&String> = calls
            .called_ids
            .iter()
            .filter(|c| c.as_str() != author && notified_set.contains(c.as_str()))
            .collect();
        implicit_delegation::record(
            &mut tx,
            mode,
            &implicit_delegation::Post {
                message_id: &id,
                channel_id: channel,
                thread_root_id: root.unwrap_or(&id),
                author_id: author,
                normalized_body: &calls.normalized_body,
            },
            &called,
            now_ms(),
            iso_ms,
        )
        .await?;
    }
    // TS `deletedRoot` — 머리가 지워져 있었으면 커밋 뒤 목록에 다시 물어 `message.updated` 로 되돌린다(아래).
    // TS `input.threadRootId && isReply` — 진행 줄은 머리 주인에게 가지 않고 지워진 머리도 되돌리지 않는다.
    let deleted_root = match (is_reply, root) {
        (true, Some(r)) => {
            thread_reply(
                &mut tx,
                r,
                author,
                channel,
                &id,
                origin.system,
                &mut notified_set,
            )
            .await?
        }
        _ => false,
    };
    // TS 와 같이 `thread_reply` 뒤 — DM 이면 상대에게 `dm`(`isReply` 만, 시스템 줄은 에이전트 상대를 건너뛴다).
    if is_dm && is_reply {
        dm_notify(
            &mut tx,
            channel,
            author,
            root,
            &id,
            origin.system,
            &mut notified_set,
        )
        .await?;
    }
    // TS 와 같이 부름·`thread_reply` 를 다 넣은 뒤 — 이 글이 부른 계정의 깨움은 접고 나머지는 깨운다.
    // TS `preemptWakesForThread` 는 사람 글만 보고, 시스템 줄(`!isSystemLine`)은 부르지 않는다.
    let preempted = match (author_is_agent || origin.system, root) {
        (false, Some(r)) => wake_preempt::preempt(&mut tx, r, author, &id, &notified_set).await?,
        _ => wake_preempt::Preempted::default(),
    };
    // TS `closeReplyGrants` — 결과를 냈으니 이 스레드에서 받은 회신권을 닫는다(이 글은 위에서 이미 게이트를 지났다).
    if let (true, true, Some(r)) = (author_is_agent, is_result, root) {
        sqlx::query(s.reply_close.as_str())
            .bind(author)
            .bind(r)
            .execute(&mut *tx)
            .await?;
    }
    // TS `closeDelegationsForReply`(선점 뒤, 같은 tx) — 사람 글은 결과(`report`·`fail`)가 아니라 닫지 않고 깨우지 않는다:
    // 기한만 밀고, v1 이면 「대기 중 update」로 적는다(턴 끝에 TS 스위퍼가 넘긴 쪽에 보낸다). 스위치 값이 없으면 v0 이다.
    // 서버 알림 줄은 위임 의무를 닫지도 밀지도 않는다(TS `!input.serverNotice`).
    //
    // C3b-2c-2: 결과 글(`meta.kind` 가 `failure`·`report` — [`Origin::closes_delegation`])은 작성자가 담당인 안 닫힌 항목을 닫고,
    // 위임의 미결이 0 이 되면 위임자를 **한 번만** 깨운다(TS `notifyIfSettled` = [`turn_settle::notify_if_settled`]). 같은 tx 다.
    // v0(`!on`): 결과 글은 기한을 밀지 않는다 · 결말 `failed`/`done`. v1(`on`): 기한을 먼저 밀고 · 결말 `failed`/`reported` ·
    // 닫은 항목이 하나라도 있었으면 대기 중 update 를 적지 않는다.
    let mut deleg = wake_preempt::Preempted::default();
    let mut deleg_woke: Vec<String> = Vec::new();
    if let (false, Some(r), on) = (origin.server_notice, root, v2) {
        let closing = origin.closes_delegation && is_result;
        if on || !closing {
            sqlx::query(s.deleg_touch.as_str())
                .bind(author)
                .bind(r)
                .bind(DELEGATION_SILENCE_SEC)
                .execute(&mut *tx)
                .await?;
        }
        let mut had_open = false;
        if closing {
            let failure = origin.meta.get("kind").and_then(Value::as_str) == Some("failure");
            let item = if on {
                &s.close_item_v2
            } else {
                &s.close_item_v0
            };
            let outcome = match (failure, on) {
                (true, _) => "failed",
                (false, true) => "reported",
                (false, false) => "done",
            };
            let open: Vec<String> = sqlx::query_scalar(s.close_open.as_str())
                .bind(author)
                .bind(r)
                .fetch_all(&mut *tx)
                .await?;
            had_open = !open.is_empty();
            for d in open {
                let closed = sqlx::query(item.as_str())
                    .bind(&d)
                    .bind(author)
                    .bind(outcome)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?;
                if closed.rows_affected() == 0 {
                    continue;
                }
                // A1 측정 — 위임 결말(`message.report`·`message.fail` 이 닫음: `reported`·`done`·`failed`). 기록만.
                super::measure::delegation_outcomes(std::slice::from_ref(&d), outcome, None);
                // D1 그림자 — 그 담당의 하위 작업을 닫는다. 이 tx 밖(다른 연결)에서 돈다. 기록만.
                super::work_shadow::delegation_closed(
                    std::slice::from_ref(&d),
                    Some(author),
                    outcome,
                    None,
                );
                if let Some(lead) = turn_settle::notify_if_settled(&mut tx, &d, &mut deleg).await? {
                    deleg_woke.push(lead);
                }
            }
        }
        if on && !had_open {
            sqlx::query(s.deleg_pending.as_str())
                .bind(author)
                .bind(r)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
    }
    // C3b-2c-4b `message.delegate` — `createDelegation`. TS 는 의무를 커밋 뒤 다른 tx 로 만들지만(그 사이 실패면 글만 남는다)
    // 여기서는 같은 tx 다. 사슬 상한(TS `beforeCommit`)은 보지 않는다(O1).
    let delegation_id = match (&origin.delegation, v2) {
        (Some(plan), on) => Some(
            delegate_write::create(&mut tx, on, &id, channel, root.unwrap_or(&id), author, plan)
                .await?,
        ),
        _ => None,
    };
    // TS `planAutoStamp` — 시스템 글에만, 커밋 앞 같은 tx 에서.
    if let (true, Some((mandate, principal))) = (origin.system, origin.plan_auto_stamp) {
        sqlx::query(PLAN_AUTO_STAMP_SQL)
            .bind(&id)
            .bind(mandate)
            .bind(principal)
            .execute(&mut *tx)
            .await?;
    }
    // TS `beforeCommit` — 위임을 닫은 뒤, 커밋 앞. 거절이면 롤백, 지나면 같은 tx 에서 행을 다시 읽는다.
    if let Some(hook) = origin.before_commit {
        if let Some(rej) = hook.run(&mut tx, &id, &notified_set).await? {
            tx.rollback().await?;
            return Ok(Outcome::Rejected(rej));
        }
        if let Some(r) = message_by_id(&mut *tx, &id).await? {
            row = r;
        }
    }
    // 훅(차례 주인 알림 등)이 inbox 를 더 넣었을 수 있다 — 그때는 표가 비어 있어도 DB 에서 읽는다.
    let notified =
        notified_in_order(&mut tx, &id, &notified_set, origin.before_commit.is_some()).await?;
    // TS 는 선점 신호를 `postMessage` 안(커밋 뒤)에서, `message.created` 는 라우트가 그 뒤에 낸다 — 같은 순서로 outbox 에.
    wake_preempt::announce(&mut tx, &preempted).await?;
    // TS 는 이어서 위임이 접은 예약의 보고처·대기 줄을 알리고, 결말이 난 위임자에게 `inbox.updated` 를 낸다(`wokeByDelegation`).
    wake_preempt::announce(
        &mut tx,
        &wake_preempt::Preempted {
            woke: Vec::new(),
            report: std::mem::take(&mut deleg.report),
            rows: std::mem::take(&mut deleg.rows),
        },
    )
    .await?;
    for a in &deleg_woke {
        crate::write::emit_event(&mut tx, &json!({ "type": "inbox.updated", "accountId": a }))
            .await?;
    }
    // 내보내는 행은 위임 키 앞에서 읽은 것 그대로다(TS 와 같다 — 행 칸에 위임 키는 없다).
    let row_value: Value = serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
    crate::write::emit_event(
        &mut tx,
        &json!({ "type": "message.created", "message": row_value, "audience": audience }),
    )
    .await?;
    // TS `emitPosted` — 지워진 머리에 답이 달리면 그 머리가 목록에 되돌아온다. `message.created` **뒤**, 같은 audience,
    // `message.updated` 로(새 말이 아니다). TS 는 커밋 뒤 `readListRow` 로 읽는다 — 같은 tx 안 이 자리에서 읽으면 같은 행이고,
    // 롤백되면 신호도 함께 사라진다. 목록에 안 보이면(`LIST_VISIBLE` 이 거르면) 내지 않는다.
    if let (true, Some(r)) = (deleted_root, root)
        && let Some(back) = read_list_row(&mut tx, channel, r).await?
    {
        let back: Value = serde_json::from_str(&back).map_err(|e| sqlx::Error::Decode(e.into()))?;
        crate::write::emit_event(
            &mut tx,
            &json!({ "type": "message.updated", "message": back, "audience": audience }),
        )
        .await?;
    }
    if !origin.defer_inbox_events {
        for a in &notified {
            crate::write::emit_event(&mut tx, &json!({ "type": "inbox.updated", "accountId": a }))
                .await?;
        }
    }
    // TS `message.delegate` — 넘겨받은 담당의 부름은 `createDelegation` 이 만들었다. 러너가 곧 폴하도록 따로 친다.
    if let Some(plan) = &origin.delegation {
        for a in plan.delegate_ids {
            crate::write::emit_event(&mut tx, &json!({ "type": "inbox.updated", "accountId": a }))
                .await?;
        }
    }
    // TS 라우트는 `inbox.updated` 뒤에 `closeAsksByReply` 를 부른다(사람 글만) — 이 답보다 앞선 열린 카드를 `replied` 로 닫는다.
    // 시스템 줄은 라우트를 거치지 않는다(서버가 바로 `postMessage` 를 부른다) — 카드를 닫지 않는다.
    if let (false, false, false, false, Some(r)) = (
        author_is_agent,
        origin.system,
        origin.service_call,
        origin.close_asks_after_commit,
        root,
    ) {
        let seq = row_value
            .get("seq")
            .and_then(Value::as_i64)
            .ok_or(sqlx::Error::RowNotFound)?;
        ask_reply_close::close_by_reply(&mut tx, r, channel, seq, author, &id).await?;
    }
    tx.commit().await?;
    // D1 그림자 — 위임마다 하위 작업 행. 커밋 뒤에만 부른다(작업 행의 FK 가 글·위임 행을 본다). 기록만.
    if let Some(d) = &delegation_id {
        super::work_shadow::delegation_created(d);
    }
    Ok(Outcome::Posted {
        row,
        notified,
        mandate,
        delegation_id,
    })
}

/// TS `channel.kind = 'dm'` — 없는 채널은 거짓(insert 가 FK 로 실패한다, TS 와 같다).
pub(crate) async fn channel_is_dm(read: &PgPool, channel: &str) -> sqlx::Result<bool> {
    let kind: Option<String> = sqlx::query_scalar(sql().channel_kind.as_str())
        .bind(channel)
        .fetch_optional(read)
        .await?;
    Ok(kind.as_deref() == Some("dm"))
}

/// 넣은 순서(inbox id 순) — TS `[...notified]`(Set 삽입 순서)와 같다. 새 글이라 inbox 행은 전부 이 요청이 넣은 것이다.
async fn notified_in_order(
    conn: &mut sqlx::PgConnection,
    message_id: &str,
    set: &HashSet<String>,
    hooked: bool,
) -> Result<Vec<String>, sqlx::Error> {
    if set.is_empty() && !hooked {
        return Ok(vec![]);
    }
    sqlx::query_scalar("select account_id::text from inbox where message_id = $1::uuid order by id")
        .bind(message_id)
        .fetch_all(&mut *conn)
        .await
}

/// TS 의 머리 주인 `thread_reply` — 작성자 아닌, 아직 안 받은 머리 주인에게. 에이전트면 직접 멘션과 같은 호출 게이트
/// (via mention, 호출자 = 작성자, 회신권 스레드 = 머리)를 지나야 하고, 사람은 facts 에 없어 그대로 받는다.
/// 사람 글은 언제나 답글로 세어지고 시스템 줄이 아니다(`isReply`·`isSystemLine`).
/// 돌려주는 값은 머리가 지워져 있었는가(TS `deletedRoot`) — 머리 주인 판정과 상관없이 같은 행에서 읽는다.
async fn thread_reply(
    conn: &mut sqlx::PgConnection,
    root: &str,
    author: &str,
    channel: &str,
    message_id: &str,
    system_line: bool,
    notified: &mut HashSet<String>,
) -> Result<bool, sqlx::Error> {
    let row: Option<(Option<String>, bool)> = sqlx::query_as(sql().root_author.as_str())
        .bind(root)
        .fetch_optional(&mut *conn)
        .await?;
    let deleted = row.as_ref().is_some_and(|(_, d)| *d);
    let Some((Some(owner), _)) = row else {
        return Ok(deleted);
    };
    if owner == author || notified.contains(&owner) {
        return Ok(deleted);
    }
    let facts = invoke_gate::invoke_facts(conn, std::slice::from_ref(&owner)).await?;
    if let Some(f) = facts.get(&owner) {
        // TS `rootFact && isSystemLine` — 에이전트 머리는 시스템 줄로 깨우지 않는다.
        if system_line {
            return Ok(deleted);
        }
        let ctx = invoke_gate::Ctx {
            caller_id: author,
            channel_id: channel,
            via: invoke_gate::Via::Mention,
            reply_grant_thread_id: Some(root),
        };
        if !invoke_gate::may_invoke(conn, f, &ctx).await? {
            return Ok(deleted);
        }
    }
    mention_fanout::insert_inbox_many(conn, &[owner], message_id, "thread_reply", notified, None)
        .await?;
    Ok(deleted)
}

/// TS 의 DM 알림 — 작성자 말고 그 방의 멤버 중 아직 안 받은 계정에게 `dm`. 에이전트면 `thread_reply` 와 같은 호출 게이트
/// (via mention, 호출자 = 작성자, 회신권 스레드 = 머리 또는 없음)를 지나야 하고, 사람은 facts 에 없어 그대로 받는다.
async fn dm_notify(
    conn: &mut sqlx::PgConnection,
    channel: &str,
    author: &str,
    root: Option<&str>,
    message_id: &str,
    system_line: bool,
    notified: &mut HashSet<String>,
) -> Result<(), sqlx::Error> {
    let peers: Vec<String> = sqlx::query_scalar(sql().dm_peers.as_str())
        .bind(channel)
        .bind(author)
        .fetch_all(&mut *conn)
        .await?;
    let facts = invoke_gate::invoke_facts(conn, &peers).await?;
    let mut to: Vec<String> = Vec::new();
    for p in peers {
        if notified.contains(&p) {
            continue;
        }
        if let Some(f) = facts.get(&p) {
            // TS `fact && isSystemLine` — 에이전트 상대는 시스템 줄로 깨우지 않는다.
            if system_line {
                continue;
            }
            let ctx = invoke_gate::Ctx {
                caller_id: author,
                channel_id: channel,
                via: invoke_gate::Via::Mention,
                reply_grant_thread_id: root,
            };
            if !invoke_gate::may_invoke(conn, f, &ctx).await? {
                continue;
            }
        }
        to.push(p);
    }
    mention_fanout::insert_inbox_many(conn, &to, message_id, "dm", notified, None).await
}

/// 미뤄 둔 받은 사람 `inbox.updated`([`Origin::defer_inbox_events`]).
async fn emit_inbox_updated(write: &sqlx::PgPool, notified: &[String]) -> sqlx::Result<()> {
    if notified.is_empty() {
        return Ok(());
    }
    let mut tx = write.begin().await?;
    for a in notified {
        crate::write::emit_event(&mut tx, &json!({ "type": "inbox.updated", "accountId": a }))
            .await?;
    }
    tx.commit().await
}

fn json_response(status: StatusCode, row: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        row,
    )
        .into_response()
}

/// `POST /channels/{id}/messages`.
/// REST 글 줄의 상태 — 글 코어 + `agentModels` 를 Rust 가 맡을 수 있는가([`super::msg_post_models`]).
pub struct RestState {
    pub post: PostState,
    /// 스레드 모델 지정 코어가 붙었는가(오퍼레이터 코어가 Rust 이고 지정 권한이 있다 — `main.rs` 의 `thread_model_set`).
    /// 거짓이면 비지 않은 `agentModels` 글은 TS 로 넘긴다(하네스 목록을 능력 스냅숏으로만 볼 수 있다).
    pub models: bool,
    /// P3 B5 — 글 승인이 고를 수 있는 결정(거절·[이번 한 번]·위임장 세우기)을 Rust 가 끝까지 할 스위치가 다 켜졌는가
    /// ([`ChatDecideSwitches::all_on`], `main.rs` 가 기동 때 정한다). 글 승인은 글을 **커밋한 뒤에** 카드를 고르므로 중간에 TS 로
    /// 넘길 수 없다 — 그래서 카드와 상관없이 쓰기 **전** 입구에서 가른다. 거짓이면 넓은 체에 걸린 글은 글째 TS 로 간다.
    pub chat_decide: bool,
    /// P3b-2 — 글 승인이 결정 코어(거절·승인·카드 답·소유자 알림)를 부를 상태. `None` 이면 `chat_decide` 를 켜지 않는다(`main.rs`).
    pub chat: Option<super::ask::AskState>,
}

/// P3 B5 — 글 승인 결정 스위치(기동 때 권한 검사 결과). 하나라도 꺼져 있으면 그 결정이 Rust 에서 TS 출구로 빠질 수 있다.
#[derive(Debug, Clone, Copy, Default)]
pub struct ChatDecideSwitches {
    /// 권한 카드 거절 코어(`decide_core::deny_pool`).
    pub deny: bool,
    /// 권한 카드 승인 코어(`decide_approve::approve_pool`).
    pub approve: bool,
    /// 머지 거절 카드의 [이번 한 번](`decide_merge_once::merge_once_on`).
    pub merge_once: bool,
    /// 있는 위임장에 줄 쓰기(`decide_approve::mandate_core_on` — command 승인도 이것을 따른다).
    pub mandate: bool,
    /// 위임장 새로 세우기(`decide_approve::new_mandate_core_on`).
    pub new_mandate: bool,
}

impl ChatDecideSwitches {
    /// 다 켜졌는가. 만료 닫기 칸은 보지 않는다 — 글 승인은 결정 전에 만료 카드를 걸러 낸다(TS 와 같다).
    pub fn all_on(self) -> bool {
        self.deny && self.approve && self.merge_once && self.mandate && self.new_mandate
    }
}

/// P3 B5 — 글 승인 DB 층(P3b-2b 카드 고르기 → 2c 결정 → 2d 안내 줄)이 `post` 에 붙었는가. 붙기 전에는 스위치가 다 켜져도
/// 넓은 체에 걸린 글을 TS 로 넘긴다(Rust 가 맡으면 승인 글이 아무 결정 없이 올라간다).
const CHAT_APPROVAL_WIRED: bool = true;

/// 넓은 체에 걸린 REST 글을 TS 로 넘기는가 — 체에 걸렸고, 글 승인을 Rust 가 끝까지 할 수 없으면.
fn guard_to_ts(body: &str, chat_decide: bool) -> bool {
    ts_guard(body) && !(CHAT_APPROVAL_WIRED && chat_decide)
}

pub async fn post(
    State(rs): State<Arc<RestState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let st = &rs.post;
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let parsed = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(crate::write::Body::Json(v)) => Some(v),
        Ok(_) => None,
        Err(r) => return r,
    };
    // 사람은 세션 글만(사람 PAT 는 인증에서 401), 에이전트는 PAT·오퍼레이터 글(C1c-4a). 모델 지정 키 등은 판정하지 않고 넘긴다.
    let human_session = me.kind == "human" && auth.via == Some(Via::Session);
    let author_is_agent = me.kind == "agent";
    if !(human_session || author_is_agent) {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    if !is_uuid(&id) {
        return bad();
    }
    let Some(input) = parsed.as_ref().and_then(parse_post) else {
        return bad();
    };
    let Some(picks) = parsed
        .as_ref()
        .and_then(Value::as_object)
        .and_then(super::msg_post_models::parse)
    else {
        return bad();
    };
    // 하네스 목록을 볼 수 없으면(오퍼레이터 코어가 TS) 고르기 글은 TS 몫이다 — 아직 아무것도 읽거나 쓰지 않았다.
    if !picks.is_empty() && !rs.models {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    let chat_on = rs.chat_decide && rs.chat.is_some();
    if guard_to_ts(&input.body, chat_on) {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    // 글 승인 판정은 사람 세션 글만(TS 라우트). 선택 카드를 링크한 글은 TS P5(`answerAskFromMessage`) 몫 — 쓰기 전에 넘긴다.
    // P3c — 선택 카드 글 답(TS P5 `answerAskFromMessage`)도 Rust 가 커밋 뒤에 한다(`chat_ask`). 카드 닫기는 그 뒤로 미룬다.
    let chat_ask =
        chat_on && human_session && super::chat_approval_apply::wants_ask_pick(&input.body);
    let chat_apply = chat_ask
        || (chat_on
            && human_session
            && super::chat_approval_apply::wants_chat_approval(&input.body));
    let preview_urls = extract_preview_urls(&input.body, 3);
    // TS `channelPostGate` — 없는 채널은 'ok'(insert 가 FK 로 실패해 500, TS 와 같다).
    let gate: Option<(bool, bool)> = match sqlx::query_as(sql().gate.as_str())
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(g) => g,
        Err(e) => return internal(e),
    };
    match gate {
        Some((false, _)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this dm channel",
            );
        }
        Some((true, true)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "channel_archived",
                "archived channels are read-only",
            );
        }
        _ => {}
    }
    // TS 와 같이 게이트 뒤, 글을 올리기 **전**에 거른다 — 올린 뒤 거절하면 글만 남고 지정이 빠진 채 기본값으로 턴이 돈다.
    if !picks.is_empty() {
        match super::msg_post_models::refuse(
            st,
            &me.kind,
            &id,
            input.thread_root.as_deref(),
            &picks,
        )
        .await
        {
            Ok(None) => {}
            Ok(Some(r)) => return r,
            Err(e) => return internal(e),
        }
    }
    let hook = (!picks.is_empty()).then(|| {
        super::msg_post_models::RestPicks::new(&id, input.thread_root.as_deref(), &me.id, picks)
    });
    // DM 은 받는 사람에게 `dm` 알림이 간다(C1c-3d 부터 Rust 가 넣는다 — [`dm_notify`]).
    let kind: Option<String> = match sqlx::query_scalar(sql().channel_kind.as_str())
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(k) => k,
        Err(e) => return internal(e),
    };
    let is_dm = kind.as_deref() == Some("dm");
    let audience = match audience_for(&st.read, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let key = parts
        .headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    match post_in_tx(
        st,
        &id,
        &me.id,
        author_is_agent,
        &input,
        key.as_deref(),
        &audience,
        is_dm,
        &Origin {
            before_commit: hook.as_ref().map(|h| h as &dyn BeforeCommit),
            defer_inbox_events: chat_apply,
            chat_ask_rust: chat_on && human_session,
            close_asks_after_commit: chat_ask,
            ..Origin::default()
        },
    )
    .await
    {
        Err(e) => internal(e),
        // 세 사유를 400 하나로 합친다 — TS 와 같이, 남의 업로드 id 가 있는지 알리는 신호가 되지 않게.
        Ok(Outcome::ToTs | Outcome::Rejected(_)) => to_ts(st.up.clone(), peer, parts, bytes).await,
        Ok(Outcome::BadThread) => json_err(
            StatusCode::BAD_REQUEST,
            "bad_thread",
            "threadRootId must be a top-level message in this channel",
        ),
        Ok(Outcome::BadAttachment) => json_err(
            StatusCode::BAD_REQUEST,
            "bad_attachment",
            "attachments must be your own, unused uploads",
        ),
        // 재생은 새로 부른 사람을 모른다 — 헤더를 싣지 않는다(TS 와 같다).
        Ok(Outcome::Replayed(row)) => json_response(StatusCode::OK, row),
        Ok(Outcome::Posted {
            row,
            notified,
            mandate,
            ..
        }) => {
            // 새로 만든 위임의 감사 — 커밋 뒤라 되돌린 글의 위임은 남지 않는다(TS `auditMandateCreated`).
            if let Some(c) = &mandate {
                crate::write::record_audit(
                    &st.write,
                    crate::write::AuditEntry {
                        action: "mandate.created",
                        actor_id: Some(c.actor_id()),
                        actor_handle: None,
                        target: Some(&c.mandate_id),
                        ip: None,
                        detail: c.audit_detail(),
                    },
                )
                .await;
            }
            // P3b-2 — 글 승인(TS `applyChatApproval`): 받은 사람 `inbox.updated` **앞**에서 정한다(security n2).
            if chat_apply {
                if let (Some(ask), Some(msg)) = (
                    rs.chat.as_ref(),
                    super::chat_approval_apply::posted_from_row(&row),
                ) {
                    // TS `applyChatApproval(pool, message)` 는 **저장된** 본문을 읽는다 — 멘션이 id 토큰(`<@id>`)으로 바뀐 뒤라
                    // 「@bot2 A 로」의 멘션이 판정에서 빠진다. 받은 본문을 그대로 넘기면 `@bot2 a 로` 가 이름과 안 맞아 답이 안 된다.
                    let stored = serde_json::from_str::<Value>(&row)
                        .ok()
                        .and_then(|v| v.get("body").and_then(Value::as_str).map(str::to_owned))
                        .unwrap_or_else(|| input.body.clone());
                    super::chat_approval_apply::apply(ask, st, &msg, &stored, &me.id).await;
                }
                if let Err(e) = emit_inbox_updated(&st.write, &notified).await {
                    eprintln!("front: deferred inbox.updated failed ({e})");
                }
                // TS 라우트: `inbox.updated` 뒤 `closeAsksByReply` — 답한 카드는 이미 답이 있어 닫히지 않는다.
                if chat_ask {
                    super::chat_approval_apply::close_after(st, &row, &me.id).await;
                }
            }
            // TS 는 지정의 시스템 줄을 `message.created` 앞에 낸다 — Rust 는 커밋 뒤라 그 뒤다(지정 행 자체는 같은 tx 에 들어갔다).
            if let Some(h) = &hook {
                h.announce(st).await;
            }
            // TS `queueLinkPreviewFetch` — 응답을 기다리게 하지 않는다(실패는 삼킨다).
            for u in preview_urls {
                tokio::spawn(super::link_preview_fetch::queue_fetch(st.write.clone(), u));
            }
            let mut res = json_response(StatusCode::CREATED, row);
            let h = res.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&notified.len().to_string()) {
                h.insert(NOTIFIED_COUNT_HEADER, v);
            }
            if !notified.is_empty() {
                let ids = notified
                    .iter()
                    .take(NOTIFIED_HEADER_MAX_IDS)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(",");
                if let Ok(v) = HeaderValue::from_str(&ids) {
                    h.insert(NOTIFIED_HEADER, v);
                }
            }
            res
        }
    }
}

/// 코어 라우터에 합칠 줄 — `msg_edit.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: RestState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<RestState>>::new()
        .post("/channels/{id}/messages", post)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {

    /// 훅이 없는 것이 기본이다 — 기존 호출자(`Origin::default()`·`..`)는 그대로 돈다. 훅은 `&dyn` 으로 실린다.
    #[test]
    fn before_commit_is_off_by_default_and_object_safe() {
        #[derive(Debug)]
        struct Reject;
        impl BeforeCommit for Reject {
            fn run<'a>(
                &'a self,
                _tx: &'a mut sqlx::Transaction<'static, sqlx::Postgres>,
                _message_id: &'a str,
                _notified: &'a HashSet<String>,
            ) -> BeforeCommitFuture<'a> {
                Box::pin(async {
                    Ok(Some(Rejection {
                        status: 400,
                        code: "bad_request".into(),
                        message: "no".into(),
                    }))
                })
            }
        }
        assert!(Origin::default().before_commit.is_none());
        let hook = Reject;
        let o = Origin {
            before_commit: Some(&hook),
            ..Origin::default()
        };
        assert!(o.before_commit.is_some());
    }

    #[test]
    fn no_mention_calls_keep_body_and_call_nobody() {
        let c = no_mention_calls("@scout <@00000000-0000-4000-8000-00000000000a> hi");
        assert_eq!(
            c.normalized_body,
            "@scout <@00000000-0000-4000-8000-00000000000a> hi"
        );
        assert!(c.called_ids.is_empty() && c.team_plans.is_empty());
        assert!(c.call_meta.is_empty() && !c.channel_called);
        // 기본값은 부른다 — 이제까지의 호출자는 그대로다.
        assert!(!Origin::default().no_mentions);
    }

    use super::*;

    #[test]
    fn golden_loads() {
        let s = sql();
        assert_eq!(s.lock_class, 0x6d73_6571);
        assert!(s.lock.contains("pg_advisory_xact_lock"));
        assert!(s.insert.contains("insert into message"));
        assert!(attach_find_raw().contains("for update"));
        assert!(s.guard_words.iter().any(|w| w == "harkroom://message/"));
    }

    #[test]
    fn delegation_v2_unset_means_unknown() {
        // 값이 없거나 비면 모른다(글 쓰기 밖의 길은 TS 로 넘긴다). 있으면 TS `delegationV2Enabled` 와 같은 낱말로 갈린다.
        assert_eq!(delegation_v2(None), None);
        assert_eq!(delegation_v2(Some("  ")), None);
        for on in ["1", "on", "TRUE", " On "] {
            assert_eq!(delegation_v2(Some(on)), Some(true), "{on}");
        }
        for off in ["0", "off", "false", "yes"] {
            assert_eq!(delegation_v2(Some(off)), Some(false), "{off}");
        }
    }

    #[test]
    fn delegation_v2_on_falls_back_to_ts_default() {
        // 글 쓰기는 값이 없으면 TS 기본값(꺼짐)으로 맡는다 — 넘기지 않는다.
        assert!(!delegation_v2_on(None));
        assert!(!delegation_v2_on(Some("  ")));
        assert!(delegation_v2_on(Some(" On ")));
        assert!(!delegation_v2_on(Some("yes")));
    }

    #[test]
    fn question_only_is_narrow() {
        for b in [
            "그게 뭐야?",
            "왜？",
            "<@0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b> 이건 어떻게 돼?",
        ] {
            assert!(question_only(b), "{b}");
        }
        for b in [
            "A 로",
            "1번",
            "`왜?` 는 말고 B",
            "> 이거 뭐야?\nB 로",
            "  > 인용?\n2",
            "B 로\r> 뭐야?",
            "B\u{2028}> 뭐?",
            "",
        ] {
            assert!(!question_only(b), "{b}");
        }
    }

    #[test]
    fn chat_decide_switches_all_or_nothing() {
        let all = ChatDecideSwitches {
            deny: true,
            approve: true,
            merge_once: true,
            mandate: true,
            new_mandate: true,
        };
        assert!(all.all_on());
        for off in 0..5 {
            let mut s = all;
            match off {
                0 => s.deny = false,
                1 => s.approve = false,
                2 => s.merge_once = false,
                3 => s.mandate = false,
                _ => s.new_mandate = false,
            }
            assert!(!s.all_on(), "{s:?}");
        }
        assert!(!ChatDecideSwitches::default().all_on());
    }

    #[test]
    fn guard_goes_to_ts_until_chat_approval_wired() {
        // 넓은 체에 안 걸린 글은 스위치와 상관없이 Rust.
        assert!(!guard_to_ts("점심 뭐 먹지", false));
        assert!(!guard_to_ts("점심 뭐 먹지", true));
        // 걸린 글은 스위치가 꺼졌으면 언제나 TS.
        assert!(guard_to_ts("승인", false));
        // P3b-2 부터 스위치가 다 켜지면 Rust 가 글 승인까지 한다.
        assert!(!guard_to_ts("승인", true));
    }

    #[test]
    fn preview_urls_like_shared() {
        assert_eq!(
            extract_preview_urls(
                "see https://A.com/x). and (https://b.com/(y)) https://a.com/x a:b mailto:z https://c.com https://d.com",
                3
            ),
            vec!["https://a.com/x", "https://b.com/(y", "https://c.com/"]
        );
        assert_eq!(trim_trailing_punctuation("x.com/a?!'\""), "x.com/a");
        assert!(!question_only("https://a.com/?q=1"));
    }

    #[test]
    fn ts_body_like_ts() {
        for b in [
            "see https://example.com",
            "mailto:x@example.com",
            "승인",
            "Approve this",
            "denied",
            "BYPASS",
            "harkroom://message/0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b",
        ] {
            assert!(ts_body(b), "{b}");
        }
        for b in ["안녕하세요", "오늘 3시", "1번", "a: b"] {
            assert!(!ts_body(b), "{b}");
        }
    }

    #[test]
    fn body_rules_like_zod() {
        let ok = |v: Value| parse_post(&v).is_some();
        assert!(ok(json!({ "body": "x" })));
        assert!(!ok(json!({ "body": "" })));
        assert!(!ok(json!({ "body": " \u{feff}\u{3000}\n" })));
        assert!(
            ok(json!({ "body": "\u{85}" })),
            "JS trim 은 U+0085 를 남긴다"
        );
        assert!(ok(
            json!({ "body": "", "attachmentIds": ["0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b"] })
        ));
        assert!(!ok(json!({ "body": "x", "attachmentIds": ["nope"] })));
        assert_eq!(super::iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::iso_ms(1_794_830_702_123), "2026-11-16T12:05:02.123Z");
        assert_eq!(super::iso_ms(951_782_400_007), "2000-02-29T00:00:00.007Z");
        assert!(!ok(
            json!({ "body": "x", "attachmentIds": vec!["0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b"; 11] })
        ));
        assert!(!ok(json!({ "body": "x", "alsoInChannel": "yes" })));
        assert!(!ok(json!({ "body": "a".repeat(8001) })));
        assert!(ok(json!({ "body": "a".repeat(8000), "extra": 1 })));
        assert!(!ok(json!({ "body": "x", "threadRootId": "bad" })));
        assert!(!ok(json!({ "body": "x", "threadRootId": null })));
        assert!(ok(
            json!({ "body": "x", "threadRootId": "0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b" })
        ));
    }
}
