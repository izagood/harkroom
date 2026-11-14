//! S5.3 C1e-1 — 채널 읽기(GET) 9줄을 Rust 코어로. TS `routes/channelRoutes.ts` 의 같은 줄과 같은 문·순서·응답.
//! 핀(`/channels/{id}/pins`)과 지우기 정보(`/channels/{id}/delete-info`)까지 11줄.
//!
//! - 문장은 TS 정본을 `golden/sql_fragments.json` 으로 받아 그대로 쓴다(`list_channels` 등). TS 가 고치면
//!   `rustSqlFragments.test.ts` 가 골든 갱신을 요구하므로 Rust 만 옛 문장을 도는 일이 없다.
//! - 응답 JSON 은 Postgres 가 만든다(`json_agg(t)`, 칸 순서 = 열 순서). node-pg 가 `Date` 로 읽어 `toISOString()` 으로 내는
//!   timestamptz 칸만 줄마다 이름을 적어 그 꼴로 바꾼다([`rows_sql`]).
//! - 같은 경로의 TS 쓰기(PUT `/channels/{id}/read` 등)는 코어 경로의 TS fallback(#2133)이 TS 로 넘긴다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

fn golden() -> &'static Value {
    static G: OnceLock<Value> = OnceLock::new();
    G.get_or_init(|| {
        serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json")
    })
}

fn frag(k: &str) -> &'static str {
    golden()[k]
        .as_str()
        .unwrap_or_else(|| panic!("golden fragment {k}"))
}

/// TS 문장을 감싸 「행 배열 JSON 텍스트」 하나를 내는 문장. `ts` 에 적은 칸은 JS `toISOString()` 꼴로 바꾼다(null 은 null).
/// 행 순서는 TS 문장의 `order by` 그대로(정렬된 부분 질의를 `json_agg` 로 모으고, 펼칠 때 `with ordinality` 순서를 지킨다).
fn rows_sql(golden_sql: &str, ts: &[&str]) -> String {
    let is_ts = if ts.is_empty() {
        "false".to_string()
    } else {
        format!(
            "e.key in ({})",
            ts.iter()
                .map(|k| format!("'{k}'"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "with a as (select coalesce(json_agg(t), '[]'::json) as j from ({golden_sql}) t) \
         select coalesce(json_agg((select json_object_agg(e.key, case \
             when {is_ts} and json_typeof(e.value) = 'string' \
               then to_json(to_char((e.value #>> '{{}}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) \
             else e.value end order by e.ord) \
           from json_each(r.v) with ordinality as e(key, value, ord)) order by r.n), '[]'::json)::text \
         from a, json_array_elements(a.j) with ordinality as r(v, n)"
    )
}

struct Sql {
    channels: String,
    reads: String,
    read: String,
    members: String,
    prefs: String,
    sections: String,
    auto_mentions: String,
    doc: String,
    scheduled: String,
    pins: String,
    delete_info: String,
    message_count: String,
    visible: String,
    exists: &'static str,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| Sql {
        channels: rows_sql(frag("list_channels"), &["archivedAt", "createdAt"]),
        reads: rows_sql(frag("all_read_states"), &[]),
        read: format!(
            "select row_to_json(t)::text from ({}) t",
            frag("read_state")
        ),
        members: rows_sql(frag("list_channel_members"), &[]),
        prefs: rows_sql(
            frag("list_channel_prefs"),
            &["mutedAt", "starredAt", "hiddenAt"],
        ),
        sections: rows_sql(frag("list_channel_sections"), &["createdAt"]),
        auto_mentions: rows_sql(frag("list_channel_auto_mentions"), &["createdAt"]),
        doc: rows_sql(frag("channel_doc"), &["updatedAt"]),
        scheduled: rows_sql(
            frag("list_scheduled"),
            &["sendAt", "createdAt", "canceledAt"],
        ),
        // TS `toPin` — 평평한 행(메시지 칸 + pinnedBy·pinnedAt)을 `{ messageId, channelId, pinnedBy, pinnedAt, message }` 로.
        // message 는 핀 두 칸을 뺀 나머지를 열 순서 그대로. 맨 겉 timestamptz(메시지 셋 + pinnedAt)만 toISOString 꼴.
        pins: format!(
            "select coalesce(json_agg(json_build_object(\
               'messageId', r.v->'id', 'channelId', r.v->'channelId', \
               'pinnedBy', r.v->'pinnedBy', 'pinnedAt', r.v->'pinnedAt', \
               'message', (select json_object_agg(e.key, e.value order by e.ord) \
                 from json_each(r.v) with ordinality as e(key, value, ord) \
                 where e.key not in ('pinnedBy', 'pinnedAt'))) order by r.n), '[]'::json)::text \
             from json_array_elements(({})::json) with ordinality as r(v, n)",
            rows_sql(
                frag("select_pins"),
                &["createdAt", "editedAt", "deletedAt", "pinnedAt"],
            )
        ),
        delete_info: format!(
            "select json_build_object('name', t.name, 'kind', t.kind, 'archived', t.archived_at is not null)::text \
             from ({}) t",
            frag("channel_delete_info")
        ),
        message_count: format!("select t.cnt from ({}) t", frag("channel_message_count")),
        // TS `assertChannelVisible` — 술어는 TS 골든(`channelVisibleSql('c', '$1::uuid')`). 없는 채널은 행이 없다(막지 않음).
        visible: format!(
            "select {} as visible from channel c where c.id = $2::uuid",
            frag("channel_visible_c_p1uuid")
        ),
        exists: "select 1 from channel where id = $1::uuid",
    })
}

/// zod `z.string().uuid()`(3.x) 와 같은 판정 — 8-4-4-4-12 의 16진수, 대소문자 무관.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn bad_id() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`lists.rs`·`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "id: invalid uuid",
    )
}

