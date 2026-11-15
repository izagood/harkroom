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
//!   아직 TS 몫인지([`TS_THREAD_SQL`] — 지워진 머리·열린 깨움·담당 위임·열린 카드면 되돌리고 TS 로) 본다. 맡으면 머리·
//!   `alsoInChannel` 을 넣고, 부름 뒤 머리의 위임을 잇고([`super::mandate_stamp::stamp_reply`]), 머리 주인에게 호출 게이트를 지난
//!   `thread_reply` 를 넣는다(TS 와 같이 위임 판정 **뒤**).
//! - **깨움 선점**(C1c-3b): 그 뒤 이 스레드의 남의 열린 깨움을 접거나(이 글이 부른 계정) 지금 깨운다([`super::wake_preempt`]).
//!   신호(`inbox.updated`·`thread.reportWakes.changed`·대기 줄 `message.updated`)는 TS 처럼 `message.created` 앞에 outbox 로.
//! - 순서(TS 와 같다): 본문 읽기(413·400·415) → 인증(401, `route_layer`) → 경로·본문 검사(400) → 쓰기 게이트(403 `forbidden`·
//!   `channel_archived`) → **쓰기 트랜잭션 하나**: seq 락(TS `lockChannelForSeq`) → 재시도 키 재생(200, 헤더 없음) → insert →
//!   첨부 잇기(실패면 되돌리고 400 `bad_attachment`) → 다시 읽기 → 재시도 키 기록 → 부름 넣기 → 위임 → `message.created`·
//!   `inbox.updated` 를 outbox 에 → 커밋 → (새 위임이면) `mandate.created` 감사 → 201.
//! - **어느 단계든 `Err` 면 트랜잭션을 버리고 500** — 글도 첨부도 남지 않는다.
//! - 문장은 전부 TS 상수를 골든으로 받는다(`post_*`·`attach_*`·`channel_post_gate`·`url_candidate_source`·
//!   `chat_approval_guard_words`). 쓰기 권한은 [`MESSAGE_POST_PRIVILEGES`] — 하나라도 없으면 `main.rs` 가 이 줄을 붙이지 않는다.
use super::audience::audience_for;
use super::invoke_gate;
use super::mandate_stamp;
use super::mention_calls::{self, Input};
use super::mention_fanout::{self, Post};
use super::msg_edit::{
    MAX_MESSAGE_BODY_CHARS, NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER, NOTIFIED_HEADER_MAX_IDS,
};
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
];
pub const MESSAGE_POST_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

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
}

