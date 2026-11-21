//! S5.4 CH4b-2 — 멤버 넣기·빼기 2줄. TS `routes/channelRoutes.ts` 의 `POST /channels/:id/members`·
//! `DELETE /channels/:id/members/:accountId` 와 `memberSystemMessage` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다):
//!   - 넣기: 본문 읽기 → 인증(401) → 경로·본문(400) → 볼 수 있나(403) → 게이트(404·400 `channel_archived`·400 `channel_is_dm`)
//!     → 계정 있나(404) → 멤버 행(멱등) → 감사 → `channel.member_added`(목록 수신자) → 넣은 사람에게 `channel.created`
//!     → 시스템 글(`kind: system`) → 멤버 목록.
//!   - 빼기: 인증(401) → 경로(400) → 남이면 admin 만(403) → 나면 볼 수 있나(403) → 게이트(나가기는 보관 채널도 통과)
//!     → 행을 지웠으면 감사 → `channel.member_removed` → 목록을 잃었으면 `channel.deleted` → (보관 채널이 아니면) 시스템 글 → 멤버 목록.
//! - 시스템 글은 TS 와 같이 **멤버 행이 커밋된 뒤** 따로 올린다([`post_in_tx`], [`Origin::system`]) — 그래야 `audienceFor` 가
//!   넣은 사람까지 센다. 본문은 자리표시자뿐이고 대상은 `meta.accountId`, 번역 표지는 `meta.i18n` 이다. 늘 최상위 글이고(DM 은
//!   게이트가 먼저 막는다) 본문에 `@` 가 없어 부름이 없다.
//! - 문장·본문은 TS 정본을 골든(`channel_membership_gate`·`member_account_exists`·`add_channel_member`·`remove_channel_member`·
//!   `channel_row`·`list_channel_members`·`member_system_bodies`)으로 받는다.
//! - 권한은 [`MEMBER_PRIVILEGES`] 와 글 올리기 권한 — 둘 다 있어야 `main.rs` 가 붙인다(없으면 TS 에 남는다).
use super::audience::{audience_for, channel_list_audience, channel_list_lost_audience};
use super::channels::{frag, is_uuid, rows_sql};
use super::msg_post::{Origin, Outcome, PostBody, PostState, post_in_tx};
use super::msg_read::channel_visible;
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, emit_event, record_audit};
use crate::writes_settings::{body_then, ip_of};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 이 줄들이 쓰는 권한(표·칸, 권한) — homelab GRANT 와 같아야 한다. 시스템 글은 따로 글 올리기 권한
/// ([`super::msg_post::MESSAGE_POST_PRIVILEGES`])을 본다.
pub const MEMBER_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("channel_member", "INSERT"),
    ("channel_member", "DELETE"),
    ("account", "SELECT"),
    ("audit_log", "INSERT"),
];

#[derive(Clone)]
pub struct MembersState {
    /// 시스템 글을 올리는 글 경로의 상태 — 판정·쓰기는 그 쓰기 풀(`post.write`)에서 한다.
    pub post: PostState,
    pub trust: TrustProxy,
}

struct Sql {
    row: String,
    members: String,
    bodies: Map<String, Value>,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| Sql {
        row: rows_sql(frag("channel_row"), &["archivedAt", "createdAt"]),
        members: rows_sql(frag("list_channel_members"), &[]),
        bodies: serde_json::from_str(frag("member_system_bodies"))
            .expect("golden member_system_bodies"),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Event {
    Added,
    Left,
    Removed,
}

impl Event {
    fn name(self) -> &'static str {
        match self {
            Event::Added => "added",
            Event::Left => "left",
            Event::Removed => "removed",
        }
    }
}

/// TS `memberSystemMessage` — 본문과 `meta` 를 함께 만든다. 남이 넣고 내보낸 줄은 누가 했는지(`…By`)를 번역 표지에 싣는다.
fn system_message(event: Event, account: &str, actor: &str) -> (String, Map<String, Value>) {
    let body = sql().bodies[event.name()]
        .as_str()
        .expect("golden member body")
        .to_owned();
    let i18n = if actor != account && event != Event::Left {
        let key = if event == Event::Added {
            "system.member.addedBy"
        } else {
            "system.member.removedBy"
        };
        json!({ "key": key, "args": { "actorId": actor, "accountId": account } })
    } else {
        json!({ "key": format!("system.member.{}", event.name()), "args": { "accountId": account } })
    };
    let mut meta = Map::new();
    meta.insert("accountId".into(), Value::String(account.to_owned()));
    meta.insert("actorId".into(), Value::String(actor.to_owned()));
    meta.insert("i18n".into(), i18n);
    (body, meta)
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태만 본다.
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

fn forbidden(msg: &str) -> Response {
    json_err(StatusCode::FORBIDDEN, "forbidden", msg)
}

/// zod `{ accountId: z.string().uuid() }`. 남는 키는 버린다.
fn parse_add(body: &Body) -> Option<String> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    m.get("accountId")?
        .as_str()
        .filter(|s| is_uuid(s))
        .map(str::to_string)
}

/// TS `channelMembershipGate`.
#[derive(Debug, PartialEq, Eq)]
enum Gate {
    Ok,
    NotFound,
    Archived,
    Dm,
}

async fn gate(pool: &PgPool, channel: &str) -> sqlx::Result<Gate> {
    let row: Option<(String, bool)> = sqlx::query_as(frag("channel_membership_gate"))
        .bind(channel)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        None => Gate::NotFound,
        Some((_, true)) => Gate::Archived,
        Some((k, false)) if k == "dm" => Gate::Dm,
        Some(_) => Gate::Ok,
    })
}

