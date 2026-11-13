//! 인박스 「오늘」 읽기(S5.2 P2b) — TS `routes/inboxTodayRoutes.ts` 의 `GET /inbox/today/open`·`/done` 과
//! `services/inboxToday.ts`(`openVersion`·`listTodayOpen`·`doneVersion`·`listTodayDone`·커서)를 옮긴다. `PUT /inbox/today/seen`
//! (`markSeen`) 은 쓰기 바탕(P3) 위에서 옮긴다 — 쓰기 풀이 있을 때만 마운트된다(`routes::MOVED_WRITE`).
//!
//! **「내 것만」.** 계정은 언제나 부른 사람(`RequireAccount`)이다 — 질의·몸통으로 받지 않는다. 가시성 술어(`channelVisibleSql`)와
//! 시스템 글 본문(`displayBodySql`)은 TS 가 정본이고, 여기선 `golden/sql_fragments.json` 을 읽어 쓴다. 그 파일이 TS 출력과 같은지는
//! `packages/server/test/rustSqlFragments.test.ts` 가 본다 — TS 쪽 술어가 바뀌면 그 시험이 먼저 빨개진다.
//!
//! **버전 태그·ETag.** 본문 전에 TS 와 같은 문장으로 태그를 구하고, `If-None-Match` 가 맞으면 본문 질의 없이 304 를 낸다.
//! ETag 는 TS 와 같은 식(`sha256(accountId ‖ 0 ‖ version)` 의 base64url 앞 32자, 따옴표 포함)이라 두 구현 사이에서도 맞는다
//! (태그 재료의 `::text` 시각은 DB 세션 시간대를 따른다 — `/dms` 와 같은 「앞단 배포 전 시간대 확인」 항목).
//!
//! 닿는 메모리 상태: 없다(`inboxToday.ts` 의 `Map`·`Set` 은 한 요청 안의 지역 변수).
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::OnceLock;

pub const TODAY_OPEN_MAX: usize = 200;
pub const TODAY_DONE_MAX: i64 = 50;
const TEXT_MAX: &str = "500";

struct Frags {
    vis: String,
    body: String,
}

fn frags() -> &'static Frags {
    static F: OnceLock<Frags> = OnceLock::new();
    F.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        Frags {
            vis: v["channel_visible_c_p1uuid"]
                .as_str()
                .expect("vis")
                .to_string(),
            body: v["display_body_m"].as_str().expect("body").to_string(),
        }
    })
}

/// TS `etagFor`.
pub fn etag_for(account_id: &str, version: &str) -> String {
    let mut h = Sha256::new();
    h.update(account_id.as_bytes());
    h.update([0u8]);
    h.update(version.as_bytes());
    let mut s = b64url(&h.finalize());
    s.truncate(32);
    format!("\"{s}\"")
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// 덧붙임 없는 base64url(Node `toString('base64url')`).
pub fn b64url(b: &[u8]) -> String {
    let mut o = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..=c.len() {
            o.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    o
}

/// Node `Buffer.from(s, 'base64url')` 와 같게 두 알파벳(`+/`·`-_`)을 다 받고 `=` 는 버린다. 그 밖의 글자가 있으면 `None`
/// (Node 는 건너뛰지만, 그런 커서는 이 서버가 낸 적이 없어 어차피 400 `bad_cursor` 로 떨어진다).
pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut acc = 0u32;
    let mut bits = 0;
    let mut out = vec![];
    for c in s.bytes().filter(|c| *c != b'=') {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// TS `notModified` — 응답에 etag·cache-control 을 달고, `If-None-Match` 의 쉼표 목록에 같은 태그가 있으면 참.
fn not_modified(req: &HeaderMap, etag: &str) -> bool {
    req.get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|inm| inm.split(',').any(|t| t.trim() == etag))
}

fn with_tag(mut r: Response, etag: &str) -> Response {
    if let Ok(v) = HeaderValue::from_str(etag) {
        r.headers_mut().insert(header::ETAG, v);
    }
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    r
}

fn ok_json(v: &Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        v.to_string(),
    )
        .into_response()
}

// ── 열린 것 ───────────────────────────────────────────────────────────

/// TS `openCtes()` — `$1` 계정(uuid), `$2` 사람인가.
fn open_ctes() -> String {
    let vis = &frags().vis;
    format!(
        "with r as (
    select distinct on (m.id) m.id, coalesce(m.thread_root_id, m.id) as root, m.channel_id, m.author_id,
           m.created_at, m.seq, m.meta, m.edited_at, m.kind as mkind
      from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
     where i.account_id = $1::uuid and m.deleted_at is null and {vis}
     order by m.id
  ), roots as (select distinct root from r),
  asks as (
    select r.* from r
     where r.meta->>'kind' = 'ask'
       and r.meta->'ask'->>'answeredWith' is null
       and r.meta->'ask'->>'closedAt' is null
       and r.meta->'ask'->>'mirrorOf' is null
       and not (r.meta ? 'permissionRequest')
       and ((r.meta->'ask'->'to'->>'kind' = 'human' and $2::boolean)
         or (r.meta->'ask'->'to'->>'kind' = 'account' and r.meta->'ask'->'to'->>'accountId' = $1::text))
  ), fails as (
    select r.* from r
     where $2::boolean and r.meta->>'kind' = 'failure'
       and not exists (
         select 1 from message x
          where (x.id = r.root or x.thread_root_id = r.root) and x.deleted_at is null and x.seq > r.seq
            and (x.kind in ('progress', 'wake') or x.meta->>'kind' = 'report' or x.author_id = r.author_id))
  ), perms as (
    select pr.id, pr.card_message_id, pr.thread_root_id, pr.channel_id, pr.agent_id, pr.kind, pr.target, pr.reason, pr.created_at
      from permission_request pr
      join agent_config ac on ac.account_id = pr.agent_id
      join channel c on c.id = pr.channel_id
     where ac.owner_account_id = $1::uuid and pr.status = 'pending' and pr.expires_at > now()
       and {vis}
  ), st as (
    select ts.root_id, ts.status, ts.reason, ts.updated_at from thread_status ts join roots on roots.root = ts.root_id
  )"
    )
}

