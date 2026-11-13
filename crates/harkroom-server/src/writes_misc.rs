//! 가벼운 쓰기③(S5.2 P4c-2) — 작업 항목·스레드 임대·푸시 기기.
//!
//! | TS | 옮김 |
//! |---|---|
//! | `routes/workItemRoutes.ts` | `GET /work-items` · `DELETE /work-items/{id}`. **`PUT /work-items` 는 TS 에 남긴다** — `state: 'done'` 이면 같은
//! |  | 트랜잭션에서 위임장을 끝내고(`endMandatesForDoneThreadTx`) 권한 카드 글을 다시 쓴다(`refreshMandateCards`) → 위임장·메시지 표를 쓰는 일이라 S5.3 코어 몫 |
//! | `routes/threadClaimRoutes.ts` | `POST /agent/thread-claims` · `POST /agent/thread-claims/release` |
//! | `routes/pushRoutes.ts` | `PUT /push/devices` · `DELETE /push/devices/current` |
//!
//! 메모리 상태: 없다(`workItems.ts`·`threadClaims.ts`·`pushRoutes.ts` 에 모듈 수준 Map·캐시 없음). 「내 것만」: 작업 항목은 보드 주인
//! (`resolveWorkItemOwner`)과 주인이 아닌 쪽의 가시성(`actorSeesItemSql`, TS 술어를 골든으로) · 임대는 PAT 주인 에이전트 몫만 · 푸시는 지금 세션에
//! 묶인 줄만. 순서는 TS 와 같다(본문 → preHandler → zod).
use crate::auth::{Auth, RequireAccount, Via};
use crate::directory::{form_pairs, internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::routes::AppState;
use crate::write::{Body, emit_event};
use crate::writes_settings::{bad, body_then, js_len, write_pool};
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}
macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

// ── 작업 항목 ─────────────────────────────────────────────────────────

/// services/workItems.ts `WORK_ITEM_SOURCES`·`MAX_ITEMS_PER_OWNER`.
const WORK_ITEM_SOURCES: &[&str] = &["github", "jira", "slack", "other", "avcs"];
const NO_OWNER: &str = "this agent has no human owner, so it has no board to write to";

struct Frags {
    vis_owner: String,
    vis_actor: String,
}
fn frags() -> &'static Frags {
    static F: OnceLock<Frags> = OnceLock::new();
    F.get_or_init(|| {
        let v: Value =
            serde_json::from_str(include_str!("../golden/sql_fragments.json")).expect("golden");
        Frags {
            vis_owner: v["channel_visible_c_p1uuid"]
                .as_str()
                .expect("c_p1")
                .to_string(),
            vis_actor: v["channel_visible_ac_p2uuid"]
                .as_str()
                .expect("ac_p2")
                .to_string(),
        }
    })
}

/// TS `actorSeesItemSql('w', '$2')` — 주인이 아닌 쪽은 자기가 지금 볼 수 있는 스레드에 붙은 항목만.
fn actor_sees() -> String {
    format!(
        "(w.thread_root_id is not null and exists (select 1 from message am join channel ac on ac.id = am.channel_id \
          where am.id = w.thread_root_id and am.deleted_at is null and {}))",
        frags().vis_actor
    )
}

/// TS `resolveWorkItemOwner` — 사람은 자신, 에이전트는 살아 있는 사람 주인, 그 밖은 없음.
async fn work_item_owner(
    pool: &PgPool,
    me: &crate::auth::Account,
) -> Result<Option<String>, sqlx::Error> {
    match me.kind.as_str() {
        "human" => Ok(Some(me.id.clone())),
        "agent" => sqlx::query_scalar(
            "select o.id::text from agent_config c join account o on o.id = c.owner_account_id \
              where c.account_id = $1::uuid and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null",
        )
        .bind(&me.id)
        .fetch_optional(pool)
        .await,
        _ => Ok(None),
    }
}

fn no_owner() -> Response {
    json_err(StatusCode::FORBIDDEN, "no_owner", NO_OWNER)
}