/// C1c-3a 갈래 판정(TS 동작이 아니라 **어느 쪽이 맡을지**) — 이 스레드에 답하면 TS 가 아직 Rust 에 없는 부수효과를 내는가.
/// 하나라도 참이면 트랜잭션을 버리고 TS 로 넘긴다. 조건은 그 부수효과의 문장보다 넓게(같거나 더 많이 걸리게) 잡는다:
/// 지워진 머리(`rootBack`) · 작성자가 담당인 열린·보고된 위임 항목
/// (`closeDelegationsForReply` V2 의 활동 갱신) · 열린 선택 카드(`closeAsksByReply`, 받는 쪽·종류와 무관하게 전부).
/// 쓰기 트랜잭션 안 seq 락 뒤에서 읽는다 — TS 가 같은 판정을 하는 때와 같은 창이다.
const TS_THREAD_SQL: &str = "select exists(select 1 from message where id = $1::uuid and deleted_at is not null) \
     or exists(select 1 from team_delegation_item i join team_delegation d on d.id = i.delegation_id \
                where d.thread_root_id = $1::uuid and i.delegate_account_id = $2::uuid \
                  and (i.outcome is null or i.outcome = 'reported')) \
     or exists(select 1 from message where (id = $1::uuid or thread_root_id = $1::uuid) and channel_id = $3::uuid \
                and deleted_at is null and meta->>'kind' = 'ask' \
                and meta->'ask'->>'answeredWith' is null and meta->'ask'->>'closedAt' is null)";

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
struct PostBody {
    body: String,
    attachment_ids: Vec<String>,
    thread_root: Option<String>,
    /// TS 와 같이 머리가 없으면 false 로 정규화한다.
    also_in_channel: bool,
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

enum Outcome {
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

/// TS `resolveMentionCalls` 의 사람 작성자 입력 — 깊이 0, 사슬·회신권·principal 없음(`mentionDepthFor` 첫 줄).
async fn resolve_human(
    conn: &mut sqlx::PgConnection,
    channel: &str,
    author: &str,
    body: &str,
    thread_root: Option<&str>,
) -> Result<mention_calls::Resolved, sqlx::Error> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    mention_calls::resolve(
        conn,
        &Input {
            body,
            channel_id: channel,
            author_id: author,
            author_is_agent: false,
            mention_depth: 0,
            chain_bound: false,
            chain_started_at_ms: None,
            // TS 는 결과 발화면 사람 글에도 머리를 넘긴다(사람은 회신권 대상이 아니라 판정은 같다).
            reply_grant_thread_id: thread_root,
            principal: None,
            now_ms,
            principal_invoke_enabled: mention_calls::principal_invoke_enabled(
                std::env::var("HARKROOM_PRINCIPAL_INVOKE").ok().as_deref(),
            ),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn post_in_tx(
    st: &PostState,
    channel: &str,
    author: &str,
    input: &PostBody,
    idempotency_key: Option<&str>,
    audience: &Value,
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
    // TS 와 같이 멘션 해석은 seq 락 **앞**이다(그 읽기는 seq 순서와 무관하고, 락 안에서 하면 줄 선 트랜잭션이 커넥션을 쥔다).
    let calls = resolve_human(&mut tx, channel, author, body, root).await?;
    sqlx::query(s.lock.as_str())
        .bind(s.lock_class)
        .bind(channel)
        .execute(&mut *tx)
        .await?;
    if let Some(r) = root {
        let ts: bool = sqlx::query_scalar(TS_THREAD_SQL)
            .bind(r)
            .bind(author)
            .bind(channel)
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
    let id: String = sqlx::query_scalar(s.insert.as_str())
        .bind(channel)
        .bind(root)
        .bind(author)
        .bind(&calls.normalized_body)
        .bind("user")
        // 사람 글은 입력 meta 가 없다 — 부름 meta 만 얹는다(TS `{...calls.callMeta}`).
        .bind(Value::Object(calls.call_meta.clone()).to_string())
        .bind(input.also_in_channel)
        .bind(0_i32)
        .bind(None::<String>)
        .bind(0_i32)
        .bind(None::<String>)
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
    let mandate = match root {
        None => mandate_stamp::stamp_root(&mut tx, &id, author, channel, &called).await?,
        Some(r) => mandate_stamp::stamp_reply(&mut tx, &id, author, channel, r, &called).await?,
    };
    if let Some(r) = root {
        thread_reply(&mut tx, r, author, channel, &id, &mut notified_set).await?;
    }
    // TS 와 같이 부름·`thread_reply` 를 다 넣은 뒤 — 이 글이 부른 계정의 깨움은 접고 나머지는 깨운다.
    let preempted = match root {
        Some(r) => wake_preempt::preempt(&mut tx, r, author, &id, &notified_set).await?,
        None => wake_preempt::Preempted::default(),
    };
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
    for a in &notified {
        crate::write::emit_event(&mut tx, &json!({ "type": "inbox.updated", "accountId": a }))
            .await?;
    }
    tx.commit().await?;
    Ok(Outcome::Posted {
        row,
        notified,
        mandate,
    })
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
async fn thread_reply(
    conn: &mut sqlx::PgConnection,
    root: &str,
    author: &str,
    channel: &str,
    message_id: &str,
    notified: &mut HashSet<String>,
) -> Result<(), sqlx::Error> {
    let row: Option<(Option<String>, bool)> = sqlx::query_as(sql().root_author.as_str())
        .bind(root)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((Some(owner), _)) = row else {
        return Ok(());
    };
    if owner == author || notified.contains(&owner) {
        return Ok(());
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
            return Ok(());
        }
    }
    mention_fanout::insert_inbox_many(conn, &[owner], message_id, "thread_reply", notified, None)
        .await
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
    // 사람·세션이 아니거나 스레드·모델 지정 키가 있으면 판정하지 않고 넘긴다(검사도 TS 가 한다).
    let human_session = me.kind == "human" && auth.via == Some(Via::Session);
    if !human_session || parsed.as_ref().is_some_and(ts_keys) {
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
    // DM 은 받는 사람에게 `dm` 알림이 간다(C1c-3 몫).
    let kind: Option<String> = match sqlx::query_scalar(sql().channel_kind.as_str())
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(k) => k,
        Err(e) => return internal(e),
    };
    if kind.as_deref() == Some("dm") {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    let audience = match audience_for(&st.read, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let key = parts
        .headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    match post_in_tx(&st, &id, &me.id, &input, key.as_deref(), &audience).await {
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