/// 묶인 값으로 `rows_sql` 문장을 돌려 배열 JSON 텍스트를 받는다.
async fn rows(pool: &PgPool, sql: &'static str, binds: &[&str]) -> Result<String, sqlx::Error> {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(pool).await
}

/// TS `assertChannelVisible` — 없는 채널은 true(뒤 단계가 404 로 답한다).
async fn visible(pool: &PgPool, me: &str, channel: &str) -> Result<bool, sqlx::Error> {
    let v: Option<bool> = sqlx::query_scalar(sql().visible.as_str())
        .bind(me)
        .bind(channel)
        .fetch_optional(pool)
        .await?;
    Ok(v.unwrap_or(true))
}

async fn exists(pool: &PgPool, channel: &str) -> Result<bool, sqlx::Error> {
    let v: Option<i32> = sqlx::query_scalar(sql().exists)
        .bind(channel)
        .fetch_optional(pool)
        .await?;
    Ok(v.is_some())
}

fn wrap(key: &str, rows: &str) -> Response {
    json_ok(format!("{{\"{key}\":{rows}}}"))
}

/// `GET /channels` — 목록 술어는 admin 예외가 있는 `channelListVisibleSql`(TS 문장 그대로, `$2` = isAdmin).
pub async fn list(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    let r = sqlx::query_scalar::<_, String>(sql().channels.as_str())
        .bind(&me.id)
        .bind(me.is_admin)
        .fetch_one(pool.as_ref())
        .await;
    match r {
        Ok(r) => wrap("channels", &r),
        Err(e) => internal(e),
    }
}

/// `GET /reads` — 내가 볼 수 있는 모든 채널의 읽음 상태(admin 예외 없음).
pub async fn reads(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    match rows(&pool, &sql().reads, &[&me.id]).await {
        Ok(r) => wrap("reads", &r),
        Err(e) => internal(e),
    }
}

/// `GET /channels/{id}/read`.
pub async fn read(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !is_uuid(&id) {
        return bad_id();
    }
    match visible(&pool, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this dm channel",
            );
        }
        Err(e) => return internal(e),
    }
    match sqlx::query_scalar::<_, String>(sql().read.as_str())
        .bind(&me.id)
        .bind(&id)
        .fetch_one(pool.as_ref())
        .await
    {
        Ok(r) => json_ok(r),
        Err(e) => internal(e),
    }
}

/// `GET /channels/{id}/members` — 없는 채널 404 → (admin 이 아니고 볼 수 없으면) 403. private 채널의 멤버는 admin 도 본다(TS #182 절충).
pub async fn members(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !is_uuid(&id) {
        return bad_id();
    }
    match exists(&pool, &id).await {
        Ok(true) => {}
        Ok(false) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel"),
        Err(e) => return internal(e),
    }
    if !me.is_admin {
        match visible(&pool, &me.id, &id).await {
            Ok(true) => {}
            Ok(false) => {
                return json_err(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "not a member of this channel",
                );
            }
            Err(e) => return internal(e),
        }
    }
    match rows(&pool, &sql().members, &[&id]).await {
        Ok(r) => wrap("members", &r),
        Err(e) => internal(e),
    }
}

/// `GET /channels/prefs` — `{ prefs, sections }`.
pub async fn prefs(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    let p = match rows(&pool, &sql().prefs, &[&me.id]).await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    match rows(&pool, &sql().sections, &[&me.id]).await {
        Ok(s) => json_ok(format!("{{\"prefs\":{p},\"sections\":{s}}}")),
        Err(e) => internal(e),
    }
}

/// `GET /channel-sections`.
pub async fn sections(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    match rows(&pool, &sql().sections, &[&me.id]).await {
        Ok(r) => wrap("sections", &r),
        Err(e) => internal(e),
    }
}

/// 「볼 수 없으면 403」 하나로 지키는 채널 줄의 공통 순서: id 400 → 403 → 읽기.
async fn gated(pool: &PgPool, me: &str, id: &str, message: &'static str) -> Option<Response> {
    if !is_uuid(id) {
        return Some(bad_id());
    }
    match visible(pool, me, id).await {
        Ok(true) => None,
        Ok(false) => Some(json_err(StatusCode::FORBIDDEN, "forbidden", message)),
        Err(e) => Some(internal(e)),
    }
}

