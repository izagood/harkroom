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
//!   아직 TS 몫인지([`TS_THREAD_SQL`] — 담당 위임·카드 답으로 읽힐 글이면 되돌리고 TS 로) 본다. 맡으면 머리·
//!   `alsoInChannel` 을 넣고, 부름 뒤 머리의 위임을 잇고([`super::mandate_stamp::stamp_reply`]), 머리 주인에게 호출 게이트를 지난
//!   `thread_reply` 를 넣는다(TS 와 같이 위임 판정 **뒤**).
//! - **깨움 선점**(C1c-3b): 그 뒤 이 스레드의 남의 열린 깨움을 접거나(이 글이 부른 계정) 지금 깨운다([`super::wake_preempt`]).
//!   신호(`inbox.updated`·`thread.reportWakes.changed`·대기 줄 `message.updated`)는 TS 처럼 `message.created` 앞에 outbox 로.
//! - **에이전트 글**(C1c-4a): PAT·오퍼레이터로 선 에이전트의 REST 글도 맡는다(원인·턴 id 가 없는 판). 회신권 「결과 한 번」 락
//!   (`REPLY_LOCK_CLASS`)을 채널 락 앞에 잡고, 부름이 실제로 간 에이전트에게 회신권을 열고(`openReplyGrants`) 답글이면 받은
//!   회신권을 닫는다(`closeReplyGrants`). 위임 키·깨움 선점·카드 닫기는 TS 와 같이 사람 글에만. 아직 TS 로 넘기는 것:
//!   상한에 막힌 부름(백스톱 카드)과 암묵 위임 스위치를 모르는 부름([`implicit_known_off`], C1c-4d).
//! - **사슬 안의 에이전트 글**(C1c-4b): 앞 고리([`chain_link`])에서 깊이·사슬 시작을 잇고, 정체 홉([`super::chain_stall`])을 적고,
//!   한도를 넘으면 막았을 부름을 `meta.mentionStallShadow` 에 남긴다(그림자 — 부름은 그대로 나간다).
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
use super::chain_stall::{self, STALL_HOP_LIMIT};
use super::invoke_gate;
use super::mandate_stamp;
use super::mention_calls::{self, Input};
use super::mention_fanout::{self, Post};
use super::mention_parse::split_mention_calls;
use super::msg_edit::{
    MAX_MESSAGE_BODY_CHARS, NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER, NOTIFIED_HEADER_MAX_IDS,
};
use super::msg_list::read_list_row;
use super::msg_read::{is_uuid, message_by_id};
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
];
pub const MESSAGE_POST_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `postMessage` 의 principal 옮겨 적기(152·153) — 다음 에이전트의 임대가 이것을 이어받는다. 판정에는 아직 쓰지 않는다.
/// 문장이 TS 와 같은지는 대조 시험이 행으로 본다(TS 는 인라인 문장이다).
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
    depth_scan: String,
    recent_bodies: String,
    own_links: String,
    stall_shadow: String,
    reply_open: String,
    reply_close: String,
    reply_lock_class: i32,
    set_mandate: String,
}

/// C1c-3a 갈래 판정(TS 동작이 아니라 **어느 쪽이 맡을지**) — 이 스레드에 답하면 TS 가 아직 Rust 에 없는 부수효과를 내는가.
/// 하나라도 참이면 트랜잭션을 버리고 TS 로 넘긴다. 조건은 그 부수효과의 문장보다 넓게(같거나 더 많이 걸리게) 잡는다:
/// 작성자가 담당인 열린·보고된 위임 항목인데 위임 스위치를 모름(`$4` 가 거짓 — [`delegation_v2`] 가 `None`. 알면 C1c-3d 부터 Rust 가
/// `closeDelegationsForReply` 의 사람 글 갈래를 한다) ·
/// (지워진 머리는 C1c-3d 부터 Rust 가 `rootBack` 까지 맡는다.) 열린 선택 카드인데 글이 **카드 답으로 읽힐 수 있음**(`$3` 이 거짓 — TS `applyChatApproval` 의 글로 고르기, 받는 쪽·종류와
/// 무관하게 카드 전부). 글이 물음뿐이면([`question_only`]) 고르기가 될 수 없어 Rust 가 맡고 카드를 `replied` 로 닫는다(C1c-3c).
/// 쓰기 트랜잭션 안 seq 락 뒤에서 읽는다 — TS 가 같은 판정을 하는 때와 같은 창이다.
const TS_THREAD_SQL: &str = "select (not $4::bool and exists(select 1 from team_delegation_item i join team_delegation d on d.id = i.delegation_id \
                where d.thread_root_id = $1::uuid and i.delegate_account_id = $2::uuid \
                  and (i.outcome is null or i.outcome = 'reported'))) \
     or (not $3::bool and exists(select 1 from message where (id = $1::uuid or thread_root_id = $1::uuid) \
                and deleted_at is null and meta->>'kind' = 'ask' \
                and meta->'ask'->>'answeredWith' is null and meta->'ask'->>'closedAt' is null))";