/// zod `{ threadRootId: uuid?, source: enum? }` — 모르는 키는 버린다.
pub fn parse_items_query(
    raw: Option<&str>,
) -> Result<(Option<String>, Option<String>), &'static str> {
    let (mut root, mut source) = (None, None);
    let mut seen: Vec<String> = vec![];
    for (k, v) in form_pairs(raw.unwrap_or("")) {
        if !matches!(k.as_str(), "threadRootId" | "source") {
            continue;
        }
        if seen.contains(&k) {
            return Err("duplicate query key");
        }
        seen.push(k.clone());
        if k == "threadRootId" {
            if !is_zod_uuid(&v) {
                return Err("threadRootId");
            }
            root = Some(v);
        } else {
            if !WORK_ITEM_SOURCES.contains(&v.as_str()) {
                return Err("source");
            }
            source = Some(v);
        }
    }
    Ok((root, source))
}

fn list_items_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select json_build_object('items', coalesce((select json_agg(x order by x.ord desc) from (\
               select w.id, w.source, w.external_key as \"externalKey\", w.url, w.title, w.state, \
                      w.thread_root_id as \"threadRootId\", w.updated_by as \"updatedBy\", \
                      {created} as \"createdAt\", {updated} as \"updatedAt\", w.updated_at as ord \
                 from work_item w left join message m on m.id = w.thread_root_id left join channel c on c.id = m.channel_id \
                where w.owner_account_id = $1::uuid \
                  and ($2::uuid = $1::uuid or {actor}) \
                  and ($3::uuid is null or w.thread_root_id = $3::uuid) \
                  and ($4::text is null or w.source = $4::text) \
                  and (w.thread_root_id is null or (m.deleted_at is null and {vis})) \
                order by w.updated_at desc limit 500) x), '[]'::json))::text",
            created = crate::iso!("w.created_at"),
            updated = crate::iso!("w.updated_at"),
            actor = actor_sees(),
            vis = frags().vis_owner,
        )
    })
}

/// `GET /work-items` — 보드 주인의 항목(주인이 아니면 볼 수 있는 스레드의 것만). 정렬용 칸은 지운다.
pub async fn list_items(
    State(pool): State<PgPool>,
    RequireAccount(me, _): RequireAccount,
    RawQuery(raw): RawQuery,
) -> Response {
    let (root, source) = match parse_items_query(raw.as_deref()) {
        Ok(q) => q,
        Err(m) => return bad(m),
    };
    let Some(owner) = db!(work_item_owner(&pool, &me).await) else {
        return no_owner();
    };
    let text: String = db!(sqlx::query_scalar(list_items_sql())
        .bind(&owner)
        .bind(&me.id)
        .bind(&root)
        .bind(&source)
        .fetch_one(&pool)
        .await);
    let mut v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if let Some(items) = v["items"].as_array_mut() {
        for it in items {
            if let Some(o) = it.as_object_mut() {
                o.remove("ord");
            }
        }
    }
    json_ok(v.to_string())
}

fn delete_item_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "delete from work_item w where w.owner_account_id = $1::uuid and w.id = $3::uuid and ($2::uuid = $1::uuid or {})",
            actor_sees()
        )
    })
}