/// `GET /channels/{id}/auto-mentions`.
pub async fn auto_mentions(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Some(r) = gated(&pool, &me.id, &id, "not a member of this dm channel").await {
        return r;
    }
    match rows(&pool, &sql().auto_mentions, &[&id]).await {
        Ok(r) => wrap("autoMentions", &r),
        Err(e) => internal(e),
    }
}

/// `GET /channels/{id}/doc` — 403 → 없는 채널 404 → 문서. 저장된 것이 없으면 빈 문서(`updatedBy`·`updatedAt` 은 null, TS 와 같다).
pub async fn doc(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Some(r) = gated(&pool, &me.id, &id, "not a member of this channel").await {
        return r;
    }
    match exists(&pool, &id).await {
        Ok(true) => {}
        Ok(false) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel"),
        Err(e) => return internal(e),
    }
    let r = match rows(&pool, &sql().doc, &[&id]).await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    match serde_json::from_str::<Vec<Value>>(&r)
        .ok()
        .and_then(|mut v| (!v.is_empty()).then(|| v.remove(0)))
    {
        Some(row) => json_ok(row.to_string()),
        None => json_ok(
            serde_json::json!({ "channelId": id, "body": "", "updatedBy": null, "updatedAt": null })
                .to_string(),
        ),
    }
}

/// `GET /channels/{id}/scheduled` — 내가 건 예약만(문장이 author 로 거른다).
pub async fn scheduled(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Some(r) = gated(&pool, &me.id, &id, "not a member of this dm channel").await {
        return r;
    }
    match rows(&pool, &sql().scheduled, &[&id, &me.id]).await {
        Ok(r) => wrap("scheduled", &r),
        Err(e) => internal(e),
    }
}

/// `GET /channels/{id}/pins` — 볼 수 없으면 403, 지워진 메시지의 핀은 문장(조인 조건)에서 빠진다.
pub async fn pins(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Some(r) = gated(&pool, &me.id, &id, "not a member of this dm channel").await {
        return r;
    }
    let r = sqlx::query_scalar::<_, String>(sql().pins.as_str())
        .bind(&id)
        .bind(None::<String>)
        .fetch_one(pool.as_ref())
        .await;
    match r {
        Ok(r) => wrap("pins", &r),
        Err(e) => internal(e),
    }
}

/// `GET /channels/{id}/delete-info` — TS 순서: `requireCap('channel.manage', 채널)`(401·403) → id 400 → 404 →
/// DM 이면 409 `cannot_delete_dm` → 보관 안 됐으면 409 `not_archived` → `{ name, messageCount }`.
pub async fn delete_info(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(_, auth): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    let target = crate::perm::Target {
        kind: crate::perm::TargetKind::Channel,
        id: &id,
    };
    if let Err(r) = crate::perm::require_cap(&pool, &auth, "channel.manage", Some(target)).await {
        return r;
    }
    if !is_uuid(&id) {
        return bad_id();
    }
    let row: Option<String> = match sqlx::query_scalar(sql().delete_info.as_str())
        .bind(&id)
        .fetch_optional(pool.as_ref())
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some(row) = row.and_then(|r| serde_json::from_str::<Value>(&r).ok()) else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel");
    };
    if row["kind"] != "standard" {
        return json_err(
            StatusCode::CONFLICT,
            "cannot_delete_dm",
            "DMs cannot be deleted",
        );
    }
    if row["archived"] != true {
        return json_err(
            StatusCode::CONFLICT,
            "not_archived",
            "only archived channels can be deleted",
        );
    }
    let count: i32 = match sqlx::query_scalar(sql().message_count.as_str())
        .bind(&id)
        .fetch_one(pool.as_ref())
        .await
    {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    json_ok(
        serde_json::json!({ "name": row["name"].as_str().unwrap_or(""), "messageCount": count })
            .to_string(),
    )
}

/// 코어 라우터에 합칠 줄(`route_table.rs`). 인증 층은 메서드 안(`route_layer`), CORS 는 바깥(`layer`) — `msg_read.rs` 와 같은 길.
pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/channels", list)
        .get("/reads", reads)
        .get("/channels/{id}/read", read)
        .get("/channels/{id}/members", members)
        .get("/channels/prefs", prefs)
        .get("/channel-sections", sections)
        .get("/channels/{id}/auto-mentions", auto_mentions)
        .get("/channels/{id}/doc", doc)
        .get("/channels/{id}/scheduled", scheduled)
        .get("/channels/{id}/pins", pins)
        .get("/channels/{id}/delete-info", delete_info)
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
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.channels.contains("a.is_admin") || s.channels.contains("$2::bool"));
        assert!(s.scheduled.contains("author_id = $2::uuid"));
        assert!(s.prefs.contains("'mutedAt', 'starredAt', 'hiddenAt'"));
        assert!(s.reads.contains("false and json_typeof"), "시각 칸 없음");
        assert!(s.pins.contains("'pinnedAt'") && s.pins.contains("message_pin p"));
        assert!(s.message_count.contains("count(*)::int as cnt"));
    }

    #[test]
    fn uuid_like_zod() {
        assert!(is_uuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!is_uuid("prefs"));
    }
}
