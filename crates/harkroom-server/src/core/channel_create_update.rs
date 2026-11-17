//! S5.4 CH4a — 채널 만들기·고치기 2줄. TS `routes/channelRoutes.ts` 의 `POST /channels`·`PATCH /channels/:id` 와
//! `services/channels.ts`(`createChannel`·`updateChannel`) 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문 읽기 → 인증(401) → `requireCap`(403) → 경로·본문(400) → 쓰기.
//!   - 만들기: `channel.create`(대상 없음). private 이면 채널 행과 만든 사람의 멤버 행을 **한 트랜잭션**으로 넣는다
//!     (둘 사이에서 끊기면 아무도 못 여는 채널이 남는다). 커밋 뒤 `channel.created`(목록 수신자) → 201.
//!   - 고치기: `channel.manage`(경로의 채널). 이름·공개 범위가 오면 고치기 **전** 의 이름·공개 범위를 읽는다(감사 from,
//!     비공개화 판정). 이름 겹침(23505)은 409 `channel_name_taken`, 0 행(없음·DM)은 404. 커밋 뒤 public→private 이면
//!     목록을 잃은 계정에게 `channel.deleted`, 그다음 `channel.updated`. 감사는 TS 와 같은 갈래·차례.
//! - 지우기(`DELETE /channels/{id}`)와 `GET /channels/{id}/delete-info` 는 **TS 에 남는다** — 지운 뒤 첨부 파일을 저장소에서
//!   지워야 하는데 Rust 에는 첨부 저장소가 없다(옮기면 파일이 고아로 남는다).
//! - 문장은 TS 정본을 골든(`create_channel`·`update_channel`·`channel_name_visibility`·`add_channel_member`)으로 받는다.
//! - 권한은 [`CREATE_UPDATE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::audience::{channel_list_audience, channel_list_lost_audience};
use super::channels::{dml_rows_sql, frag, is_uuid};
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::perm::{Target, TargetKind, require_cap};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, emit_event, record_audit};
use crate::writes_settings::{body_then, ip_of};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 이 줄들이 쓰는 권한(표·칸, 권한) — homelab GRANT 와 같아야 한다. 쓴 행을 바로 읽어 답하고(returning),
/// 목록 수신자 계산이 `account`·`channel_member` 를 읽으므로 SELECT 도 쓰기 풀에서 본다.
pub const CREATE_UPDATE_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel.name", "INSERT"),
    ("channel.topic", "INSERT"),
    ("channel.kind", "INSERT"),
    ("channel.repo", "INSERT"),
    ("channel.visibility", "INSERT"),
    ("channel.created_by", "INSERT"),
    ("channel.name", "UPDATE"),
    ("channel.topic", "UPDATE"),
    ("channel.repo", "UPDATE"),
    ("channel.archived_at", "UPDATE"),
    ("channel.archived_by", "UPDATE"),
    ("channel.visibility", "UPDATE"),
    ("channel_member", "SELECT"),
    ("channel_member", "INSERT"),
    ("account", "SELECT"),
    ("audit_log", "INSERT"),
];

/// shared `CHANNEL_NAME_PATTERN` = `^[a-z0-9_-]{1,48}$`.
fn name_ok(s: &str) -> bool {
    (1..=48).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// zod `string().max(n)` — UTF-16 길이.
fn max16(s: &str, n: usize) -> bool {
    s.encode_utf16().count() <= n
}

#[derive(Clone)]
pub struct CreateUpdateState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: TrustProxy,
}

