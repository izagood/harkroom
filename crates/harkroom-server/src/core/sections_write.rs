//! S5.4 CH1 — 사이드바 섹션 쓰기 4줄. TS `routes/channelRoutes.ts` 의 `POST /channel-sections`·`PATCH`·`DELETE
//! /channel-sections/:id`·`PUT /channel-sections/order` 와 `services/channelSections.ts` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문 읽기(fastify) → 인증(401) → 경로(400) → 본문(400) → 이름 가공(400 `invalid_name`)
//!   → (만들기만) 넣을 채널마다 가시성(403) → 있나(404) → DM 인가(400) → 트랜잭션.
//! - **이름 거울**: `channel_pref.section_id` 를 쓰는 문장은 언제나 `section`(이름)도 같이 쓴다 — 옛 앱이 그 칸을 읽는다.
//! - 이벤트가 없다(TS 도 내지 않는다). 쓰기는 쓰기 풀의 트랜잭션 하나. 권한은 [`SECTION_WRITE_PRIVILEGES`] —
//!   없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
//! - 옛 이름 경로 `PATCH /channels/sections/{name}`(합치기)는 TS 에 남긴다.
use super::channels::{is_uuid, prefs_sql, sections_sql, visible};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::write::Body;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use std::sync::Arc;

/// TS `MAX_SECTIONS_PER_ACCOUNT`.
pub const MAX_SECTIONS_PER_ACCOUNT: i64 = 200;
/// zod `sectionName = z.string().max(40)` — UTF-16 단위.
const NAME_MAX: usize = 40;
/// zod `.max(500)` (channelIds·ids).
const IDS_MAX: usize = 500;

/// 섹션 쓰기가 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 칸 권한으로 좁힌다(읽기는 역할의 SELECT).
pub const SECTION_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("channel_section.account_id", "INSERT"),
    ("channel_section.name", "INSERT"),
    ("channel_section.position", "INSERT"),
    ("channel_section.name", "UPDATE"),
    ("channel_section.position", "UPDATE"),
    ("channel_section.collapsed", "UPDATE"),
    ("channel_section", "DELETE"),
    ("channel_pref.account_id", "INSERT"),
    ("channel_pref.channel_id", "INSERT"),
    ("channel_pref.section_id", "INSERT"),
    ("channel_pref.section", "INSERT"),
    ("channel_pref.section_id", "UPDATE"),
    ("channel_pref.section", "UPDATE"),
];

#[derive(Clone)]
pub struct SectionState {
    pub read: PgPool,
    pub write: PgPool,
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}
fn bad_name() -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_name",
        "section name must be 1-40 characters",
    )
}
fn name_taken() -> Response {
    json_err(
        StatusCode::CONFLICT,
        "section_exists",
        "a section with that name already exists",
    )
}
fn not_found() -> Response {
    json_err(
        StatusCode::NOT_FOUND,
        "section_not_found",
        "no such section",
    )
}

/// TS `normalizeSectionName` — JS `trim()`(유니코드 공백 + BOM), 빈 값은 None.
pub fn normalize(v: &str) -> Option<String> {
    let t = v.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    (!t.is_empty()).then(|| t.to_string())
}

/// zod `sectionName`(nullable) — Ok(None) 은 null.
fn section_name(v: &Value) -> Result<Option<&str>, ()> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.encode_utf16().count() <= NAME_MAX => Ok(Some(s)),
        _ => Err(()),
    }
}

/// zod `z.array(z.string().uuid()).max(500)`.
fn uuid_list(v: &Value) -> Option<Vec<String>> {
    let a = v.as_array()?;
    if a.len() > IDS_MAX {
        return None;
    }
    a.iter()
        .map(|x| x.as_str().filter(|s| is_uuid(s)).map(str::to_string))
        .collect()
}

/// `.strict()` 객체 — 모르는 칸이 있으면 None.
fn strict<'a>(body: &'a Body, keys: &[&str]) -> Option<&'a serde_json::Map<String, Value>> {
    match body {
        Body::Json(Value::Object(m)) if m.keys().all(|k| keys.contains(&k.as_str())) => Some(m),
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
pub struct CreateBody {
    pub name: String,
    pub position: Option<i64>,
    pub channel_ids: Vec<String>,
}

/// 만들기 본문 — Err 는 (zod 400 | 이름 400).
pub fn parse_create(body: &Body) -> Result<CreateBody, &'static str> {
    let m = strict(body, &["name", "position", "channelIds"]).ok_or("body")?;
    let raw = section_name(m.get("name").ok_or("body")?).map_err(|_| "body")?;
    let position = match m.get("position") {
        None => None,
        Some(v) => {
            let f = v.as_f64().ok_or("body")?;
            if !f.is_finite() || f.fract() != 0.0 || f < 0.0 {
                return Err("body");
            }
            // 상한은 섹션 수로 자르므로(아래 clamp) 큰 값은 i64 끝에서 멈춰도 같다.
            Some(if f > i64::MAX as f64 {
                i64::MAX
            } else {
                f as i64
            })
        }
    };
    let ids = match m.get("channelIds") {
        None => vec![],
        Some(v) => uuid_list(v).ok_or("body")?,
    };
    let name = raw.and_then(normalize).ok_or("name")?;
    let mut channel_ids: Vec<String> = vec![];
    for id in ids {
        if !channel_ids.contains(&id) {
            channel_ids.push(id);
        }
    }
    Ok(CreateBody {
        name,
        position,
        channel_ids,
    })
}