fn gate_reject(g: &Gate) -> Response {
    match g {
        Gate::NotFound => json_err(StatusCode::NOT_FOUND, "not_found", "no such channel"),
        Gate::Archived => json_err(
            StatusCode::BAD_REQUEST,
            "channel_archived",
            "archived channels are read-only",
        ),
        _ => json_err(
            StatusCode::BAD_REQUEST,
            "channel_is_dm",
            "a dm has no membership to edit",
        ),
    }
}

async fn audit(
    st: &MembersState,
    parts: &axum::http::request::Parts,
    me: &Account,
    action: &str,
    channel: &str,
    account: &str,
) {
    let ip = ip_of(parts, &st.trust);
    record_audit(
        &st.post.write,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(channel),
            ip: ip.as_deref(),
            detail: json!({ "accountId": account }),
        },
    )
    .await;
}

/// 커밋 뒤 이벤트 하나를 버스(outbox)로 낸다.
async fn publish(pool: &PgPool, event: Value) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    emit_event(&mut conn, &event).await.map(|_| ())
}

/// 시스템 글 — TS `postMessage(kind: 'system')` 다음 `emitPosted(audienceFor)`. `message.created` 는 글 경로가 같은 tx 의 outbox 로 낸다.
async fn post_system(
    st: &MembersState,
    channel: &str,
    me: &Account,
    event: Event,
    account: &str,
) -> sqlx::Result<()> {
    let (body, meta) = system_message(event, account, &me.id);
    let audience = audience_for(&st.post.write, channel).await?.to_json();
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: None,
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        ..Origin::default()
    };
    match post_in_tx(
        &st.post,
        channel,
        &me.id,
        me.kind == "agent",
        &input,
        None,
        &audience,
        false,
        &origin,
    )
    .await?
    {
        Outcome::Posted { .. } => Ok(()),
        // 최상위 시스템 글에는 닿지 않는 갈래다(머리·첨부·위임이 없다). 멤버 행은 이미 커밋됐다 — TS 의 `if (added.message)` 처럼
        // 글 없이 지나가되 흔적은 남긴다.
        other => {
            eprintln!(
                "[channelMembers] system line not posted: {}",
                match other {
                    Outcome::ToTs => "to_ts",
                    Outcome::BadThread => "bad_thread",
                    Outcome::BadAttachment => "bad_attachment",
                    Outcome::Rejected(_) => "rejected",
                    Outcome::Replayed(_) => "replayed",
                    Outcome::Posted { .. } => "posted",
                }
            );
            Ok(())
        }
    }
}

async fn members_list(st: &MembersState, channel: &str) -> Response {
    match sqlx::query_scalar::<_, String>(sql().members.as_str())
        .bind(channel)
        .fetch_one(&st.post.write)
        .await
    {
        Ok(r) => json_ok(format!("{{\"members\":{r}}}")),
        Err(e) => internal(e),
    }
}

/// `POST /channels/{id}/members` — 그 채널을 볼 수 있는 사람이면 누구나(admin 전용이 아니다).
pub async fn add(
    State(st): State<Arc<MembersState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_uuid(&id) {
        return bad("params");
    }
    let Some(account) = parse_add(&body) else {
        return bad("body");
    };
    let w = &st.post.write;
    match channel_visible(w, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => return forbidden("not a member of this channel"),
        Err(e) => return internal(e),
    }
    match gate(w, &id).await {
        Ok(Gate::Ok) => {}
        Ok(g) => return gate_reject(&g),
        Err(e) => return internal(e),
    }
    match sqlx::query(frag("member_account_exists"))
        .bind(&account)
        .fetch_optional(w)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such account"),
        Err(e) => return internal(e),
    }
    if let Err(e) = sqlx::query(frag("add_channel_member"))
        .bind(&id)
        .bind(&account)
        .execute(w)
        .await
    {
        return internal(e);
    }
    audit(&st, &parts, &me, "channel.member.added", &id, &account).await;
    let list_aud = match channel_list_audience(w, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    if let Err(e) = publish(
        w,
        json!({ "type": "channel.member_added", "channelId": id, "accountId": account, "audience": list_aud }),
    )
    .await
    {
        return internal(e);
    }
    let rows: String = match sqlx::query_scalar(sql().row.as_str())
        .bind(&id)
        .fetch_one(w)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let row: Value = serde_json::from_str(&rows).unwrap_or(Value::Null);
    if let Some(channel) = row.get(0)
        && let Err(e) = publish(
            w,
            json!({ "type": "channel.created", "channel": channel, "audience": [account] }),
        )
        .await
    {
        return internal(e);
    }
    if let Err(e) = post_system(&st, &id, &me, Event::Added, &account).await {
        return internal(e);
    }
    members_list(&st, &id).await
}