struct Sql {
    create: String,
    update: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| Sql {
        create: dml_rows_sql(frag("create_channel"), &["archivedAt", "createdAt"]),
        update: dml_rows_sql(frag("update_channel"), &["archivedAt", "createdAt"]),
    })
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태만 본다(`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

/// 한 행짜리 결과(`[{…}]`)에서 그 행의 JSON 글자를 꺼낸다 — 칸 순서를 지키려고 다시 직렬화하지 않는다.
fn only_row(rows: &str) -> Option<&str> {
    let inner = rows.strip_prefix('[')?.strip_suffix(']')?;
    (!inner.is_empty()).then_some(inner)
}

/// 만들기 본문 — zod `{ name: regex, topic?: ≤256, repo?: ≤128, visibility?: public|private }`. 남는 키는 버린다.
#[derive(Debug, PartialEq)]
struct CreateBody {
    name: String,
    topic: Option<String>,
    repo: Option<String>,
    visibility: Option<&'static str>,
}

fn visibility(v: &Value) -> Option<&'static str> {
    match v.as_str()? {
        "public" => Some("public"),
        "private" => Some("private"),
        _ => None,
    }
}

/// `optional()` 칸: 없으면 Ok(None), 있으면 검사(null 도 거절).
fn opt_str(m: &Map<String, Value>, k: &str, max: usize) -> Result<Option<String>, ()> {
    match m.get(k) {
        None => Ok(None),
        Some(Value::String(s)) if max16(s, max) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

fn parse_create(body: &Body) -> Option<CreateBody> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let name = m.get("name")?.as_str()?;
    if !name_ok(name) {
        return None;
    }
    let topic = opt_str(m, "topic", 256).ok()?;
    let repo = opt_str(m, "repo", 128).ok()?;
    let visibility = match m.get("visibility") {
        None => None,
        Some(v) => Some(visibility(v)?),
    };
    Some(CreateBody {
        name: name.to_string(),
        topic,
        repo,
        visibility,
    })
}

/// 고치기 본문 — zod `{ name?, topic?, repo?: string|null, archived?: bool, visibility? }`. 키가 없으면 손대지 않는다.
#[derive(Debug, PartialEq, Default)]
struct PatchBody {
    name: Option<String>,
    topic: Option<String>,
    /// `None` 키 없음 · `Some(None)` 바인딩 해제 · `Some(Some(r))`.
    repo: Option<Option<String>>,
    archived: Option<bool>,
    visibility: Option<&'static str>,
}

fn parse_patch(body: &Body) -> Option<PatchBody> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let name = match m.get("name") {
        None => None,
        Some(Value::String(s)) if name_ok(s) => Some(s.clone()),
        Some(_) => return None,
    };
    let topic = opt_str(m, "topic", 256).ok()?;
    let repo = match m.get("repo") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if max16(s, 128) => Some(Some(s.clone())),
        Some(_) => return None,
    };
    let archived = match m.get("archived") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return None,
    };
    let visibility = match m.get("visibility") {
        None => None,
        Some(v) => Some(visibility(v)?),
    };
    Some(PatchBody {
        name,
        topic,
        repo,
        archived,
        visibility,
    })
}

impl PatchBody {
    /// `channel.updated` 감사의 `fields` — zod 출력 키 차례(스키마 차례)에서 archived·visibility·name 을 뺀 것.
    fn plain_fields(&self) -> Vec<&'static str> {
        let mut f = vec![];
        if self.topic.is_some() {
            f.push("topic");
        }
        if self.repo.is_some() {
            f.push("repo");
        }
        f
    }
}

async fn audit(
    st: &CreateUpdateState,
    parts: &axum::http::request::Parts,
    me: &Account,
    action: &str,
    channel: &str,
    detail: Value,
) {
    let ip = ip_of(parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(channel),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
}

/// 커밋 뒤 이벤트 하나를 버스(outbox)로 낸다.
async fn publish(pool: &PgPool, event: Value) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    emit_event(&mut conn, &event).await.map(|_| ())
}

/// `POST /channels` — `channel.create`. 201 과 만든 행.
pub async fn create(State(st): State<Arc<CreateUpdateState>>, req: Request) -> Response {
    let (body, RequireAccount(_, auth), _parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let me = match require_cap(&st.read, &auth, "channel.create", None).await {
        Ok(m) => m,
        Err(r) => return r,
    };
    let Some(input) = parse_create(&body) else {
        return bad("body");
    };
    let visibility = input.visibility.unwrap_or("public");
    let topic = input.topic.unwrap_or_default();
    let mut tx = match st.write.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let rows: String = match sqlx::query_scalar(sql().create.as_str())
        .bind(&input.name)
        .bind(&topic)
        .bind(input.repo.as_deref())
        .bind(visibility)
        .bind(&me.id)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(r) => r,
        // 이름 겹침도 TS 는 잡지 않는다(23505 → 500). 같게 둔다.
        Err(e) => return internal(e),
    };
    let Some(row) = only_row(&rows).map(str::to_string) else {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    let v: Value = serde_json::from_str(&row).unwrap_or(Value::Null);
    let Some(id) = v.get("id").and_then(Value::as_str).map(str::to_string) else {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    // private 이면 만든 사람이 첫 멤버다 — 같은 트랜잭션에서.
    if visibility == "private"
        && let Err(e) = sqlx::query(frag("add_channel_member"))
            .bind(&id)
            .bind(&me.id)
            .execute(&mut *tx)
            .await
    {
        return internal(e);
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    // 삽입이 커밋된 뒤에 발행한다(#284).
    let audience = match channel_list_audience(&st.write, &id).await {
        Ok(a) => a,
        Err(e) => return internal(e),
    };
    if let Err(e) = publish(
        &st.write,
        json!({ "type": "channel.created", "channel": v, "audience": audience.to_json() }),
    )
    .await
    {
        return internal(e);
    }
    let mut r = json_ok(row);
    *r.status_mut() = StatusCode::CREATED;
    r
}

/// `PATCH /channels/{id}` — `channel.manage`(그 채널).
pub async fn update(
    State(st): State<Arc<CreateUpdateState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(_, auth), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let me = match require_cap(
        &st.read,
        &auth,
        "channel.manage",
        Some(Target {
            kind: TargetKind::Channel,
            id: &id,
        }),
    )
    .await
    {
        Ok(m) => m,
        Err(r) => return r,
    };
    if !is_uuid(&id) {
        return bad("params");
    }
    let Some(patch) = parse_patch(&body) else {
        return bad("body");
    };
    // 고치기 전의 이름·공개 범위 — 이름이나 공개 범위가 왔을 때만 읽는다(TS 와 같다).
    let old: Option<(String, String)> = if patch.visibility.is_some() || patch.name.is_some() {
        match sqlx::query_as(frag("channel_name_visibility"))
            .bind(&id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(o) => o,
            Err(e) => return internal(e),
        }
    } else {
        None
    };
    let was_public = old.as_ref().is_some_and(|(_, v)| v == "public");
    let old_name = old.map(|(n, _)| n);
    let rows: String = match sqlx::query_scalar(sql().update.as_str())
        .bind(&id)
        .bind(patch.topic.is_some())
        .bind(patch.topic.as_deref())
        .bind(patch.repo.is_some())
        .bind(patch.repo.clone().flatten())
        .bind(patch.archived)
        .bind(if patch.archived == Some(true) {
            Some(me.id.as_str())
        } else {
            None
        })
        .bind(patch.visibility.is_some())
        .bind(patch.visibility)
        .bind(patch.name.is_some())
        .bind(patch.name.as_deref())
        .fetch_one(&st.write)
        .await
    {
        Ok(r) => r,
        // `channel.name` 은 유니크다 — 미리 조회하지 않고 DB 의 판정을 409 로 옮긴다(TS 와 같다, 창이 없다).
        Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("23505") => {
            return json_err(
                StatusCode::CONFLICT,
                "channel_name_taken",
                "this channel name is already taken",
            );
        }
        Err(e) => return internal(e),
    };
    let Some(row) = only_row(&rows).map(str::to_string) else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel");
    };
    let v: Value = serde_json::from_str(&row).unwrap_or(Value::Null);
    // 발행은 커밋 뒤다(#284). 비공개화 전환이면 목록을 잃은 계정에게 먼저 `channel.deleted`.
    if was_public && patch.visibility == Some("private") {
        let lost = match channel_list_lost_audience(&st.write, &id).await {
            Ok(l) => l,
            Err(e) => return internal(e),
        };
        if let Err(e) = publish(
            &st.write,
            json!({ "type": "channel.deleted", "channelId": id, "audience": lost }),
        )
        .await
        {
            return internal(e);
        }
    }
    let audience = match channel_list_audience(&st.write, &id).await {
        Ok(a) => a,
        Err(e) => return internal(e),
    };
    if let Err(e) = publish(
        &st.write,
        json!({ "type": "channel.updated", "channel": v, "audience": audience.to_json() }),
    )
    .await
    {
        return internal(e);
    }
    // 감사 — TS 와 같은 갈래·차례.
    if let Some(vis) = patch.visibility {
        audit(
            &st,
            &parts,
            &me,
            "channel.visibility.changed",
            &id,
            json!({ "visibility": vis }),
        )
        .await;
    }
    if let Some(name) = patch.name.as_deref()
        && Some(name) != old_name.as_deref()
    {
        audit(
            &st,
            &parts,
            &me,
            "channel.renamed",
            &id,
            json!({ "from": old_name, "to": name }),
        )
        .await;
    }
    match patch.archived {
        Some(true) => audit(&st, &parts, &me, "channel.archived", &id, json!({})).await,
        Some(false) => audit(&st, &parts, &me, "channel.unarchived", &id, json!({})).await,
        None => {
            let fields = patch.plain_fields();
            if !fields.is_empty() {
                audit(
                    &st,
                    &parts,
                    &me,
                    "channel.updated",
                    &id,
                    json!({ "fields": fields }),
                )
                .await;
            }
        }
    }
    json_ok(row)
}

/// 코어 라우터에 합칠 줄 — `channel_auto_mention_doc.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
/// 같은 경로의 `GET /channels` 는 읽기 코어(`channels.rs`)가 붙였다. `DELETE /channels/{id}` 는 붙이지 않는다(TS 에 남는다).
pub fn routes(
    st: CreateUpdateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<CreateUpdateState>>::new()
        .post("/channels", create)
        .patch("/channels/{id}", update)
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
    fn name_like_shared_pattern() {
        assert!(name_ok("a"));
        assert!(name_ok("dev_ops-1"));
        assert!(name_ok(&"a".repeat(48)));
        assert!(!name_ok(&"a".repeat(49)));
        assert!(!name_ok(""));
        assert!(!name_ok("Dev"));
        assert!(!name_ok("a b"));
        assert!(!name_ok("한글"));
        assert!(!name_ok("a\n"));
    }

    #[test]
    fn create_body_like_zod() {
        let c = |v: Value| parse_create(&Body::Json(v));
        assert_eq!(
            c(json!({ "name": "x", "extra": 1 })),
            Some(CreateBody {
                name: "x".into(),
                topic: None,
                repo: None,
                visibility: None
            })
        );
        assert_eq!(
            c(json!({ "name": "x", "visibility": "private" }))
                .unwrap()
                .visibility,
            Some("private")
        );
        assert!(c(json!({ "name": "x", "visibility": "secret" })).is_none());
        assert!(c(json!({ "name": "x", "topic": null })).is_none());
        assert!(c(json!({ "name": "x", "repo": null })).is_none());
        assert!(c(json!({ "name": "x", "topic": "t".repeat(256) })).is_some());
        assert!(c(json!({ "name": "x", "topic": "t".repeat(257) })).is_none());
        assert!(c(json!({ "name": "x", "repo": "😀".repeat(64) })).is_some());
        assert!(c(json!({ "name": "x", "repo": "😀".repeat(65) })).is_none());
        assert!(c(json!({ "name": "X" })).is_none());
        assert!(c(json!({})).is_none());
        assert!(parse_create(&Body::None).is_none());
        assert!(parse_create(&Body::Json(Value::Null)).is_none());
    }

    #[test]
    fn patch_body_like_zod() {
        let p = |v: Value| parse_patch(&Body::Json(v));
        assert_eq!(p(json!({})), Some(PatchBody::default()));
        assert_eq!(p(json!({ "repo": null })).unwrap().repo, Some(None));
        assert_eq!(
            p(json!({ "repo": "r" })).unwrap().repo,
            Some(Some("r".into()))
        );
        assert_eq!(
            p(json!({ "archived": false })).unwrap().archived,
            Some(false)
        );
        assert!(p(json!({ "archived": null })).is_none());
        assert!(p(json!({ "name": null })).is_none());
        assert!(p(json!({ "name": "Bad" })).is_none());
        assert!(p(json!({ "topic": null })).is_none());
        assert!(p(json!({ "visibility": null })).is_none());
        assert!(parse_patch(&Body::None).is_none());
        let f =
            p(json!({ "repo": null, "name": "n", "topic": "t", "visibility": "public" })).unwrap();
        assert_eq!(f.plain_fields(), vec!["topic", "repo"]);
    }

    #[test]
    fn dml_sql_wraps_returning() {
        let s = sql();
        assert!(s.create.starts_with("with w as (insert into channel"));
        assert!(s.update.starts_with("with w as (update channel set"));
        assert!(s.update.contains("select * from w"));
    }
}
