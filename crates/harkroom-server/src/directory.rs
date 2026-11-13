//! 읽기① 디렉터리 묶음(S5.2 P1) — TS `directoryRoutes.ts`(`GET /accounts`·`GET /dms`)·`mcpServerRoutes.ts`(`GET /mcp-servers`)·
//! `auditRoutes.ts`(`GET /audit`)를 옮긴다. 질의는 TS 와 같은 문장이고, 응답 JSON 은 **Postgres 가 만든다**(`json_build_object`) —
//! node-pg 가 값을 JSON 으로 바꾸는 규칙을 SQL 로 맞춘다:
//! - `timestamptz` → node-pg 는 `Date` 로 읽고 `toISOString()`(UTC, 밀리초 3자리, `Z`)으로 낸다 → [`iso!`].
//! - `::text` 로 캐스팅한 값·uuid·`bigint::text` 는 문자열 그대로, `int`·`boolean` 은 그대로, `jsonb` 는 값으로.
//!
//! 메모리 상태(TS 의 `Map`·투영 워커)를 읽는 라우트는 여기 두지 않는다 — `GET /leases` 는 `projection.currentUrl()`(투영 워커가
//! 지금 보는 avcs 서버, 프로세스 메모리)에 기대므로 S5.3 코어로 간다.
use crate::auth::RequireAccount;
use crate::perm::require_cap;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;