fn open_version_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "{}
     select md5(coalesce((select string_agg(k, ',' order by k) from (
              select 'a' || id || ':' || coalesce(edited_at::text, '') from asks
              union all select 'f' || id || ':' || coalesce(edited_at::text, '') from fails
              union all select 'p' || id || ':' || coalesce(card_message_id::text, '') from perms
              union all select 's' || root_id || ':' || status || ':' || updated_at::text from st
            ) x(k)), '')) as sig,
            (select seen_at::text from inbox_view_cursor where account_id = $1::uuid) as seen,
            ((now() at time zone 'utc')::date)::text as day",
            open_ctes()
        )
    })
}

/// 행마다 JS 가 `Date` 로 읽어 쓰는 값(밀리초로 버림)을 SQL 에서 미리 낸다: ISO 글자·epoch 밀리초·UTC 날짜 차.
fn open_rows_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let body = &frags().body;
        format!(
            "{ctes}, rows as (
       select 'ask' as k, a.id, a.root, a.channel_id, a.author_id, a.created_at, a.meta,
              left(coalesce(nullif(a.meta->'ask'->>'prompt', ''), {body}), {TEXT_MAX}) as text,
              null::text as status, null::text as reason, null::uuid as perm_id
         from asks a join message m on m.id = a.id
       union all
       select 'fail', f.id, f.root, f.channel_id, f.author_id, f.created_at, null,
              left(coalesce(nullif(f.meta->'failure'->>'reason', ''), nullif(f.meta->'failure'->>'what', ''), {body}), {TEXT_MAX}),
              null, null, null
         from fails f join message m on m.id = f.id
       union all
       select 'perm', p.card_message_id, p.thread_root_id, p.channel_id, p.agent_id, p.created_at, null,
              left(p.target, {TEXT_MAX}), p.kind, p.reason, p.id
         from perms p
       union all
       select 'st', null, s.root_id, m.channel_id, m.author_id, s.updated_at, null,
              left(coalesce(s.reason, ''), {TEXT_MAX}), s.status, null, null
         from st s join message m on m.id = s.root_id
     )
     select rows.k, rows.id::text, rows.root::text, rows.channel_id::text, rows.author_id::text,
            {iso} as created_iso,
            floor(extract(epoch from rows.created_at) * 1000)::bigint as created_ms,
            greatest(0, (now() at time zone 'utc')::date - (date_trunc('milliseconds', rows.created_at) at time zone 'utc')::date)::bigint as age_days,
            rows.meta::text, rows.text, rows.status, rows.reason, rows.perm_id::text
       from rows",
            ctes = open_ctes(),
            iso = crate::iso!("rows.created_at"),
        )
    })
}

type OpenRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// TS `String(x)` 의 흔한 꼴 — 글자·수·참거짓은 그대로, null 은 "null", 없으면 "undefined".
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `GET /inbox/today/open`.
pub async fn open(
    State(pool): State<PgPool>,
    RequireAccount(me, _): RequireAccount,
    headers: HeaderMap,
) -> Response {
    let human = me.kind == "human";
    let v = sqlx::query_as::<_, (String, Option<String>, String)>(open_version_sql())
        .bind(&me.id)
        .bind(human)
        .fetch_one(&pool)
        .await;
    let (sig, seen_txt, day) = match v {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let etag = etag_for(
        &me.id,
        &format!("open|{sig}|{}|{day}", seen_txt.unwrap_or_default()),
    );
    if not_modified(&headers, &etag) {
        return with_tag(StatusCode::NOT_MODIFIED.into_response(), &etag);
    }
    match open_body(&pool, &me.id, human).await {
        Ok(b) => with_tag(ok_json(&b), &etag),
        Err(e) => internal(e),
    }
}

async fn open_body(pool: &PgPool, account: &str, human: bool) -> Result<Value, sqlx::Error> {
    // TS `getSeenAt` — 밀리초 ISO 와 epoch 밀리초.
    let seen: Option<(String, i64)> = sqlx::query_as(concat!(
        "select ",
        crate::iso!("seen_at"),
        ", floor(extract(epoch from seen_at) * 1000)::bigint from inbox_view_cursor where account_id = $1::uuid"
    ))
    .bind(account)
    .fetch_optional(pool)
    .await?;
    let rows: Vec<OpenRow> = sqlx::query_as(open_rows_sql())
        .bind(account)
        .bind(human)
        .fetch_all(pool)
        .await?;
    Ok(build_open(&rows, seen.as_ref()))
}

fn build_open(rows: &[OpenRow], seen: Option<&(String, i64)>) -> Value {
    let mut status_by_root = std::collections::HashMap::new();
    let (mut running, mut waiting) = (0, 0);
    for r in rows.iter().filter(|r| r.0 == "st") {
        let st = r.10.clone().unwrap_or_default();
        match st.as_str() {
            "running" | "received" => running += 1,
            "waiting" | "my-turn" => waiting += 1,
            _ => {}
        }
        status_by_root.insert(r.2.clone(), st);
    }
    let done = |root: &str| status_by_root.get(root).is_some_and(|s| s == "done");
    let asks: Vec<&OpenRow> = rows.iter().filter(|r| r.0 == "ask").collect();
    let fail_roots: std::collections::HashSet<&str> = rows
        .iter()
        .filter(|r| r.0 == "fail")
        .map(|r| r.2.as_str())
        .collect();
    // (정렬 열쇠, 줄)
    let mut items: Vec<(String, String, Value)> = vec![];
    for r in rows {
        let (k, id, root, channel, author, iso, ms, age) =
            (&r.0, &r.1, &r.2, &r.3, &r.4, &r.5, r.6, r.7);
        if k == "st" && (r.10.as_deref() != Some("stuck") || fail_roots.contains(root.as_str())) {
            continue;
        }
        let is_new = seen.is_none_or(|(_, s)| ms > *s);
        let mut o = serde_json::Map::new();
        let push_base = |o: &mut serde_json::Map<String, Value>| {
            o.insert("threadRootId".into(), json!(root));
            o.insert("channelId".into(), json!(channel));
            o.insert("authorId".into(), json!(author));
            o.insert("question".into(), json!(r.9.clone().unwrap_or_default()));
            o.insert("createdAt".into(), json!(iso));
            o.insert("isNew".into(), json!(is_new));
            o.insert("ageDays".into(), json!(age));
        };
        let message_id: Option<String>;
        if k == "ask" {
            message_id = id.clone();
            o.insert("kind".into(), json!("ask"));
            o.insert("messageId".into(), json!(id));
            push_base(&mut o);
            let meta: Value =
                r.8.as_deref()
                    .and_then(|m| serde_json::from_str(m).ok())
                    .unwrap_or(Value::Null);
            let opts: Vec<Value> = meta
                .pointer("/ask/options")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|x| json!({ "id": js_string(x.get("id")), "label": js_string(x.get("label")) }))
                        .collect()
                })
                .unwrap_or_default();
            o.insert("options".into(), Value::Array(opts));
            let newer = asks
                .iter()
                .any(|x| x.1 != *id && x.2 == *root && x.4 == *author && x.6 > ms);
            let hint = if done(root) {
                json!("thread_done")
            } else if newer {
                json!("newer_card")
            } else {
                Value::Null
            };
            o.insert("staleHint".into(), hint);
        } else if k == "perm" {
            message_id = id.clone();
            o.insert("kind".into(), json!("permission"));
            o.insert("messageId".into(), json!(id));
            o.insert("permissionRequestId".into(), json!(r.12));
            push_base(&mut o);
            o.insert("reason".into(), json!(r.11));
            o.insert(
                "staleHint".into(),
                if done(root) {
                    json!("thread_done")
                } else {
                    Value::Null
                },
            );
        } else {
            let mid = if k == "fail" {
                id.clone()
            } else {
                Some(root.clone())
            };
            message_id = mid.clone();
            o.insert("kind".into(), json!("blocked"));
            o.insert("messageId".into(), json!(mid));
            push_base(&mut o);
            o.insert(
                "staleHint".into(),
                if done(root) {
                    json!("thread_done")
                } else {
                    Value::Null
                },
            );
        }
        let tie = message_id.unwrap_or_else(|| root.clone());
        items.push((iso.clone(), tie, Value::Object(o)));
    }
    // TS: createdAt 글자 → (messageId ?? threadRootId) 글자. 둘 다 자리 고정 꼴이라 바이트 순서와 localeCompare 가 같다.
    items.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let truncated = items.len() > TODAY_OPEN_MAX;
    let items: Vec<Value> = items
        .into_iter()
        .take(TODAY_OPEN_MAX)
        .map(|x| x.2)
        .collect();
    json!({
        "items": items,
        "truncated": truncated,
        "counts": { "running": running, "waiting": waiting },
        "seenAt": seen.map(|s| s.0.clone()),
    })
}