/// `DELETE /work-items/{id}` — 주인 보드의 것만, 주인이 아니면 볼 수 있는 스레드의 것만(범위 밖은 없는 것과 같은 404).
/// 지우면 주인에게 `inbox.updated`(같은 트랜잭션).
pub async fn delete_item(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, RequireAccount(me, _), _) = tri!(body_then::<RequireAccount>(req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let pool = tri!(write_pool(&st));
    let Some(owner) = db!(work_item_owner(pool, &me).await) else {
        return no_owner();
    };
    let mut tx = db!(pool.begin().await);
    let n = db!(sqlx::query(delete_item_sql())
        .bind(&owner)
        .bind(&me.id)
        .bind(&id)
        .execute(&mut *tx)
        .await)
    .rows_affected();
    if n == 0 {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such work item");
    }
    db!(emit_event(
        &mut tx,
        &json!({ "type": "inbox.updated", "accountId": owner })
    )
    .await);
    db!(tx.commit().await);
    StatusCode::NO_CONTENT.into_response()
}

// ── 스레드 임대 ───────────────────────────────────────────────────────

/// services/threadClaims.ts `THREAD_CLAIM_*_TTL_SEC`.
const TTL_DEFAULT: i64 = 90;
const TTL_MIN: f64 = 15.0;
const TTL_MAX: f64 = 600.0;
const CLAIM_BAD: &str = "channelId, threadRootId (uuid) and holder are required";

#[derive(Debug, PartialEq, Eq)]
pub struct ClaimKey {
    pub channel: String,
    pub root: String,
    pub holder: String,
    pub ttl: i64,
}

/// zod `{ channelId: uuid, threadRootId: uuid, holder: string 1..100, ttlSec?: int 15..600 }`(`req.body ?? {}`).
pub fn parse_claim(body: &Body, with_ttl: bool) -> Option<ClaimKey> {
    let empty = Map::new();
    let o = match body {
        Body::Json(Value::Object(o)) => o,
        Body::None => &empty,
        _ => return None,
    };
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let (channel, root, holder) = (s("channelId")?, s("threadRootId")?, s("holder")?);
    if !is_zod_uuid(channel) || !is_zod_uuid(root) || !(1..=100).contains(&js_len(holder)) {
        return None;
    }
    let ttl = match (with_ttl, o.get("ttlSec")) {
        (true, Some(v)) => {
            let n = v.as_f64()?;
            if n.fract() != 0.0 || !(TTL_MIN..=TTL_MAX).contains(&n) {
                return None;
            }
            n as i64
        }
        _ => TTL_DEFAULT,
    };
    Some(ClaimKey {
        channel: channel.into(),
        root: root.into(),
        holder: holder.into(),
        ttl,
    })
}

#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn agent_claim_gate(req: Request) -> Result<(Body, crate::auth::Account), Response> {
    let (body, RequireAccount(me, _), _) = body_then::<RequireAccount>(req).await?;
    if me.kind != "agent" {
        return Err(json_err(
            StatusCode::FORBIDDEN,
            "agent_only",
            "thread claims are only for agent accounts",
        ));
    }
    Ok((body, me))
}

/// `POST /agent/thread-claims` — 잡기·하트비트. 남이 산 임대를 쥐었으면 409(`expiresAt` 실음). `cache-control: no-store`.
pub async fn claim(State(st): State<AppState>, req: Request) -> Response {
    let (body, me) = tri!(agent_claim_gate(req).await);
    let Some(k) = parse_claim(&body, true) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", CLAIM_BAD);
    };
    let pool = tri!(write_pool(&st));
    db!(sqlx::query("delete from agent_thread_claim where agent_id = $1::uuid and expires_at < now() - interval '1 hour'").bind(&me.id).execute(pool).await);
    let won: Option<String> = db!(sqlx::query_scalar(concat!(
        "insert into agent_thread_claim (agent_id, channel_id, thread_root_id, holder, expires_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4, now() + make_interval(secs => $5::int)) \
         on conflict (agent_id, channel_id, thread_root_id) do update \
           set holder = excluded.holder, expires_at = excluded.expires_at, \
               claimed_at = case when agent_thread_claim.holder = excluded.holder then agent_thread_claim.claimed_at else now() end \
           where agent_thread_claim.holder = excluded.holder or agent_thread_claim.expires_at <= now() \
         returning ",
        crate::iso!("expires_at")
    ))
    .bind(&me.id)
    .bind(&k.channel)
    .bind(&k.root)
    .bind(&k.holder)
    .bind(k.ttl as i32)
    .fetch_optional(pool)
    .await);
    let mut r = match won {
        Some(at) => json_ok(json!({ "claimed": true, "expiresAt": at }).to_string()),
        None => {
            let held: Option<String> = db!(sqlx::query_scalar(concat!(
                "select ",
                crate::iso!("expires_at"),
                " from agent_thread_claim where agent_id = $1::uuid and channel_id = $2::uuid and thread_root_id = $3::uuid"
            ))
            .bind(&me.id)
            .bind(&k.channel)
            .bind(&k.root)
            .fetch_optional(pool)
            .await);
            let body = json!({
                "error": { "code": "thread_claimed", "message": "another runner of this agent holds this thread" },
                "expiresAt": held,
            });
            let mut r = json_ok(body.to_string());
            *r.status_mut() = StatusCode::CONFLICT;
            r
        }
    };
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// `POST /agent/thread-claims/release` — 멱등(이미 없거나 남의 것이어도 204, 남의 임대는 지우지 않는다).
pub async fn release(State(st): State<AppState>, req: Request) -> Response {
    let (body, me) = tri!(agent_claim_gate(req).await);
    let Some(k) = parse_claim(&body, false) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", CLAIM_BAD);
    };
    let pool = tri!(write_pool(&st));
    db!(sqlx::query("delete from agent_thread_claim where agent_id = $1::uuid and channel_id = $2::uuid and thread_root_id = $3::uuid and holder = $4")
        .bind(&me.id)
        .bind(&k.channel)
        .bind(&k.root)
        .bind(&k.holder)
        .execute(pool)
        .await);
    StatusCode::NO_CONTENT.into_response()
}

