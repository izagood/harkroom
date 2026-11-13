//! 쓰기 바탕(S5.2 P3) — Rust 로 옮긴 쓰는 라우트가 함께 쓰는 셋:
//!
//! - [`emit_event`]: TS `events.ts::emitEvent` 의 짝. `harkroom-bus` 로 `event_outbox` 에 넣고 NOTIFY 한다 — TS 의 `eventBus.ts` 가
//!   받아 모양을 거르고 `emitEvent` 로 WS 구독자에게 옮긴다. **쓰기와 같은 트랜잭션**에 넣는다(롤백하면 이벤트도 없다).
//! - [`record_audit`]: TS `audit.ts::recordAudit` 의 짝. 같은 줄을 넣고, 실패해도 요청은 막지 않는다(TS 와 같다).
//! - [`fastify_body`]: TS 서버(fastify)가 라우트 **앞에서**(인증 판정 `requireAccount` 보다 먼저) 본문을 읽는 규칙. 본문이 틀리면
//!   익명 요청도 401 이 아니라 400/415 를 받는다 — 같은 순서로 내야 두 구현의 답이 같다.
//!
//! 쓰기 풀은 env `DATABASE_WRITE_URL` 이 있을 때만 열린다(`main.rs`). 그 역할에 줄 권한은 [`REQUIRED_PRIVILEGES`] 가 정본이고,
//! 기동 때 [`missing_privileges`] 로 확인해 기록한다.
use crate::directory::json_err;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};

/// 앞단 쓰기 역할에 주는 권한(표, 권한) — homelab 의 GRANT 와 이 목록이 같아야 한다. 늘리면 그 PR 에서 homelab 도 같이 늘린다.
/// 읽기는 `pg_read_all_data` 로 받는다(여기 적지 않는다).
pub const REQUIRED_PRIVILEGES: &[(&str, &str)] = &[
    ("event_outbox", "INSERT"),
    ("audit_log", "INSERT"),
    ("inbox_view_cursor", "INSERT"),
    ("inbox_view_cursor", "UPDATE"),
    // P4d — 인증 미들웨어의 기록(세션 연장 `RENEW_SESSION`, PAT 사용 시각).
    ("session", "UPDATE"),
    ("pat", "UPDATE"),
    // P4a — 설정 PUT 둘·스킬 승인/비활성/사용 기록(`writes_settings.rs`).
    ("agent_defaults", "UPDATE"),
    ("mention_policy", "INSERT"),
    ("mention_policy", "UPDATE"),
    ("workspace_skill", "UPDATE"),
    ("workspace_skill_usage", "INSERT"),
    ("builtin_skill_usage", "INSERT"),
    // P4b — 팀·집합(`writes_teams.rs`·`writes_groups.rs`). 구성원 표는 부모를 지울 때 FK cascade 가 지운다(표 주인 권한).
    ("agent_team", "INSERT"),
    ("agent_team", "UPDATE"),
    ("agent_team", "DELETE"),
    ("agent_team_member", "INSERT"),
    ("agent_team_member", "DELETE"),
    ("agent_team_invoker", "INSERT"),
    ("agent_team_invoker", "DELETE"),
    ("handle_group", "INSERT"),
    ("handle_group", "UPDATE"),
    ("handle_group", "DELETE"),
    ("handle_group_member", "INSERT"),
    ("handle_group_member", "DELETE"),
];
/// 시퀀스 권한(시퀀스, 권한) — `event_outbox.id` 는 bigserial 이다. `audit_log.id` 는 identity 라 필요 없다.
pub const REQUIRED_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[
    ("event_outbox_id_seq", "USAGE"),
    ("workspace_skill_usage_id_seq", "USAGE"),
    ("builtin_skill_usage_id_seq", "USAGE"),
];

/// 지금 연결된 역할에 없는 권한. 기동 기록용 — 비어 있어야 정상이다.
pub async fn missing_privileges(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let mut out = vec![];
    for (t, p) in REQUIRED_PRIVILEGES {
        let ok: bool = sqlx::query_scalar("select has_table_privilege($1, $2)")
            .bind(t)
            .bind(p)
            .fetch_one(pool)
            .await?;
        if !ok {
            out.push(format!("{p} on {t}"));
        }
    }
    for (s, p) in REQUIRED_SEQUENCE_PRIVILEGES {
        let ok: bool = sqlx::query_scalar("select has_sequence_privilege($1, $2)")
            .bind(s)
            .bind(p)
            .fetch_one(pool)
            .await?;
        if !ok {
            out.push(format!("{p} on sequence {s}"));
        }
    }
    Ok(out)
}