// ── 끝난 것 ───────────────────────────────────────────────────────────

/// TS `decodeCursor` — base64url(JSON `[at, key]`), `at` 은 시각으로 읽혀야 하고 `key` 는 64자(UTF-16) 이하.
pub fn decode_cursor(s: &str) -> Option<(String, String)> {
    let bytes = b64url_decode(s)?;
    let text = String::from_utf8_lossy(&bytes);
    let v: Value = serde_json::from_str(&text).ok()?;
    let a = v.as_array()?;
    if a.len() != 2 {
        return None;
    }
    let (at, key) = (a[0].as_str()?, a[1].as_str()?);
    if !looks_like_date(at) || key.encode_utf16().count() > 64 {
        return None;
    }
    Some((at.to_string(), key.to_string()))
}

/// JS `Date.parse` 가 받는 꼴 중 ISO 꼴만(`YYYY-MM-DD`, 뒤에 `THH:MM[:SS[.f…]]` 와 `Z`·`±HH:MM`). 서버가 내는 커서는 언제나 이 꼴이다.
pub fn looks_like_date(s: &str) -> bool {
    let b = s.as_bytes();
    let d = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let date_ok = b.len() >= 10
        && (0..4).all(d)
        && b[4] == b'-'
        && d(5)
        && d(6)
        && b[7] == b'-'
        && d(8)
        && d(9);
    if !date_ok {
        return false;
    }
    let mut i = 10;
    if i == b.len() {
        return true;
    }
    if b[i] != b'T' {
        return false;
    }
    i += 1;
    if !(d(i) && d(i + 1) && b.get(i + 2) == Some(&b':') && d(i + 3) && d(i + 4)) {
        return false;
    }
    i += 5;
    if b.get(i) == Some(&b':') {
        if !(d(i + 1) && d(i + 2)) {
            return false;
        }
        i += 3;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while d(i) {
                i += 1;
            }
            if i == start {
                return false;
            }
        }
    }
    match &b[i..] {
        [] | [b'Z'] => true,
        [b'+' | b'-', h1, h2, b':', m1, m2] => [h1, h2, m1, m2].iter().all(|c| c.is_ascii_digit()),
        _ => false,
    }
}

