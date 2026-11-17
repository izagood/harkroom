//! S5.4 CH3c — 채널 선호 쓰기 2줄. TS `routes/channelRoutes.ts` 의 `PATCH /channels/:id/pref`·
//! `PATCH /channels/sections/:name`(옛 이름 경로, 합치기)과 `services/channels.ts` 의 `updateChannelPref`·
//! `renameSection` 을 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문 읽기 → 인증(401) → 경로(400) → 본문(400) → 가시성(403) → section·sectionId
//!   동시(400) → 남의 섹션 id(404) → 채널 있나(404)·DM 인가(400) → 쓰기.
//! - pref 쓰기는 TS 처럼 **트랜잭션이 아니다** — 보낸 칸마다 한 문장을 TS 와 같은 차례로 쓴다. 섹션 상한(409)에
//!   걸리면 앞서 쓴 알림 수준·별표는 TS 처럼 남는다.
//! - **이름 거울**: 섹션 넣기·빼기는 `sections_write::SET_SECTION` 하나로 쓴다(`section_id` 와 `section` 을 같이).
//! - 이벤트·감사가 없다(TS 도 내지 않는다). 권한은 [`PREF_WRITE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지
//!   않아 TS 에 남는다.
use super::channels::{frag, is_uuid, prefs_sql, rows_sql, visible};
use super::sections_write::{COMPACT, MAX_SECTIONS_PER_ACCOUNT, SET_SECTION, normalize};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::write::Body;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use std::sync::{Arc, OnceLock};

/// zod `sectionName = z.string().max(40)` — UTF-16 단위.
const NAME_MAX: usize = 40;
/// `NOTIFY_LEVELS`(@harkroom/shared).
const NOTIFY_LEVELS: &[&str] = &["all", "mentions", "none"];

/// 선호 쓰기가 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 칸 권한으로 좁힌다(읽기는 역할의 SELECT).
pub const PREF_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("channel_pref.account_id", "INSERT"),
    ("channel_pref.channel_id", "INSERT"),
    ("channel_pref.notify_level", "INSERT"),
    ("channel_pref.muted_at", "INSERT"),
    ("channel_pref.starred_at", "INSERT"),
    ("channel_pref.section_id", "INSERT"),
    ("channel_pref.section", "INSERT"),
    ("channel_pref.hidden_at", "INSERT"),
    ("channel_pref.sort_order", "INSERT"),
    ("channel_pref.notify_level", "UPDATE"),
    ("channel_pref.muted_at", "UPDATE"),
    ("channel_pref.starred_at", "UPDATE"),
    ("channel_pref.section_id", "UPDATE"),
    ("channel_pref.section", "UPDATE"),
    ("channel_pref.hidden_at", "UPDATE"),
    ("channel_pref.sort_order", "UPDATE"),
    ("channel_section.account_id", "INSERT"),
    ("channel_section.name", "INSERT"),
    ("channel_section.position", "INSERT"),
    ("channel_section.name", "UPDATE"),
    ("channel_section.position", "UPDATE"),
    ("channel_section", "DELETE"),
];

#[derive(Clone)]
pub struct PrefState {
    pub write: PgPool,
}