/// TS `emitEvent` 의 짝 — 호출자의 트랜잭션(또는 연결) 안에서 outbox 에 넣는다. 모양은 `events.ts::WorkspaceEvent` 와 같아야 한다
/// (받는 쪽 `eventBus.ts` 가 모르는 꼴은 버린다).
pub async fn emit_event(conn: &mut PgConnection, event: &Value) -> Result<i64, sqlx::Error> {
    harkroom_bus::publish_on(conn, event).await
}

/// TS `recordAudit` 의 칸.
pub struct AuditEntry<'a> {
    pub action: &'a str,
    pub actor_id: Option<&'a str>,
    pub actor_handle: Option<&'a str>,
    pub target: Option<&'a str>,
    pub ip: Option<&'a str>,
    pub detail: Value,
}

/// TS `recordAudit` — 실패해도 요청을 막지 않는다(기록만 남긴다).
pub async fn record_audit(pool: &PgPool, e: AuditEntry<'_>) {
    let r = sqlx::query(
        "insert into audit_log (action, actor_id, actor_handle, target, ip, detail) \
         values ($1, $2::uuid, $3, $4, $5, $6::jsonb)",
    )
    .bind(e.action)
    .bind(e.actor_id)
    .bind(e.actor_handle)
    .bind(e.target)
    .bind(e.ip)
    .bind(e.detail.to_string())
    .execute(pool)
    .await;
    if let Err(err) = r {
        eprintln!(
            "front: audit record failed ({}): {}",
            e.action,
            err.as_database_error().map_or("io", |_| "db")
        );
    }
}

/// fastify 가 읽은 본문. `None` 은 TS 의 `req.body === undefined`(본문 없음)다.
#[derive(Debug, PartialEq)]
pub enum Body {
    None,
    Json(Value),
    /// `text/plain` — 문자열 그대로(zod 객체 검사에서 400 으로 떨어진다).
    Text(String),
}

/// TS 서버의 본문 규칙(`buildServer.ts` 의 `*` 파서와 fastify 기본 파서):
/// - 빈·공백 `content-type` 은 없는 것으로 본다.
/// - `application/json`: 비면 400 `fst_err_ctp_empty_json_body`, 깨졌으면 400 `fst_err_ctp_invalid_json_body`.
/// - `text/plain`: 문자열.
/// - 그 밖(없음 포함): 비면 본문 없음, 있으면 415 `bad_request`.
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
pub fn fastify_body(headers: &HeaderMap, bytes: &[u8]) -> Result<Body, Response> {
    let media = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|v| !v.is_empty());
    match media.as_deref() {
        Some("application/json") => {
            if bytes.is_empty() {
                return Err(json_err(
                    StatusCode::BAD_REQUEST,
                    "fst_err_ctp_empty_json_body",
                    "Body cannot be empty when content-type is set to 'application/json'",
                ));
            }
            serde_json::from_slice(bytes).map(Body::Json).map_err(|_| {
                json_err(
                    StatusCode::BAD_REQUEST,
                    "fst_err_ctp_invalid_json_body",
                    "Body is not valid JSON but content-type is set to 'application/json'",
                )
            })
        }
        Some("text/plain") => Ok(Body::Text(String::from_utf8_lossy(bytes).into_owned())),
        _ if bytes.is_empty() => Ok(Body::None),
        _ => Err(json_err(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "bad_request",
            "Unsupported Media Type",
        )),
    }
}

/// fastify `bodyLimit`(`buildServer.ts`, 1 MiB) — 넘으면 413 `fst_err_ctp_body_too_large`.
pub const BODY_LIMIT: usize = 1024 * 1024;

/// 요청 본문을 fastify 처럼 읽는다(한도 → [`fastify_body`]).
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
pub async fn read_body(headers: &HeaderMap, body: axum::body::Body) -> Result<Body, Response> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        )
    })?;
    fastify_body(headers, &bytes)
}