/// 이 글이 TS `parseAskPick` 에서 **반드시 null** 인가(카드 답이 될 수 없는가) — 넓게 TS 로 보내는 쪽으로만 틀린다.
/// TS 는 코드·인용 줄·링크·멘션을 걷어 낸 나머지에 `?`·`？` 가 있으면 null(`QUESTION`)이다. 여기서는 걷어 낼 거리(백틱·`>` 인용 줄)가
/// 하나라도 있으면 거짓으로 두고, 없을 때 본문에 물음표가 있으면 참이다. URL·메시지 링크 글은 이미 [`ts_body`] 로 TS 에 간다.
/// 멘션 토큰(`<@uuid>`)에는 물음표가 들 수 없다.
fn question_only(body: &str) -> bool {
    // JS `^` 는 m 플래그에서 \n·\r·U+2028·U+2029 뒤 모두에서 줄을 시작한다 — 같은 경계로 자른다.
    let quoted = body
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|l| l.trim_start_matches([' ', '\t']).starts_with('>'));
    if body.contains('`') || quoted {
        return false;
    }
    body.contains('?') || body.contains('？')
}

/// TS `delegationV2Enabled`(`HARKROOM_DELEGATION_V2`)을 Rust 가 읽는 법 — **값이 없으면 모른다**(`None`).
/// TS 는 없으면 꺼짐(v0)으로 보지만, 앞단 컨테이너에 이 변수가 빠진 채 TS 만 켜져 있으면 두 서버가 다르게 군다. 그래서 Rust 는
/// 값이 있을 때만 위임 갈래를 맡고(`1`·`on`·`true` → v1, 그 밖의 값 → v0 — TS 와 같은 낱말), 없으면 지금처럼 TS 로 넘긴다.
/// TS 와 같이 부를 때마다 읽는다.
fn delegation_v2(raw: Option<&str>) -> Option<bool> {
    let v = raw?.trim().to_lowercase();
    if v.is_empty() {
        return None;
    }
    Some(matches!(v.as_str(), "1" | "on" | "true"))
}

/// TS `implicitDelegationMode` 이 **꺼짐**인지 Rust 가 아는가 — 위임 스위치를 알고(`delegation_v2` 가 `Some`) 그것이 꺼졌거나,
/// 켜졌어도 `HARKROOM_DELEGATION_IMPLICIT` 이 끄는 낱말(`off`·`0`·`false`)일 때만 참이다. 모르거나 켜졌으면(그림자 포함) 암묵 위임을
/// 적을 수 있으므로 에이전트가 누군가를 부른 글은 TS 로 넘긴다(C1c-4d 가 옮긴다).
fn implicit_known_off(v2: Option<bool>, implicit: Option<&str>) -> bool {
    match v2 {
        None => false,
        Some(false) => true,
        Some(true) => {
            let v = implicit.unwrap_or_default().trim().to_lowercase();
            matches!(v.as_str(), "off" | "0" | "false")
        }
    }
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
            // 시각은 TS 가 `Date` 로 읽는 것과 같게 밀리초로 자른다(백스톱 나이 판정과 `chain_started_at` 옮겨 적기가 같은 값을 쓴다).
            depth_scan: format!(
                "select s.body, s.author_is_agent, s.woke, s.depth::int, s.stall::int, \
                 (extract(epoch from date_trunc('milliseconds', s.created_at)) * 1000)::bigint, \
                 (extract(epoch from date_trunc('milliseconds', s.chain_started_at)) * 1000)::bigint \
                 from ({}) s",
                frag("mention_depth_scan")
            ),
            recent_bodies: frag("stall_recent_bodies"),
            own_links: frag("stall_own_thread_links"),
            stall_shadow: frag("stall_shadow"),
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
    /// TS `causeMessageId` — 깊이를 물려받을 원인(모양만 본 헤더 값, 확인은 [`super::cause_link::cause_depth`]).
    pub(crate) cause: Option<&'a str>,
    /// TS `chainCause` — 사슬 고리·principal·위임에 쓰는 원인(오퍼레이터를 거친 요청의 헤더만).
    pub(crate) chain_cause: Option<&'a str>,
    /// TS `turnId` — 에이전트 글의 `meta.turnId`(오퍼레이터를 거친 요청의 헤더만).
    pub(crate) turn_id: Option<&'a str>,
    /// TS 입력 `meta` — MCP 는 모델 신고(`reportedModelMeta`)만 싣는다. 부름 meta 가 그 위에 얹힌다.
    pub(crate) meta: serde_json::Map<String, Value>,
}