/// TS `encodeCursor` — `JSON.stringify([at, key])` 의 base64url.
pub fn encode_cursor(at: &str, key: &str) -> String {
    b64url(serde_json::to_string(&[at, key]).expect("json").as_bytes())
}

/// `GET /inbox/today/done` 의 질의 — TS zod `{ since: string max 200?, limit: coerce int 1..=50? }`.
pub fn parse_done_query(raw: Option<&str>) -> Result<(Option<String>, Option<i64>), &'static str> {
    let (mut since, mut limit) = (None, None);
    for (k, v) in crate::directory::form_pairs(raw.unwrap_or("")) {
        match k.as_str() {
            "since" => {
                if since.is_some() {
                    return Err("duplicate query key");
                }
                if v.encode_utf16().count() > 200 {
                    return Err("since too long");
                }
                since = Some(v);
            }
            "limit" => {
                if limit.is_some() {
                    return Err("duplicate query key");
                }
                let n = crate::directory::coerce_int(&v).ok_or("limit must be an integer")?;
                if !(1..=TODAY_DONE_MAX).contains(&n) {
                    return Err("limit out of range");
                }
                limit = Some(n);
            }
            _ => {}
        }
    }
    Ok((since, limit))
}

fn done_version_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let vis = &frags().vis;
        format!(
            "select
       (select concat_ws('|', count(*) filter (where m.deleted_at is null and {vis}),
                         count(*) filter (where m.deleted_at is not null and {vis}),
                         max(i.id) filter (where {vis}),
                         max(m.edited_at) filter (where {vis})::text,
                         md5(coalesce(string_agg(distinct m.channel_id::text, ',') filter (where {vis}), '')))
          from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
         where i.account_id = $1::uuid) as inbox,
       (select md5(coalesce(string_agg(ts.root_id::text || ':' || ts.status || ':' || ts.updated_at::text || ':' || (rm.deleted_at is null)::text,
                                       ',' order by ts.root_id), ''))
          from thread_status ts join message rm on rm.id = ts.root_id
         where ts.root_id in (
           select coalesce(m.thread_root_id, m.id)
             from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
            where i.account_id = $1::uuid and m.deleted_at is null and {vis})) as st,
       (select seen_at::text from inbox_view_cursor where account_id = $1::uuid) as seen,
       ((now() at time zone 'utc')::date)::text as day"
        )
    })
}

const DEFAULT_SINCE: &str = "select to_char(coalesce((select seen_at from inbox_view_cursor where account_id = $1::uuid),
                       (date_trunc('day', now() at time zone 'utc') - interval '1 day') at time zone 'utc') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";

fn done_rows_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let (vis, body) = (&frags().vis, &frags().body);
        format!(
            "with vis as (
       select m.id, coalesce(m.thread_root_id, m.id) as root, m.channel_id, m.author_id, m.created_at, m.meta, i.reason
         from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
        where i.account_id = $1::uuid and m.deleted_at is null and {vis}
     ), items as (
       select distinct on (v.id) 'report'::text as kind, 'r' || v.id::text as key, v.id, v.root, v.channel_id, v.author_id,
              v.created_at as at_ts
         from vis v
        where (v.meta->>'kind' = 'report' or v.reason = 'delegation_done') and v.created_at >= $2::timestamptz
       union all
       select 'thread_done', 't' || ts.root_id::text, ts.root_id, ts.root_id, rm.channel_id, rm.author_id, ts.updated_at
         from thread_status ts join message rm on rm.id = ts.root_id
        where ts.status = 'done' and ts.updated_at >= $2::timestamptz and rm.deleted_at is null
          and exists (select 1 from vis where vis.root = ts.root_id)
     )
     select it.kind, it.key, it.id::text, it.root::text, it.channel_id::text, it.author_id::text,
            left({body}, {TEXT_MAX}) as body,
            to_char(it.at_ts at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as at
       from items it join message m on m.id = it.id
      where (it.at_ts, it.key) > ($2::timestamptz, $3::text)
      order by it.at_ts, it.key
      limit $4"
        )
    })
}

type DoneRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
);