/// zod `z.string().datetime({ offset: true })`(v3.25) 를 통과하고 JS `new Date(s).toISOString()` 이 낼 값.
/// - `Err(())`: zod 가 거절한다(→ 400 `invalid_request`).
/// - `Ok(None)`: zod 는 통과하나 JS 가 `Invalid Date` 로 읽는다(오프셋 시 > 23·분 > 59, 또는 ISO 로 못 적는 해) — TS 는
///   `toISOString()` 에서 던져 500 이다.
/// - `Ok(Some(iso))`: 밀리초까지(넘는 자리는 버림) UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`.
#[allow(clippy::result_unit_err)]
pub fn zod_datetime_offset(s: &str) -> Result<Option<String>, ()> {
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Result<i64, ()> {
        let t = b.get(r).ok_or(())?;
        if t.is_empty() || !t.iter().all(u8::is_ascii_digit) {
            return Err(());
        }
        Ok(t.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0')))
    };
    let lit = |i: usize, c: u8| {
        if b.get(i) == Some(&c) {
            Ok(())
        } else {
            Err(())
        }
    };
    // 날짜: \d{4}-MM-DD, 달·날 범위와 윤년(02-29) 은 zod dateRegexSource 와 같다.
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    lit(4, b'-')?;
    lit(7, b'-')?;
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = match mo {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(()),
    };
    if !(1..=dim).contains(&d) {
        return Err(());
    }
    lit(10, b'T')?;
    // 시각: HH:MM(:SS(.\d+)?)?
    let (h, mi) = (num(11..13)?, num(14..16)?);
    lit(13, b':')?;
    if h > 23 || mi > 59 {
        return Err(());
    }
    let mut i = 16;
    let (mut sec, mut ms) = (0i64, 0i64);
    if b.get(i) == Some(&b':') {
        sec = num(i + 1..i + 3)?;
        if sec > 59 {
            return Err(());
        }
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut j = start;
            while b.get(j).is_some_and(u8::is_ascii_digit) {
                j += 1;
            }
            if j == start {
                return Err(());
            }
            // JS 는 앞 세 자리만 읽는다(버림).
            let frac = &s[start..j.min(start + 3)];
            ms = num(start..start + frac.len())? * 10i64.pow(3 - frac.len() as u32);
            i = j;
        }
    }
    // 오프셋: Z | [+-]\d{2}:?\d{2}
    let off_min = match b.get(i) {
        Some(b'Z') if i + 1 == b.len() => 0,
        Some(&c @ (b'+' | b'-')) => {
            let oh = num(i + 1..i + 3)?;
            let k = if b.get(i + 3) == Some(&b':') {
                i + 4
            } else {
                i + 3
            };
            let om = num(k..k + 2)?;
            if k + 2 != b.len() {
                return Err(());
            }
            if oh > 23 || om > 59 {
                return Ok(None);
            }
            let m = oh * 60 + om;
            if c == b'+' { m } else { -m }
        }
        _ => return Err(()),
    };
    let days = days_from_civil(y, mo, d);
    let t = days * 86_400_000 + ((h * 60 + mi - off_min) * 60 + sec) * 1000 + ms;
    let (dd, rem) = (t.div_euclid(86_400_000), t.rem_euclid(86_400_000));
    let (yy, mm, ddd) = civil_from_days(dd);
    if !(0..=9999).contains(&yy) {
        // JS 는 ±YYYYYY 로 적고 DB 가 그 꼴을 받지 못한다 — TS 는 500 이다.
        return Ok(None);
    }
    Ok(Some(format!(
        "{yy:04}-{mm:02}-{ddd:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )))
}

/// 1970-01-01 부터의 날 수(proleptic Gregorian, H. Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(ct: Option<&str>) -> HeaderMap {
        let mut m = HeaderMap::new();
        if let Some(c) = ct {
            m.insert(header::CONTENT_TYPE, c.parse().unwrap());
        }
        m
    }

    fn status(r: Result<Body, Response>) -> u16 {
        r.err().map_or(200, |r| r.status().as_u16())
    }

    #[test]
    fn body_rules_follow_fastify() {
        assert_eq!(fastify_body(&h(None), b"").unwrap(), Body::None);
        assert_eq!(fastify_body(&h(Some("  ")), b"").unwrap(), Body::None);
        assert_eq!(
            fastify_body(&h(Some("application/json; charset=utf-8")), br#"{"a":1}"#).unwrap(),
            Body::Json(serde_json::json!({"a":1}))
        );
        assert_eq!(status(fastify_body(&h(Some("application/json")), b"")), 400);
        assert_eq!(
            status(fastify_body(&h(Some("application/json")), b"{")),
            400
        );
        assert_eq!(
            fastify_body(&h(Some("text/plain")), b"x").unwrap(),
            Body::Text("x".into())
        );
        assert_eq!(
            status(fastify_body(&h(Some("application/xml")), b"<a/>")),
            415
        );
        assert_eq!(status(fastify_body(&h(None), b"x")), 415);
        assert_eq!(
            fastify_body(&h(Some("application/x-www-form-urlencoded")), b"").unwrap(),
            Body::None
        );
    }

    #[test]
    fn privilege_list_names_only_listed_tables() {
        let tables: std::collections::BTreeSet<_> =
            REQUIRED_PRIVILEGES.iter().map(|x| x.0).collect();
        assert_eq!(
            tables.into_iter().collect::<Vec<_>>(),
            [
                "agent_defaults",
                "agent_team",
                "agent_team_invoker",
                "agent_team_member",
                "audit_log",
                "builtin_skill_usage",
                "event_outbox",
                "handle_group",
                "handle_group_member",
                "inbox_view_cursor",
                "mention_policy",
                "pat",
                "session",
                "workspace_skill",
                "workspace_skill_usage"
            ],
            "넓힐 때는 homelab GRANT 와 이 시험을 같이 고친다"
        );
        // DELETE 는 P4b 의 팀·집합(과 그 구성원) 표에만 — homelab#353 목록과 같다. TRUNCATE·그 밖의 것은 없다.
        const DELETE_OK: &[&str] = &[
            "agent_team",
            "agent_team_member",
            "agent_team_invoker",
            "handle_group",
            "handle_group_member",
        ];
        assert!(
            REQUIRED_PRIVILEGES.iter().all(|x| x.1 == "INSERT"
                || x.1 == "UPDATE"
                || (x.1 == "DELETE" && DELETE_OK.contains(&x.0))),
            "DELETE 는 팀·집합 표에만, TRUNCATE 는 주지 않는다"
        );
    }

    #[test]
    fn datetime_matches_zod_and_js_date() {
        let ok = |s: &str| zod_datetime_offset(s).unwrap().unwrap();
        // 값은 `node -e "new Date(s).toISOString()"` 로 뽑았다.
        assert_eq!(ok("2026-11-13T09:00+0900"), "2026-11-13T00:00:00.000Z");
        assert_eq!(
            ok("2026-11-13T09:00:00.123456789+09:00"),
            "2026-11-13T00:00:00.123Z"
        );
        assert_eq!(ok("2026-11-13T09:00Z"), "2026-11-13T09:00:00.000Z");
        assert_eq!(
            ok("2026-11-13T09:00:00.5-03:30"),
            "2026-11-13T12:30:00.500Z"
        );
        assert_eq!(ok("2026-11-13T09:00+23:59"), "2026-11-12T09:01:00.000Z");
        assert_eq!(ok("2024-02-29T00:00:00Z"), "2024-02-29T00:00:00.000Z");
        assert_eq!(ok("2000-02-29T00:00:00Z"), "2000-02-29T00:00:00.000Z");
        assert_eq!(ok("0001-01-01T00:00:00Z"), "0001-01-01T00:00:00.000Z");
        // zod 는 통과, JS 는 Invalid Date.
        assert_eq!(zod_datetime_offset("2026-11-13T09:00+24:00"), Ok(None));
        assert_eq!(zod_datetime_offset("2026-11-13T09:00+05:60"), Ok(None));
        assert_eq!(zod_datetime_offset("0000-01-01T00:00+01:00"), Ok(None));
        // zod 거절.
        for bad in [
            "",
            "2026-11-13",
            "2026-11-13T09:00",
            "2026-11-13t09:00Z",
            "2026-11-13 09:00Z",
            "2026-02-29T00:00Z",
            "1900-02-29T00:00Z",
            "2026-13-01T00:00Z",
            "2026-04-31T00:00Z",
            "2026-11-13T24:00Z",
            "2026-11-13T09:60Z",
            "2026-11-13T09:00:60Z",
            "2026-11-13T09:00:00.Z",
            "2026-11-13T09:00.5Z",
            "2026-11-13T09:00+9",
            "2026-11-13T09:00+09:0",
            "2026-11-13T09:00Zx",
            "2026-11-13T09:00z",
            "+2026-11-13T09:00Z",
            "2026-11-13T09:00+09:00 ",
        ] {
            assert_eq!(zod_datetime_offset(bad), Err(()), "{bad}");
        }
    }
}