/// 읽은 JSON 이 TS 몫인가 — 키만 보고 정한다(값이 틀렸으면 TS 가 400 을 준다).
fn ts_keys(v: &Value) -> bool {
    let Value::Object(o) = v else { return false };
    // 머리 id 가 uuid 글자가 아니면(null 포함) zod 400 은 TS 가 낸다.
    let odd_root = o
        .get("threadRootId")
        .is_some_and(|r| !r.as_str().is_some_and(is_uuid));
    o.contains_key("agentModels") || odd_root
}

/// zod 스키마 + refine. `threadRootId`·`agentModels` 는 [`ts_keys`] 가 먼저 TS 로 보낸다.
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
    let thread_root = o
        .get("threadRootId")
        .and_then(Value::as_str)
        .map(str::to_owned);
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

/// 본문만 보고 TS 몫인가 — URL 후보(링크 미리보기)나 글 승인 넓은 체.
fn ts_body(body: &str) -> bool {
    let s = sql();
    if s.url.is_match(body) {
        return true;
    }
    let low = body.to_lowercase();
    s.guard_words.iter().any(|w| low.contains(w.as_str()))
}

fn bad() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid")
}

async fn to_ts(
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
    Posted {
        row: String,
        notified: Vec<String>,
        mandate: Option<mandate_stamp::Created>,
    },
}

/// TS `resolveMentionCalls` 의 입력 — 깊이·사슬 시작은 [`chain_link`](사람은 언제나 0·없음), principal 없음(REST 에는 원인이 없다).
/// 회신권 스레드는 결과 발화면 머리다(REST 글은 언제나 `user` 라 결과다).
#[allow(clippy::too_many_arguments)]
async fn resolve_post(
    conn: &mut sqlx::PgConnection,
    channel: &str,
    author: &str,
    author_is_agent: bool,
    body: &str,
    thread_root: Option<&str>,
    link: &Chain,
    principal: Option<&str>,
) -> Result<mention_calls::Resolved, sqlx::Error> {
    mention_calls::resolve(
        conn,
        &Input {
            body,
            channel_id: channel,
            author_id: author,
            author_is_agent,
            mention_depth: link.depth as i64,
            chain_bound: false,
            chain_started_at_ms: link.started_ms,
            // TS 는 결과 발화면 사람 글에도 머리를 넘긴다(사람은 회신권 대상이 아니라 판정은 같다).
            reply_grant_thread_id: thread_root,
            principal: principal.map(|id| mention_calls::Principal { id }),
            now_ms: link.now_ms,
            principal_invoke_enabled: mention_calls::principal_invoke_enabled(
                std::env::var("HARKROOM_PRINCIPAL_INVOKE").ok().as_deref(),
            ),
        },
    )
    .await
}