/// 한 채널의 내 선호 — TS `getChannelPref`(행 없음 → null). 시각 칸은 `toISOString()` 꼴.
fn pref_one_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select (({})::json -> 0)::text",
            rows_sql(
                &format!("{} and channel_id = $2::uuid", frag("list_channel_prefs")),
                &["mutedAt", "starredAt", "hiddenAt"],
            )
        )
    })
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`sections_write.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}
fn no_channel() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such channel")
}
fn too_many() -> Response {
    json_err(
        StatusCode::CONFLICT,
        "too_many_sections",
        &format!("at most {MAX_SECTIONS_PER_ACCOUNT} sections per account"),
    )
}

/// 칸 하나: 안 보냄 / null / 값.
#[derive(Debug, PartialEq, Clone)]
pub enum Field<T> {
    Absent,
    Null,
    Set(T),
}

#[derive(Debug, PartialEq)]
pub struct PrefBody {
    pub notify_level: Option<String>,
    pub starred: Option<bool>,
    /// 가공 전 이름(길이만 본 것).
    pub section: Field<String>,
    pub section_id: Field<String>,
    pub sort_order: Field<f64>,
    pub hidden: Option<bool>,
}

/// zod `prefBody`(`.strict()`) — Err 면 400.
pub fn parse_pref(body: &Body) -> Result<PrefBody, &'static str> {
    let Body::Json(Value::Object(m)) = body else {
        return Err("body");
    };
    const KEYS: &[&str] = &[
        "notifyLevel",
        "starred",
        "section",
        "sectionId",
        "sortOrder",
        "hidden",
    ];
    if !m.keys().all(|k| KEYS.contains(&k.as_str())) {
        return Err("body");
    }
    let opt_bool = |k: &str| -> Result<Option<bool>, &'static str> {
        match m.get(k) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err("body"),
        }
    };
    let notify_level = match m.get("notifyLevel") {
        None => None,
        Some(Value::String(s)) if NOTIFY_LEVELS.contains(&s.as_str()) => Some(s.clone()),
        Some(_) => return Err("body"),
    };
    let section = match m.get("section") {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(Value::String(s)) if s.encode_utf16().count() <= NAME_MAX => Field::Set(s.clone()),
        Some(_) => return Err("body"),
    };
    let section_id = match m.get("sectionId") {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(Value::String(s)) if is_uuid(s) => Field::Set(s.clone()),
        Some(_) => return Err("body"),
    };
    // zod `z.number().int()` — 유한한 정수(1.0 도 정수다).
    let sort_order = match m.get("sortOrder") {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.is_finite() && f.fract() == 0.0 => Field::Set(f),
            _ => return Err("body"),
        },
        Some(_) => return Err("body"),
    };
    Ok(PrefBody {
        notify_level,
        starred: opt_bool("starred")?,
        section,
        section_id,
        sort_order,
        hidden: opt_bool("hidden")?,
    })
}

enum Fail {
    Limit,
    Db(sqlx::Error),
}
impl From<sqlx::Error> for Fail {
    fn from(e: sqlx::Error) -> Self {
        Fail::Db(e)
    }
}

/// TS `findOrCreateSectionByName` — 상한에 닿았고 그 이름이 없으면 Limit.
async fn find_or_create(c: &mut PgConnection, me: &str, name: &str) -> Result<String, Fail> {
    sqlx::query(
        "insert into channel_section (account_id, name, position) \
         select $1::uuid, $2, coalesce(max(position) + 1, 0) from channel_section where account_id = $1::uuid \
         having count(*) < $3 \
         on conflict (account_id, name) do nothing",
    )
    .bind(me)
    .bind(name)
    .bind(MAX_SECTIONS_PER_ACCOUNT)
    .execute(&mut *c)
    .await?;
    section_id_of(c, me, name).await?.ok_or(Fail::Limit)
}

async fn section_id_of(c: &mut PgConnection, me: &str, name: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        "select id::text from channel_section where account_id = $1::uuid and name = $2",
    )
    .bind(me)
    .bind(name)
    .fetch_optional(c)
    .await
}

async fn set_section(
    c: &mut PgConnection,
    me: &str,
    ch: &str,
    section: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(SET_SECTION)
        .bind(me)
        .bind(ch)
        .bind(section)
        .execute(c)
        .await
        .map(|_| ())
}

/// TS `updateChannelPref` — 트랜잭션 없이 보낸 칸만, TS 와 같은 차례로. Ok(None) 은 「채널 없음 / 행 없음」(404).
async fn update_pref(
    write: &PgPool,
    me: &str,
    ch: &str,
    p: &PrefBody,
) -> Result<Option<String>, Fail> {
    let mut c = write.acquire().await?;
    let found: Option<i32> = sqlx::query_scalar("select 1 from channel where id = $1::uuid")
        .bind(ch)
        .fetch_optional(&mut *c)
        .await?;
    if found.is_none() {
        return Ok(None);
    }
    if let Some(level) = &p.notify_level {
        sqlx::query(
            "insert into channel_pref (account_id, channel_id, notify_level, muted_at) \
             values ($1::uuid, $2::uuid, $3, case when $3 = 'none' then now() end) \
             on conflict (account_id, channel_id) do update set notify_level = excluded.notify_level, muted_at = excluded.muted_at",
        )
        .bind(me)
        .bind(ch)
        .bind(level)
        .execute(&mut *c)
        .await?;
    }
    if let Some(s) = p.starred {
        sqlx::query(
            "insert into channel_pref (account_id, channel_id, starred_at) \
             values ($1::uuid, $2::uuid, case when $3::boolean then now() end) \
             on conflict (account_id, channel_id) do update set starred_at = excluded.starred_at",
        )
        .bind(me)
        .bind(ch)
        .bind(s)
        .execute(&mut *c)
        .await?;
    }
    match &p.section {
        Field::Absent => {}
        Field::Null => set_section(&mut c, me, ch, None).await?,
        Field::Set(raw) => match normalize(raw) {
            None => set_section(&mut c, me, ch, None).await?,
            Some(name) => {
                let id = find_or_create(&mut c, me, &name).await?;
                set_section(&mut c, me, ch, Some(&id)).await?;
            }
        },
    }
    match &p.section_id {
        Field::Absent => {}
        Field::Null => set_section(&mut c, me, ch, None).await?,
        Field::Set(id) => set_section(&mut c, me, ch, Some(id)).await?,
    }
    if let Some(h) = p.hidden {
        sqlx::query(
            "insert into channel_pref (account_id, channel_id, hidden_at) \
             values ($1::uuid, $2::uuid, case when $3::boolean then now() end) \
             on conflict (account_id, channel_id) do update set hidden_at = excluded.hidden_at",
        )
        .bind(me)
        .bind(ch)
        .bind(h)
        .execute(&mut *c)
        .await?;
    }
    let order = match p.sort_order {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(f) => Some(Some(f)),
    };
    if let Some(v) = order {
        // JS number 를 그대로 — int 범위를 넘으면 TS 처럼 pg 가 거절한다(500).
        sqlx::query(
            "insert into channel_pref (account_id, channel_id, sort_order) \
             values ($1::uuid, $2::uuid, $3::float8::integer) \
             on conflict (account_id, channel_id) do update set sort_order = excluded.sort_order",
        )
        .bind(me)
        .bind(ch)
        .bind(v)
        .execute(&mut *c)
        .await?;
    }
    Ok(sqlx::query_scalar::<_, Option<String>>(pref_one_sql())
        .bind(me)
        .bind(ch)
        .fetch_one(&mut *c)
        .await?)
}

/// `PATCH /channels/{id}/pref` — 바뀐 선호 한 행.
pub async fn patch_pref(
    State(st): State<Arc<PrefState>>,
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
    let Ok(p) = parse_pref(&body) else {
        return bad("body");
    };
    // 가시성이 먼저다 — DM 검사를 앞에 두면 남의 DM 인지가 400/403 으로 갈려 샌다.
    match visible(&st.write, &me.id, &id).await {
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
    if p.section != Field::Absent && p.section_id != Field::Absent {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "send either section or sectionId",
        );
    }
    if let Field::Set(sid) = &p.section_id {
        let mine: Result<Option<i32>, _> = sqlx::query_scalar(
            "select 1 from channel_section where account_id = $1::uuid and id = $2::uuid",
        )
        .bind(&me.id)
        .bind(sid)
        .fetch_optional(&st.write)
        .await;
        match mine {
            Ok(Some(_)) => {}
            Ok(None) => {
                return json_err(
                    StatusCode::NOT_FOUND,
                    "section_not_found",
                    "no such section",
                );
            }
            Err(e) => return internal(e),
        }
    }
    if matches!(p.section, Field::Set(_)) || matches!(p.section_id, Field::Set(_)) {
        let kind: Result<Option<String>, _> =
            sqlx::query_scalar("select kind from channel where id = $1::uuid")
                .bind(&id)
                .fetch_optional(&st.write)
                .await;
        match kind {
            Ok(None) => return no_channel(),
            Ok(Some(k)) if k == "dm" => {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "cannot_section_dm",
                    "DMs cannot have a section",
                );
            }
            Ok(Some(_)) => {}
            Err(e) => return internal(e),
        }
    }
    match update_pref(&st.write, &me.id, &id, &p).await {
        Ok(Some(row)) => json_ok(row),
        Ok(None) => no_channel(),
        Err(Fail::Limit) => too_many(),
        Err(Fail::Db(e)) => internal(e),
    }
}

const ORDERED: &str = "select channel_id::text from channel_pref \
     where account_id = $1::uuid and section_id = $2::uuid \
     order by sort_order nulls last, channel_id";

async fn ordered(c: &mut PgConnection, me: &str, section: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(ORDERED)
        .bind(me)
        .bind(section)
        .fetch_all(c)
        .await
}

/// TS `renameSection` 의 트랜잭션 부분 — 옛 이름이 없으면 아무것도 쓰지 않는다.
async fn rename_tx(write: &PgPool, me: &str, old: &str, new: Option<&str>) -> sqlx::Result<()> {
    let mut tx = write.begin().await?;
    let Some(old_id) = section_id_of(&mut tx, me, old).await? else {
        tx.rollback().await?;
        return Ok(());
    };
    let old_prefs = ordered(&mut tx, me, &old_id).await?;
    let new_id = match new {
        None => None,
        Some(n) => section_id_of(&mut tx, me, n).await?,
    };
    match (new, new_id) {
        (None, _) => {
            sqlx::query("update channel_pref set section_id = null, section = null where account_id = $1::uuid and section_id = $2::uuid")
                .bind(me)
                .bind(&old_id)
                .execute(&mut *tx)
                .await?;
            delete_section(&mut tx, me, &old_id).await?;
        }
        (Some(_), Some(new_id)) => {
            let mut all = ordered(&mut tx, me, &new_id).await?;
            all.extend(old_prefs);
            for (i, ch) in all.iter().enumerate() {
                set_section(&mut tx, me, ch, Some(&new_id)).await?;
                sqlx::query("update channel_pref set sort_order = $3 where account_id = $1::uuid and channel_id = $2::uuid")
                    .bind(me)
                    .bind(ch)
                    .bind(i as i32)
                    .execute(&mut *tx)
                    .await?;
            }
            delete_section(&mut tx, me, &old_id).await?;
        }
        (Some(n), None) => {
            sqlx::query(
                "update channel_section set name = $3 where account_id = $1::uuid and id = $2::uuid",
            )
            .bind(me)
            .bind(&old_id)
            .bind(n)
            .execute(&mut *tx)
            .await?;
            sqlx::query("update channel_pref set section = $3 where account_id = $1::uuid and section_id = $2::uuid")
                .bind(me)
                .bind(&old_id)
                .bind(n)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await
}

async fn delete_section(c: &mut PgConnection, me: &str, id: &str) -> sqlx::Result<()> {
    sqlx::query("delete from channel_section where account_id = $1::uuid and id = $2::uuid")
        .bind(me)
        .bind(id)
        .execute(&mut *c)
        .await?;
    sqlx::query(COMPACT).bind(me).execute(&mut *c).await?;
    Ok(())
}

/// 이름 바꾸기 본문 `{ name }` — zod `z.object({ name: sectionName.optional() })`(strict 아님).
/// Ok(None) 은 안 보냄(400 `invalid_body`), Ok(Some(None)) 은 null.
pub fn parse_rename(body: &Body) -> Result<Option<Option<String>>, &'static str> {
    let Body::Json(Value::Object(m)) = body else {
        return Err("body");
    };
    match m.get("name") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if s.encode_utf16().count() <= NAME_MAX => Ok(Some(Some(s.clone()))),
        Some(_) => Err("body"),
    }
}

/// `PATCH /channels/sections/{name}` — `{ prefs }`(내 선호 전부).
pub async fn rename(
    State(st): State<Arc<PrefState>>,
    Path(old): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if old.encode_utf16().count() > NAME_MAX {
        return bad("params");
    }
    let new = match parse_rename(&body) {
        Ok(Some(n)) => n,
        Ok(None) => return json_err(StatusCode::BAD_REQUEST, "invalid_body", "name is required"),
        Err(w) => return bad(w),
    };
    let new = new.as_deref().and_then(normalize);
    // TS 는 빈 옛 이름에서 Error 를 던진다(500).
    let Some(old) = normalize(&old) else {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    if new.as_deref() != Some(old.as_str())
        && let Err(e) = rename_tx(&st.write, &me.id, &old, new.as_deref()).await
    {
        return internal(e);
    }
    // TS 는 커밋 뒤 풀로 다시 읽는다 — 쓰기 풀로 읽어 방금 쓴 것을 놓치지 않는다.
    match sqlx::query_scalar::<_, String>(prefs_sql())
        .bind(&me.id)
        .fetch_one(&st.write)
        .await
    {
        Ok(p) => json_ok(format!("{{\"prefs\":{p}}}")),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — `sections_write.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: PrefState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PrefState>>::new()
        .patch("/channels/{id}/pref", patch_pref)
        .patch("/channels/sections/{name}", rename)
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

    fn j(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn pref_body_like_zod() {
        let p = parse_pref(&j(json!({}))).unwrap();
        assert_eq!(p.section, Field::Absent);
        assert!(parse_pref(&j(json!({"muted": true}))).is_err());
        assert!(parse_pref(&j(json!({"notifyLevel": "loud"}))).is_err());
        assert!(parse_pref(&j(json!({"starred": 1}))).is_err());
        assert!(parse_pref(&Body::None).is_err());
        assert!(parse_pref(&j(json!(null))).is_err());
        let p = parse_pref(&j(json!({"section": null, "sortOrder": 2.0}))).unwrap();
        assert_eq!(p.section, Field::Null);
        assert_eq!(p.sort_order, Field::Set(2.0));
        assert!(parse_pref(&j(json!({"sortOrder": 1.5}))).is_err());
        assert_eq!(
            parse_pref(&j(json!({"sortOrder": null})))
                .unwrap()
                .sort_order,
            Field::Null
        );
        assert!(parse_pref(&j(json!({"sectionId": "x"}))).is_err());
        // 40 UTF-16 단위까지 — 서로게이트 하나는 둘로 센다.
        assert!(parse_pref(&j(json!({"section": "가".repeat(40)}))).is_ok());
        assert!(parse_pref(&j(json!({"section": "😀".repeat(21)}))).is_err());
        assert!(parse_pref(&j(json!({"section": "😀".repeat(20)}))).is_ok());
    }

    #[test]
    fn rename_body_like_zod() {
        assert_eq!(parse_rename(&j(json!({}))), Ok(None));
        assert_eq!(parse_rename(&j(json!({"x": 1}))), Ok(None));
        assert_eq!(parse_rename(&j(json!({"name": null}))), Ok(Some(None)));
        assert_eq!(
            parse_rename(&j(json!({"name": "a"}))),
            Ok(Some(Some("a".into())))
        );
        assert!(parse_rename(&j(json!({"name": 3}))).is_err());
        assert!(parse_rename(&Body::None).is_err());
        assert!(parse_rename(&j(json!({"name": "a".repeat(41)}))).is_err());
    }
}