/// 고치기 본문 — `name` 은 보낸 것만(Some), `collapsed` 도.
pub fn parse_patch(body: &Body) -> Result<(Option<String>, Option<bool>), &'static str> {
    let m = strict(body, &["name", "collapsed"]).ok_or("body")?;
    let name = match m.get("name") {
        None => None,
        Some(v) => Some(section_name(v).map_err(|_| "body")?),
    };
    let collapsed = match m.get("collapsed") {
        None => None,
        Some(v) => Some(v.as_bool().ok_or("body")?),
    };
    let name = match name {
        None => None,
        Some(raw) => Some(raw.and_then(normalize).ok_or("name")?),
    };
    Ok((name, collapsed))
}

const SECTION_ONE: &str = "select json_build_object('id', id, 'name', name, 'position', position, 'collapsed', collapsed, \
     'createdAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))::text \
     from channel_section where account_id = $1::uuid and id = $2::uuid";
const SET_SECTION: &str = "insert into channel_pref (account_id, channel_id, section_id, section) \
     values ($1::uuid, $2::uuid, $3::uuid, (select name from channel_section where id = $3::uuid and account_id = $1::uuid)) \
     on conflict (account_id, channel_id) do update set section_id = excluded.section_id, section = excluded.section";
const COMPACT: &str = "update channel_section s set position = r.pos \
     from (select id, (row_number() over (order by position, name) - 1)::integer as pos \
           from channel_section where account_id = $1::uuid) r \
     where s.id = r.id and s.position <> r.pos";

async fn one(c: &mut PgConnection, me: &str, id: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(SECTION_ONE)
        .bind(me)
        .bind(id)
        .fetch_optional(c)
        .await
}

fn unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505")
}

enum Fail {
    Taken,
    Limit,
    Db(sqlx::Error),
}
impl From<sqlx::Error> for Fail {
    fn from(e: sqlx::Error) -> Self {
        if unique_violation(&e) {
            Fail::Taken
        } else {
            Fail::Db(e)
        }
    }
}