// ── 푸시 기기 ─────────────────────────────────────────────────────────

/// pushRoutes.ts `PUSH_DEVICES_PER_ACCOUNT`·`DEFAULT_PUSH_PREFS`.
const PUSH_DEVICES_PER_ACCOUNT: i64 = 20;
const PREF_KEYS: &[&str] = &["mention", "dm", "threadReply", "ask", "preview", "badge"];
fn default_prefs() -> Map<String, Value> {
    let mut m = Map::new();
    for (k, v) in [
        ("mention", true),
        ("dm", true),
        ("threadReply", true),
        ("ask", true),
        ("preview", false),
        ("badge", true),
    ] {
        m.insert(k.into(), Value::Bool(v));
    }
    m
}

/// TS `requireHumanSession` — 사람의 로그인 세션만(PAT·오퍼레이터 토큰 403).
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
fn human_session(auth: &Auth) -> Result<(String, String), Response> {
    let Some(a) = &auth.account else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        ));
    };
    match (&auth.via, &auth.credential_hash) {
        (Some(Via::Session), Some(h)) if a.kind == "human" => Ok((a.id.clone(), h.clone())),
        _ => Err(json_err(
            StatusCode::FORBIDDEN,
            "push_session_only",
            "푸시 기기는 사람의 로그인 세션으로만 등록한다",
        )),
    }
}

#[derive(Debug, PartialEq)]
pub struct DeviceInput {
    pub token: String,
    pub env: String,
    pub prefs: Map<String, Value>,
}

/// zod strict `{ token: /^[0-9a-fA-F]{64,200}$/ → 소문자, platform: 'ios', env: enum, prefs?: partial strict booleans }`.
pub fn parse_device(body: &Body) -> Result<DeviceInput, &'static str> {
    let Body::Json(Value::Object(o)) = body else {
        return Err("expected object");
    };
    if o.keys()
        .any(|k| !matches!(k.as_str(), "token" | "platform" | "env" | "prefs"))
    {
        return Err("unrecognized key");
    }
    let token = match o.get("token") {
        Some(Value::String(t))
            if (64..=200).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            t.to_ascii_lowercase()
        }
        _ => return Err("token"),
    };
    if o.get("platform") != Some(&Value::String("ios".into())) {
        return Err("platform");
    }
    let env = match o.get("env") {
        Some(Value::String(e)) if e == "production" || e == "sandbox" => e.clone(),
        _ => return Err("env"),
    };
    let prefs = match o.get("prefs") {
        None => Map::new(),
        Some(Value::Object(p)) => {
            if p.iter()
                .any(|(k, v)| !PREF_KEYS.contains(&k.as_str()) || !v.is_boolean())
            {
                return Err("prefs");
            }
            p.clone()
        }
        Some(_) => return Err("prefs"),
    };
    Ok(DeviceInput { token, env, prefs })
}

const UPSERT_DEVICE: &str = concat!(
    "insert into push_device (account_id, session_token_hash, platform, apns_env, token, prefs) \
     values ($1::uuid, $2, 'ios', $3, $4, $5::jsonb) \
     on conflict (token, account_id) do update \
       set session_token_hash = excluded.session_token_hash, platform = excluded.platform, \
           apns_env = excluded.apns_env, prefs = excluded.prefs, last_seen_at = now() \
     returning json_build_object('id', id, 'platform', platform, 'env', apns_env, 'prefs', prefs, 'createdAt', ",
    crate::iso!("created_at"),
    ", 'lastSeenAt', ",
    crate::iso!("last_seen_at"),
    ")::text"
);