/// 이 글의 사슬 자리 — TS `mentionDepthFor`(원인 없는 판)의 앞 고리와 그 위에서 정한 이 글의 정체 홉·사슬 시작.
#[derive(Debug, Default)]
struct Chain {
    /// 이 글의 깊이(앞 고리 + 1, 사슬 밖이면 0).
    depth: i32,
    /// 앞 고리의 정체 홉(사람 고리는 0).
    prev_stall: i32,
    /// TS `chainStartedAt` — 사슬 안의 에이전트 글만 갖는다(앞 고리에 없으면 지금).
    started_ms: Option<i64>,
    now_ms: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// TS `mentionDepthFor`(원인 없는 판 — REST 에는 원인이 없다). 이 대화에서 나를 **실제로 깨운**(inbox 가 생긴) 부름 가운데
/// 가장 최근 하나가 앞 고리다. 없으면 사슬 밖(0). 에이전트 고리면 그 고리의 정체·사슬 시작을, 사람 고리면 0·그 글 시각을 물려받는다.
async fn chain_link(
    conn: &mut sqlx::PgConnection,
    channel: &str,
    root: Option<&str>,
    author: &str,
) -> Result<Chain, sqlx::Error> {
    type Row = (String, bool, bool, i32, i32, i64, Option<i64>);
    let rows: Vec<Row> = sqlx::query_as(sql().depth_scan.as_str())
        .bind(channel)
        .bind(root)
        .bind(author)
        .fetch_all(&mut *conn)
        .await?;
    let now = now_ms();
    let hit = rows.iter().find(|(body, row_agent, woke, ..)| {
        *woke
            && split_mention_calls(body, *row_agent, |id| id == author)
                .call
                .iter()
                .any(|c| c == author)
    });
    Ok(match hit {
        None => Chain {
            now_ms: now,
            ..Chain::default()
        },
        Some((_, row_agent, _, depth, stall, created, chain_started)) => Chain {
            depth: depth + 1,
            prev_stall: if *row_agent { *stall } else { 0 },
            started_ms: Some(if *row_agent {
                chain_started.unwrap_or(*created)
            } else {
                *created
            }),
            now_ms: now,
        },
    })
}

/// 밀리초 시각을 ISO 8601(UTC, 밀리초)로 — TS 가 `Date` 를 넘기는 것과 같은 값을 `$11::timestamptz` 에 넣는다.
fn iso_ms(ms: i64) -> String {
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
    let s = sql();
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
    if let (true, Some(r)) = (author_is_agent, root) {
        sqlx::query("select pg_advisory_xact_lock($1, hashtext($2))")
            .bind(s.reply_lock_class)
            .bind(format!("{author}:{r}"))
            .execute(&mut *tx)
            .await?;
    }
    let v2 = delegation_v2(std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref());
    // TS `mentionDepthFor` — 사람 글은 언제나 사슬 밖이다. 원인이 있으면 먼저 그 원인에서 물려받고(C1c-4c), 원인이 나를 깨운
    // 것이 아니면 스레드 스캔으로 간다.
    let from_cause = match (author_is_agent, origin.cause) {
        (true, Some(c)) => cause_link::cause_depth(&mut tx, author, c).await?,
        _ => None,
    };
    let mut link = if let Some(c) = from_cause {
        Chain {
            depth: c.depth,
            prev_stall: c.prev_stall,
            started_ms: c.started_ms,
            now_ms: now_ms(),
        }
    } else if author_is_agent {
        chain_link(&mut tx, channel, root, author).await?
    } else {
        Chain {
            now_ms: now_ms(),
            ..Chain::default()
        }
    };
    // 정체 홉(146) — 사슬 안의 에이전트 글만 센다. **그림자다**: 막지 않고 막았을 부름만 meta 에 남긴다(아래).
    let stall = if author_is_agent && link.depth > 0 {
        let recent: Vec<String> = sqlx::query_scalar(s.recent_bodies.as_str())
            .bind(channel)
            .bind(root)
            .fetch_all(&mut *tx)
            .await?;
        let ids = chain_stall::message_link_ids(body);
        let own: HashSet<String> = if ids.is_empty() {
            HashSet::new()
        } else {
            sqlx::query_scalar::<_, String>(s.own_links.as_str())
                .bind(&ids)
                .bind(channel)
                .bind(root)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .collect()
        };
        chain_stall::stall_step(
            link.depth,
            link.prev_stall,
            body,
            &recent,
            !attachment_ids.is_empty(),
            &own,
        )
    } else {
        chain_stall::StallStep::default()
    };
    // 사슬의 시작 시각(147) — 앞 고리가 시작이면(사람 고리) 그 글 시각, 사슬 밖이면 없다.
    if link.depth > 0 && link.started_ms.is_none() {
        link.started_ms = Some(link.now_ms);
    }
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
    let calls = resolve_post(
        &mut tx,
        channel,
        author,
        author_is_agent,
        body,
        root,
        &link,
        principal.as_ref().map(|(p, _)| p.as_str()),
    )
    .await?;
    // 에이전트 글의 아직 TS 몫인 부수효과 — 상한에 막힌 부름(백스톱 카드)·암묵 위임을 적을 수 있는 부름(C1c-4d).
    if author_is_agent
        && (!calls.capped_ids.is_empty()
            || (!calls.called_ids.is_empty()
                && !implicit_known_off(
                    v2,
                    std::env::var("HARKROOM_DELEGATION_IMPLICIT")
                        .ok()
                        .as_deref(),
                )))
    {
        tx.rollback().await?;
        return Ok(Outcome::ToTs);
    }
    sqlx::query(s.lock.as_str())
        .bind(s.lock_class)
        .bind(channel)
        .execute(&mut *tx)
        .await?;
    if let Some(r) = root {
        let ts: bool = sqlx::query_scalar(TS_THREAD_SQL)
            .bind(r)
            .bind(author)
            .bind(question_only(body))
            .bind(v2.is_some())
            .fetch_one(&mut *tx)
            .await?;
        if ts {
            tx.rollback().await?;
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
    // TS `stallShadowFor` — 정체 한도가 막았을 부름(부른 에이전트만, 부른 순서). 상한에 막힌 부름은 위 가드가 이미 TS 로 넘겼다.
    // TS `{...input.meta, ...calls.callMeta, turnId?, mentionStall…}` — 입력 meta(모델 신고) 위에 부름 meta 가 얹힌다.
    let mut meta = origin.meta.clone();
    for (k, v) in &calls.call_meta {
        meta.insert(k.clone(), v.clone());
    }
    if let (true, Some(t)) = (author_is_agent, origin.turn_id) {
        meta.insert("turnId".into(), Value::String(t.to_owned()));
    }
    if stall.stall_depth >= STALL_HOP_LIMIT {
        let called: Vec<&String> = calls
            .called_ids
            .iter()
            .filter(|c| c.as_str() != author && !calls.capped_ids.contains(c.as_str()))
            .collect();
        if !called.is_empty() {
            let agents: HashSet<String> = sqlx::query_scalar::<_, String>(s.stall_shadow.as_str())
                .bind(&called)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .collect();
            let mut seen = HashSet::new();
            let would: Vec<&String> = called
                .into_iter()
                .filter(|c| agents.contains(c.as_str()) && seen.insert(c.as_str()))
                .collect();
            if !would.is_empty() {
                meta.insert(
                    "mentionStallShadow".into(),
                    json!({ "wouldCap": would, "stallDepth": stall.stall_depth, "limit": STALL_HOP_LIMIT }),
                );
            }
        }
    }
    if stall.link_only_reset {
        meta.insert("mentionStallLinkReset".into(), Value::Bool(true));
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
        .bind("user")
        .bind(Value::Object(meta).to_string())
        .bind(input.also_in_channel)
        .bind(link.depth)
        .bind(cause_link_id)
        .bind(stall.stall_depth)
        .bind(link.started_ms.map(iso_ms))
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
    let Some(row) = message_by_id(&mut *tx, &id).await? else {
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
    let called = notified_in_order(&mut tx, &id, &notified_set).await?;
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
    let mandate = match (author_is_agent, root) {
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
    // TS `deletedRoot` — 머리가 지워져 있었으면 커밋 뒤 목록에 다시 물어 `message.updated` 로 되돌린다(아래).
    let deleted_root = match root {
        Some(r) => thread_reply(&mut tx, r, author, channel, &id, &mut notified_set).await?,
        None => false,
    };
    // TS 와 같이 `thread_reply` 뒤 — DM 이면 상대에게 `dm`(사람 글은 언제나 답글로 세어지고 시스템 줄이 아니다).
    if is_dm {
        dm_notify(&mut tx, channel, author, root, &id, &mut notified_set).await?;
    }
    // TS 와 같이 부름·`thread_reply` 를 다 넣은 뒤 — 이 글이 부른 계정의 깨움은 접고 나머지는 깨운다.
    // TS `preemptWakesForThread` 는 사람 글만 본다.
    let preempted = match (author_is_agent, root) {
        (false, Some(r)) => wake_preempt::preempt(&mut tx, r, author, &id, &notified_set).await?,
        _ => wake_preempt::Preempted::default(),
    };
    // TS `closeReplyGrants` — 결과를 냈으니 이 스레드에서 받은 회신권을 닫는다(이 글은 위에서 이미 게이트를 지났다).
    if let (true, Some(r)) = (author_is_agent, root) {
        sqlx::query(s.reply_close.as_str())
            .bind(author)
            .bind(r)
            .execute(&mut *tx)
            .await?;
    }
    // TS `closeDelegationsForReply`(선점 뒤, 같은 tx) — 사람 글은 결과(`report`·`fail`)가 아니라 닫지 않고 깨우지 않는다:
    // 기한만 밀고, v1 이면 「대기 중 update」로 적는다(턴 끝에 TS 스위퍼가 넘긴 쪽에 보낸다). 스위치를 모르면 위 가드가 이미 TS 로 넘겼다.
    if let (Some(r), Some(on)) = (root, v2) {
        sqlx::query(s.deleg_touch.as_str())
            .bind(author)
            .bind(r)
            .bind(DELEGATION_SILENCE_SEC)
            .execute(&mut *tx)
            .await?;
        if on {
            sqlx::query(s.deleg_pending.as_str())
                .bind(author)
                .bind(r)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
    }
    let notified = notified_in_order(&mut tx, &id, &notified_set).await?;
    // TS 는 선점 신호를 `postMessage` 안(커밋 뒤)에서, `message.created` 는 라우트가 그 뒤에 낸다 — 같은 순서로 outbox 에.
    wake_preempt::announce(&mut tx, &preempted).await?;
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
    for a in &notified {
        crate::write::emit_event(&mut tx, &json!({ "type": "inbox.updated", "accountId": a }))
            .await?;
    }
    // TS 라우트는 `inbox.updated` 뒤에 `closeAsksByReply` 를 부른다(사람 글만) — 이 답보다 앞선 열린 카드를 `replied` 로 닫는다.
    if let (false, Some(r)) = (author_is_agent, root) {
        let seq = row_value
            .get("seq")
            .and_then(Value::as_i64)
            .ok_or(sqlx::Error::RowNotFound)?;
        ask_reply_close::close_by_reply(&mut tx, r, channel, seq, author, &id).await?;
    }
    tx.commit().await?;
    Ok(Outcome::Posted {
        row,
        notified,
        mandate,
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
) -> Result<Vec<String>, sqlx::Error> {
    if set.is_empty() {
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

fn json_response(status: StatusCode, row: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        row,
    )
        .into_response()
}

/// `POST /channels/{id}/messages`.
pub async fn post(
    State(st): State<Arc<PostState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
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
    if !(human_session || author_is_agent) || parsed.as_ref().is_some_and(ts_keys) {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    if !is_uuid(&id) {
        return bad();
    }
    let Some(input) = parsed.as_ref().and_then(parse_post) else {
        return bad();
    };
    if ts_body(&input.body) {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
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
        &st,
        &id,
        &me.id,
        author_is_agent,
        &input,
        key.as_deref(),
        &audience,
        is_dm,
        &Origin::default(),
    )
    .await
    {
        Err(e) => internal(e),
        // 세 사유를 400 하나로 합친다 — TS 와 같이, 남의 업로드 id 가 있는지 알리는 신호가 되지 않게.
        Ok(Outcome::ToTs) => to_ts(st.up.clone(), peer, parts, bytes).await,
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
    st: PostState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PostState>>::new()
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
        // 값이 없거나 비면 모른다 → TS 로 넘긴다. 있으면 TS `delegationV2Enabled` 와 같은 낱말로 갈린다.
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
        assert!(ts_keys(&json!({ "body": "x", "threadRootId": "bad" })));
        assert!(ts_keys(&json!({ "body": "x", "agentModels": [] })));
    }
}