/// TS `Date#toISOString()` 꼴. PG `MS` 는 마이크로초를 버려 밀리초로 만든다 — node-pg 가 `Date` 로 읽으며 버리는 것과 같다.
#[macro_export]
macro_rules! iso {
    ($col:literal) => {
        concat!(
            "to_char(",
            $col,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

pub(crate) fn json_ok(body: String) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

pub(crate) fn json_err(status: StatusCode, code: &str, message: &str) -> Response {
    let body = format!(
        r#"{{"error":{{"code":{},"message":{}}}}}"#,
        quote(code),
        quote(message)
    );
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// JSON 문자열 리터럴(따옴표 포함).
fn quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// DB 오류 → TS 의 오류 처리기와 같은 500 꼴. 원문은 싣지 않는다(앞단 `auth::layer` 와 같은 원칙).
pub(crate) fn internal(e: sqlx::Error) -> Response {
    eprintln!(
        "front: directory query failed: {}",
        e.as_database_error().map_or("io", |_| "db")
    );
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

// 거절이 곧 axum 응답이라 그대로 돌려준다(`perm::require_cap` 과 같은 까닭, CI clippy 1.99).
#[allow(clippy::result_large_err)]
pub(crate) async fn one_json(
    pool: &PgPool,
    sql: &'static str,
    bind: Option<&str>,
) -> Result<String, Response> {
    let q = sqlx::query_scalar::<_, String>(sql);
    let q = match bind {
        Some(b) => q.bind(b),
        None => q,
    };
    q.fetch_one(pool).await.map_err(internal)
}

const ACCOUNTS: &str = concat!(
    "select json_build_object(",
    "'accounts', coalesce((select json_agg(x order by x.handle) from (",
    "select a.id, a.handle, a.display_name as \"displayName\", a.kind, a.is_admin as \"isAdmin\", a.role, ",
    "a.disabled_at is not null as disabled, a.deleted_at is not null as deleted, ",
    "a.status, a.status_text as \"statusText\", a.avatar_attachment_id as \"avatarAttachmentId\", ",
    "c.owner_account_id as \"ownerAccountId\" ",
    "from account a left join agent_config c on c.account_id = a.id) x), '[]'::json), ",
    // `listHandleGroups`(services/handleGroups.ts) 와 같은 칸.
    "'groups', coalesce((select json_agg(x order by x.handle) from (",
    "select g.id, g.handle, g.display_name as \"displayName\", ",
    iso!("g.created_at"),
    " as \"createdAt\", ",
    "(select count(*) from handle_group_member m where m.group_id = g.id)::int as \"memberCount\" ",
    "from handle_group g) x), '[]'::json), ",
    // `listTeams`(services/teams.ts) 와 같은 칸.
    "'teams', coalesce((select json_agg(x order by x.name) from (",
    "select t.id, t.name, t.created_by as \"createdBy\", ",
    iso!("t.created_at"),
    " as \"createdAt\", ",
    "t.lead_account_id as \"leadAccountId\", t.invoke_scope as \"invokeScope\", t.owner_account_id as \"ownerAccountId\", ",
    "(select count(*) from agent_team_member m where m.team_id = t.id)::int as \"memberCount\" ",
    "from agent_team t) x), '[]'::json)",
    ")::text"
);

/// `GET /accounts` — 비활성·삭제 계정도 준다(작성자 이름을 푸는 표다). 이유는 TS 주석 참고.
pub async fn accounts(State(pool): State<PgPool>, _: RequireAccount) -> Response {
    match one_json(&pool, ACCOUNTS, None).await {
        Ok(b) => json_ok(b),
        Err(r) => r,
    }
}

const DMS: &str = concat!(
    "select json_build_object('dms', coalesce(json_agg(",
    "json_build_object('id', x.id, 'memberIds', x.member_ids, 'lastMessageAt', x.last_text) ",
    "order by x.last_text desc nulls last, x.created_at desc), '[]'::json))::text ",
    "from (select c.id, c.created_at, ",
    "array_agg(m.account_id order by m.account_id) as member_ids, ",
    // TS 는 `max(created_at)::text`(세션 시간대의 PG 글자꼴)를 그대로 내고, `order by "lastMessageAt"` 도 그 **글자** 순이다 — 같게 한다.
    "(select max(msg.created_at)::text from message msg where msg.channel_id = c.id and msg.deleted_at is null) as last_text ",
    "from channel c join channel_member m on m.channel_id = c.id ",
    "where c.kind = 'dm' and exists (select 1 from channel_member me where me.channel_id = c.id and me.account_id = $1::uuid) ",
    "group by c.id) x"
);

/// `GET /dms` — 내가 든 DM, 마지막 말 시각 최근순.
pub async fn dms(State(pool): State<PgPool>, RequireAccount(me, _): RequireAccount) -> Response {
    match one_json(&pool, DMS, Some(&me.id)).await {
        Ok(b) => json_ok(b),
        Err(r) => r,
    }
}

const MCP_SERVERS: &str = concat!(
    "select json_build_object('servers', coalesce((select json_agg(x order by x.name) from (",
    "select name, credential_kind as \"credentialKind\", created_by as \"createdBy\", ",
    iso!("created_at"),
    " as \"createdAt\" from mcp_server) x), '[]'::json))::text"
);

/// `GET /mcp-servers` — 레지스트리 이름 목록(로그인한 누구나).
pub async fn mcp_servers(State(pool): State<PgPool>, _: RequireAccount) -> Response {
    match one_json(&pool, MCP_SERVERS, None).await {
        Ok(b) => json_ok(b),
        Err(r) => r,
    }
}

/// `GET /audit` 의 질의 — TS zod `{ limit: coerce int 1..=500?, before: /^\d+$/?, action: max 64? }`. 모르는 키는 버린다(zod 기본).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AuditQuery {
    pub limit: Option<i64>,
    pub before: Option<String>,
    pub action: Option<String>,
}

/// zod `z.coerce.number()` 는 JS `Number(x)` 다. 여기선 그중 10진 꼴만 받는다(`0x10`·`1e2` 같은 꼴은 400 — TS 는 받는다, 화면은 쓰지 않는다).
pub(crate) fn coerce_int(raw: &str) -> Option<i64> {
    let t = raw.trim();
    if t.is_empty() {
        return Some(0); // Number("") === 0 → min(1) 에서 걸린다.
    }
    let v: f64 = t.parse().ok().filter(|v: &f64| v.is_finite())?;
    if !t
        .bytes()
        .all(|b| b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'+')
    {
        return None;
    }
    (v.fract() == 0.0 && v.abs() < 9e15).then_some(v as i64)
}

/// 거절이면 zod 오류처럼 400 `invalid_request` 를 낸다(문구는 TS 와 다르다 — zod 의 오류 JSON 을 따라 쓰지 않는다).
pub fn parse_audit_query(raw: Option<&str>) -> Result<AuditQuery, &'static str> {
    let mut q = AuditQuery::default();
    let mut seen: Vec<String> = vec![];
    for (k, v) in form_pairs(raw.unwrap_or("")) {
        if !matches!(k.as_str(), "limit" | "before" | "action") {
            continue;
        }
        // 같은 키가 둘이면 TS 는 배열을 받아 zod 가 거절한다.
        if seen.contains(&k) {
            return Err("duplicate query key");
        }
        seen.push(k.clone());
        match k.as_str() {
            "limit" => {
                let n = coerce_int(&v).ok_or("limit must be an integer")?;
                if !(1..=500).contains(&n) {
                    return Err("limit out of range");
                }
                q.limit = Some(n);
            }
            "before" => {
                if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
                    return Err("before must be digits");
                }
                q.before = Some(v);
            }
            _ => {
                if v.encode_utf16().count() > 64 {
                    return Err("action too long");
                }
                q.action = Some(v);
            }
        }
    }
    Ok(q)
}

/// `application/x-www-form-urlencoded` 풀기(`+` 는 공백, `%xx` 는 바이트). 깨진 `%` 는 글자 그대로 둔다.
pub(crate) fn form_pairs(raw: &str) -> Vec<(String, String)> {
    fn dec(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'+' => out.push(b' '),
                b'%' if i + 2 < b.len() => {
                    let hex = |c: u8| (c as char).to_digit(16);
                    match (hex(b[i + 1]), hex(b[i + 2])) {
                        (Some(h), Some(l)) => {
                            out.push((h * 16 + l) as u8);
                            i += 2;
                        }
                        _ => out.push(b'%'),
                    }
                }
                c => out.push(c),
            }
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    raw.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (dec(k), dec(v)),
            None => (dec(p), String::new()),
        })
        .collect()
}