/// `PUT /push/devices` — 같은 (토큰, 계정)이면 지금 세션으로 옮기고 prefs 는 보낸 키만 바꾼다. 계정당 20대(가장 오래 안 본 것부터 지움).
pub async fn put_device(State(st): State<AppState>, req: Request) -> Response {
    let (body, RequireAccount(_, auth), _) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        // 계정이 없으면 RequireAccount 가 TS 와 같은 401 을 낸다.
        Err(r) => return r,
    };
    let (account, hash) = tri!(human_session(&auth));
    let dev = tri!(parse_device(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let mut tx = db!(pool.begin().await);
    let before: Option<String> = db!(sqlx::query_scalar(
        "select prefs::text from push_device where token = $1 and account_id = $2::uuid for update"
    )
    .bind(&dev.token)
    .bind(&account)
    .fetch_optional(&mut *tx)
    .await);
    let mut prefs = default_prefs();
    if let Some(Value::Object(b)) = before.as_deref().and_then(|s| serde_json::from_str(s).ok()) {
        prefs.extend(b);
    }
    prefs.extend(dev.prefs.clone());
    let row: String = db!(sqlx::query_scalar(UPSERT_DEVICE)
        .bind(&account)
        .bind(&hash)
        .bind(&dev.env)
        .bind(&dev.token)
        .bind(Value::Object(prefs).to_string())
        .fetch_one(&mut *tx)
        .await);
    db!(sqlx::query(
        "delete from push_device where account_id = $1::uuid and id not in (\
           select id from push_device where account_id = $1::uuid order by last_seen_at desc, id limit $2)"
    )
    .bind(&account)
    .bind(PUSH_DEVICES_PER_ACCOUNT)
    .execute(&mut *tx)
    .await);
    db!(tx.commit().await);
    json_ok(row)
}

/// `DELETE /push/devices/current` — 지금 세션에 묶인 줄만 지운다(토큰을 받지 않는다). 204.
pub async fn delete_device(State(st): State<AppState>, req: Request) -> Response {
    let (_, RequireAccount(_, auth), _) = tri!(body_then::<RequireAccount>(req).await);
    let (account, hash) = tri!(human_session(&auth));
    let pool = tri!(write_pool(&st));
    db!(sqlx::query(
        "delete from push_device where session_token_hash = $1 and account_id = $2::uuid"
    )
    .bind(&hash)
    .bind(&account)
    .execute(pool)
    .await);
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn claim_shapes() {
        let ok =
            Body::Json(json!({ "channelId": U, "threadRootId": U, "holder": "h", "ttlSec": 30 }));
        assert_eq!(parse_claim(&ok, true).unwrap().ttl, 30);
        assert_eq!(parse_claim(&ok, false).unwrap().ttl, TTL_DEFAULT);
        assert!(
            parse_claim(&Body::None, true).is_none(),
            "본문 없음은 빈 객체로 읽혀 400"
        );
        assert!(
            parse_claim(
                &Body::Json(json!({ "channelId": U, "threadRootId": U, "holder": "" })),
                true
            )
            .is_none()
        );
        assert!(
            parse_claim(
                &Body::Json(
                    json!({ "channelId": U, "threadRootId": U, "holder": "h", "ttlSec": 5 })
                ),
                true
            )
            .is_none()
        );
        assert!(
            parse_claim(
                &Body::Json(
                    json!({ "channelId": U, "threadRootId": U, "holder": "h", "ttlSec": 30.5 })
                ),
                true
            )
            .is_none()
        );
    }

    #[test]
    fn device_shapes() {
        let t = "AB".repeat(32);
        let d = parse_device(&Body::Json(json!({ "token": t, "platform": "ios", "env": "sandbox", "prefs": { "preview": true } }))).unwrap();
        assert_eq!(d.token, "ab".repeat(32), "소문자로");
        assert!(
            parse_device(&Body::Json(
                json!({ "token": "ab".repeat(32), "platform": "android", "env": "sandbox" })
            ))
            .is_err()
        );
        assert!(
            parse_device(&Body::Json(
                json!({ "token": "ab".repeat(32), "platform": "ios", "env": "sandbox", "x": 1 })
            ))
            .is_err(),
            "strict"
        );
        assert!(parse_device(&Body::Json(json!({ "token": "ab".repeat(32), "platform": "ios", "env": "sandbox", "prefs": { "loud": true } }))).is_err());
        assert!(
            parse_device(&Body::Json(
                json!({ "token": "zz".repeat(32), "platform": "ios", "env": "sandbox" })
            ))
            .is_err()
        );
    }

    #[test]
    fn items_query() {
        assert_eq!(
            parse_items_query(Some("source=github&x=1")),
            Ok((None, Some("github".into())))
        );
        assert!(parse_items_query(Some("source=gitlab")).is_err());
        assert!(parse_items_query(Some("threadRootId=nope")).is_err());
    }
}