/// `GET /inbox/today/done`.
pub async fn done(
    State(pool): State<PgPool>,
    RequireAccount(me, _): RequireAccount,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let (since_raw, limit) = match parse_done_query(raw.as_deref()) {
        Ok(q) => q,
        Err(m) => return json_err(StatusCode::BAD_REQUEST, "invalid_request", m),
    };
    let since = match since_raw.as_deref() {
        None => None,
        Some(s) => match decode_cursor(s) {
            Some(c) => Some(c),
            None => {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "bad_cursor",
                    "since is not a cursor from this endpoint",
                );
            }
        },
    };
    let limit = limit.unwrap_or(TODAY_DONE_MAX);
    let v = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, String)>(
        done_version_sql(),
    )
    .bind(&me.id)
    .fetch_one(&pool)
    .await;
    let (inbox, st, seen, day) = match v {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    // JS 템플릿 글자는 null 을 "null" 로 쓴다(`${row.inbox}`) — seen 만 `?? ''`.
    let version = format!(
        "done|{}|{}|{}|{day}|{}|{limit}",
        inbox.as_deref().unwrap_or("null"),
        st.as_deref().unwrap_or("null"),
        seen.unwrap_or_default(),
        since_raw.as_deref().unwrap_or("")
    );
    let etag = etag_for(&me.id, &version);
    if not_modified(&headers, &etag) {
        return with_tag(StatusCode::NOT_MODIFIED.into_response(), &etag);
    }
    match done_body(&pool, &me.id, since, limit).await {
        Ok(b) => with_tag(ok_json(&b), &etag),
        Err(e) => internal(e),
    }
}

async fn done_body(
    pool: &PgPool,
    account: &str,
    since: Option<(String, String)>,
    limit: i64,
) -> Result<Value, sqlx::Error> {
    let since = match since {
        Some(s) => s,
        None => {
            let at: String = sqlx::query_scalar(DEFAULT_SINCE)
                .bind(account)
                .fetch_one(pool)
                .await?;
            (at, String::new())
        }
    };
    let rows: Vec<DoneRow> = sqlx::query_as(done_rows_sql())
        .bind(account)
        .bind(&since.0)
        .bind(&since.1)
        .bind(limit + 1)
        .fetch_all(pool)
        .await?;
    let more = rows.len() as i64 > limit;
    let rows = &rows[..rows.len().min(limit as usize)];
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({ "kind": r.0, "messageId": r.2, "threadRootId": r.3, "channelId": r.4,
                    "authorId": r.5, "body": r.6, "at": r.7 })
        })
        .collect();
    let (last_at, last_key) = rows
        .last()
        .map(|r| (r.7.clone(), r.1.clone()))
        .unwrap_or(since);
    let cursor = encode_cursor(&last_at, &last_key);
    Ok(json!({
        "items": items,
        "nextCursor": if more { Value::String(cursor.clone()) } else { Value::Null },
        "cursor": cursor,
        "cursorAt": last_at,
    }))
}

/// `PUT /inbox/today/seen` — TS 와 같은 순서로 거절한다: 본문(fastify, 익명도 400/415) → 401 → zod(400) → JS `Date`(500).
/// seen 은 `greatest()` 로만 오르고 미래는 지금으로 자른다. 실제로 올랐으면 **같은 트랜잭션에서** `inbox.updated` 를 낸다
/// (TS 는 쓰기 뒤 메모리로 낸다 — 여기선 outbox 라 롤백되면 이벤트도 없다).
pub async fn put_seen(
    State(st): State<crate::routes::AppState>,
    req: axum::extract::Request,
) -> Response {
    use crate::write::{Body, read_body, zod_datetime_offset};
    let (mut parts, body) = req.into_parts();
    let body = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let me = match <RequireAccount as axum::extract::FromRequestParts<()>>::from_request_parts(
        &mut parts,
        &(),
    )
    .await
    {
        Ok(RequireAccount(me, _)) => me,
        Err(r) => return r,
    };
    let up_to = match &body {
        Body::Json(Value::Object(o)) => o.get("upTo"),
        _ => None,
    };
    let iso = match up_to.and_then(Value::as_str).map(zod_datetime_offset) {
        Some(Ok(Some(iso))) => iso,
        Some(Ok(None)) => {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            );
        }
        _ => {
            return json_err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "upTo must be an ISO datetime with offset",
            );
        }
    };
    let Some(write) = st.write.as_ref() else {
        // 마운트 조건(쓰기 풀)이 있으니 여기 오지 않는다.
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    match mark_seen(write, &me.id, &iso).await {
        Ok(seen) => crate::directory::json_ok(json!({ "seenAt": seen }).to_string()),
        Err(e) => internal(e),
    }
}