/// `DELETE /channels/{id}/members/{accountId}` — 나가기는 누구나, 남을 빼기는 admin 만.
pub async fn remove(
    State(st): State<Arc<MembersState>>,
    Path((id, account)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_uuid(&id) || !is_uuid(&account) {
        return bad("params");
    }
    let is_self = account == me.id;
    if !is_self && !me.is_admin {
        return forbidden("only admin can remove others");
    }
    let w = &st.post.write;
    if is_self {
        match channel_visible(w, &me.id, &id).await {
            Ok(true) => {}
            Ok(false) => return forbidden("not a member of this channel"),
            Err(e) => return internal(e),
        }
    }
    let g = match gate(w, &id).await {
        Ok(g) => g,
        Err(e) => return internal(e),
    };
    match g {
        Gate::Ok => {}
        // 나가기는 보관 채널도 통과한다(#344).
        Gate::Archived if is_self => {}
        _ => return gate_reject(&g),
    }
    let removed = match sqlx::query(frag("remove_channel_member"))
        .bind(&id)
        .bind(&account)
        .execute(w)
        .await
    {
        Ok(r) => r.rows_affected() > 0,
        Err(e) => return internal(e),
    };
    if removed {
        audit(&st, &parts, &me, "channel.member.removed", &id, &account).await;
        let list_aud = match channel_list_audience(w, &id).await {
            Ok(a) => a.to_json(),
            Err(e) => return internal(e),
        };
        if let Err(e) = publish(
            w,
            json!({ "type": "channel.member_removed", "channelId": id, "accountId": account, "audience": list_aud }),
        )
        .await
        {
            return internal(e);
        }
        let lost = match channel_list_lost_audience(w, &id).await {
            Ok(l) => l,
            Err(e) => return internal(e),
        };
        if lost.contains(&account)
            && let Err(e) = publish(
                w,
                json!({ "type": "channel.deleted", "channelId": id, "audience": [account] }),
            )
            .await
        {
            return internal(e);
        }
        // 보관 채널에는 시스템 글을 남기지 않는다(#344) — 판정은 위 게이트 그대로.
        if g != Gate::Archived {
            let event = if is_self { Event::Left } else { Event::Removed };
            if let Err(e) = post_system(&st, &id, &me, event, &account).await {
                return internal(e);
            }
        }
    }
    members_list(&st, &id).await
}

/// 코어 라우터에 합칠 줄 — `channel_create_update.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
/// 같은 경로의 `GET /channels/{id}/members` 는 읽기 코어(`channels.rs`)가 붙였다.
pub fn routes(
    st: MembersState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<MembersState>>::new()
        .post("/channels/{id}/members", add)
        .delete("/channels/{id}/members/{accountId}", remove)
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

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";

    #[test]
    fn body_like_zod() {
        let p = |v: Value| parse_add(&Body::Json(v));
        assert_eq!(p(json!({ "accountId": A, "x": 1 })), Some(A.into()));
        assert!(p(json!({ "accountId": "nope" })).is_none());
        assert!(p(json!({ "accountId": null })).is_none());
        assert!(p(json!({})).is_none());
        assert!(parse_add(&Body::None).is_none());
    }

    #[test]
    fn system_message_like_ts() {
        let (b, m) = system_message(Event::Added, A, A);
        assert_eq!(b, "{account}님이 채널에 추가되었습니다.");
        assert_eq!(
            Value::Object(m),
            json!({ "accountId": A, "actorId": A,
                    "i18n": { "key": "system.member.added", "args": { "accountId": A } } })
        );
        let (_, m) = system_message(Event::Added, A, B);
        assert_eq!(m["i18n"]["key"], "system.member.addedBy");
        assert_eq!(m["i18n"]["args"], json!({ "actorId": B, "accountId": A }));
        let (b, m) = system_message(Event::Removed, A, B);
        assert_eq!(b, "{account}님이 채널에서 제거되었습니다.");
        assert_eq!(m["i18n"]["key"], "system.member.removedBy");
        let (b, m) = system_message(Event::Left, A, A);
        assert_eq!(b, "{account}님이 채널에서 나갔습니다.");
        assert_eq!(m["i18n"]["key"], "system.member.left");
    }
}