const AUDIT: &str = concat!(
    "select json_build_object('entries', coalesce(json_agg(json_build_object(",
    "'id', x.id::text, 'at', ",
    iso!("x.at"),
    ", 'action', x.action, 'actorId', x.actor_id, 'actorHandle', x.actor_handle, ",
    "'target', x.target, 'ip', x.ip, 'detail', x.detail) order by x.id desc), '[]'::json))::text ",
    "from (select * from audit_log ",
    "where ($1::bigint is null or id < $1::bigint) and ($2::text is null or action = $2::text) ",
    "order by audit_log.id desc limit $3) x"
);

/// `GET /audit` — `audit.read` 권한. TS 처럼 권한 판정이 질의 검사보다 먼저다.
pub async fn audit(
    State(pool): State<PgPool>,
    auth: axum::Extension<crate::auth::Auth>,
    RawQuery(raw): RawQuery,
) -> Response {
    if let Err(r) = require_cap(&pool, &auth, "audit.read", None).await {
        return r;
    }
    let q = match parse_audit_query(raw.as_deref()) {
        Ok(q) => q,
        Err(m) => return json_err(StatusCode::BAD_REQUEST, "invalid_request", m),
    };
    let res = sqlx::query_scalar::<_, String>(AUDIT)
        .bind(q.before)
        .bind(q.action)
        .bind(q.limit.unwrap_or(100))
        .fetch_one(&pool)
        .await;
    match res {
        Ok(b) => json_ok(b),
        Err(e) => internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(raw: &str) -> Result<AuditQuery, &'static str> {
        parse_audit_query(Some(raw))
    }

    #[test]
    fn coerce_int_follows_js_number_for_decimal_forms() {
        assert_eq!(coerce_int("5"), Some(5));
        assert_eq!(coerce_int(" 7 "), Some(7), "Number 은 앞뒤 공백을 버린다");
        assert_eq!(coerce_int("+3"), Some(3));
        assert_eq!(coerce_int("-2"), Some(-2));
        assert_eq!(coerce_int("10.0"), Some(10), ".0 은 정수다(z.int 통과)");
        assert_eq!(coerce_int(""), Some(0), "Number('') === 0");
        assert_eq!(coerce_int("1.5"), None, "z.int 거절");
        assert_eq!(coerce_int("abc"), None, "NaN");
        assert_eq!(coerce_int("Infinity"), None);
        assert_eq!(coerce_int("NaN"), None);
        // TS 는 받지만 여기선 거절하는 꼴(화면이 쓰지 않는다) — 바뀌면 PR 본문 차이 목록도 고친다.
        assert_eq!(coerce_int("1e2"), None);
        assert_eq!(coerce_int("0x10"), None);
    }

    #[test]
    fn form_pairs_decodes_like_urlsearchparams() {
        assert_eq!(
            form_pairs("a=1&b=x+y&c=%41%42&&d&e=%zz&f=%4"),
            vec![
                ("a".into(), "1".into()),
                ("b".into(), "x y".into()),
                ("c".into(), "AB".into()),
                ("d".into(), String::new()),
                ("e".into(), "%zz".into()),
                ("f".into(), "%4".into()),
            ]
        );
        assert_eq!(form_pairs("k=a=b"), vec![("k".into(), "a=b".into())]);
        assert_eq!(form_pairs("x=%ED%95%9C"), vec![("x".into(), "한".into())]);
        assert!(form_pairs("").is_empty());
    }

    #[test]
    fn audit_query_accepts_what_zod_accepts() {
        assert_eq!(parse_audit_query(None), Ok(AuditQuery::default()));
        assert_eq!(
            q("limit=2&action=login&before=123&other=zzz"),
            Ok(AuditQuery {
                limit: Some(2),
                before: Some("123".into()),
                action: Some("login".into()),
            })
        );
        assert_eq!(q("limit=1").unwrap().limit, Some(1));
        assert_eq!(q("limit=500").unwrap().limit, Some(500));
        assert_eq!(q("action=").unwrap().action, Some(String::new()));
        assert_eq!(
            q(&format!("action={}", "a".repeat(64)))
                .unwrap()
                .action
                .unwrap()
                .len(),
            64
        );
        // 64 는 UTF-16 단위다(JS string length) — 한글 64자는 통과.
        assert!(q(&format!("action={}", "%ED%95%9C".repeat(64))).is_ok());
    }

    #[test]
    fn audit_query_rejects_what_zod_rejects() {
        for bad in [
            "limit=0",
            "limit=501",
            "limit=",
            "limit=1.5",
            "limit=x",
            "before=",
            "before=12a",
            "before=-1",
            "limit=1&limit=2",
            "action=a&action=b",
        ] {
            assert!(q(bad).is_err(), "{bad}");
        }
        assert!(q(&format!("action={}", "a".repeat(65))).is_err());
    }
}