/// TS `markSeen` + `emitEvent` — 돌려주는 값은 밀리초 ISO(UTC) 의 seenAt.
async fn mark_seen(
    pool: &PgPool,
    account_id: &str,
    up_to_iso: &str,
) -> Result<String, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let (seen, changed): (String, bool) = sqlx::query_as(
        "with prev as (select seen_at from inbox_view_cursor where account_id = $1::uuid), \
         up as ( \
           insert into inbox_view_cursor as v (account_id, seen_at) values ($1::uuid, least($2::timestamptz, now())) \
           on conflict (account_id) do update \
             set seen_at = greatest(v.seen_at, excluded.seen_at), \
                 updated_at = case when excluded.seen_at > v.seen_at then now() else v.updated_at end \
           returning v.seen_at) \
         select to_char(date_trunc('milliseconds', up.seen_at) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
                (select seen_at from prev) is null \
                  or date_trunc('milliseconds', up.seen_at) <> date_trunc('milliseconds', (select seen_at from prev)) \
           from up",
    )
    .bind(account_id)
    .bind(up_to_iso)
    .fetch_one(&mut *tx)
    .await?;
    if changed {
        crate::write::emit_event(
            &mut tx,
            &json!({ "type": "inbox.updated", "accountId": account_id }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(seen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64url_round_trip_and_node_alphabets() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            assert_eq!(b64url_decode(&b64url(s.as_bytes())).unwrap(), s.as_bytes());
        }
        assert_eq!(b64url(b"\xfb\xff"), "-_8");
        assert_eq!(b64url_decode("+/8=").unwrap(), b"\xfb\xff");
        assert!(b64url_decode("a b").is_none());
    }

    #[test]
    fn etag_shape() {
        let e = etag_for("00000000-0000-0000-0000-000000000001", "open|x||2026-11-13");
        assert_eq!(e.len(), 34);
        assert!(e.starts_with('"') && e.ends_with('"'));
        assert_ne!(
            e,
            etag_for("00000000-0000-0000-0000-000000000002", "open|x||2026-11-13"),
            "계정이 섞인다"
        );
    }

    #[test]
    fn cursor_round_trip_and_rejects() {
        let c = encode_cursor(
            "2026-11-13T06:00:00.123456Z",
            "r00000000-0000-0000-0000-000000000001",
        );
        assert_eq!(
            decode_cursor(&c),
            Some((
                "2026-11-13T06:00:00.123456Z".into(),
                "r00000000-0000-0000-0000-000000000001".into()
            ))
        );
        assert!(decode_cursor("not json").is_none());
        assert!(decode_cursor(&b64url(br#"["2026-11-13"]"#)).is_none());
        assert!(decode_cursor(&b64url(br#"["nope","k"]"#)).is_none());
        assert!(
            decode_cursor(&b64url(
                format!("[\"2026-11-13\",\"{}\"]", "k".repeat(65)).as_bytes()
            ))
            .is_none()
        );
        assert!(decode_cursor(&b64url(br#"[1,"k"]"#)).is_none());
    }

    #[test]
    fn date_shapes() {
        for ok in [
            "2026-11-13",
            "2026-11-13T06:00",
            "2026-11-13T06:00:01",
            "2026-11-13T06:00:01.5Z",
            "2026-11-13T06:00:01+09:00",
        ] {
            assert!(looks_like_date(ok), "{ok}");
        }
        for bad in [
            "",
            "2026-1-13",
            "2026-11-13T6:00",
            "2026-11-13T06:00:01.Z",
            "2026-11-13 06:00",
            "x",
        ] {
            assert!(!looks_like_date(bad), "{bad}");
        }
    }

    #[test]
    fn done_query_follows_zod() {
        assert_eq!(parse_done_query(None), Ok((None, None)));
        assert_eq!(parse_done_query(Some("limit=5&x=1")), Ok((None, Some(5))));
        assert!(parse_done_query(Some("limit=0")).is_err());
        assert!(parse_done_query(Some("limit=51")).is_err());
        assert!(parse_done_query(Some(&format!("since={}", "a".repeat(201)))).is_err());
        assert!(parse_done_query(Some("since=a&since=b")).is_err());
    }

    #[test]
    fn golden_fragments_load() {
        assert!(frags().vis.contains("cm_vis.account_id = $1::uuid"));
        assert!(frags().body.contains("m.body"));
    }
}