async fn create_tx(write: &PgPool, me: &str, b: &CreateBody) -> Result<String, Fail> {
    let mut tx = write.begin().await?;
    let n: i64 = sqlx::query_scalar(
        "select count(*)::bigint from channel_section where account_id = $1::uuid",
    )
    .bind(me)
    .fetch_one(&mut *tx)
    .await?;
    if n >= MAX_SECTIONS_PER_ACCOUNT {
        return Err(Fail::Limit);
    }
    let position = b.position.map_or(n, |p| p.clamp(0, n)) as i32;
    sqlx::query("update channel_section set position = position + 1 where account_id = $1::uuid and position >= $2")
        .bind(me)
        .bind(position)
        .execute(&mut *tx)
        .await?;
    let id: String = sqlx::query_scalar(
        "insert into channel_section (account_id, name, position) values ($1::uuid, $2, $3) returning id::text",
    )
    .bind(me)
    .bind(&b.name)
    .bind(position)
    .fetch_one(&mut *tx)
    .await?;
    for ch in &b.channel_ids {
        sqlx::query(SET_SECTION)
            .bind(me)
            .bind(ch)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(COMPACT).bind(me).execute(&mut *tx).await?;
    let row = one(&mut tx, me, &id).await?.unwrap_or_default();
    tx.commit().await?;
    Ok(row)
}

/// `POST /channel-sections` — 201 `{ section, prefs }`.
pub async fn create(State(st): State<Arc<SectionState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let b = match parse_create(&body) {
        Ok(b) => b,
        Err("name") => return bad_name(),
        Err(w) => return bad(w),
    };
    for ch in &b.channel_ids {
        match visible(&st.read, &me.id, ch).await {
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
    }
    if !b.channel_ids.is_empty() {
        // 없는 채널은 404, DM 은 400 — 확인 없이 넣으면 FK 위반이 500 으로 나간다.
        let kinds: Vec<String> =
            match sqlx::query_scalar("select kind from channel where id = any($1::uuid[])")
                .bind(&b.channel_ids)
                .fetch_all(&st.read)
                .await
            {
                Ok(k) => k,
                Err(e) => return internal(e),
            };
        if kinds.len() != b.channel_ids.len() {
            return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel");
        }
        if kinds.iter().any(|k| k == "dm") {
            return json_err(
                StatusCode::BAD_REQUEST,
                "cannot_section_dm",
                "DMs cannot have a section",
            );
        }
    }
    let section = match create_tx(&st.write, &me.id, &b).await {
        Ok(s) => s,
        Err(Fail::Taken) => return name_taken(),
        Err(Fail::Limit) => {
            return json_err(
                StatusCode::CONFLICT,
                "too_many_sections",
                &format!("at most {MAX_SECTIONS_PER_ACCOUNT} sections per account"),
            );
        }
        Err(Fail::Db(e)) => return internal(e),
    };
    // TS 는 커밋 뒤 풀로 다시 읽는다 — 쓰기 풀로 읽어 방금 쓴 것을 놓치지 않는다.
    let prefs: String = match sqlx::query_scalar(prefs_sql())
        .bind(&me.id)
        .fetch_one(&st.write)
        .await
    {
        Ok(p) => p,
        Err(e) => return internal(e),
    };
    let mut r = json_ok(format!("{{\"section\":{section},\"prefs\":{prefs}}}"));
    *r.status_mut() = StatusCode::CREATED;
    r
}

async fn patch_tx(
    write: &PgPool,
    me: &str,
    id: &str,
    name: Option<&str>,
    collapsed: Option<bool>,
) -> Result<Option<String>, Fail> {
    let mut tx = write.begin().await?;
    let current: Option<String> = sqlx::query_scalar(
        "select name from channel_section where account_id = $1::uuid and id = $2::uuid",
    )
    .bind(me)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(current) = current else {
        return Ok(None);
    };
    if let Some(name) = name.filter(|n| *n != current) {
        sqlx::query(
            "update channel_section set name = $3 where account_id = $1::uuid and id = $2::uuid",
        )
        .bind(me)
        .bind(id)
        .bind(name)
        .execute(&mut *tx)
        .await?;
        sqlx::query("update channel_pref set section = $3 where account_id = $1::uuid and section_id = $2::uuid")
            .bind(me)
            .bind(id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(c) = collapsed {
        sqlx::query("update channel_section set collapsed = $3 where account_id = $1::uuid and id = $2::uuid")
            .bind(me)
            .bind(id)
            .bind(c)
            .execute(&mut *tx)
            .await?;
    }
    let row = one(&mut tx, me, id).await?;
    tx.commit().await?;
    Ok(row)
}

/// `PATCH /channel-sections/{id}` — 보낸 것만 바꾼다. 같은 이름은 409(합치지 않는다).
pub async fn patch(
    State(st): State<Arc<SectionState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) {
        return bad("params");
    }
    let (name, collapsed) = match parse_patch(&body) {
        Ok(v) => v,
        Err("name") => return bad_name(),
        Err(w) => return bad(w),
    };
    match patch_tx(&st.write, &me.id, &id, name.as_deref(), collapsed).await {
        Ok(Some(s)) => json_ok(format!("{{\"section\":{s}}}")),
        Ok(None) => not_found(),
        Err(Fail::Taken) => name_taken(),
        Err(Fail::Limit) => not_found(), // 고치기에는 상한이 없다 — 닿지 않는 갈래.
        Err(Fail::Db(e)) => internal(e),
    }
}

async fn delete_tx(write: &PgPool, me: &str, id: &str) -> sqlx::Result<Option<String>> {
    let mut tx = write.begin().await?;
    let Some(section) = one(&mut tx, me, id).await? else {
        return Ok(None);
    };
    let mut ids: Vec<String> = sqlx::query_scalar(
        "update channel_pref set section_id = null, section = null \
         where account_id = $1::uuid and section_id = $2::uuid returning channel_id::text",
    )
    .bind(me)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("delete from channel_section where account_id = $1::uuid and id = $2::uuid")
        .bind(me)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(COMPACT).bind(me).execute(&mut *tx).await?;
    tx.commit().await?;
    // TS `.sort()` — UTF-16 순서. uuid 글자(ASCII)라 바이트 순서와 같다.
    ids.sort();
    Ok(Some(format!(
        "{{\"section\":{section},\"channelIds\":{}}}",
        serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into())
    )))
}

/// `DELETE /channel-sections/{id}` — 되돌리기에 필요한 전부(섹션·채널 id).
pub async fn delete(
    State(st): State<Arc<SectionState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !is_uuid(&id) {
        return bad("params");
    }
    match delete_tx(&st.write, &me.id, &id).await {
        Ok(Some(b)) => json_ok(b),
        Ok(None) => not_found(),
        Err(e) => internal(e),
    }
}

async fn reorder_tx(write: &PgPool, me: &str, ids: &[String]) -> sqlx::Result<Option<String>> {
    let mut tx = write.begin().await?;
    let have: Vec<String> = sqlx::query_scalar(
        "select id::text from channel_section where account_id = $1::uuid for update",
    )
    .bind(me)
    .fetch_all(&mut *tx)
    .await?;
    // TS 와 같이 pg 가 돌려준 글자(소문자)와 그대로 비교한다 — 대문자 id 는 TS 에서도 409 다.
    let want: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    if want.len() != ids.len() || want.len() != have.len() || ids.iter().any(|i| !have.contains(i))
    {
        return Ok(None);
    }
    for (i, id) in ids.iter().enumerate() {
        sqlx::query("update channel_section set position = $3 where account_id = $1::uuid and id = $2::uuid and position <> $3")
            .bind(me)
            .bind(id)
            .bind(i as i32)
            .execute(&mut *tx)
            .await?;
    }
    let rows: String = sqlx::query_scalar(sections_sql())
        .bind(me)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(rows))
}

/// `PUT /channel-sections/order` — 요청자의 섹션 전부를 새 순서로. 집합이 다르면 409.
pub async fn reorder(State(st): State<Arc<SectionState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let Some(ids) = strict(&body, &["ids"])
        .and_then(|m| m.get("ids"))
        .and_then(uuid_list)
    else {
        return bad("body");
    };
    match reorder_tx(&st.write, &me.id, &ids).await {
        Ok(Some(s)) => json_ok(format!("{{\"sections\":{s}}}")),
        Ok(None) => json_err(
            StatusCode::CONFLICT,
            "sections_changed",
            "section set changed; reload and retry",
        ),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — `msg_react.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
/// `/channel-sections` 의 `GET` 은 읽기 코어(`channels.rs`)가 이미 붙였다 — 같은 경로라 여기서 `POST` 만 더한다.
pub fn routes(
    st: SectionState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SectionState>>::new()
        .post("/channel-sections", create)
        .put("/channel-sections/order", reorder)
        .patch("/channel-sections/{id}", patch)
        .delete("/channel-sections/{id}", delete)
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
    use serde_json::json;

    const U: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn create_body_like_zod() {
        let ok = parse_create(&Body::Json(
            json!({ "name": "  Work ", "position": 2, "channelIds": [U, U] }),
        ))
        .unwrap();
        assert_eq!(
            ok,
            CreateBody {
                name: "Work".into(),
                position: Some(2),
                channel_ids: vec![U.into()]
            }
        );
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": "   " }))),
            Err("name")
        );
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": null }))),
            Err("name")
        );
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": "a".repeat(41) }))),
            Err("body")
        );
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": "a", "x": 1 }))),
            Err("body")
        );
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": "a", "position": 1.5 }))),
            Err("body")
        );
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": "a", "position": -1 }))),
            Err("body")
        );
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": "a", "channelIds": ["x"] }))),
            Err("body")
        );
        assert_eq!(parse_create(&Body::Json(json!({}))), Err("body"));
        assert_eq!(parse_create(&Body::None), Err("body"));
        // 본문 검사(zod)가 이름 가공보다 먼저다 — 빈 이름 + 모르는 칸은 400 invalid_request.
        assert_eq!(
            parse_create(&Body::Json(json!({ "name": "", "x": 1 }))),
            Err("body")
        );
    }

    #[test]
    fn patch_body_like_zod() {
        assert_eq!(parse_patch(&Body::Json(json!({}))), Ok((None, None)));
        assert_eq!(
            parse_patch(&Body::Json(json!({ "collapsed": true }))),
            Ok((None, Some(true)))
        );
        assert_eq!(
            parse_patch(&Body::Json(json!({ "name": " x " }))),
            Ok((Some("x".into()), None))
        );
        assert_eq!(
            parse_patch(&Body::Json(json!({ "name": null }))),
            Err("name")
        );
        assert_eq!(
            parse_patch(&Body::Json(json!({ "collapsed": 1 }))),
            Err("body")
        );
        assert_eq!(parse_patch(&Body::None), Err("body"));
    }

    #[test]
    fn normalize_like_js_trim() {
        assert_eq!(normalize("\u{FEFF} a \u{3000}"), Some("a".into()));
        assert_eq!(normalize("\u{00A0}"), None);
    }
}
